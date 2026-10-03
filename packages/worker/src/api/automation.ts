import { problem } from "@next-cloud-flare/shared/errors";
import type { AccessVerifier } from "../auth/access";
import {
  authorizationAssertion,
  authorizeNode,
  type Principal,
  servicePrincipal,
} from "../auth/authorize";
import { AutomationCursorTokens } from "../auth/automationCursor";
import type { ContentKeyRing } from "../auth/contentTokens";
import { assertExists, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";

const ROOT = "/api/v1/automation/nodes";
const NODE = /^\/api\/v1\/automation\/nodes\/([A-Za-z0-9_-]{1,128})$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function automationRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return request.method === "GET" && (path === ROOT || NODE.test(path));
}

export async function handleAutomationHttp(
  request: Request,
  env: Env,
  epoch: number,
  verifier: AccessVerifier,
  cursorRing?: ContentKeyRing,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.hash || !automationRoute(request))
    return problem(404, "not_found");
  if (request.body) return problem(400, "bad_request");
  let claims;
  try {
    claims = await verifier.verify(request, "service");
  } catch {
    return problem(401, "unauthorized");
  }
  let principal: Principal;
  try {
    principal = await servicePrincipal(env.DB, claims, epoch);
  } catch {
    return problem(403, "forbidden");
  }
  if (!cursorRing) return problem(503, "not_ready");
  const cursorTokens = new AutomationCursorTokens(cursorRing);
  const nodeMatch = NODE.exec(url.pathname);
  if (nodeMatch) {
    if (url.search) return problem(400, "bad_request");
    try {
      const nodeId = nodeMatch[1] ?? "";
      const spaceId = await primary(env.DB)
        .prepare("SELECT space_id FROM nodes WHERE id=?")
        .bind(nodeId)
        .first<string>("space_id");
      if (!spaceId) return problem(404, "not_found");
      const proof = await authorizeNode(env.DB, principal, {
        operation: "automation.metadata.read",
        spaceId,
        nodeId,
      });
      if (proof.operation !== "automation.metadata.read") return problem(404, "not_found");
      await atomicBatch(env.DB, [
        authorizationAssertion(proof),
        assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
          epoch,
        ]),
      ]);
      return Response.json(
        {
          id: proof.node.id,
          spaceId: proof.node.space_id,
          ownerId: proof.node.owner_id,
          parentId: proof.node.parent_id,
          name: proof.node.name,
          kind: proof.node.kind,
          revision: proof.node.revision,
          currentBlobId: proof.node.current_blob_id,
          treeGeneration: proof.node.tree_generation,
        },
        { headers: HEADERS },
      );
    } catch {
      return problem(404, "not_found");
    }
  }
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1
  )
    return problem(400, "bad_request");
  const token = url.searchParams.get("cursor") ?? undefined;
  if (token !== undefined && (token.length === 0 || token.length > 4096))
    return problem(400, "bad_request");
  try {
    return Response.json(await listAutomationRoot(env, principal, epoch, cursorTokens, token), {
      headers: HEADERS,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_automation_cursor")
      return problem(400, "bad_request");
    return problem(404, "not_found");
  }
}

async function listAutomationRoot(
  env: Env,
  principal: Principal,
  epoch: number,
  tokens: AutomationCursorTokens,
  token?: string,
) {
  if (principal.kind !== "service") throw new Error("authorization_denied");
  const grant = await primary(env.DB)
    .prepare(`SELECT space_id AS spaceId,root_node_id AS rootNodeId
    FROM service_principals WHERE id=? AND mapped_user_id=? AND disabled_at IS NULL`)
    .bind(principal.service_principal_id, principal.user_id)
    .first<{ spaceId: string; rootNodeId: string }>();
  if (!grant?.rootNodeId) throw new Error("authorization_denied");
  const rootProof = await authorizeNode(env.DB, principal, {
    operation: "automation.list",
    spaceId: grant.spaceId,
    nodeId: grant.rootNodeId,
  });
  if (rootProof.operation !== "automation.list" || rootProof.node.kind === "file")
    throw new Error("authorization_denied");
  let lastNameCi: string | undefined;
  let lastId: string | undefined;
  if (token !== undefined) {
    const cursor = await tokens.verify(token);
    if (
      cursor.servicePrincipalId !== principal.service_principal_id ||
      cursor.credentialId !== principal.credential_id ||
      cursor.mappedUserId !== principal.user_id ||
      cursor.spaceId !== grant.spaceId ||
      cursor.scopeRootId !== grant.rootNodeId ||
      cursor.epoch !== epoch ||
      cursor.generation !== rootProof.node.tree_generation
    )
      throw new Error("invalid_automation_cursor");
    lastNameCi = cursor.lastNameCi;
    lastId = cursor.lastId;
  }
  const query =
    lastNameCi === undefined
      ? {
          sql: `SELECT n.id,n.parent_id AS parentId,n.owner_id AS ownerId,n.name,n.name_ci AS nameCi,
        n.kind,n.revision,n.current_blob_id AS currentBlobId,n.updated_at AS updatedAt,
        b.size,b.mime_sniffed AS mime FROM nodes n INDEXED BY nodes_children_keyset
        LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
          AND b.state IN ('committed','gc_candidate')
        WHERE n.parent_id=? AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
        ORDER BY n.name_ci,n.id LIMIT 201`,
          values: [grant.rootNodeId, grant.spaceId, principal.user_id],
        }
      : {
          sql: `SELECT n.id,n.parent_id AS parentId,n.owner_id AS ownerId,n.name,n.name_ci AS nameCi,
        n.kind,n.revision,n.current_blob_id AS currentBlobId,n.updated_at AS updatedAt,
        b.size,b.mime_sniffed AS mime FROM nodes n INDEXED BY nodes_children_keyset
        LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
          AND b.state IN ('committed','gc_candidate')
        WHERE n.parent_id=? AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
          AND (n.name_ci>? OR (n.name_ci=? AND n.id>?))
        ORDER BY n.name_ci,n.id LIMIT 201`,
          values: [
            grant.rootNodeId,
            grant.spaceId,
            principal.user_id,
            lastNameCi,
            lastNameCi,
            lastId ?? "",
          ],
        };
  const result = await atomicBatch(env.DB, [
    authorizationAssertion(rootProof),
    assertExists(
      `SELECT 1 FROM service_principals svc JOIN credentials c ON c.service_principal_id=svc.id
      JOIN control ctl ON ctl.singleton=1 WHERE svc.id=? AND svc.mapped_user_id=? AND svc.space_id=?
      AND svc.root_node_id=? AND svc.access_iss=? AND svc.common_name=? AND svc.disabled_at IS NULL
      AND c.id=? AND c.kind='service' AND ctl.epoch=? AND ctl.maintenance=0`,
      [
        principal.service_principal_id,
        principal.user_id,
        grant.spaceId,
        grant.rootNodeId,
        principal.access_iss,
        principal.common_name,
        principal.credential_id,
        epoch,
      ],
    ),
    query,
  ]);
  const rows = (result[2]?.results ?? []) as Array<
    Record<string, unknown> & { nameCi: string; id: string }
  >;
  const page = rows.slice(0, 200);
  const last = page.at(-1);
  const nextCursor =
    rows.length > 200 && last
      ? await tokens.issue({
          servicePrincipalId: principal.service_principal_id,
          credentialId: principal.credential_id,
          mappedUserId: principal.user_id,
          spaceId: grant.spaceId,
          scopeRootId: grant.rootNodeId,
          generation: rootProof.node.tree_generation,
          lastNameCi: last.nameCi,
          lastId: last.id,
          epoch,
        })
      : null;
  return {
    scopeRootId: grant.rootNodeId,
    spaceId: grant.spaceId,
    treeGeneration: rootProof.node.tree_generation,
    nodes: page.map(({ nameCi: _nameCi, ...node }) => node),
    nextCursor,
  };
}
