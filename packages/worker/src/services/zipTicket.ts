import type { Principal } from "../auth/authorize";
import { acceptContentTicket } from "../auth/contentAccept";
import type { ContentTokens } from "../auth/contentTokens";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { ensureContentBudget } from "./contentBudget";
import { publishContentTicket } from "./contentTicket";
import { stageEncodedTargetManifest } from "./targetManifest";
import { pinZipSnapshot, zipPinsAssertion } from "./zipPins";
import { prepareZipSnapshot, zipSnapshotAssertions } from "./zipSnapshot";

/** Create an app-delivered ZIP grant. Its ID only selects a ticket for the original credential. */
export async function issueZipTicket(
  env: Pick<Env, "DB" | "CONTROL" | "BLOBS">,
  tokens: ContentTokens,
  principal: Principal,
  nodeId: string,
  expiresAt: number,
): Promise<{ id: string; size: number; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000) * 1000;
  expiresAt = Math.floor(expiresAt / 1000) * 1000;
  if (
    principal.kind === "service" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt > issuedAt + 600_000
  )
    throw new Error("invalid_zip_request");
  const snapshot = await prepareZipSnapshot(env.DB, principal, nodeId);
  const share = principal.kind === "link_share" ? undefined : principal.selected_share;
  const shareId = principal.kind === "link_share" ? principal.share_id : share?.id;
  if (shareId) {
    const row = await primary(env.DB)
      .prepare("SELECT expires_at AS expiresAt FROM shares WHERE id=?")
      .bind(shareId)
      .first<{ expiresAt: number | null }>();
    if (!row) throw new Error("zip_unavailable");
    if (row.expiresAt !== null)
      expiresAt = Math.min(expiresAt, Math.floor(row.expiresAt / 1000) * 1000);
  }
  const budget = await ensureContentBudget(env, snapshot.proof, expiresAt, share);
  const targetSetId = crypto.randomUUID();
  await pinZipSnapshot(env, snapshot, targetSetId, expiresAt);
  // No early pin release on staging/publication/acceptance failure: the fixed deadline
  // covers unknown commits and every concurrent reader of a successfully issued ticket.
  const record = await stageEncodedTargetManifest(
    env.BLOBS,
    snapshot.encoded,
    {
      env,
      ownerId: snapshot.proof.node.owner_id,
      epoch: principal.epoch,
    },
    targetSetId,
  );
  const issued = await publishContentTicket(
    env,
    env.BLOBS,
    tokens,
    principal,
    {
      record,
      ownerId: snapshot.proof.node.owner_id,
      budgetId: budget.id,
      purpose: "zip",
      issuedAt,
      expiresAt,
      guards: [
        ...zipSnapshotAssertions(snapshot.proof, snapshot.manifest),
        zipPinsAssertion(snapshot.manifest, targetSetId, expiresAt),
      ],
    },
    share,
  );
  await acceptContentTicket(env, tokens, issued.ticket);
  return Object.freeze({
    id: issued.ticketId,
    size: record.totalBytes,
    expiresAt: issued.expiresAt,
  });
}
