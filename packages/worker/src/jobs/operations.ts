import type { Operation } from "@next-cloud-flare/shared/contracts";
import {
  type AuthorizedNode,
  authorizeNode,
  type Principal,
  principalAuthorizationContext,
} from "../auth/authorize";
import { assertOpenPermit, type Permit } from "../db/permits";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import {
  authorizeOperationLookup,
  claimAuthorityAssertions,
  operationAuthorityPlan,
} from "./operationAuthority";
import { validateOutboxContract } from "./outboxContract";

export interface OperationIntent {
  readonly id: string;
  readonly principal: Principal;
  readonly principalId: string;
  readonly spaceId: string;
  readonly kind: Operation;
  readonly digest: string;
  readonly operands: string;
}
export interface OperationRow {
  op_id: string;
  principal_kind: Principal["kind"];
  principal_id: string;
  credential_id: string;
  credential_version: number | null;
  authorization_context: string | null;
  space_id: string;
  kind: Operation;
  state: "claimed" | "committed" | "failed";
  request_digest: string;
  epoch: number;
  permit_id: string;
  permit_expires_at: number;
  expected_steps: number;
  operands_json: string;
  result_json: string | null;
  error_code: string | null;
}
export interface OperationClaim {
  readonly intent: OperationIntent;
  readonly permit: Permit;
  readonly steps: number;
}

function canonicalJson(value: unknown, limit = 16_384): string {
  let visited = 0;
  const ancestors = new Set<object>();
  const normalize = (input: unknown, depth = 0): unknown => {
    if (++visited > 8192 || depth > 32) throw new Error("intent_too_large");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isSafeInteger(input)) return input;
    if (input && typeof input === "object") {
      if (ancestors.has(input)) throw new Error("invalid_intent_value");
      ancestors.add(input);
      let normalized: unknown;
      if (Array.isArray(input)) normalized = input.map((item) => normalize(item, depth + 1));
      else if (Object.getPrototypeOf(input) === Object.prototype)
        normalized = Object.fromEntries(
          Object.entries(input)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, normalize(item, depth + 1)]),
        );
      else throw new Error("invalid_intent_value");
      ancestors.delete(input);
      return normalized;
    }
    throw new Error("invalid_intent_value");
  };
  const encoded = JSON.stringify(normalize(value));
  if (new TextEncoder().encode(encoded).byteLength > limit) throw new Error("intent_too_large");
  return encoded;
}

export async function digestJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function principalId(principal: Principal): string {
  return principal.kind === "link_share"
    ? principal.share_id
    : principal.kind === "service"
      ? principal.service_principal_id
      : principal.user_id;
}

/** The key selects a credential-local slot; the entire canonical intent is compared separately. */
export async function operationIntent(
  principal: Principal,
  key: string,
  spaceId: string,
  kind: Operation,
  body: unknown,
  operands: Record<string, string>,
): Promise<OperationIntent> {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new Error("invalid_idempotency_key");
  const actor = principalId(principal);
  const authorizationContext = principalAuthorizationContext(principal);
  const id = `op_${await digestJson(
    authorizationContext
      ? [principal.kind, actor, principal.credential_id, authorizationContext, key]
      : [principal.kind, actor, principal.credential_id, key],
  )}`;
  const digest = await digestJson(
    authorizationContext ? { spaceId, kind, authorizationContext, body } : { spaceId, kind, body },
  );
  const encoded = canonicalJson(operands, 8192);
  return Object.freeze({
    id,
    principal: Object.freeze({ ...principal }),
    principalId: actor,
    spaceId,
    kind,
    digest,
    operands: encoded,
  });
}

export async function operationRow(db: D1Database, id: string): Promise<OperationRow | null> {
  return primary(db)
    .prepare("SELECT * FROM operations WHERE op_id=?")
    .bind(id)
    .first<OperationRow>();
}

function sameIntent(row: OperationRow, intent: OperationIntent, steps: number): boolean {
  return (
    row.principal_kind === intent.principal.kind &&
    row.principal_id === intent.principalId &&
    row.credential_id === intent.principal.credential_id &&
    row.credential_version ===
      (intent.principal.kind === "link_share" ? intent.principal.share_version : null) &&
    row.authorization_context === principalAuthorizationContext(intent.principal) &&
    row.space_id === intent.spaceId &&
    row.kind === intent.kind &&
    row.request_digest === intent.digest &&
    row.epoch === intent.principal.epoch &&
    row.operands_json === intent.operands &&
    row.expected_steps === steps
  );
}

export async function findOperationIntent(
  db: D1Database,
  intent: OperationIntent,
  steps: number,
): Promise<OperationRow | null> {
  const row = await operationRow(db, intent.id);
  if (row && !sameIntent(row, intent, steps)) throw new Error("idempotency_conflict");
  return row;
}

export function assertOperationClaim(claim: OperationClaim): SqlStatement {
  const { intent, permit } = claim;
  return assertExists(
    `SELECT 1 FROM operations WHERE op_id=? AND state='claimed' AND credential_id=? AND credential_version IS ? AND authorization_context IS ? AND principal_kind=? AND principal_id=?
    AND space_id=? AND kind=? AND request_digest=? AND epoch=? AND permit_id=? AND permit_expires_at=? AND claimed_expires_at=? AND expected_steps=? AND operands_json=?`,
    [
      intent.id,
      intent.principal.credential_id,
      intent.principal.kind === "link_share" ? intent.principal.share_version : null,
      principalAuthorizationContext(intent.principal),
      intent.principal.kind,
      intent.principalId,
      intent.spaceId,
      intent.kind,
      intent.digest,
      permit.epoch,
      permit.permit_id,
      permit.expires_at,
      permit.expires_at,
      claim.steps,
      intent.operands,
    ],
  );
}

export function validateClaimAuthorization(
  intent: OperationIntent,
  permit: Permit,
  authorization: AuthorizedNode | readonly AuthorizedNode[],
  steps: number,
): readonly SqlStatement[] {
  const authorized = Array.isArray(authorization) ? authorization : [authorization];
  const plan = operationAuthorityPlan(intent.kind, intent.operands, "claimed");
  if (
    !plan ||
    authorized.some(
      (proof) =>
        proof.principal.kind !== intent.principal.kind ||
        principalId(proof.principal) !== intent.principalId ||
        proof.principal.credential_id !== intent.principal.credential_id ||
        proof.principal.epoch !== intent.principal.epoch ||
        principalAuthorizationContext(proof.principal) !==
          principalAuthorizationContext(intent.principal) ||
        (proof.principal.kind === "link_share" &&
          intent.principal.kind === "link_share" &&
          proof.principal.share_version !== intent.principal.share_version),
    ) ||
    principalId(intent.principal) !== intent.principalId ||
    permit.space_id !== intent.spaceId ||
    permit.epoch !== intent.principal.epoch ||
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 1000
  )
    throw new Error("invalid_operation_claim");
  return claimAuthorityAssertions(plan, authorized, intent.spaceId);
}

/** A claim is not a namespace commit. Resume is restricted to the same permit. */
export async function claimOperation(
  db: D1Database,
  intent: OperationIntent,
  permit: Permit,
  authorized: AuthorizedNode | readonly AuthorizedNode[],
  steps: number,
): Promise<{ kind: "claimed"; claim: OperationClaim } | { kind: "terminal"; row: OperationRow }> {
  const authority = validateClaimAuthorization(intent, permit, authorized, steps);
  const claim: OperationClaim = Object.freeze({ intent, permit, steps });
  const existing = await findOperationIntent(db, intent, steps);
  if (existing && existing.state !== "claimed") {
    await atomicBatch(db, authority);
    return { kind: "terminal", row: existing };
  }
  try {
    await atomicBatch(db, [
      assertOpenPermit(permit),
      ...authority,
      {
        sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,authorization_context,space_id,kind,state,request_digest,epoch,
          permit_id,permit_expires_at,claimed_expires_at,expected_steps,operands_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'claimed',?,?,?,?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000) ON CONFLICT(op_id) DO NOTHING`,
        values: [
          intent.id,
          intent.principal.kind,
          intent.principalId,
          intent.principal.credential_id,
          intent.principal.kind === "link_share" ? intent.principal.share_version : null,
          principalAuthorizationContext(intent.principal),
          intent.spaceId,
          intent.kind,
          intent.digest,
          permit.epoch,
          permit.permit_id,
          permit.expires_at,
          permit.expires_at,
          steps,
          intent.operands,
        ],
      },
      assertOperationClaim(claim),
    ]);
  } catch (error) {
    const current = await operationRow(db, intent.id);
    if (current && !sameIntent(current, intent, steps)) throw new Error("idempotency_conflict");
    if (current?.state === "claimed" && current.permit_id === permit.permit_id) {
      await atomicBatch(db, [assertOpenPermit(permit), ...authority, assertOperationClaim(claim)]);
      return { kind: "claimed", claim };
    }
    if (current && current.state !== "claimed") {
      await atomicBatch(db, authority);
      return { kind: "terminal", row: current };
    }
    throw error;
  }
  return { kind: "claimed", claim };
}

export interface VisibleOperation {
  id: string;
  state: OperationRow["state"];
  errorCode: string | null;
  result: { status: number; nodeId?: string; revision?: number } | null;
  job?: {
    id: string;
    state: "pending" | "running" | "completed" | "failed" | "cancelled";
    processed: number;
    total: number | null;
  };
}

/** R6 operation lookup uses the exact initiating credential, then current original-operand authorization. */
export async function lookupOperation(
  db: D1Database,
  principal: Principal,
  id: string,
): Promise<VisibleOperation | null> {
  const row = await operationRow(db, id);
  let authorizedPrincipal = principal;
  if (
    row?.authorization_context &&
    principal.kind === "app_password" &&
    !principal.internal_share
  ) {
    try {
      authorizedPrincipal = Object.freeze({
        ...principal,
        internal_share: JSON.parse(row.authorization_context) as NonNullable<
          Extract<Principal, { kind: "app_password" }>["internal_share"]
        >,
      });
    } catch {
      return null;
    }
  }
  if (
    !row ||
    row.credential_id !== principal.credential_id ||
    row.principal_kind !== principal.kind ||
    row.principal_id !== principalId(principal) ||
    row.epoch !== principal.epoch ||
    row.credential_version !== (principal.kind === "link_share" ? principal.share_version : null) ||
    row.authorization_context !== principalAuthorizationContext(authorizedPrincipal)
  )
    return null;
  try {
    const plan = operationAuthorityPlan(row.kind, row.operands_json, row.state);
    if (!plan) return null;
    if (row.state !== "committed" && row.result_json !== null) return null;
    let terminalResult: { status: number; nodeId: string; revision?: number } | null = null;
    if (row.state === "committed") {
      if (!row.result_json) return null;
      if (plan.terminalResult === "proppatch") {
        const result = JSON.parse(row.result_json) as Record<string, unknown>;
        if (result.status !== 207 || result.nodeId !== plan.operands.nodeId) return null;
        terminalResult = { status: 207, nodeId: plan.operands.nodeId! };
      } else {
        const events = await primary(db)
          .prepare(
            `SELECT b.kind,b.payload_ref,o.kind AS op_kind,o.operands_json,o.result_json
              FROM outbox b JOIN operations o ON o.op_id=b.op_id
              WHERE b.op_id=? AND EXISTS(
                SELECT 1 FROM operation_steps s WHERE s.op_id=b.op_id
                  AND s.kind='node' AND s.affected_id=b.payload_ref
              )`,
          )
          .bind(row.op_id)
          .all<{
            kind: string;
            payload_ref: string;
            op_kind: string;
            operands_json: string;
            result_json: string | null;
          }>();
        if (events.results.length !== 1) return null;
        const contract = validateOutboxContract(events.results[0]!);
        if (!contract) return null;
        terminalResult = contract.result;
      }
    }
    await authorizeOperationLookup(db, authorizedPrincipal, row, plan);
    let visible: VisibleOperation["result"] = terminalResult
      ? { status: terminalResult.status }
      : null;
    if (terminalResult) {
      try {
        const proof = await authorizeNode(db, authorizedPrincipal, {
          operation: plan.resultAuthority,
          nodeId: terminalResult.nodeId,
          spaceId: row.space_id,
        });
        if (proof.operation !== "node.create")
          visible = {
            status: terminalResult.status,
            nodeId: proof.node.id,
            revision: proof.node.revision,
          };
      } catch {
        /* Status is visible; a purged or newly restricted node is not disclosed. */
      }
    }
    const errorCode =
      row.error_code === null
        ? null
        : [
              "permit_expired",
              "permit_revoked",
              "stale_epoch",
              "mutation_rejected",
              "name_conflict",
              "blob_unrecoverable",
              "tree_too_large",
              "queue_exhausted",
              "quota_exceeded",
            ].includes(row.error_code)
          ? row.error_code
          : "operation_failed";
    const job = await primary(db)
      .prepare(`SELECT id,state,node_count,
        CASE WHEN json_extract(checkpoint,'$.phase') IN ('finalize','completed')
          THEN node_count ELSE NULL END AS total
        FROM bulk_jobs WHERE op_id=? AND kind IN ('node.trash','node.restore','node.purge')`)
      .bind(row.op_id)
      .first<{
        id: string;
        state: "pending" | "running" | "completed" | "failed" | "cancelled";
        node_count: number;
        total: number | null;
      }>();
    return {
      id: row.op_id,
      state: row.state,
      errorCode,
      result: visible,
      ...(job
        ? {
            job: {
              id: job.id,
              state: job.state,
              processed: job.node_count,
              total: job.total,
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}
