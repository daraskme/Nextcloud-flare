import {
  type AuthorizedNode,
  authorizationBatchAssertions,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { type ContentPurpose } from "../auth/contentSession";
import { type ContentTokens } from "../auth/contentTokens";
import { shareCoverageAssertion, shareCoverageBatchAssertions } from "../auth/shareCoverage";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { prepareAuthorizedNodeBlobRead } from "./blobRead";
import { ensureContentBudget } from "./contentBudget";
import { stageTargetManifest, type TargetEntry, type TargetManifestRecord } from "./targetManifest";

export interface ContentTicketTarget {
  readonly spaceId: string;
  readonly nodeId: string;
}

export interface IssuedContentTicket {
  readonly ticket: string;
  readonly ticketId: string;
  readonly targetSetId: string;
  readonly budgetId: string;
  readonly expiresAt: number;
}

function identity(principal: Principal, share?: { readonly id: string; readonly version: number }) {
  return {
    userId: principal.kind === "link_share" ? null : principal.user_id,
    shareId: principal.kind === "link_share" ? principal.share_id : (share?.id ?? null),
    shareVersion:
      principal.kind === "link_share" ? principal.share_version : (share?.version ?? null),
    unlockId:
      principal.kind === "link_share" && principal.credential_id.startsWith("ss:")
        ? principal.credential_id.slice(3)
        : null,
  };
}

function budgetAndShareAssertion(
  principal: Principal,
  ownerId: string,
  budgetId: string,
  expiresAt: number,
  share?: { readonly id: string; readonly version: number },
) {
  const { userId, shareId, shareVersion, unlockId } = identity(principal, share);
  return assertExists(
    `SELECT 1 FROM budgets b JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=b.epoch
      WHERE b.id=? AND b.owner_id=? AND b.user_id IS ? AND b.share_id IS ?
        AND b.unlock_session_id IS ? AND b.epoch=? AND b.state='active'
        AND b.expires_at>=? AND ctl.maintenance=0
        AND ((?='user' AND EXISTS(
          SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
          WHERE c.id=? AND c.kind='access' AND s.kind='access' AND s.user_id=?
            AND s.epoch=b.epoch AND s.revoked_at IS NULL AND s.expires_at>=?))
          OR (?='app_password' AND EXISTS(
            SELECT 1 FROM credentials c JOIN app_passwords ap ON ap.id=c.app_password_id
            WHERE c.id=? AND c.kind='app_password' AND ap.user_id=?
              AND ap.revoked_at IS NULL AND ap.expires_at>=?))
          OR ?='link_share')
        AND (? IS NULL OR EXISTS(
          SELECT 1 FROM shares sh JOIN users owner ON owner.id=sh.owner_id
            WHERE sh.id=? AND sh.owner_id=b.owner_id AND sh.version=?
              AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL
              AND (sh.expires_at IS NULL OR sh.expires_at>=?)
              AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')
              AND ((? IS NOT NULL AND sh.kind='internal' AND EXISTS(
                SELECT 1 FROM share_grants g WHERE g.share_id=sh.id AND g.user_id=?
                  AND g.version=sh.version AND g.disabled_at IS NULL))
                OR (? IS NULL AND sh.kind='link' AND EXISTS(
                  SELECT 1 FROM credentials c JOIN share_sessions ss ON ss.id=c.share_session_id
                  WHERE c.id=? AND c.kind='share' AND ss.id=? AND ss.share_id=sh.id
                    AND ss.share_version=sh.version AND ss.epoch=b.epoch
                    AND ss.revoked_at IS NULL AND ss.expires_at>=?)))))`,
    [
      budgetId,
      ownerId,
      userId,
      shareId,
      unlockId,
      principal.epoch,
      expiresAt,
      principal.kind,
      principal.credential_id,
      userId,
      expiresAt,
      principal.kind,
      principal.credential_id,
      userId,
      expiresAt,
      principal.kind,
      shareId,
      shareId,
      shareVersion,
      expiresAt,
      userId,
      userId,
      userId,
      principal.credential_id,
      unlockId,
      expiresAt,
    ],
  );
}

/** Issue a purpose-bound ticket only after every target is current and its manifest is readable. */
export async function issueContentTicket(
  db: D1Database,
  bucket: R2Bucket,
  tokens: ContentTokens,
  principal: Principal,
  targets: readonly ContentTicketTarget[],
  purpose: ContentPurpose,
  expiresAt: number,
  share?: { readonly id: string; readonly version: number },
): Promise<IssuedContentTicket> {
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  const exp = Math.floor(expiresAt / 1000);
  if (
    principal.kind === "service" ||
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.length > 1_000 ||
    !["content", "thumb", "page", "zip", "track"].includes(purpose) ||
    !Number.isSafeInteger(expiresAt) ||
    exp <= iat ||
    expiresAt > now + 600_000 ||
    (share !== undefined && principal.kind === "link_share")
  )
    throw new Error("invalid_content_ticket_request");
  const selectedShare =
    principal.kind === "link_share"
      ? { id: principal.share_id, version: principal.share_version }
      : share;
  const proofs: (AuthorizedNode & { readonly operation: "node.read" })[] = [];
  const entries: TargetEntry[] = [];
  let ownerId: string | null = null;
  for (const target of targets) {
    const proof = await authorizeNode(db, principal, {
      operation: "node.read",
      spaceId: target.spaceId,
      nodeId: target.nodeId,
    });
    if (
      proof.operation !== "node.read" ||
      proof.node.kind !== "file" ||
      !proof.node.current_blob_id
    )
      throw new Error("content_ticket_target_unavailable");
    if (ownerId !== null && ownerId !== proof.node.owner_id)
      throw new Error("content_ticket_mixed_owners");
    ownerId = proof.node.owner_id;
    if (selectedShare) await atomicBatch(db, [shareCoverageAssertion(proof.node, selectedShare)]);
    const blob = await prepareAuthorizedNodeBlobRead(db, proof);
    const object = await bucket.head(blob.key);
    if (!object || object.size !== blob.size || object.etag !== blob.r2Etag)
      throw new Error("content_ticket_blob_unavailable");
    proofs.push(proof as AuthorizedNode & { readonly operation: "node.read" });
    entries.push({
      spaceId: proof.node.space_id,
      nodeId: proof.node.id,
      blobId: proof.node.current_blob_id,
      purpose,
      size: blob.size,
    });
  }
  const first = proofs[0];
  if (!first || !ownerId) throw new Error("invalid_content_ticket_request");
  const budget = await ensureContentBudget(db, first, expiresAt, share);
  const record = await stageTargetManifest(bucket, entries);
  const ticketId = crypto.randomUUID();
  const claims = {
    ticket_id: ticketId,
    credential_id: principal.credential_id,
    target_set_id: record.id,
    target_set_hash: record.hash,
    budget_id: budget.id,
    purpose,
    epoch: principal.epoch,
    user_id: identity(principal, share).userId,
    share_id: identity(principal, share).shareId,
    share_version: identity(principal, share).shareVersion,
    iat,
    exp,
  };
  const result = Object.freeze({
    ticketId,
    targetSetId: record.id,
    budgetId: budget.id,
    expiresAt: exp * 1000,
  });
  let signed: string | undefined;
  try {
    signed = await tokens.issueTicket(claims);
    await atomicBatch(db, [
      ...authorizationBatchAssertions(proofs),
      ...(selectedShare
        ? shareCoverageBatchAssertions(
            proofs.map((proof) => proof.node),
            selectedShare,
          )
        : []),
      budgetAndShareAssertion(principal, ownerId, budget.id, result.expiresAt, share),
      {
        sql: `INSERT INTO target_sets
          (id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch)
          VALUES(?,?,?,?,?,?,?,?)`,
        values: [
          record.id,
          ownerId,
          principal.credential_id,
          record.hash,
          record.ref,
          record.totalBytes,
          result.expiresAt,
          principal.epoch,
        ],
      },
      {
        sql: `INSERT INTO tickets
          (id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?)`,
        values: [
          ticketId,
          principal.credential_id,
          record.id,
          budget.id,
          purpose,
          principal.epoch,
          iat * 1000,
          result.expiresAt,
        ],
      },
    ]);
  } catch (error) {
    if (await reconcileTicketIssue(db, bucket, record, ticketId, error)) {
      if (!signed) throw new Error("content_ticket_commit_unknown", { cause: error });
      return Object.freeze({ ...result, ticket: signed });
    }
    throw error;
  }
  return Object.freeze({ ...result, ticket: signed });
}

async function reconcileTicketIssue(
  db: D1Database,
  bucket: R2Bucket,
  record: TargetManifestRecord,
  ticketId: string,
  cause: unknown,
): Promise<boolean> {
  let row: { hash: string; ref: string; ticketId: string | null } | null;
  try {
    row = await primary(db)
      .prepare(`SELECT ts.manifest_hash AS hash,ts.manifest_ref AS ref,t.id AS ticketId
        FROM target_sets ts LEFT JOIN tickets t ON t.target_set_id=ts.id AND t.id=?
        WHERE ts.id=?`)
      .bind(ticketId, record.id)
      .first();
  } catch {
    throw new Error("content_ticket_commit_unknown", { cause });
  }
  if (!row) {
    await bucket.delete(record.ref).catch(() => undefined);
    return false;
  }
  if (row.hash !== record.hash || row.ref !== record.ref || row.ticketId !== ticketId)
    throw new Error("content_ticket_commit_unknown", { cause });
  return true;
}
