import type { ArchiveBook, PageReadingState, PageReadingUpdate } from "../../../shared/src/library";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { ARCHIVE_GENERATOR } from "../media/archive/codec";
import { acquireAccountMutation, commitAccountMutation } from "./accountMutation";
import { prepareAuthorizedArchiveRead } from "./archiveRead";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export async function archiveBookAuthority(db: D1Database, principal: Principal, nodeId: string) {
  if (!ID.test(nodeId)) throw new Error("authorization_denied");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("authorization_denied");
  const proof = await authorizeNode(db, principal, { operation: "library.read", spaceId, nodeId });
  if (proof.operation !== "library.read") throw new Error("authorization_denied");
  const plan = await prepareAuthorizedArchiveRead(db, proof);
  return { proof, plan };
}
interface StoredState {
  position: string;
  updatedAt: number;
}
export function readingState(
  row: StoredState | undefined,
  book: { indexHash: string; pageCount: number },
): PageReadingState | null {
  if (
    !row ||
    !Number.isSafeInteger(row.updatedAt) ||
    row.updatedAt < 0 ||
    row.updatedAt >= Number.MAX_SAFE_INTEGER
  )
    return null;
  try {
    const value = JSON.parse(row.position);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "generator,indexHash,kind,page" ||
      value.kind !== "page" ||
      value.generator !== ARCHIVE_GENERATOR ||
      value.indexHash !== book.indexHash ||
      !Number.isSafeInteger(value.page) ||
      value.page < 1 ||
      value.page > book.pageCount
    )
      return null;
    return { page: value.page, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}
async function currentState(db: D1Database, principal: Principal, nodeId: string) {
  const { proof, plan } = await archiveBookAuthority(db, principal, nodeId);
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    plan.guard,
    {
      sql: "SELECT position_json AS position,updated_at AS updatedAt FROM user_reading_state WHERE user_id=? AND node_id=? AND blob_id=?",
      values: [principal.kind === "user" ? principal.user_id : null, nodeId, plan.book.blobId],
    },
  ]);
  const stored = result.at(-1)?.results[0] as StoredState | undefined;
  return { proof, plan, stored, reading: readingState(stored, plan.book) };
}
export async function readArchiveBook(
  db: D1Database,
  principal: Principal,
  nodeId: string,
): Promise<ArchiveBook> {
  const { plan, reading } = await currentState(db, principal, nodeId);
  return { ...plan.book, reading };
}
export class ReadingConflict extends Error {
  constructor() {
    super("reading_conflict");
  }
}
function validate(input: PageReadingUpdate) {
  if (
    !input ||
    typeof input.blobId !== "string" ||
    !ID.test(input.blobId) ||
    input.generator !== ARCHIVE_GENERATOR ||
    typeof input.indexHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.indexHash) ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    input.page > 10000 ||
    (input.previousUpdatedAt !== null &&
      (!Number.isSafeInteger(input.previousUpdatedAt) ||
        input.previousUpdatedAt < 0 ||
        input.previousUpdatedAt >= Number.MAX_SAFE_INTEGER))
  )
    throw new Error("invalid_reading_update");
}
async function writableState(
  db: D1Database,
  principal: Principal,
  nodeId: string,
  input: PageReadingUpdate,
) {
  if (principal.kind !== "user") throw new Error("authorization_denied");
  const current = await currentState(db, principal, nodeId),
    book = current.plan.book;
  const write = await authorizeNode(db, principal, {
    operation: "reading_state.write",
    spaceId: book.spaceId,
    nodeId,
  });
  if (
    write.operation !== "reading_state.write" ||
    write.node.current_blob_id !== book.blobId ||
    book.blobId !== input.blobId ||
    book.indexHash !== input.indexHash
  )
    throw new Error("authorization_denied");
  if (input.page > book.pageCount) throw new Error("invalid_reading_update");
  if ((current.reading?.updatedAt ?? null) !== input.previousUpdatedAt) throw new ReadingConflict();
  return { ...current, write };
}

/** Reading shares write only their own state; a stale tab must reload before replacing it. */
export async function saveReadingState(
  env: Pick<Env, "DB" | "CONTROL">,
  principal: Principal,
  nodeId: string,
  input: PageReadingUpdate,
): Promise<PageReadingState> {
  validate(input);
  const current = await writableState(env.DB, principal, nodeId, input);
  if (principal.kind !== "user") throw new Error("authorization_denied");
  const owner = current.proof.node.owner_id;
  const admission = await acquireAccountMutation(env, owner, principal.epoch, "reading.write");
  const updatedAt = Math.max(Date.now(), (input.previousUpdatedAt ?? -1) + 1);
  const position = JSON.stringify({
    kind: "page",
    generator: ARCHIVE_GENERATOR,
    indexHash: input.indexHash,
    page: input.page,
  });
  try {
    await commitAccountMutation(env.DB, admission, owner, [
      authorizationAssertion(current.proof),
      authorizationAssertion(current.write),
      current.plan.guard,
      assertExists(
        `SELECT 1 WHERE (SELECT position_json FROM user_reading_state WHERE user_id=?1 AND node_id=?2 AND blob_id=?3) IS ?4
        AND (SELECT updated_at FROM user_reading_state WHERE user_id=?1 AND node_id=?2 AND blob_id=?3) IS ?5`,
        [
          principal.user_id,
          nodeId,
          input.blobId,
          current.stored?.position ?? null,
          current.stored?.updatedAt ?? null,
        ],
      ),
      {
        sql: "DELETE FROM user_reading_state WHERE user_id=? AND node_id=? AND blob_id<>?",
        values: [principal.user_id, nodeId, input.blobId],
      },
      {
        sql: `INSERT INTO user_reading_state(user_id,node_id,blob_id,position_json,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,node_id,blob_id) DO UPDATE SET position_json=excluded.position_json,updated_at=excluded.updated_at`,
        values: [principal.user_id, nodeId, input.blobId, position, updatedAt],
      },
      assertOneChange,
    ]);
  } catch (error) {
    await writableState(env.DB, principal, nodeId, input);
    throw error;
  }
  return { page: input.page, updatedAt };
}
