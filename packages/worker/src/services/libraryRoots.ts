import type { LibraryRoots } from "../../../shared/src/library";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertLiveAccessCredential, readAccessSession } from "../auth/sessions";
import { assertExists, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { acquireAccountMutation, commitAccountMutation } from "./accountMutation";
import { libraryAuthority } from "./libraryList";

export const LIBRARY_ROOT_LIMIT = 32;
async function account(db: D1Database, principal: Principal) {
  if (principal.kind !== "user" || principal.selected_share)
    throw new Error("authorization_denied");
  const session = await readAccessSession(db, principal.credential_id, principal.epoch);
  if (!session || session.user_id !== principal.user_id) throw new Error("authorization_denied");
  return [
    assertLiveAccessCredential(principal.credential_id, principal.epoch),
    assertExists(
      `SELECT 1 FROM sessions s JOIN credentials c ON c.session_id=s.id JOIN control ctl ON ctl.singleton=1
      WHERE c.id=? AND s.user_id=? AND ctl.maintenance=0`,
      [principal.credential_id, principal.user_id],
    ),
  ];
}
export async function listLibraryRoots(
  db: D1Database,
  principal: Principal,
): Promise<LibraryRoots> {
  const guards = await account(db, principal);
  if (principal.kind !== "user") throw new Error("authorization_denied");
  const result = await atomicBatch(db, [
    ...guards,
    {
      sql: "SELECT node_id FROM library_roots WHERE user_id=? ORDER BY node_id LIMIT ?",
      values: [principal.user_id, LIBRARY_ROOT_LIMIT + 1],
    },
  ]);
  const rows = result.at(-1)!.results as { node_id: string }[];
  if (rows.length > LIBRARY_ROOT_LIMIT) throw new Error("library_roots_limit");
  const entries = await Promise.all(
    rows.map(async (row) => {
      try {
        const proof = await libraryAuthority(db, principal, row.node_id);
        if (proof.node.owner_id !== principal.user_id || proof.node.kind === "file")
          return { nodeId: row.node_id, name: null };
        return { nodeId: row.node_id, name: proof.node.name, proof };
      } catch {
        return { nodeId: row.node_id, name: null };
      }
    }),
  );
  await atomicBatch(db, [
    ...guards,
    ...entries.flatMap((entry) => (entry.proof ? [authorizationAssertion(entry.proof)] : [])),
  ]);
  return {
    items: entries.map(({ nodeId, name }) => ({ nodeId, name })),
    limit: LIBRARY_ROOT_LIMIT,
  };
}
/** Personal folder registrations do not change the content node or its revision. */
export async function updateLibraryRoot(
  env: Pick<Env, "DB" | "CONTROL">,
  principal: Principal,
  nodeId: string,
  add: boolean,
): Promise<void> {
  const guards = await account(env.DB, principal);
  if (principal.kind !== "user" || !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId))
    throw new Error("authorization_denied");
  const proof = add ? await libraryAuthority(env.DB, principal, nodeId) : undefined;
  if (proof && (proof.node.owner_id !== principal.user_id || proof.node.kind === "file"))
    throw new Error("authorization_denied");
  const write = proof
    ? await authorizeNode(env.DB, principal, {
        operation: "library.write",
        nodeId,
        spaceId: proof.node.space_id,
      })
    : undefined;
  const full = async () =>
    (await primary(env.DB)
      .prepare("SELECT COUNT(*) AS n FROM library_roots WHERE user_id=? AND node_id<>?")
      .bind(principal.user_id, nodeId)
      .first<number>("n"))! >= LIBRARY_ROOT_LIMIT;
  if (add && (await full())) throw new Error("library_roots_limit");
  const permit = await acquireAccountMutation(
    env,
    principal.user_id,
    principal.epoch,
    "library.roots",
  );
  try {
    await commitAccountMutation(env.DB, permit, principal.user_id, [
      ...guards,
      ...(proof ? [authorizationAssertion(proof)] : []),
      ...(write ? [authorizationAssertion(write)] : []),
      ...(add
        ? [
            assertExists(
              "SELECT 1 WHERE (SELECT COUNT(*) FROM library_roots WHERE user_id=? AND node_id<>?)<?",
              [principal.user_id, nodeId, LIBRARY_ROOT_LIMIT],
            ),
          ]
        : []),
      {
        sql: add
          ? "INSERT INTO library_roots(user_id,node_id) VALUES(?,?) ON CONFLICT(user_id,node_id) DO NOTHING"
          : "DELETE FROM library_roots WHERE user_id=? AND node_id=?",
        values: [principal.user_id, nodeId],
      },
    ]);
  } catch (error) {
    if (add && (await full())) throw new Error("library_roots_limit");
    throw error;
  }
}
