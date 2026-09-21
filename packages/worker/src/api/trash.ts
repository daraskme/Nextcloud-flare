import { authenticateAccessUser } from "../auth/httpAuth.js";
import { getOwnedNode, getOwnerWorkspace } from "../services/nodes.js";
import { purgeTrash } from "../services/purge.js";
import { listTrash, trashNode } from "../services/trash.js";
import { restoreTrash } from "../services/trashRestore.js";
import { type AppContext, mapError } from "./http.js";
import { acquireMutation } from "./mutation.js";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function cursor(value: string | undefined): { createdAt: number; id: string } {
  if (value === undefined) return { createdAt: Number.MAX_SAFE_INTEGER, id: "~" };
  try {
    const parsed = JSON.parse(atob(value)) as { createdAt?: unknown; id?: unknown };
    if (!Number.isSafeInteger(parsed.createdAt) || typeof parsed.id !== "string") {
      throw new Error("invalid_cursor");
    }
    return { createdAt: Number(parsed.createdAt), id: parsed.id };
  } catch {
    throw new RangeError("Cursor is invalid");
  }
}

export async function handleTrashNode(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const node = await getOwnedNode(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
    );
    if (node.parentId === null) throw new Error("root_mutation_forbidden");
    const parent = await getOwnedNode(context.env, user.principal.userId, node.parentId);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const trashOpId = randomId("trash");
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.trash",
      expectedSteps: 7,
      intent: { nodeId: node.id, revision: node.revision },
      nodeIds: [node.id, parent.id],
    });
    await trashNode(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      trashOpId,
      nodeId: node.id,
      parentId: parent.id,
      expectedNodeRevision: node.revision,
      expectedParentRevision: parent.revision,
      expectedTreeGeneration: workspace.treeGeneration,
      purgeAfter: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    await lease.release();
    return context.json({ trashOpId }, 202);
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}

export async function handleListTrash(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const after = cursor(context.req.query("cursor"));
    return context.json(
      await listTrash(context.env, user.principal.userId, after.createdAt, after.id),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

async function trashDestination(
  context: AppContext,
  userId: string,
  opId: string,
): Promise<string> {
  const row = await context.env.DB.prepare(
    "SELECT n.orig_parent_id parentId,s.root_node_id rootId FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id JOIN spaces s ON s.id=t.space_id WHERE t.op_id=?1 AND t.actor_id=?2 AND t.state='trashed'",
  )
    .bind(opId, userId)
    .first<{ parentId: string | null; rootId: string }>();
  if (row === null) throw new Error("trash_not_found");
  if (row.parentId !== null) {
    try {
      await getOwnedNode(context.env, userId, row.parentId);
      return row.parentId;
    } catch {
      return row.rootId;
    }
  }
  return row.rootId;
}

export async function handleRestoreTrash(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const opId = context.req.param("opId");
    let requested: string | undefined;
    try {
      const body: { destinationParentId?: unknown } = await context.req.json();
      if (typeof body.destinationParentId === "string") requested = body.destinationParentId;
    } catch {
      requested = undefined;
    }
    const destinationId =
      requested ?? (await trashDestination(context, user.principal.userId, opId));
    const destination = await getOwnedNode(context.env, user.principal.userId, destinationId);
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.restore",
      expectedSteps: 7,
      intent: { opId, destinationId },
      nodeIds: [destinationId],
    });
    const nodeId = await restoreTrash(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      trashOpId: opId,
      destinationParentId: destination.id,
      expectedDestinationRevision: destination.revision,
      expectedTreeGeneration: workspace.treeGeneration,
    });
    await lease.release();
    return context.json(await getOwnedNode(context.env, user.principal.userId, nodeId));
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}

export async function handlePurgeTrash(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const opId = context.req.param("opId");
    const parentId = await trashDestination(context, user.principal.userId, opId);
    const parent = await getOwnedNode(context.env, user.principal.userId, parentId);
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.purge",
      expectedSteps: 9,
      intent: { opId },
      nodeIds: [parent.id],
    });
    const members = await purgeTrash(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      trashOpId: opId,
      expectedParentRevision: parent.revision,
      expectedTreeGeneration: workspace.treeGeneration,
      gcNotBefore: Date.now() + 24 * 60 * 60 * 1000,
    });
    await lease.release();
    return context.json({ purged: true, members });
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}
