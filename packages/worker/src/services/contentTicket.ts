import {
  type AuthorizedNode,
  authorizationBatchAssertions,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import type { ContentPurpose } from "../auth/contentSession";
import type { ContentTokens } from "../auth/contentTokens";
import { shareCoverageAssertion, shareCoverageBatchAssertions } from "../auth/shareCoverage";
import type { MutationAdmission } from "../db/mutationAdmission";
import { assertExists, atomicBatch, primary } from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "./accountMutation";
import {
  prepareAuthorizedNodeBlobRead,
  prepareAuthorizedNodeThumbnailRead,
  prepareAuthorizedNodeTrackRead,
} from "./blobRead";
import { ensureContentBudget } from "./contentBudget";
import { addZipPinStatements } from "./refs";
import {
  stageTargetManifest,
  stageZipTargetManifest,
  type TargetEntry,
  type TargetManifestRecord,
} from "./targetManifest";
import { planZipDownload, zipPathBatchAssertions } from "./zipDownload";

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

export interface ContentTicketIssueOptions {
  readonly idempotencyKey?: string;
}

async function idempotencySlot(credentialId: string, key: string): Promise<string> {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new Error("invalid_idempotency_key");
  const bytes = new TextEncoder().encode(JSON.stringify(["content.issue", credentialId, key]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
              AND (sh.kind<>'internal' OR EXISTS(
                SELECT 1 FROM current_internal_shares current
                WHERE current.share_id=sh.id AND current.version=sh.version
              ))
              AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')
              AND ((? IS NOT NULL AND sh.kind='internal' AND (
                EXISTS(SELECT 1 FROM share_grants g
                  WHERE g.share_id=sh.id AND g.user_id=?
                    AND g.version=sh.version AND g.disabled_at IS NULL)
                OR EXISTS(
                  SELECT 1 FROM share_group_grants gg
                  JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
                    AND sg.disabled_at IS NULL
                  JOIN share_group_members gm ON gm.group_id=sg.id AND gm.user_id=b.user_id
                    AND gm.disabled_at IS NULL
                  WHERE gg.share_id=sh.id
                )))
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
  env: AccountMutationEnv,
  bucket: R2Bucket,
  tokens: ContentTokens,
  principal: Principal,
  targets: readonly ContentTicketTarget[],
  purpose: ContentPurpose,
  expiresAt: number,
  share?: { readonly id: string; readonly version: number },
  options: ContentTicketIssueOptions = {},
): Promise<IssuedContentTicket> {
  const db = env.DB;
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
    (share !== undefined && principal.kind === "link_share") ||
    (purpose === "track" && share !== undefined) ||
    (options.idempotencyKey !== undefined && purpose !== "zip")
  )
    throw new Error("invalid_content_ticket_request");
  const selectedShare =
    principal.kind === "link_share"
      ? { id: principal.share_id, version: principal.share_version }
      : share;
  const zip = purpose === "zip" ? await planZipDownload(db, bucket, principal, targets) : undefined;
  const proofs: (AuthorizedNode & { readonly operation: "node.read" })[] = [];
  const entries: TargetEntry[] = [];
  let ownerId: string | null = null;
  if (zip) {
    proofs.push(
      ...zip.proofs.map((proof) => {
        if (proof.operation !== "node.read") throw new Error("content_ticket_target_unavailable");
        return proof as AuthorizedNode & { readonly operation: "node.read" };
      }),
    );
    ownerId = zip.ownerId;
  } else {
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
      const blob =
        purpose === "thumb"
          ? await prepareAuthorizedNodeThumbnailRead(db, proof)
          : purpose === "track"
            ? await prepareAuthorizedNodeTrackRead(db, proof)
            : await prepareAuthorizedNodeBlobRead(db, proof);
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
  }
  const first = proofs[0];
  if (!first || !ownerId) throw new Error("invalid_content_ticket_request");
  if (selectedShare && zip)
    await atomicBatch(
      db,
      shareCoverageBatchAssertions(
        proofs.map((proof) => proof.node),
        selectedShare,
      ),
    );
  const budget = await ensureContentBudget(env, first, expiresAt, share);
  const slot =
    options.idempotencyKey === undefined
      ? undefined
      : await idempotencySlot(principal.credential_id, options.idempotencyKey);
  const ticketId = slot ? `ct_${slot}` : crypto.randomUUID();
  const targetSetId = slot ? `ts_${slot}` : undefined;
  const record = zip
    ? await stageZipTargetManifest(bucket, zip.entries, zip.outputSize, targetSetId)
    : await stageTargetManifest(bucket, entries, targetSetId);
  const result = Object.freeze({
    ticketId,
    targetSetId: record.id,
    budgetId: budget.id,
    expiresAt: exp * 1000,
  });
  const guards = (guardExpiresAt: number) => [
    assertExists("SELECT 1 WHERE ?>strftime('%s','now')*1000", [guardExpiresAt]),
    ...authorizationBatchAssertions(proofs),
    ...(selectedShare
      ? shareCoverageBatchAssertions(
          proofs.map((proof) => proof.node),
          selectedShare,
        )
      : []),
    ...(zip ? zipPathBatchAssertions(zip.entries, ownerId) : []),
    budgetAndShareAssertion(principal, ownerId, budget.id, guardExpiresAt, share),
  ];
  const issueSigned = async (issuedAt: number, ticketExpiresAt: number) => {
    const ticketIat = Math.floor(issuedAt / 1000);
    const ticketExp = Math.floor(ticketExpiresAt / 1000);
    const ticket = await tokens.issueTicket({
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
      iat: ticketIat,
      exp: ticketExp,
    });
    return Object.freeze({
      ticket,
      ticketId,
      targetSetId: record.id,
      budgetId: budget.id,
      expiresAt: ticketExp * 1000,
    });
  };
  const existingPublication = async (): Promise<IssuedContentTicket | null> => {
    if (!slot) return null;
    const existing = await primary(db)
      .prepare(`SELECT t.issued_at AS issuedAt,t.expires_at AS expiresAt
        FROM tickets t JOIN target_sets ts ON ts.id=t.target_set_id
        WHERE t.id=? AND t.credential_id=? AND t.target_set_id=? AND t.budget_id=?
          AND t.purpose=? AND t.epoch=? AND t.cancelled_at IS NULL
          AND t.expires_at>strftime('%s','now')*1000
          AND ts.owner_id=? AND ts.credential_id=t.credential_id
          AND ts.manifest_ref=? AND ts.manifest_hash=? AND ts.total_bytes=?
          AND ts.expires_at=t.expires_at AND ts.epoch=t.epoch`)
      .bind(
        ticketId,
        principal.credential_id,
        record.id,
        budget.id,
        purpose,
        principal.epoch,
        ownerId,
        record.ref,
        record.hash,
        record.totalBytes,
      )
      .first<{ issuedAt: number; expiresAt: number }>();
    if (!existing) return null;
    await atomicBatch(db, guards(existing.expiresAt));
    return issueSigned(existing.issuedAt, existing.expiresAt);
  };
  const replay = await existingPublication();
  if (replay) return replay;
  if (slot) {
    const occupied = await primary(db)
      .prepare("SELECT 1 FROM tickets WHERE id=? OR target_set_id=?")
      .bind(ticketId, record.id)
      .first<number>();
    if (occupied !== null) throw new Error("idempotency_conflict");
  }
  let signed: string | undefined;
  let admission: MutationAdmission | undefined;
  try {
    signed = (await issueSigned(iat * 1000, result.expiresAt)).ticket;
    const publicationGuards = guards(result.expiresAt);
    await atomicBatch(db, publicationGuards);
    admission = await acquireAccountMutation(env, ownerId, principal.epoch, "content.issue");
    await commitAccountMutation(db, admission, ownerId, [
      ...publicationGuards,
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
      ...(zip
        ? addZipPinStatements(
            record.id,
            zip.entries.map((entry) => entry.blobId),
            result.expiresAt,
            iat * 1000,
          )
        : []),
    ]);
  } catch (error) {
    const concurrentReplay = await existingPublication().catch(() => null);
    if (concurrentReplay) {
      if (admission) await closeReplayAdmission(db, admission, ticketId, record);
      return concurrentReplay;
    }
    await discardUnpublishedManifest(db, bucket, record, ticketId, admission, error);
    throw error;
  }
  return Object.freeze({ ...result, ticket: signed });
}

async function closeReplayAdmission(
  db: D1Database,
  admission: MutationAdmission,
  ticketId: string,
  record: TargetManifestRecord,
): Promise<void> {
  await atomicBatch(db, [
    assertExists(
      `SELECT 1 FROM tickets t JOIN target_sets ts ON ts.id=t.target_set_id
        WHERE t.id=? AND t.target_set_id=? AND ts.manifest_ref=? AND ts.manifest_hash=?`,
      [ticketId, record.id, record.ref, record.hash],
    ),
    {
      sql: "UPDATE mutation_admissions SET state='closed' WHERE id=? AND permit_id=? AND space_id=? AND epoch=? AND expires_at=? AND state='active' AND committed_at IS NULL",
      values: [
        admission.id,
        admission.permit_id,
        admission.space_id,
        admission.epoch,
        admission.expires_at,
      ],
    },
    assertExists(
      "SELECT 1 FROM mutation_admissions WHERE id=? AND state='closed' AND committed_at IS NULL",
      [admission.id],
    ),
  ]);
}

/** A primary absence read alone cannot fence an in-flight publication. */
async function discardUnpublishedManifest(
  db: D1Database,
  bucket: R2Bucket,
  record: TargetManifestRecord,
  ticketId: string,
  admission: MutationAdmission | undefined,
  cause: unknown,
): Promise<void> {
  if (admission) {
    try {
      await atomicBatch(db, [
        // This is the exact attempt's cancellation fence, never a successful publication receipt.
        assertExists(
          "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM target_sets WHERE id=?) AND NOT EXISTS(SELECT 1 FROM tickets WHERE id=? OR target_set_id=?)",
          [record.id, ticketId, record.id],
        ),
        {
          sql: "UPDATE mutation_admissions SET state='closed' WHERE id=? AND permit_id=? AND space_id=? AND epoch=? AND expires_at=? AND state='active' AND committed_at IS NULL",
          values: [
            admission.id,
            admission.permit_id,
            admission.space_id,
            admission.epoch,
            admission.expires_at,
          ],
        },
        assertExists(
          "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE id=? AND (state<>'closed' OR committed_at IS NOT NULL))",
          [admission.id],
        ),
      ]);
    } catch {
      throw new Error("content_ticket_commit_unknown", { cause });
    }
  }
  // The staged PUT was awaited before admission. No publication was dispatched without a ticket.
  // If the fencing batch or its acknowledgement is lost, keep the manifest.
  await bucket.delete(record.ref).catch(() => undefined);
}
