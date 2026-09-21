import { LIMITS } from "@ncf/shared";

import { authenticateAccessUser } from "../auth/httpAuth.js";
import { markStagedBlobOrphan, transferImmutableBlob } from "../services/blobs.js";
import { serveNodeContent } from "../services/content.js";
import { overwriteFile } from "../services/fileMutations.js";
import { getOwnedNode, getOwnerWorkspace } from "../services/nodes.js";
import { reserveQuota } from "../services/quota.js";
import { acquireMutation } from "./mutation.js";
import { type AppContext, jsonError, mapError } from "./http.js";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function handleContent(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return await serveNodeContent(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
      context.req.raw,
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePutContent(context: AppContext): Promise<Response> {
  let lease: Awaited<ReturnType<typeof acquireMutation>> | undefined;
  let staged: { id: string; ownerId: string } | undefined;
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const node = await getOwnedNode(
      context.env,
      user.principal.userId,
      context.req.param("nodeId"),
    );
    if (node.kind !== "file" || node.parentId === null || node.blobId === null) {
      return jsonError(context, 409, "not_a_file", "Content can only be replaced on a file");
    }
    if (context.req.header("If-Match") !== `"b-${node.blobId}"`) {
      return jsonError(
        context,
        412,
        "precondition_failed",
        "The current content validator is required",
      );
    }
    const contentLength = context.req.header("Content-Length");
    if (contentLength === undefined) {
      return jsonError(context, 411, "length_required", "Content-Length is required");
    }
    const size = Number(contentLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.maxRequestBytes) {
      return jsonError(context, 413, "payload_too_large", "Content length is invalid");
    }
    const parent = await getOwnedNode(context.env, user.principal.userId, node.parentId);
    const workspace = await getOwnerWorkspace(context.env, user.principal.userId);
    const blobId = randomId("blob");
    await reserveQuota(context.env, user.principal.userId, size);
    const source =
      context.req.raw.body ??
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    await transferImmutableBlob(context.env, {
      ownerId: user.principal.userId,
      blobId,
      source,
      size,
    });
    staged = { id: blobId, ownerId: user.principal.userId };
    lease = await acquireMutation(context.env, user, {
      spaceId: workspace.spaceId,
      kind: "node.content.write",
      expectedSteps: 7,
      intent: { nodeId: node.id, blobId, revision: node.revision },
      nodeIds: [node.id, node.parentId],
    });
    await overwriteFile(context.env, {
      operationId: lease.operationId,
      permitId: lease.permitId,
      epoch: lease.epoch,
      userId: user.principal.userId,
      sessionId: user.principal.sessionId,
      spaceId: workspace.spaceId,
      auditId: lease.auditId,
      outboxId: lease.outboxId,
      nodeId: node.id,
      parentId: node.parentId,
      blobId,
      versionId: randomId("ver"),
      expectedNodeRevision: node.revision,
      expectedParentRevision: parent.revision,
    });
    staged = undefined;
    await lease.release();
    return context.json(await getOwnedNode(context.env, user.principal.userId, node.id));
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    if (staged !== undefined) {
      await markStagedBlobOrphan(context.env, staged.id, staged.ownerId).catch(() => undefined);
    }
    return mapError(context, error);
  }
}
