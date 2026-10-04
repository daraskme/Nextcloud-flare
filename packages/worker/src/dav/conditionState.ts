import { type LiveNode, type Principal, principalAuthorizationContext } from "../auth/authorize";
import { lockTokenHashes } from "../auth/locks";
import { classifyBatchFailure } from "../db/outcome";
import { assertExists, atomicBatch, type SqlStatement } from "../db/primary";
import type { OperationClaim } from "../jobs/operations";
import { commitMutationStatements, type MutationOutcome } from "../services/fsMutation";
import { type DavResourceState, evaluateDavIf, parseDavIfHeader } from "./conditions";
import { davEtag } from "./etag";
import { evaluateDavHttpPreconditions } from "./httpPreconditions";
import { davConditionAbsentAssertion, parseDavPath, resolveDavConditionPath } from "./path";

interface StateRow {
  id: string;
  kind: "root" | "folder" | "file";
  revision: number;
  current_blob_id: string | null;
  space_id: string;
  updated_at: number;
  tree_generation: number;
}
interface LockRow {
  token_hash: string;
}

async function resourceState(
  db: D1Database,
  principal: Principal,
  appOrigin: string,
  resource: string,
  tokenByHash: ReadonlyMap<string, string>,
  assertions?: SqlStatement[],
  source?: LiveNode,
): Promise<DavResourceState & { lastModified?: number }> {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return { tokens: new Set(), etag: null };
  }
  if (
    url.origin !== appOrigin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return { tokens: new Set(), etag: null };
  let path;
  try {
    path = parseDavPath(url.pathname);
  } catch {
    return { tokens: new Set(), etag: null };
  }
  const resolved = await resolveDavConditionPath(db, principal, path);
  if (!resolved) {
    assertions?.push(davConditionAbsentAssertion(principal, path));
    return { tokens: new Set(), etag: null };
  }
  const batches = await atomicBatch(db, [
    resolved.assertion,
    {
      sql: `SELECT n.id,n.kind,n.revision,n.current_blob_id,n.space_id,n.updated_at,sp.tree_generation
          FROM nodes n JOIN spaces sp ON sp.id=n.space_id
          WHERE n.id=? AND n.space_id=? AND n.deleted_at IS NULL`,
      values: [resolved.id, resolved.spaceId],
    },
    {
      sql: relevantLocks,
      values: [resolved.id, resolved.spaceId, resolved.spaceId, resolved.spaceId, principal.epoch],
    },
  ]).catch((error: unknown) => {
    if (assertions && classifyBatchFailure(error) === "rolled_back")
      throw new Error("dav_precondition_failed");
    throw error;
  });
  const node = batches[1]?.results[0] as StateRow | undefined;
  if (!node) return { tokens: new Set(), etag: null };
  const snapshot = (batches[2]?.results[0] as { snapshot: string }).snapshot;
  if (
    source &&
    (node.id !== source.id ||
      node.space_id !== source.space_id ||
      node.revision !== source.revision ||
      node.current_blob_id !== source.current_blob_id ||
      node.tree_generation !== source.tree_generation)
  )
    throw new Error("dav_precondition_failed");
  assertions?.push(
    resolved.assertion,
    assertExists(
      `SELECT 1 FROM nodes n JOIN spaces sp ON sp.id=n.space_id
      WHERE n.id=? AND n.space_id=? AND n.kind=? AND n.revision=? AND n.current_blob_id IS ?
        AND n.updated_at=? AND n.deleted_at IS NULL AND sp.tree_generation=?`,
      [
        node.id,
        node.space_id,
        node.kind,
        node.revision,
        node.current_blob_id,
        node.updated_at,
        node.tree_generation,
      ],
    ),
    assertExists(`SELECT 1 FROM (${relevantLocks}) WHERE snapshot=?`, [
      resolved.id,
      resolved.spaceId,
      resolved.spaceId,
      resolved.spaceId,
      principal.epoch,
      snapshot,
    ]),
  );
  const tokens = new Set<string>();
  for (const row of JSON.parse(snapshot) as LockRow[]) {
    const token = tokenByHash.get(row.token_hash);
    if (token) tokens.add(token);
  }
  return { tokens, etag: davEtag(node), lastModified: node.updated_at };
}

const relevantLocks = `WITH RECURSIVE a(id,parent_id,depth) AS (
  SELECT id,parent_id,0 FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
  UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN a ON n.id=a.parent_id
    WHERE a.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
) SELECT json_group_array(json_object('token_hash',token_hash,'node',node_id,'depth',depth,
  'creator',creator_credential_id,'expires',expires_at,'epoch',epoch)) AS snapshot FROM (
  SELECT l.* FROM a JOIN locks l ON l.node_id=a.id
  WHERE l.space_id=? AND l.epoch=? AND l.expires_at>strftime('%s','now')*1000
    AND (a.depth=0 OR l.depth='infinity') ORDER BY l.token_hash
)`;

export interface DavMutationConditions {
  readonly sourceNodeId: string;
  readonly spaceId: string;
}
const mutationProofs = new WeakMap<
  DavMutationConditions,
  {
    readonly principal: string;
    readonly assertions: readonly SqlStatement[];
  }
>();

function conditionPrincipal(principal: Principal): string {
  return JSON.stringify([
    principal.kind,
    principal.credential_id,
    "user_id" in principal ? principal.user_id : null,
    principal.epoch,
    principalAuthorizationContext(principal),
  ]);
}

/** A conditional snapshot only adds restrictions; it never replaces service authorization. */
export async function evaluateDavMutationConditions(
  db: D1Database,
  principal: Principal,
  appOrigin: string,
  request: Request,
  source: LiveNode,
  mutationPrincipal: Principal,
): Promise<{ lockTokens: readonly string[]; conditions: DavMutationConditions }> {
  const header = parseDavIfHeader(request.headers.get("If"));
  const submitted = header?.submittedTokens ?? [];
  if (submitted.length > 16) throw new Error("invalid_dav_if");
  const tokenByHash = new Map(
    await Promise.all(
      submitted.map(async (token) => [(await lockTokenHashes([token]))[0]!, token] as const),
    ),
  );
  const assertions: SqlStatement[] = [];
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  const state = await resourceState(
    db,
    principal,
    appOrigin,
    url.href,
    tokenByHash,
    assertions,
    source,
  );
  if (state.etag === null) throw new Error("dav_precondition_failed");
  evaluateDavHttpPreconditions(request.headers, state.etag, state.lastModified);
  const cache = new Map([[url.href, state]]);
  if (
    !(await evaluateDavIf(header, url.href, async (resource) => {
      let current = cache.get(resource);
      if (!current) {
        current = await resourceState(db, principal, appOrigin, resource, tokenByHash, assertions);
        cache.set(resource, current);
      }
      return current;
    }))
  )
    throw new Error("dav_precondition_failed");
  const conditions = Object.freeze({ sourceNodeId: source.id, spaceId: source.space_id });
  mutationProofs.set(conditions, { principal: conditionPrincipal(mutationPrincipal), assertions });
  return { lockTokens: submitted, conditions };
}

function conditionAssertions(
  conditions: DavMutationConditions | undefined,
  principal: Principal,
  nodeId: string,
  spaceId: string,
): readonly SqlStatement[] {
  if (!conditions) return [];
  const proof = mutationProofs.get(conditions);
  if (
    !proof ||
    proof.principal !== conditionPrincipal(principal) ||
    conditions.sourceNodeId !== nodeId ||
    conditions.spaceId !== spaceId
  )
    throw new Error("invalid_dav_condition_proof");
  return proof.assertions;
}

export async function assertDavMutationConditions(
  db: D1Database,
  conditions: DavMutationConditions | undefined,
  principal: Principal,
  nodeId: string,
  spaceId: string,
): Promise<void> {
  const assertions = conditionAssertions(conditions, principal, nodeId, spaceId);
  if (!assertions.length) return;
  try {
    await atomicBatch(db, assertions);
  } catch (error) {
    if (classifyBatchFailure(error) === "rolled_back") throw new Error("dav_precondition_failed");
    throw error;
  }
}

export async function commitDavMutation(
  db: D1Database,
  claim: OperationClaim,
  statements: readonly SqlStatement[],
  conditions: DavMutationConditions | undefined,
  principal: Principal,
  nodeId: string,
  spaceId: string,
): Promise<MutationOutcome> {
  const outcome = await commitMutationStatements(db, claim, [
    ...conditionAssertions(conditions, principal, nodeId, spaceId),
    ...statements,
  ]);
  if (
    outcome.kind === "terminal" &&
    outcome.operation.state === "failed" &&
    outcome.operation.errorCode === "mutation_rejected"
  ) {
    try {
      await assertDavMutationConditions(db, conditions, principal, nodeId, spaceId);
    } catch (error) {
      if (error instanceof Error && error.message === "dav_precondition_failed")
        return {
          kind: "terminal",
          operation: { ...outcome.operation, errorCode: "dav_precondition_failed" },
        };
      throw error;
    }
  }
  return outcome;
}

/** Parse and evaluate If against bounded current DAV state, returning submitted lock tokens. */
export async function evaluateDavRequestIf(
  db: D1Database,
  principal: Principal,
  appOrigin: string,
  request: Request,
): Promise<readonly string[]> {
  const header = parseDavIfHeader(request.headers.get("If"));
  if (!header) return [];
  if (header.submittedTokens.length > 16) throw new Error("invalid_dav_if");
  const tokenByHash = new Map(
    await Promise.all(
      header.submittedTokens.map(
        async (token) => [(await lockTokenHashes([token]))[0]!, token] as const,
      ),
    ),
  );
  const requestUrl = new URL(request.url);
  requestUrl.search = "";
  requestUrl.hash = "";
  const matches = await evaluateDavIf(header, requestUrl.href, (resource) =>
    resourceState(db, principal, appOrigin, resource, tokenByHash),
  );
  if (!matches) throw new Error("dav_precondition_failed");
  return header.submittedTokens;
}
