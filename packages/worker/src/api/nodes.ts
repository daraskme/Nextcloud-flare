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
import { acquireMutation } from "./mutation.js";
import { type AppContext, mapError } from "./http.js";

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
    return context.json(
      await getOwnedNode(context.env, user.principal.userId, context.req.param("nodeId")),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleChildren(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(
      await listChildren(
        context.env,
        user.principal.userId,
        context.req.param("nodeId"),
        context.req.query("cursor"),
      ),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePath(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json({
      items: await getOwnedPath(context.env, user.principal.userId, context.req.param("nodeId")),
    });
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
