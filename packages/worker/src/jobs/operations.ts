import type { Operation } from "@next-cloud-flare/shared/contracts";
import type { SelectedShare } from "../../../shared/src/shares";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import {
  freezePrincipal,
  principalSelection,
  type SelectedShareRecord,
  storedPrincipal,
} from "../auth/selectedShare";
import {
  destinationPrincipal,
  sameDestination,
  storedDestination,
  type TransferDestination,
  type TransferDestinationRecord,
  transferDestination,
} from "../auth/transferScope";
import { assertOpenPermit, type Permit } from "../db/permits";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";

import { copyPublicationAuthority } from "./copyPublicationAuthority";
import { verifyCopyRetry } from "./copyRetryProof";

export interface OperationIntent {
  readonly id: string;
  readonly principal: Principal;
  readonly principalId: string;
  readonly spaceId: string;
  readonly kind: Operation;
  readonly digest: string;
  readonly operands: string;
  readonly destination?: TransferDestination;
}
export interface OperationRow extends SelectedShareRecord, TransferDestinationRecord {
  op_id: string;
  principal_kind: Principal["kind"];
  principal_id: string;
  credential_id: string;
  credential_version: number | null;
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

/** Preserve legacy digests while binding selected writes to one share version. */
export function operationDigest(
  spaceId: string,
  kind: Operation,
  body: unknown,
  share?: SelectedShare,
  destination?: TransferDestination,
) {
  return digestJson({
    spaceId,
    kind,
    body,
    ...(share ? { share } : {}),
    ...(destination ? { destination } : {}),
  });
}

/** The key selects a credential-local slot; the entire canonical intent is compared separately. */
export async function operationIntent(
  principal: Principal,
  key: string,
  spaceId: string,
  kind: Operation,
  body: unknown,
  operands: Record<string, string>,
  destination?: TransferDestination,
): Promise<OperationIntent> {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new Error("invalid_idempotency_key");
  principal = freezePrincipal(principal);
  destination = transferDestination(destination);
  if (kind === "copy.enqueue" && !destination) throw new Error("invalid_transfer_scope");
  if (
    destination &&
    (!["node.copy", "node.move", "dav.copy", "dav.move", "copy.enqueue"].includes(kind) ||
      !["user", "app_password"].includes(principal.kind) ||
      (kind !== "copy.enqueue" && destination.spaceId !== spaceId) ||
      (kind === "copy.enqueue" && (principal.kind !== "user" || destination.spaceId === spaceId)))
  )
    throw new Error("invalid_transfer_scope");
  const actor = principalId(principal);
  const id = `op_${await digestJson([principal.kind, actor, principal.credential_id, key])}`;
  const digest = await operationDigest(
    spaceId,
    kind,
    body,
    principalSelection(principal),
    destination,
  );
  const encoded = canonicalJson(operands, 8192);
  return Object.freeze({
    id,
    principal,
    principalId: actor,
    spaceId,
    kind,
    digest,
    operands: encoded,
    ...(destination ? { destination } : {}),
  });
}

export async function operationRow(db: D1Database, id: string): Promise<OperationRow | null> {
  return primary(db)
    .prepare("SELECT * FROM operations WHERE op_id=?")
    .bind(id)
    .first<OperationRow>();
}

function sameIntent(row: OperationRow, intent: OperationIntent, steps: number): boolean {
  const share = principalSelection(intent.principal);
  return (
    sameDestination(row, intent.destination) &&
    row.selected_share_id === (share?.id ?? null) &&
    row.selected_share_version === (share?.version ?? null) &&
    row.principal_kind === intent.principal.kind &&
    row.principal_id === intent.principalId &&
    row.credential_id === intent.principal.credential_id &&
    row.credential_version ===
      (intent.principal.kind === "link_share" ? intent.principal.share_version : null) &&
    row.space_id === intent.spaceId &&
    row.kind === intent.kind &&
    row.request_digest === intent.digest &&
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
  const share = principalSelection(intent.principal);
  return assertExists(
    `SELECT 1 FROM operations WHERE op_id=? AND state='claimed' AND credential_id=? AND credential_version IS ? AND principal_kind=? AND principal_id=?
    AND space_id=? AND kind=? AND request_digest=? AND epoch=? AND permit_id=? AND permit_expires_at=? AND claimed_expires_at=? AND expected_steps=? AND operands_json=?
    AND selected_share_id IS ? AND selected_share_version IS ?
    AND destination_space_id IS ? AND destination_share_id IS ? AND destination_share_version IS ?`,
    [
      intent.id,
      intent.principal.credential_id,
      intent.principal.kind === "link_share" ? intent.principal.share_version : null,
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
      share?.id ?? null,
      share?.version ?? null,
      intent.destination?.spaceId ?? null,
      intent.destination?.share?.id ?? null,
      intent.destination?.share?.version ?? null,
    ],
  );
}

export function validateClaimAuthorization(
  intent: OperationIntent,
  permit: Permit,
  authorized: AuthorizedNode,
  steps: number,
): SqlStatement {
  const selected = principalSelection(intent.principal);
  const proved = principalSelection(authorized.principal);
  const operands = JSON.parse(intent.operands) as {
    parentId?: unknown;
    overwriteTargetId?: unknown;
    sourceNodeId?: unknown;
    sourceParentId?: unknown;
    nodeId?: unknown;
    blobId?: unknown;
  };
  const create = [
    "node.create",
    "dav.mkcol",
    "dav.lock",
    "dav.put",
    "upload.complete",
    "copy.publish",
  ].includes(intent.kind);
  const contentWrite =
    ["dav.put", "upload.complete"].includes(intent.kind) &&
    authorized.operation === "node.content.write";
  const trash = ["node.trash", "dav.delete"].includes(intent.kind);
  const move = ["node.move", "dav.move"].includes(intent.kind);
  const copy = ["node.copy", "dav.copy", "copy.enqueue"].includes(intent.kind);
  const restore = intent.kind === "node.restore";
  const purge = intent.kind === "node.purge";
  const targetMatches =
    (intent.kind === "thumbnail.request" &&
      authorized.operation === "gallery.read" &&
      authorized.node.id === operands.nodeId &&
      authorized.node.parent_id === operands.parentId &&
      authorized.node.current_blob_id === operands.blobId &&
      authorized.node.space_id === intent.spaceId) ||
    (create &&
      authorized.operation === "node.create" &&
      authorized.parent.id === operands.parentId &&
      authorized.spaceId === intent.spaceId) ||
    (contentWrite &&
      authorized.node.id === operands.nodeId &&
      authorized.parentId === operands.parentId &&
      authorized.node.space_id === intent.spaceId) ||
    (trash &&
      authorized.operation === "node.trash" &&
      authorized.node.id === operands.nodeId &&
      authorized.parentId === operands.parentId &&
      authorized.node.space_id === intent.spaceId) ||
    (move &&
      authorized.operation === "node.rename" &&
      authorized.node.id === operands.nodeId &&
      authorized.parentId === operands.sourceParentId &&
      authorized.node.space_id === intent.spaceId) ||
    (copy &&
      authorized.operation === "node.read" &&
      authorized.node.id === operands.sourceNodeId &&
      authorized.node.space_id === intent.spaceId) ||
    (restore &&
      authorized.operation === "node.create" &&
      authorized.parent.id === operands.parentId &&
      authorized.spaceId === intent.spaceId) ||
    (purge &&
      authorized.operation === "node.read" &&
      authorized.node.id === operands.parentId &&
      authorized.node.space_id === intent.spaceId) ||
    (intent.kind === "node.rename" &&
      authorized.operation === "node.rename" &&
      authorized.node.id === operands.nodeId &&
      authorized.parentId === operands.parentId &&
      authorized.node.space_id === intent.spaceId) ||
    (intent.kind === "audio.metadata.write" &&
      authorized.operation === "audio.metadata.write" &&
      authorized.node.id === operands.nodeId &&
      authorized.node.space_id === intent.spaceId &&
      authorized.node.current_blob_id === operands.blobId) ||
    (intent.kind === "dav.proppatch" &&
      authorized.operation === "node.props.write" &&
      authorized.node.id === operands.nodeId &&
      authorized.node.space_id === intent.spaceId);
  if (
    !targetMatches ||
    (intent.destination &&
      !selected &&
      ("node" in authorized ? authorized.node.owner_id : authorized.parent.owner_id) !==
        intent.principalId) ||
    selected?.id !== proved?.id ||
    selected?.version !== proved?.version ||
    authorized.principal.kind !== intent.principal.kind ||
    principalId(authorized.principal) !== intent.principalId ||
    principalId(intent.principal) !== intent.principalId ||
    authorized.principal.credential_id !== intent.principal.credential_id ||
    authorized.principal.epoch !== intent.principal.epoch ||
    (authorized.principal.kind === "link_share" &&
      intent.principal.kind === "link_share" &&
      authorized.principal.share_version !== intent.principal.share_version) ||
    permit.space_id !== intent.spaceId ||
    permit.epoch !== intent.principal.epoch ||
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 1000
  )
    throw new Error("invalid_operation_claim");
  // Validate the request-local proof before any operation read or write.
  return authorizationAssertion(authorized);
}

/** A claim is not a namespace commit. Resume is restricted to the same permit. */
export async function claimOperation(
  db: D1Database,
  intent: OperationIntent,
  permit: Permit,
  authorized: AuthorizedNode,
  steps: number,
  destinationProof?: AuthorizedNode,
): Promise<{ kind: "claimed"; claim: OperationClaim } | { kind: "terminal"; row: OperationRow }> {
  const authority = validateClaimAuthorization(intent, permit, authorized, steps);
  const share = principalSelection(intent.principal);
  const destinationAuthorities: SqlStatement[] = [];
  if (intent.destination) {
    const target = destinationPrincipal(intent.principal, intent.destination),
      selected = principalSelection(target);
    const proved = destinationProof ? principalSelection(destinationProof.principal) : undefined;
    if (
      !destinationProof ||
      destinationProof.operation !== "node.create" ||
      destinationProof.parent.id !== JSON.parse(intent.operands).parentId ||
      destinationProof.spaceId !== intent.destination.spaceId ||
      principalId(destinationProof.principal) !== intent.principalId ||
      destinationProof.principal.kind !== target.kind ||
      destinationProof.principal.credential_id !== target.credential_id ||
      destinationProof.principal.epoch !== target.epoch ||
      selected?.id !== proved?.id ||
      selected?.version !== proved?.version ||
      (!selected && destinationProof.parent.owner_id !== intent.principalId)
    )
      throw new Error("invalid_operation_claim");
    destinationAuthorities.push(authorizationAssertion(destinationProof));
  } else if (destinationProof) throw new Error("invalid_operation_claim");
  const claim: OperationClaim = Object.freeze({ intent, permit, steps });
  const existing = await findOperationIntent(db, intent, steps);
  if (existing && existing.state !== "claimed") {
    await atomicBatch(db, [authority, ...destinationAuthorities]);
    return { kind: "terminal", row: existing };
  }
  try {
    await atomicBatch(db, [
      assertOpenPermit(permit),
      authority,
      ...destinationAuthorities,
      {
        sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,
          permit_id,permit_expires_at,claimed_expires_at,expected_steps,operands_json,selected_share_id,selected_share_version,destination_space_id,destination_share_id,destination_share_version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'claimed',?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000) ON CONFLICT(op_id) DO NOTHING`,
        values: [
          intent.id,
          intent.principal.kind,
          intent.principalId,
          intent.principal.credential_id,
          intent.principal.kind === "link_share" ? intent.principal.share_version : null,
          intent.spaceId,
          intent.kind,
          intent.digest,
          permit.epoch,
          permit.permit_id,
          permit.expires_at,
          permit.expires_at,
          steps,
          intent.operands,
          share?.id ?? null,
          share?.version ?? null,
          intent.destination?.spaceId ?? null,
          intent.destination?.share?.id ?? null,
          intent.destination?.share?.version ?? null,
        ],
      },
      assertOperationClaim(claim),
    ]);
  } catch (error) {
    const current = await operationRow(db, intent.id);
    if (current && !sameIntent(current, intent, steps)) throw new Error("idempotency_conflict");
    if (current?.state === "claimed" && current.permit_id === permit.permit_id) {
      await atomicBatch(db, [
        assertOpenPermit(permit),
        authority,
        ...destinationAuthorities,
        assertOperationClaim(claim),
      ]);
      return { kind: "claimed", claim };
    }
    if (current && current.state !== "claimed") {
      await atomicBatch(db, [authority, ...destinationAuthorities]);
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
  result: { status: number; nodeId?: string; jobId?: string; revision?: number } | null;
}

/** R6 operation lookup uses the exact initiating credential, then current original-operand authorization. */
export async function lookupOperation(
  db: D1Database,
  principal: Principal,
  id: string,
): Promise<VisibleOperation | null> {
  const row = await operationRow(db, id);
  if (
    !row ||
    row.credential_id !== principal.credential_id ||
    row.principal_kind !== principal.kind ||
    row.principal_id !== principalId(principal) ||
    row.credential_version !== (principal.kind === "link_share" ? principal.share_version : null) ||
    (row.kind !== "node.create" &&
      row.kind !== "dav.mkcol" &&
      row.kind !== "dav.lock" &&
      row.kind !== "dav.put" &&
      row.kind !== "upload.complete" &&
      row.kind !== "dav.delete" &&
      row.kind !== "dav.copy" &&
      row.kind !== "dav.move" &&
      row.kind !== "node.copy" &&
      row.kind !== "copy.enqueue" &&
      row.kind !== "thumbnail.request" &&
      row.kind !== "copy.publish" &&
      row.kind !== "node.move" &&
      row.kind !== "node.trash" &&
      row.kind !== "node.restore" &&
      row.kind !== "node.purge" &&
      row.kind !== "node.rename" &&
      row.kind !== "audio.metadata.write" &&
      row.kind !== "dav.proppatch")
  )
    return null;
  try {
    principal = storedPrincipal(principal, row);
    const proofs: AuthorizedNode[] = [];
    const prove = async (p: Principal, r: Parameters<typeof authorizeNode>[2]) => {
      const proof = await authorizeNode(db, p, r);
      proofs.push(proof);
      return proof;
    };
    const destination = storedDestination(row);
    if (
      destination &&
      (!["node.copy", "node.move", "dav.copy", "dav.move", "copy.enqueue"].includes(row.kind) ||
        (row.kind !== "copy.enqueue" && destination.spaceId !== row.space_id))
    )
      return null;
    const targetPrincipal = destinationPrincipal(principal, destination);
    const sourceOwnerOnly = !!destination && !principalSelection(principal);
    const targetOwnerOnly = !!destination && !destination.share;
    const operands = JSON.parse(row.operands_json) as {
      parentId?: unknown;
      uploadId?: unknown;
      overwriteTargetId?: unknown;
      sourceNodeId?: unknown;
      sourceParentId?: unknown;
      nodeId?: unknown;
      blobId?: unknown;
    };
    const create = ["node.create", "dav.mkcol", "dav.lock", "copy.publish"].includes(row.kind);
    const publication =
      row.kind === "copy.publish" ? await copyPublicationAuthority(db, id, principal) : [];
    if (row.kind === "upload.complete") {
      if (typeof operands.uploadId !== "string" || typeof operands.parentId !== "string")
        return null;
      const bound = await primary(db)
        .prepare(`SELECT 1 FROM uploads WHERE id=? AND completion_op_id=?
        AND credential_id=? AND epoch=? AND space_id=? AND parent_id=? AND target_id IS ?
        AND selected_share_id IS ? AND selected_share_version IS ?
        AND link_share_id IS ? AND link_share_version IS ?
        AND (?<>'committed' OR state='completed')`)
        .bind(
          operands.uploadId,
          row.op_id,
          row.credential_id,
          row.epoch,
          row.space_id,
          operands.parentId,
          typeof operands.nodeId === "string" ? operands.nodeId : null,
          row.selected_share_id,
          row.selected_share_version,
          principal.kind === "link_share" ? principal.share_id : null,
          principal.kind === "link_share" ? principal.share_version : null,
          row.state,
        )
        .first();
      if (!bound) return null;
    }
    if (row.kind === "thumbnail.request") {
      if (
        typeof operands.nodeId !== "string" ||
        typeof operands.parentId !== "string" ||
        typeof operands.blobId !== "string"
      )
        return null;
      const proof = await prove(principal, {
        operation: "gallery.read",
        nodeId: operands.nodeId,
        spaceId: row.space_id,
      });
      if (
        proof.operation !== "gallery.read" ||
        proof.node.current_blob_id !== operands.blobId ||
        proof.node.parent_id !== operands.parentId
      )
        return null;
    } else if (row.kind === "dav.copy" || row.kind === "node.copy" || row.kind === "copy.enqueue") {
      if (typeof operands.sourceNodeId !== "string" || typeof operands.parentId !== "string")
        return null;
      await prove(principal, {
        ownerOnly: sourceOwnerOnly,
        operation: "node.read",
        nodeId: operands.sourceNodeId,
        spaceId: row.space_id,
      });
      await prove(targetPrincipal, {
        ownerOnly: targetOwnerOnly,
        operation: "node.create",
        parentId: operands.parentId,
        spaceId: destination?.spaceId ?? row.space_id,
      });
    } else if (
      create ||
      (row.kind === "node.restore" && row.state !== "committed") ||
      row.kind === "node.purge"
    ) {
      if (typeof operands.parentId !== "string") return null;
      if (row.kind === "node.purge")
        await prove(principal, {
          operation: "node.read",
          nodeId: operands.parentId,
          spaceId: row.space_id,
        });
      else
        await prove(principal, {
          operation: "node.create",
          parentId: operands.parentId,
          spaceId: row.space_id,
        });
      if (row.kind === "node.restore" || row.kind === "node.purge") {
        if (
          principal.kind !== "user" ||
          typeof (operands as { trashOpId?: unknown }).trashOpId !== "string"
        )
          return null;
        const visible = await primary(db)
          .prepare(
            `SELECT 1 AS ok FROM trash_ops WHERE op_id=? AND space_id=?
              AND EXISTS(SELECT 1 FROM spaces WHERE id=trash_ops.space_id AND owner_id=?)
              AND state IN ('trashed','purged')`,
          )
          .bind((operands as { trashOpId: string }).trashOpId, row.space_id, principal.user_id)
          .first<number>("ok");
        if (visible !== 1) return null;
      }
    } else if (["node.rename", "node.move", "dav.move", "node.restore"].includes(row.kind)) {
      if (typeof operands.parentId !== "string") return null;
      if (typeof operands.nodeId !== "string") return null;
      const authorized = await prove(
        destination && row.state === "committed" ? targetPrincipal : principal,
        {
          ownerOnly: destination && row.state === "committed" ? targetOwnerOnly : sourceOwnerOnly,
          operation: "node.rename",
          nodeId: operands.nodeId,
          spaceId: row.space_id,
        },
      );
      if (
        (principalSelection(principal) || destination) &&
        ["node.move", "dav.move"].includes(row.kind)
      ) {
        if (typeof operands.sourceParentId !== "string") return null;
        await prove(principal, {
          operation: "node.create",
          parentId: operands.sourceParentId,
          spaceId: row.space_id,
          ownerOnly: sourceOwnerOnly,
        });
        await prove(targetPrincipal, {
          operation: "node.create",
          parentId: operands.parentId,
          spaceId: row.space_id,
          ownerOnly: targetOwnerOnly,
        });
      }
      const expectedParent =
        ["node.move", "dav.move"].includes(row.kind) && row.state !== "committed"
          ? operands.sourceParentId
          : operands.parentId;
      if (authorized.operation !== "node.rename" || authorized.parentId !== expectedParent)
        return null;
    } else if (row.kind === "dav.delete" || row.kind === "node.trash") {
      if (typeof operands.parentId !== "string" || typeof operands.nodeId !== "string") return null;
      await prove(principal, {
        operation: principal.kind === "link_share" ? "node.props.write" : "node.read",
        nodeId: operands.parentId,
        spaceId: row.space_id,
      });
      if (principal.kind === "link_share") {
        if (row.kind !== "node.trash") return null;
        if (row.state === "committed")
          publication.push(
            assertExists(
              "SELECT 1 FROM trash_ops WHERE op_id=? AND actor_id IS NULL AND space_id=? AND root_node_id=? AND epoch=? AND reason='node.trash'",
              [row.op_id, row.space_id, operands.nodeId, row.epoch],
            ),
          );
        else
          await prove(principal, {
            operation: "node.trash",
            nodeId: operands.nodeId,
            spaceId: row.space_id,
          });
      }
    } else if (row.kind === "dav.put" || row.kind === "upload.complete") {
      if (typeof operands.nodeId === "string") {
        const authorized = await prove(principal, {
          operation: "node.content.write",
          upload: row.kind === "upload.complete",
          nodeId: operands.nodeId,
          spaceId: row.space_id,
        });
        if (
          authorized.operation !== "node.content.write" ||
          authorized.parentId !== operands.parentId
        )
          return null;
      } else {
        if (typeof operands.parentId !== "string") return null;
        await prove(principal, {
          operation: "node.create",
          parentId: operands.parentId,
          spaceId: row.space_id,
          upload: row.kind === "upload.complete",
        });
      }
    } else if (row.kind === "audio.metadata.write") {
      if (typeof operands.nodeId !== "string" || typeof operands.blobId !== "string") return null;
      const authorized = await prove(principal, {
        operation: "audio.metadata.write",
        nodeId: operands.nodeId,
        spaceId: row.space_id,
      });
      if (!("node" in authorized) || authorized.node.current_blob_id !== operands.blobId)
        return null;
    } else {
      if (typeof operands.nodeId !== "string") return null;
      await prove(principal, {
        operation: "node.props.write",
        nodeId: operands.nodeId,
        spaceId: row.space_id,
      });
    }
    const result =
      row.state === "committed" && row.result_json
        ? (JSON.parse(row.result_json) as { status: number; nodeId?: string; jobId?: string })
        : null;
    const expectedStatus =
      row.kind === "copy.enqueue" || row.kind === "thumbnail.request"
        ? 202
        : row.kind === "dav.put" || row.kind === "upload.complete"
          ? typeof operands.nodeId === "string"
            ? 204
            : 201
          : row.kind === "dav.delete" || row.kind === "node.trash"
            ? 204
            : row.kind === "node.restore"
              ? 200
              : row.kind === "node.purge"
                ? 200
                : ["node.move", "dav.move"].includes(row.kind)
                  ? typeof operands.overwriteTargetId === "string"
                    ? 204
                    : 201
                  : ["node.copy", "dav.copy", "copy.publish"].includes(row.kind)
                    ? typeof operands.overwriteTargetId === "string"
                      ? 204
                      : 201
                    : create
                      ? 201
                      : row.kind === "dav.proppatch"
                        ? 207
                        : 200;
    if (result && result.status !== expectedStatus) return null;
    if (
      result &&
      [
        "node.rename",
        "node.move",
        "dav.move",
        "thumbnail.request",
        "audio.metadata.write",
      ].includes(row.kind) &&
      result.nodeId !== operands.nodeId
    )
      return null;
    let visible: VisibleOperation["result"] = result ? { status: result.status } : null;
    if (row.kind === "copy.enqueue") {
      if (!destination || row.principal_kind !== "user" || destination.spaceId === row.space_id)
        return null;
      if (result && Object.hasOwn(operands, "retryOf") && !(await verifyCopyRetry(db, row.op_id)))
        return null;
      if (result) {
        const jobId = "copy_" + row.op_id.slice(3);
        if (result.jobId !== jobId || result.nodeId !== undefined) return null;
        const bound = assertExists(
          "SELECT 1 FROM bulk_jobs j JOIN spaces s ON s.id=? JOIN copy_job_manifests m ON m.job_id=j.id WHERE j.id=? AND j.op_id=? AND j.kind='node.copy' AND j.owner_id=s.owner_id AND j.credential_id=? AND j.epoch=?",
          [destination.spaceId, jobId, row.op_id, row.credential_id, row.epoch],
        );
        await atomicBatch(db, [...proofs.map(authorizationAssertion), bound]);
        visible = { status: 202, jobId };
      }
    }
    if (result && typeof result.nodeId === "string") {
      try {
        const proof = await prove(targetPrincipal, {
          ownerOnly: targetOwnerOnly,
          operation: "node.read",
          nodeId: result.nodeId,
          spaceId: row.space_id,
        });
        if (proof.operation !== "node.create")
          visible = { status: result.status, nodeId: proof.node.id, revision: proof.node.revision };
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
              "quota_exceeded",
            ].includes(row.error_code)
          ? row.error_code
          : "operation_failed";
    if (destination || publication.length)
      await atomicBatch(db, [...proofs.map(authorizationAssertion), ...publication]);
    return { id: row.op_id, state: row.state, errorCode, result: visible };
  } catch {
    return null;
  }
}
