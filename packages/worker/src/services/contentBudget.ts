import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { shareCoverageAssertion } from "../auth/shareCoverage";
import { assertExists, assertOneChange, atomicBatch, type SqlStatement } from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "./accountMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LIFETIME_MS = 600_000;

export interface ContentBudget {
  readonly id: string;
  readonly expiresAt: number;
}

/** Reuse the identity budget across tabs; the D1 batch fences the chosen node and credential. */
export async function ensureContentBudget(
  env: AccountMutationEnv,
  authorized: AuthorizedNode,
  expiresAt: number,
  share?: { readonly id: string; readonly version: number },
): Promise<ContentBudget> {
  const db = env.DB;
  const principal = authorized.principal;
  const now = Date.now();
  if (
    authorized.operation !== "node.read" ||
    principal.kind === "service" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_LIFETIME_MS ||
    (share !== undefined &&
      (principal.kind === "link_share" ||
        !ID.test(share.id) ||
        !Number.isSafeInteger(share.version) ||
        share.version < 1))
  )
    throw new Error("invalid_content_budget");
  const userId = principal.kind === "link_share" ? null : principal.user_id;
  const shareId = principal.kind === "link_share" ? principal.share_id : (share?.id ?? null);
  const unlockId =
    principal.kind === "link_share" && principal.credential_id.startsWith("ss:")
      ? principal.credential_id.slice(3)
      : null;
  if (
    !ID.test(authorized.node.owner_id) ||
    (userId !== null && !ID.test(userId)) ||
    (shareId !== null && !ID.test(shareId)) ||
    (principal.kind === "link_share" && (!unlockId || !ID.test(unlockId))) ||
    (userId !== null && shareId === null && authorized.node.owner_id !== userId)
  )
    throw new Error("invalid_content_budget");
  const id =
    principal.kind === "link_share"
      ? `s:${shareId}:c:${unlockId}`
      : shareId === null
        ? `u:${userId}`
        : `u:${userId}:s:${shareId}`;
  if (id.length > 512) throw new Error("invalid_content_budget");

  let authority: SqlStatement;
  if (principal.kind === "link_share") {
    authority = assertExists(
      `SELECT 1 FROM control ctl JOIN credentials c ON c.id=? AND c.kind='share'
        JOIN share_sessions ss ON ss.id=c.share_session_id
        JOIN shares sh ON sh.id=ss.share_id JOIN users owner ON owner.id=sh.owner_id
        WHERE ctl.singleton=1 AND ctl.epoch=? AND ctl.maintenance=0
          AND ss.id=? AND ss.share_id=? AND ss.share_version=? AND ss.epoch=?
          AND ss.revoked_at IS NULL AND ss.expires_at>=?
          AND sh.owner_id=? AND sh.kind='link' AND sh.version=ss.share_version
          AND sh.disabled_at IS NULL AND owner.disabled_at IS NULL
          AND (sh.expires_at IS NULL OR sh.expires_at>=?)
          AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')`,
      [
        principal.credential_id,
        principal.epoch,
        unlockId,
        shareId,
        principal.share_version,
        principal.epoch,
        expiresAt,
        authorized.node.owner_id,
        expiresAt,
      ],
    );
  } else {
    authority = assertExists(
      `SELECT 1 FROM control ctl JOIN credentials c ON c.id=?
        JOIN users u ON u.id=? AND u.disabled_at IS NULL
        WHERE ctl.singleton=1 AND ctl.epoch=? AND ctl.maintenance=0
          AND ((?='user' AND c.kind='access' AND EXISTS(
            SELECT 1 FROM sessions s WHERE s.id=c.session_id AND s.kind='access'
              AND s.user_id=u.id AND s.epoch=? AND s.revoked_at IS NULL AND s.expires_at>=?))
            OR (?='app_password' AND c.kind='app_password' AND EXISTS(
              SELECT 1 FROM app_passwords ap WHERE ap.id=c.app_password_id
                AND ap.user_id=u.id AND ap.revoked_at IS NULL AND ap.expires_at>=?)))
          AND (? IS NULL OR EXISTS(
            SELECT 1 FROM shares sh JOIN share_grants g ON g.share_id=sh.id
            WHERE sh.id=? AND sh.version=? AND sh.owner_id=? AND sh.kind='internal'
              AND sh.disabled_at IS NULL AND (sh.expires_at IS NULL OR sh.expires_at>=?)
              AND g.user_id=u.id AND g.version=sh.version AND g.disabled_at IS NULL
              AND EXISTS(SELECT 1 FROM share_actions sa
                WHERE sa.share_id=sh.id AND sa.action='read')))`,
      [
        principal.credential_id,
        userId,
        principal.epoch,
        principal.kind,
        principal.epoch,
        expiresAt,
        principal.kind,
        expiresAt,
        shareId,
        shareId,
        share?.version ?? null,
        authorized.node.owner_id,
        expiresAt,
      ],
    );
  }
  const guards = [
    assertExists("SELECT 1 WHERE ?>strftime('%s','now')*1000", [expiresAt]),
    authorizationAssertion(authorized),
    assertExists("SELECT 1 FROM nodes WHERE id=? AND space_id=? AND owner_id=?", [
      authorized.node.id,
      authorized.node.space_id,
      authorized.node.owner_id,
    ]),
    ...(shareId !== null
      ? [
          shareCoverageAssertion(authorized.node, {
            id: shareId,
            version:
              principal.kind === "link_share" ? principal.share_version : (share?.version ?? 0),
          }),
        ]
      : []),
    authority,
  ];
  await atomicBatch(db, guards);
  const admission = await acquireAccountMutation(
    env,
    authorized.node.owner_id,
    principal.epoch,
    "content.budget",
  );
  try {
    await commitAccountMutation(db, admission, authorized.node.owner_id, [
      ...guards,
      {
        sql: `INSERT INTO budgets(id,owner_id,user_id,share_id,unlock_session_id,epoch,expires_at,state)
        VALUES(?,?,?,?,?,?,?,'active')
        ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,
          expires_at=MAX(budgets.expires_at,excluded.expires_at),state='active'
        WHERE budgets.owner_id=excluded.owner_id AND budgets.user_id IS excluded.user_id
          AND budgets.share_id IS excluded.share_id
          AND budgets.unlock_session_id IS excluded.unlock_session_id
          AND budgets.epoch<=excluded.epoch AND budgets.state<>'revoked'
          AND (budgets.state='active' OR budgets.expires_at<=strftime('%s','now')*1000)`,
        values: [
          id,
          authorized.node.owner_id,
          userId,
          shareId,
          unlockId,
          principal.epoch,
          expiresAt,
        ],
      },
      assertOneChange,
    ]);
  } catch (cause) {
    throw new Error("content_budget_commit_unknown", { cause });
  }
  return Object.freeze({ id, expiresAt });
}
