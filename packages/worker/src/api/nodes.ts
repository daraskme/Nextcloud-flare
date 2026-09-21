import {
  copyNodeBodySchema,
  createFolderBodySchema,
  moveNodeBodySchema,
  renameNodeBodySchema,
} from "@ncf/shared";

import { authenticateAccessUser } from "../auth/httpAuth.js";
import { buildCopyManifest, commitSameOwnerCopy } from "../services/copy.js";
import { moveNode } from "../services/fileMutations.js";
import { createFolder } from "../services/fsMutation.js";
import { listChildren } from "../services/listing.js";
import { getOwnedNode, getOwnedPath, getOwnerWorkspace } from "../services/nodes.js";
import { listVersions, restoreFileVersion } from "../services/versions.js";
import {
  findInternalShare,
  getShareNode,
  getSharePath,
  listShareChildren,
} from "../services/shares.js";
import { acquireMutation } from "./mutation.js";
import { type AppContext, jsonError, mapError } from "./http.js";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function handleMe(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    return context.json({
      user: { id: user.principal.userId, email: user.email, role: user.role },
      workspace,
    });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleGetNode(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const nodeId = context.req.param("nodeId");
    try {
      return context.json(await getOwnedNode(context.env, user.principal.userId, nodeId));
    } catch {
      const share = await findInternalShare(context.env, user.principal.userId, nodeId, "read");
      if (share === null) throw new Error("node_not_found");
      return context.json(await getShareNode(context.env, share, nodeId));
    }
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleListVersions(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({
      items: await listVersions(context.env, user.principal.userId, context.req.param("nodeId")),
    });
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleRestoreVersion(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = await context.req.json<{ expectedRevision?: unknown }>();
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision)) {
      throw new RangeError("Expected revision is required");
    }
    const node = await getOwnedNode(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
    );
    if (node.kind !== "file" || node.parentId === null) throw new Error("not_a_file");
    if (node.revision !== expectedRevision) {
      return jsonError(context, 412, "precondition_failed", "The file changed before restoration");
    }
    const parent = await getOwnedNode(context.env, user.principal.userId, node.parentId);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.content.write",
      expectedSteps: 6,
      intent: {
        nodeId: node.id,
        versionId: context.req.param("versionId"),
        revision: node.revision,
      },
      nodeIds: [node.id, parent.id],
    });
    await restoreFileVersion(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      nodeId: node.id,
      parentId: parent.id,
      versionId: context.req.param("versionId"),
      replacementVersionId: randomId("ver"),
      expectedNodeRevision: node.revision,
      expectedParentRevision: parent.revision,
    });
    await lease.release();
    return context.json(await getOwnedNode(context.env, user.principal.userId, node.id));
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}

export async function handleChildren(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const nodeId = context.req.param("nodeId");
    try {
      return context.json(
        await listChildren(context.env, user.principal.userId, nodeId, context.req.query("cursor")),
      );
    } catch {
      if (context.req.query("cursor") !== undefined)
        throw new RangeError("Shared cursor is invalid");
      const share = await findInternalShare(context.env, user.principal.userId, nodeId, "read");
      if (share === null) throw new Error("node_not_found");
      const generation = await context.env.DB.prepare(
        "SELECT tree_generation value FROM nodes n JOIN spaces s ON s.id=n.space_id WHERE n.id=?1",
      )
        .bind(share.rootNodeId)
        .first<{ value: number }>();
      return context.json({
        items: await listShareChildren(context.env, share, nodeId),
        nextCursor: null,
        treeGeneration: generation?.value ?? 0,
      });
    }
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePath(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const nodeId = context.req.param("nodeId");
    try {
      return context.json({
        items: await getOwnedPath(context.env, user.principal.userId, nodeId),
      });
    } catch {
      const share = await findInternalShare(context.env, user.principal.userId, nodeId, "read");
      if (share === null) throw new Error("node_not_found");
      return context.json({ items: await getSharePath(context.env, share, nodeId) });
    }
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCreateFolder(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = createFolderBodySchema.parse(await context.req.json());
    const parent = await getOwnedNode(context.env, user.principal.userId, body.parentId);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const nodeId = randomId("nod");
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.create",
      expectedSteps: 5,
      intent: body,
      nodeIds: [body.parentId],
    });
    await createFolder(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      parentId: body.parentId,
      nodeId,
      name: body.name,
      expectedParentRevision: parent.revision,
      expectedTreeGeneration: workspace.treeGeneration,
      outboxId: lease.outboxId,
      auditId: lease.auditId,
    });
    await lease.release();
    return context.json(await getOwnedNode(context.env, user.principal.userId, nodeId), 201);
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}

export async function handleRename(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = renameNodeBodySchema.parse(await context.req.json());
    const node = await getOwnedNode(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
    );
    if (node.parentId === null) {
      throw new Error("root_mutation_forbidden");
    }
    const parent = await getOwnedNode(context.env, user.principal.userId, node.parentId);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.rename",
      expectedSteps: 5,
      intent: body,
      nodeIds: [node.id, node.parentId],
    });
    await moveNode(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      expectedTreeGeneration: workspace.treeGeneration,
      nodeId: node.id,
      sourceParentId: node.parentId,
      destinationParentId: node.parentId,
      name: body.name,
      expectedNodeRevision: node.revision,
      expectedSourceParentRevision: parent.revision,
    });
    await lease.release();
    return context.json(await getOwnedNode(context.env, user.principal.userId, node.id));
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}

export async function handleMove(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = moveNodeBodySchema.parse(await context.req.json());
    const node = await getOwnedNode(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
    );
    if (node.parentId === null) {
      throw new Error("root_mutation_forbidden");
    }
    const sourceParent = await getOwnedNode(context.env, user.principal.userId, node.parentId);
    const destination = await getOwnedNode(
      context.env,
      user.principal.userId,
      body.destinationParentId,
    );
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const sameParent = sourceParent.id === destination.id;
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.move",
      expectedSteps: sameParent ? 5 : 6,
      intent: body,
      nodeIds: [node.id, sourceParent.id, destination.id],
    });
    await moveNode(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      expectedTreeGeneration: workspace.treeGeneration,
      nodeId: node.id,
      sourceParentId: sourceParent.id,
      destinationParentId: destination.id,
      name: body.name ?? node.name,
      expectedNodeRevision: node.revision,
      expectedSourceParentRevision: sourceParent.revision,
      ...(sameParent ? {} : { expectedDestinationParentRevision: destination.revision }),
    });
    await lease.release();
    return context.json(await getOwnedNode(context.env, user.principal.userId, node.id));
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}

export async function handleCopy(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = copyNodeBodySchema.parse(await context.req.json());
    const destination = await getOwnedNode(
      context.env,
      user.principal.userId,
      body.destinationParentId,
    );
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const manifest = await buildCopyManifest(context.env, {
      sourceId: context.req.param("nodeId"),
      destinationParentId: destination.id,
      userId: user.principal.userId,
      ...(body.name === undefined ? {} : { name: body.name }),
      idFactory: () => randomId("nod"),
    });
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.copy",
      expectedSteps: manifest.entries.length + 4,
      intent: body,
      nodeIds: [context.req.param("nodeId"), destination.id],
    });
    await commitSameOwnerCopy(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      expectedTreeGeneration: workspace.treeGeneration,
      expectedDestinationRevision: destination.revision,
      manifest,
    });
    await lease.release();
    const copied = manifest.entries[0];
    if (copied === undefined) {
      throw new Error("copy_manifest_invalid");
    }
    return context.json(
      await getOwnedNode(context.env, user.principal.userId, copied.destinationId),
      201,
    );
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    return mapError(context, error);
  }
}
