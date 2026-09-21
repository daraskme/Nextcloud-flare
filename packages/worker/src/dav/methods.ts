import { LIMITS, type Scope } from "@ncf/shared";

import type { AppContext } from "../api/http.js";
import { acquireMutation, type MutationLease } from "../api/mutation.js";
import { authenticateAppPassword, type AuthenticatedAppPassword } from "../auth/appPassword.js";
import { randomToken } from "../auth/tokens.js";
import { markStagedBlobOrphan, transferImmutableBlob } from "../services/blobs.js";
import { serveNodeContentById } from "../services/content.js";
import { buildCopyManifest, commitSameOwnerCopy } from "../services/copy.js";
import { buildDavOverwriteTarget, type DavOverwriteTarget } from "../services/davOverwrite.js";
import { applyDavProperties } from "../services/davProperties.js";
import { createFile, moveNode, overwriteFile } from "../services/fileMutations.js";
import { createFolder } from "../services/fsMutation.js";
import { getOwnedNode, getOwnerWorkspace } from "../services/nodes.js";
import { reserveQuota } from "../services/quota.js";
import { trashNode } from "../services/trash.js";
import { davEtag, parseDavTimeout, requiresDavPutPrecondition } from "./contract.js";
import { evaluateDavIf, parseDavIf, type DavConditionContext } from "./conditions.js";
import { davXmlResponse, parseDavXml, xmlText, type DavXmlNode } from "./davXml.js";
import {
  isMissingDavPath,
  listDavChildren,
  listSharedMounts,
  parseDavUrl,
  resolveDavPath,
  validateDestination,
  type DavMissingPath,
  type DavNode,
} from "./path.js";
import {
  parsePropfind,
  parseProppatch,
  protectedPropertyFailure,
  renderPropfind,
  renderProppatchResult,
} from "./properties.js";

class DavFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${randomToken(18)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireScopes(authentication: AuthenticatedAppPassword, ...required: Scope[]): void {
  if (!required.every((scope) => authentication.principal.scopes.includes(scope))) {
    throw new DavFailure(403, "forbidden");
  }
}

function existing(value: DavNode | DavMissingPath): DavNode {
  if (isMissingDavPath(value)) throw new DavFailure(404, "not_found");
  return value;
}

function missing(value: DavNode | DavMissingPath): DavMissingPath {
  if (!isMissingDavPath(value)) throw new DavFailure(405, "resource_exists");
  return value;
}

function mutationContext(
  authentication: AuthenticatedAppPassword,
  lease: MutationLease,
  spaceId: string,
) {
  return {
    operationId: lease.operationId,
    permitId: lease.permitId,
    epoch: lease.epoch,
    userId: authentication.principal.userId,
    sessionId: authentication.sessionId,
    credentialKind: "app_password" as const,
    credentialId: authentication.principal.credentialId,
    appPasswordId: authentication.principal.appPasswordId,
    spaceId,
    auditId: lease.auditId,
    outboxId: lease.outboxId,
  };
}

function etag(node: DavNode): string {
  return davEtag(node.id, node.revision, node.blobId ?? undefined);
}

async function activeLocks(
  context: AppContext,
  nodeId: string,
): Promise<{ digest: string; creatorUserId: string }[]> {
  const rows = await context.env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM nodes WHERE id=?1 UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN a ON n.id=a.parent_id WHERE a.depth<64) SELECT DISTINCT l.token_digest digest,l.creator_user_id creatorUserId FROM locks l JOIN a ON a.id=l.node_id WHERE l.expires_at>(strftime('%s','now')*1000) AND (a.depth=0 OR l.depth='infinity')",
  )
    .bind(nodeId)
    .all<{ digest: string; creatorUserId: string }>();
  return rows.results;
}

async function prepareConditions(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
  requestNode: DavNode,
): Promise<{ tokenDigests: string[]; validToken: boolean; validTokenValue: string | null }> {
  const parsed = parseDavIf(context.req.header("If") ?? null);
  const hashedTokens = await Promise.all(
    [...parsed.submittedTokens].map(async (token) => [token, await sha256Hex(token)] as const),
  );
  const tokenDigests = hashedTokens.map((entry) => entry[1]);
  const digestByToken = new Map(hashedTokens);
  const resource = context.req.url;
  const resources = new Map<string, DavNode>([[resource, requestNode]]);
  for (const list of parsed.lists) {
    if (list.resource === null || resources.has(list.resource)) continue;
    let tagged: URL;
    try {
      tagged = new URL(list.resource, context.env.APP_ORIGIN);
    } catch {
      throw new DavFailure(400, "invalid_if_resource");
    }
    const appOrigin = new URL(context.env.APP_ORIGIN);
    if (tagged.origin !== appOrigin.origin || tagged.search !== "" || tagged.hash !== "") {
      throw new DavFailure(400, "invalid_if_resource");
    }
    resources.set(
      list.resource,
      existing(await resolveDavPath(context.env, authentication, tagged.toString())),
    );
  }
  const conditions = new Map<string, DavConditionContext>();
  let validTokenValue: string | null = null;
  for (const [key, node] of resources) {
    const locks = await activeLocks(context, node.id);
    const matched = new Set<string>();
    for (const [token, digest] of digestByToken) {
      const lock = locks.find((candidate) => candidate.digest === digest);
      if (lock !== undefined) {
        matched.add(token);
        if (node.id === requestNode.id && lock.creatorUserId === authentication.principal.userId) {
          validTokenValue = token;
        }
      }
    }
    conditions.set(key, { etag: etag(node), lockTokens: matched });
  }
  if (!evaluateDavIf(parsed, resource, conditions)) throw new DavFailure(412, "condition_failed");
  return { tokenDigests, validToken: validTokenValue !== null, validTokenValue };
}

async function assertSubtreeLocks(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
  nodeId: string,
  tokenDigests: readonly string[],
): Promise<void> {
  const rows = await context.env.DB.prepare(
    "WITH RECURSIVE sub(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?1 UNION ALL SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND sub.depth<64 LIMIT 1001) SELECT DISTINCT l.token_digest digest,l.creator_user_id creatorUserId FROM locks l JOIN sub ON sub.id=l.node_id WHERE l.expires_at>(strftime('%s','now')*1000)",
  )
    .bind(nodeId)
    .all<{ digest: string; creatorUserId: string }>();
  const submitted = new Set(tokenDigests);
  if (
    rows.results.some(
      (lock) =>
        lock.creatorUserId !== authentication.principal.userId || !submitted.has(lock.digest),
    )
  ) {
    throw new DavFailure(423, "lock_token_submitted");
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function createDavFile(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
  target: DavMissingPath,
  request: Request,
  size: number,
  tokenDigests: string[],
): Promise<DavNode> {
  const workspace = await getOwnerWorkspace(context.env, authentication.principal.userId);
  const parent = await getOwnedNode(context.env, authentication.principal.userId, target.parent.id);
  const blobId = randomId("blob");
  let lease: MutationLease | undefined;
  let staged = false;
  await reserveQuota(context.env, authentication.principal.userId, size);
  try {
    await transferImmutableBlob(context.env, {
      ownerId: authentication.principal.userId,
      blobId,
      source: request.body ?? emptyStream(),
      size,
      mime: request.headers.get("Content-Type")?.split(";", 1)[0] ?? "application/octet-stream",
    });
    staged = true;
    lease = await acquireMutation(context.env, authentication, {
      spaceId: workspace.spaceId,
      kind: "dav.put",
      expectedSteps: 7,
      intent: { parentId: parent.id, name: target.name, blobId, size },
      nodeIds: [parent.id],
      lockTokenDigests: tokenDigests,
    });
    const nodeId = randomId("nod");
    await createFile(context.env, {
      ...mutationContext(authentication, lease, workspace.spaceId),
      parentId: parent.id,
      expectedParentRevision: parent.revision,
      expectedTreeGeneration: workspace.treeGeneration,
      nodeId,
      blobId,
      name: target.name,
    });
    staged = false;
    await lease.release();
    const node = await getOwnedNode(context.env, authentication.principal.userId, nodeId);
    return {
      ...node,
      ownerId: authentication.principal.userId,
      spaceId: workspace.spaceId,
      createdAt: node.updatedAt,
      href: target.href,
      shared: false,
    };
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    if (staged) {
      await markStagedBlobOrphan(context.env, blobId, authentication.principal.userId).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function createDavFolder(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
  target: DavMissingPath,
  tokenDigests: string[],
): Promise<DavNode> {
  const workspace = await getOwnerWorkspace(context.env, authentication.principal.userId);
  const parent = await getOwnedNode(context.env, authentication.principal.userId, target.parent.id);
  const lease = await acquireMutation(context.env, authentication, {
    spaceId: workspace.spaceId,
    kind: "dav.mkcol",
    expectedSteps: 5,
    intent: { parentId: parent.id, name: target.name },
    nodeIds: [parent.id],
    lockTokenDigests: tokenDigests,
  });
  try {
    const nodeId = randomId("nod");
    await createFolder(context.env, {
      ...mutationContext(authentication, lease, workspace.spaceId),
      parentId: parent.id,
      nodeId,
      name: target.name,
      expectedParentRevision: parent.revision,
      expectedTreeGeneration: workspace.treeGeneration,
    });
    await lease.release();
    return existing(
      await resolveDavPath(
        context.env,
        authentication,
        new URL(target.href, context.env.APP_ORIGIN).toString(),
      ),
    );
  } catch (error) {
    await lease.revoke().catch(() => undefined);
    throw error;
  }
}

async function trashDavNode(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
  node: DavNode,
  tokenDigests: string[],
): Promise<void> {
  if (node.parentId === null || node.shared) throw new DavFailure(403, "root_mutation_forbidden");
  const parent = await getOwnedNode(context.env, authentication.principal.userId, node.parentId);
  const workspace = await getOwnerWorkspace(context.env, authentication.principal.userId);
  const lease = await acquireMutation(context.env, authentication, {
    spaceId: workspace.spaceId,
    kind: "dav.delete",
    expectedSteps: 7,
    intent: { nodeId: node.id, revision: node.revision },
    nodeIds: [node.id, parent.id],
    lockTokenDigests: tokenDigests,
  });
  try {
    await trashNode(context.env, {
      ...mutationContext(authentication, lease, workspace.spaceId),
      trashOpId: randomId("trash"),
      nodeId: node.id,
      parentId: parent.id,
      expectedNodeRevision: node.revision,
      expectedParentRevision: parent.revision,
      expectedTreeGeneration: workspace.treeGeneration,
      purgeAfter: Date.now() + 35 * 86_400_000,
    });
    await lease.release();
  } catch (error) {
    await lease.revoke().catch(() => undefined);
    throw error;
  }
}

async function handleOptions(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  await resolveDavPath(context.env, authentication, context.req.url);
  return new Response(null, {
    status: 204,
    headers: {
      Allow:
        "OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK",
      DAV: "1, 2",
      "MS-Author-Via": "DAV",
    },
  });
}

async function handlePropfind(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:read");
  const depth = (context.req.header("Depth") ?? "infinity").toLowerCase();
  if (depth === "infinity") {
    return davXmlResponse('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', 403);
  }
  if (depth !== "0" && depth !== "1") throw new DavFailure(400, "invalid_depth");
  const node = existing(await resolveDavPath(context.env, authentication, context.req.url));
  const request = await parsePropfind(context.req.raw);
  let nodes = [node];
  if (depth === "1" && node.kind !== "file") {
    nodes = [
      node,
      ...(node.id.startsWith("shared-")
        ? await listSharedMounts(context.env, authentication.principal.userId)
        : await listDavChildren(context.env, node)),
    ];
  }
  return renderPropfind(context.env, nodes, request);
}

async function handleRead(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:read");
  const node = existing(await resolveDavPath(context.env, authentication, context.req.url));
  if (node.kind !== "file") throw new DavFailure(405, "collection_read_forbidden");
  if (context.req.header("Range")?.includes(",") === true) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${node.size ?? 0}`, ETag: etag(node) },
    });
  }
  return serveNodeContentById(context.env, node.id, context.req.raw);
}

async function handleMkcol(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:create");
  const length = context.req.header("Content-Length");
  if (length !== undefined && length !== "0") throw new DavFailure(415, "mkcol_body_unsupported");
  const target = missing(await resolveDavPath(context.env, authentication, context.req.url, true));
  const conditions = await prepareConditions(context, authentication, target.parent);
  const node = await createDavFolder(context, authentication, target, conditions.tokenDigests);
  return new Response(null, { status: 201, headers: { Location: node.href, ETag: etag(node) } });
}

async function handlePut(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  const length = context.req.header("Content-Length");
  if (length === undefined) throw new DavFailure(411, "length_required");
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.maxRequestBytes) {
    throw new DavFailure(413, "payload_too_large");
  }
  const resolved = await resolveDavPath(context.env, authentication, context.req.url, true);
  if (isMissingDavPath(resolved)) {
    requireScopes(authentication, "node:create");
    if (context.req.header("If-Match") !== undefined)
      throw new DavFailure(412, "precondition_failed");
    const conditions = await prepareConditions(context, authentication, resolved.parent);
    const node = await createDavFile(
      context,
      authentication,
      resolved,
      context.req.raw,
      size,
      conditions.tokenDigests,
    );
    return new Response(null, { status: 201, headers: { Location: node.href, ETag: etag(node) } });
  }
  requireScopes(authentication, "node:write");
  const ifNoneMatch = context.req.header("If-None-Match");
  if (
    ifNoneMatch
      ?.split(",")
      .map((value) => value.trim())
      .some((value) => value === "*" || value === etag(resolved)) === true
  ) {
    throw new DavFailure(412, "precondition_failed");
  }
  if (
    resolved.kind !== "file" ||
    resolved.parentId === null ||
    resolved.blobId === null ||
    resolved.shared
  ) {
    throw new DavFailure(409, "not_a_file");
  }
  const conditions = await prepareConditions(context, authentication, resolved);
  const ifMatch = context.req.header("If-Match") ?? null;
  if (requiresDavPutPrecondition(true, ifMatch, conditions.validToken)) {
    throw new DavFailure(428, "precondition_required");
  }
  if (ifMatch !== null && ifMatch !== "*" && ifMatch !== etag(resolved)) {
    throw new DavFailure(412, "precondition_failed");
  }
  const parent = await getOwnedNode(
    context.env,
    authentication.principal.userId,
    resolved.parentId,
  );
  const workspace = await getOwnerWorkspace(context.env, authentication.principal.userId);
  const blobId = randomId("blob");
  let staged = false;
  let lease: MutationLease | undefined;
  await reserveQuota(context.env, authentication.principal.userId, size);
  try {
    await transferImmutableBlob(context.env, {
      ownerId: authentication.principal.userId,
      blobId,
      source: context.req.raw.body ?? emptyStream(),
      size,
      mime: context.req.header("Content-Type")?.split(";", 1)[0] ?? "application/octet-stream",
    });
    staged = true;
    lease = await acquireMutation(context.env, authentication, {
      spaceId: workspace.spaceId,
      kind: "dav.put",
      expectedSteps: 7,
      intent: { nodeId: resolved.id, revision: resolved.revision, blobId, size },
      nodeIds: [resolved.id, parent.id],
      lockTokenDigests: conditions.tokenDigests,
    });
    await overwriteFile(context.env, {
      ...mutationContext(authentication, lease, workspace.spaceId),
      nodeId: resolved.id,
      parentId: parent.id,
      blobId,
      versionId: randomId("ver"),
      expectedNodeRevision: resolved.revision,
      expectedParentRevision: parent.revision,
    });
    staged = false;
    await lease.release();
    return new Response(null, { status: 204, headers: { ETag: `"b-${blobId}"` } });
  } catch (error) {
    await lease?.revoke().catch(() => undefined);
    if (staged) {
      await markStagedBlobOrphan(context.env, blobId, authentication.principal.userId).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function handleDelete(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:delete");
  const node = existing(await resolveDavPath(context.env, authentication, context.req.url));
  const conditions = await prepareConditions(context, authentication, node);
  await assertSubtreeLocks(context, authentication, node.id, conditions.tokenDigests);
  await trashDavNode(context, authentication, node, conditions.tokenDigests);
  return new Response(null, { status: 204 });
}

async function destinationTarget(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
  tokenDigests: string[],
): Promise<{
  target: DavMissingPath;
  overwritten: boolean;
  existingNodeId: string | null;
  overwrite?: DavOverwriteTarget;
}> {
  const destination = validateDestination(
    context.req.header("Destination") ?? null,
    context.env.APP_ORIGIN,
  );
  const resolved = await resolveDavPath(context.env, authentication, destination.toString(), true);
  if (isMissingDavPath(resolved)) {
    return { target: resolved, overwritten: false, existingNodeId: null };
  }
  const overwriteHeader = (context.req.header("Overwrite") ?? "T").toUpperCase();
  if (overwriteHeader !== "T" && overwriteHeader !== "F") {
    throw new DavFailure(400, "invalid_overwrite");
  }
  if (overwriteHeader === "F") throw new DavFailure(412, "overwrite_forbidden");
  requireScopes(authentication, "node:delete");
  if (resolved.parentId === null || resolved.shared) {
    throw new DavFailure(403, "overwrite_forbidden");
  }
  await assertSubtreeLocks(context, authentication, resolved.id, tokenDigests);
  const parentUrl = new URL(destination);
  const pathname = parentUrl.pathname.endsWith("/")
    ? parentUrl.pathname.slice(0, -1)
    : parentUrl.pathname;
  parentUrl.pathname = pathname.slice(0, pathname.lastIndexOf("/")) || "/dav";
  const parent = existing(await resolveDavPath(context.env, authentication, parentUrl.toString()));
  return {
    target: { parent, name: resolved.name, href: resolved.href },
    overwritten: true,
    existingNodeId: resolved.id,
    overwrite: await buildDavOverwriteTarget(context.env, {
      nodeId: resolved.id,
      parentId: resolved.parentId,
      expectedRevision: resolved.revision,
    }),
  };
}

async function handleCopy(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:read", "node:create");
  const source = existing(await resolveDavPath(context.env, authentication, context.req.url));
  if (source.shared || source.parentId === null) throw new DavFailure(403, "copy_forbidden");
  const depth = (context.req.header("Depth") ?? "infinity").toLowerCase();
  if (depth !== "0" && depth !== "infinity") throw new DavFailure(400, "invalid_depth");
  const conditions = await prepareConditions(context, authentication, source);
  const destination = await destinationTarget(context, authentication, conditions.tokenDigests);
  if (destination.existingNodeId === source.id) {
    throw new DavFailure(403, "copy_to_self_forbidden");
  }
  const destinationParent = await getOwnedNode(
    context.env,
    authentication.principal.userId,
    destination.target.parent.id,
  );
  const workspace = await getOwnerWorkspace(context.env, authentication.principal.userId);
  let manifest = await buildCopyManifest(context.env, {
    sourceId: source.id,
    destinationParentId: destinationParent.id,
    userId: authentication.principal.userId,
    name: destination.target.name,
    idFactory: () => randomId("nod"),
  });
  if (source.kind !== "file" && depth === "0") {
    const root = manifest.entries[0];
    if (root === undefined) throw new DavFailure(409, "copy_manifest_invalid");
    manifest = {
      ...manifest,
      entries: [root],
      properties: manifest.properties.filter((property) => property.sourceId === source.id),
    };
  }
  const blobIds = manifest.entries.flatMap((entry) =>
    entry.blobId === null ? [] : [entry.blobId],
  );
  const totalRow = await context.env.DB.prepare(
    "SELECT COALESCE(SUM(size),0) value FROM blobs WHERE id IN (SELECT value FROM json_each(?1))",
  )
    .bind(JSON.stringify(blobIds))
    .first<{ value: number }>();
  if (manifest.entries.length > 1000 || (totalRow?.value ?? 0) > 10 * 1024 ** 3) {
    return davXmlResponse(
      '<D:error xmlns:D="DAV:" xmlns:N="urn:next-cloud-flare:error"><N:too-large-for-dav/></D:error>',
      403,
    );
  }
  const lease = await acquireMutation(context.env, authentication, {
    spaceId: workspace.spaceId,
    kind: "dav.copy",
    expectedSteps: manifest.entries.length + (destination.overwrite === undefined ? 4 : 5),
    intent: { sourceId: source.id, destination: destination.target.href, depth },
    nodeIds: [
      source.id,
      destinationParent.id,
      ...(destination.overwrite === undefined ? [] : [destination.overwrite.nodeId]),
    ],
    lockTokenDigests: conditions.tokenDigests,
  });
  try {
    await commitSameOwnerCopy(context.env, {
      ...mutationContext(authentication, lease, workspace.spaceId),
      expectedTreeGeneration: workspace.treeGeneration,
      expectedDestinationRevision: destinationParent.revision,
      manifest,
      ...(destination.overwrite === undefined ? {} : { overwrite: destination.overwrite }),
    });
    await lease.release();
    return new Response(null, {
      status: destination.overwritten ? 204 : 201,
      headers: { Location: destination.target.href },
    });
  } catch (error) {
    await lease.revoke().catch(() => undefined);
    throw error;
  }
}

async function handleMove(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:write", "node:create");
  const source = existing(await resolveDavPath(context.env, authentication, context.req.url));
  if (source.shared || source.parentId === null) throw new DavFailure(403, "move_forbidden");
  const depth = (context.req.header("Depth") ?? "infinity").toLowerCase();
  if (depth !== "infinity") throw new DavFailure(400, "invalid_depth");
  const conditions = await prepareConditions(context, authentication, source);
  const destination = await destinationTarget(context, authentication, conditions.tokenDigests);
  if (destination.existingNodeId === source.id) return new Response(null, { status: 204 });
  await assertSubtreeLocks(context, authentication, source.id, conditions.tokenDigests);
  const sourceParent = await getOwnedNode(
    context.env,
    authentication.principal.userId,
    source.parentId,
  );
  const targetParent = await getOwnedNode(
    context.env,
    authentication.principal.userId,
    destination.target.parent.id,
  );
  const workspace = await getOwnerWorkspace(context.env, authentication.principal.userId);
  const sameParent = sourceParent.id === targetParent.id;
  const lease = await acquireMutation(context.env, authentication, {
    spaceId: workspace.spaceId,
    kind: "dav.move",
    expectedSteps: (sameParent ? 5 : 6) + (destination.overwrite === undefined ? 0 : 1),
    intent: { sourceId: source.id, destination: destination.target.href },
    nodeIds: [
      source.id,
      sourceParent.id,
      targetParent.id,
      ...(destination.overwrite === undefined ? [] : [destination.overwrite.nodeId]),
    ],
    lockTokenDigests: conditions.tokenDigests,
  });
  try {
    await moveNode(context.env, {
      ...mutationContext(authentication, lease, workspace.spaceId),
      expectedTreeGeneration: workspace.treeGeneration,
      nodeId: source.id,
      sourceParentId: sourceParent.id,
      destinationParentId: targetParent.id,
      name: destination.target.name,
      expectedNodeRevision: source.revision,
      expectedSourceParentRevision: sourceParent.revision,
      ...(sameParent ? {} : { expectedDestinationParentRevision: targetParent.revision }),
      ...(destination.overwrite === undefined ? {} : { overwrite: destination.overwrite }),
    });
    await lease.release();
    await context.env.DB.prepare("DELETE FROM locks WHERE node_id=?1").bind(source.id).run();
    return new Response(null, {
      status: destination.overwritten ? 204 : 201,
      headers: { Location: destination.target.href },
    });
  } catch (error) {
    await lease.revoke().catch(() => undefined);
    throw error;
  }
}

async function handleProppatch(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:write");
  const node = existing(await resolveDavPath(context.env, authentication, context.req.url));
  if (node.shared) throw new DavFailure(403, "shared_read_only");
  const conditions = await prepareConditions(context, authentication, node);
  const changes = await parseProppatch(context.req.raw);
  const protectedIndex = protectedPropertyFailure(changes);
  if (protectedIndex !== null) return renderProppatchResult(node.href, changes, protectedIndex);
  const removals = changes.filter((change) => change.action === "remove");
  for (const change of removals) {
    const present = await context.env.DB.prepare(
      "SELECT 1 value FROM node_props WHERE node_id=?1 AND namespace_uri=?2 AND local_name=?3",
    )
      .bind(node.id, change.namespace, change.localName)
      .first<{ value: number }>();
    if (present === null) {
      return renderProppatchResult(node.href, changes, changes.indexOf(change));
    }
  }
  const lease = await acquireMutation(context.env, authentication, {
    spaceId: node.spaceId,
    kind: "dav.proppatch",
    expectedSteps: changes.length + 3,
    intent: { nodeId: node.id, changes },
    nodeIds: [node.id],
    lockTokenDigests: conditions.tokenDigests,
  });
  try {
    await applyDavProperties(context.env, {
      ...mutationContext(authentication, lease, node.spaceId),
      nodeId: node.id,
      expectedRevision: node.revision,
      changes,
    });
    await lease.release();
    return renderProppatchResult(node.href, changes, null);
  } catch (error) {
    await lease.revoke().catch(() => undefined);
    throw error;
  }
}

function isDav(node: DavXmlNode, localName: string): boolean {
  return node.namespace === "DAV:" && node.localName === localName;
}

function lockBodyValid(root: DavXmlNode): boolean {
  const scope = root.children.find((child) => isDav(child, "lockscope"));
  const type = root.children.find((child) => isDav(child, "locktype"));
  return (
    isDav(root, "lockinfo") &&
    scope?.children.some((child) => isDav(child, "exclusive")) === true &&
    type?.children.some((child) => isDav(child, "write")) === true
  );
}

async function lockRequest(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
  node: DavNode,
  token: string,
  method: "POST" | "PATCH" | "DELETE",
  timeoutSeconds: number,
  depth: "0" | "infinity",
): Promise<Response> {
  const control = await context.env.DB.prepare(
    "SELECT epoch FROM control WHERE singleton=1",
  ).first<{
    epoch: number;
  }>();
  if (control === null) throw new DavFailure(503, "control_unavailable");
  const response = await context.env.LOCKS.get(context.env.LOCKS.idFromName(node.spaceId)).fetch(
    "https://lock.internal/locks",
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: node.id,
        creatorUserId: authentication.principal.userId,
        creatorCredentialId: authentication.principal.credentialId,
        appPasswordId: authentication.principal.appPasswordId,
        sessionId: authentication.sessionId,
        tokenDigest: await sha256Hex(token),
        displayUri: node.href,
        depth,
        timeoutSeconds,
        epoch: control.epoch,
      }),
    },
  );
  if (!response.ok)
    throw new DavFailure(response.status, response.status === 423 ? "locked" : "lock_failed");
  return response;
}

function lockResponse(
  node: DavNode,
  token: string,
  timeoutSeconds: number,
  status: number,
  depth: "0" | "infinity",
): Response {
  const xml = `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>${depth === "infinity" ? "Infinity" : "0"}</D:depth><D:timeout>Second-${timeoutSeconds}</D:timeout><D:locktoken><D:href>${xmlText(token)}</D:href></D:locktoken><D:lockroot><D:href>${xmlText(node.href)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
  const response = davXmlResponse(xml, status);
  response.headers.set("Lock-Token", `<${token}>`);
  return response;
}

async function handleLock(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:write");
  const timeout = parseDavTimeout(context.req.header("Timeout") ?? null);
  const contentLength = context.req.header("Content-Length");
  const refresh = contentLength === "0";
  let resolved = await resolveDavPath(context.env, authentication, context.req.url, true);
  if (refresh) {
    const node = existing(resolved);
    const conditions = await prepareConditions(context, authentication, node);
    if (conditions.validTokenValue === null) throw new DavFailure(423, "lock_token_submitted");
    await lockRequest(
      context,
      authentication,
      node,
      conditions.validTokenValue,
      "PATCH",
      timeout,
      "0",
    );
    return lockResponse(node, conditions.validTokenValue, timeout, 200, "0");
  }
  const body = await parseDavXml(context.req.raw, true);
  if (body === null || !lockBodyValid(body)) throw new DavFailure(400, "invalid_lockinfo");
  const depthHeader = (context.req.header("Depth") ?? "infinity").toLowerCase();
  if (depthHeader !== "0" && depthHeader !== "infinity") throw new DavFailure(400, "invalid_depth");
  const depth = depthHeader;
  let created = false;
  if (isMissingDavPath(resolved)) {
    requireScopes(authentication, "node:create");
    const conditions = await prepareConditions(context, authentication, resolved.parent);
    const request = new Request(context.req.url, {
      method: "PUT",
      headers: { "Content-Length": "0", "Content-Type": "application/octet-stream" },
      body: null,
    });
    await createDavFile(context, authentication, resolved, request, 0, conditions.tokenDigests);
    resolved = await resolveDavPath(context.env, authentication, context.req.url);
    created = true;
  }
  const node = existing(resolved);
  if (node.shared) throw new DavFailure(403, "shared_read_only");
  const token = `opaquelocktoken:${randomToken(32)}`;
  await lockRequest(context, authentication, node, token, "POST", timeout, depth);
  return lockResponse(node, token, timeout, created ? 201 : 200, depth);
}

async function handleUnlock(
  context: AppContext,
  authentication: AuthenticatedAppPassword,
): Promise<Response> {
  requireScopes(authentication, "node:write");
  const node = existing(await resolveDavPath(context.env, authentication, context.req.url));
  const match = /^<([^<>]{1,1024})>$/u.exec(context.req.header("Lock-Token") ?? "");
  if (match?.[1] === undefined) throw new DavFailure(400, "invalid_lock_token");
  await lockRequest(context, authentication, node, match[1], "DELETE", 1, "0");
  return new Response(null, { status: 204 });
}

function davError(status: number, code: string): Response {
  if (status === 401) {
    return new Response(null, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Next-cloud-flare WebDAV", charset="UTF-8"',
      },
    });
  }
  if (status === 423) {
    return davXmlResponse(
      `<D:error xmlns:D="DAV:"><D:lock-token-submitted><D:href/></D:lock-token-submitted></D:error>`,
      423,
    );
  }
  return davXmlResponse(
    `<D:error xmlns:D="DAV:" xmlns:N="urn:next-cloud-flare:error"><N:${/^[a-z][a-z0-9_-]*$/u.test(code) ? code : "request-failed"}/></D:error>`,
    status,
  );
}

function mapDavError(error: unknown): Response {
  if (error instanceof DavFailure) return davError(error.status, error.code);
  const message = error instanceof Error ? error.message : "request_failed";
  if (
    message.includes("app_password") ||
    message.startsWith("dav_https") ||
    message === "dav_browser_forbidden"
  ) {
    return davError(message === "dav_browser_forbidden" ? 403 : 401, "authentication_required");
  }
  if (message === "node_not_found") return davError(404, "not_found");
  if (message === "length_required") return davError(411, "length_required");
  if (message === "locked") return davError(423, "locked");
  if (message === "dav_propfind_limit") return davError(507, "propfind_limit");
  if (message.includes("UNIQUE constraint") || message === "name_conflict") {
    return davError(409, "name_conflict");
  }
  if (error instanceof RangeError) return davError(400, "invalid_request");
  return davError(409, "mutation_rejected");
}

export async function handleDav(context: AppContext): Promise<Response> {
  try {
    parseDavUrl(context.req.url);
    const authentication = await authenticateAppPassword(context.env, context.req.raw);
    switch (context.req.method) {
      case "OPTIONS":
        return await handleOptions(context, authentication);
      case "PROPFIND":
        return await handlePropfind(context, authentication);
      case "PROPPATCH":
        return await handleProppatch(context, authentication);
      case "MKCOL":
        return await handleMkcol(context, authentication);
      case "GET":
      case "HEAD":
        return await handleRead(context, authentication);
      case "PUT":
        return await handlePut(context, authentication);
      case "DELETE":
        return await handleDelete(context, authentication);
      case "COPY":
        return await handleCopy(context, authentication);
      case "MOVE":
        return await handleMove(context, authentication);
      case "LOCK":
        return await handleLock(context, authentication);
      case "UNLOCK":
        return await handleUnlock(context, authentication);
      default:
        return davError(405, "method_not_allowed");
    }
  } catch (error) {
    return mapDavError(error);
  }
}
