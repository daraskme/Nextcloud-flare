import { portableName } from "@next-cloud-flare/shared/names";
import { type AccessSession, assertLiveAccessCredential } from "../auth/sessions";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { acquireAccountMutation, commitAccountMutation } from "./accountMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_GROUPS = 100;
const MAX_MEMBERS = 100;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface GroupRow {
  id: string;
  name: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  members: string;
}

export interface CreateShareGroupInput {
  readonly name: string;
  readonly memberEmails: readonly string[];
}

export interface UpdateShareGroupInput {
  readonly name?: string;
  readonly memberEmails?: readonly string[];
}

function ulid(): string {
  let time = Date.now();
  const result = Array<string>(26);
  for (let index = 9; index >= 0; index--) {
    result[index] = ALPHABET[time % 32]!;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < 16; index++) result[index + 10] = ALPHABET[random[index]! & 31]!;
  return `grp_${result.join("")}`;
}

function currentAccess(session: AccessSession): SqlStatement[] {
  return [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      session.epoch,
    ]),
    assertLiveAccessCredential(session.credential_id, session.epoch),
    assertExists(
      `SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
        WHERE c.id=? AND c.kind='access' AND s.user_id=? AND s.epoch=?`,
      [session.credential_id, session.user_id, session.epoch],
    ),
  ];
}

function normalizedName(value: string) {
  if (typeof value !== "string") throw new Error("invalid_group_request");
  try {
    return portableName(value.normalize("NFC").trim());
  } catch {
    throw new Error("invalid_group_request");
  }
}

function normalizedEmails(values: readonly string[]) {
  if (!Array.isArray(values) || values.length > MAX_MEMBERS)
    throw new Error("invalid_group_request");
  const normalized = values.map((value) => {
    if (typeof value !== "string") throw new Error("invalid_group_request");
    const email = value.normalize("NFC").trim();
    if (email.length < 3 || email.length > 320) throw new Error("invalid_group_request");
    return email;
  });
  if (
    new Set(normalized.map((email) => email.toLocaleLowerCase("en-US"))).size !== normalized.length
  )
    throw new Error("invalid_group_request");
  return normalized;
}

async function resolvedMemberIds(db: D1Database, ownerId: string, emails: readonly string[]) {
  if (emails.length === 0) return [];
  const rows = await primary(db)
    .prepare(`SELECT u.id,u.email FROM users u JOIN json_each(?) requested
      ON lower(u.email)=lower(CAST(requested.value AS TEXT))
      WHERE u.disabled_at IS NULL ORDER BY u.id`)
    .bind(JSON.stringify(emails))
    .all<{ id: string; email: string }>();
  const counts = new Map<string, number>();
  for (const row of rows.results) {
    const key = row.email.toLocaleLowerCase("en-US");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (
    rows.results.length !== emails.length ||
    rows.results.some((row) => row.id === ownerId) ||
    emails.some((email) => counts.get(email.toLocaleLowerCase("en-US")) !== 1)
  )
    throw new Error("group_member_not_found");
  return rows.results.map((row) => row.id);
}

const GROUP_SELECT = `SELECT g.id,g.name,g.version,g.created_at AS createdAt,g.updated_at AS updatedAt,
  COALESCE((SELECT json_group_array(email) FROM (
    SELECT u.email FROM share_group_members gm JOIN users u ON u.id=gm.user_id
    WHERE gm.group_id=g.id AND gm.disabled_at IS NULL AND u.disabled_at IS NULL
    ORDER BY lower(u.email),u.id
  )),'[]') AS members
  FROM share_groups g`;

function output(row: GroupRow) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    memberEmails: Object.freeze(JSON.parse(row.members) as string[]),
  });
}

export async function listShareGroups(db: D1Database, session: AccessSession) {
  const results = await atomicBatch(db, [
    ...currentAccess(session),
    {
      sql: `${GROUP_SELECT} WHERE g.owner_id=? AND g.disabled_at IS NULL
        ORDER BY g.name_ci,g.id LIMIT ${MAX_GROUPS + 1}`,
      values: [session.user_id],
    },
  ]);
  const rows = (results.at(-1)?.results ?? []) as unknown as GroupRow[];
  if (rows.length > MAX_GROUPS) throw new Error("group_limit");
  return rows.map(output);
}

export async function readShareGroup(db: D1Database, session: AccessSession, groupId: string) {
  if (!ID.test(groupId)) throw new Error("group_not_found");
  const results = await atomicBatch(db, [
    ...currentAccess(session),
    {
      sql: `${GROUP_SELECT} WHERE g.id=? AND g.owner_id=? AND g.disabled_at IS NULL`,
      values: [groupId, session.user_id],
    },
  ]);
  const row = results.at(-1)?.results[0] as unknown as GroupRow | undefined;
  if (!row) throw new Error("group_not_found");
  return output(row);
}

function exactMembersAssertion(
  groupId: string,
  ownerId: string,
  emails: readonly string[],
  memberIds: readonly string[],
) {
  return assertExists(
    `SELECT 1 WHERE
      (SELECT COUNT(*) FROM users u JOIN json_each(?) requested
        ON lower(u.email)=lower(CAST(requested.value AS TEXT))
        WHERE u.disabled_at IS NULL AND u.id<>?)=?
      AND (SELECT COUNT(DISTINCT lower(CAST(value AS TEXT))) FROM json_each(?))=?
      AND NOT EXISTS(
        SELECT 1 FROM json_each(?) requested
        WHERE (SELECT COUNT(*) FROM users u WHERE u.disabled_at IS NULL
          AND u.id<>? AND lower(u.email)=lower(CAST(requested.value AS TEXT)))<>1
      )
      AND (SELECT COUNT(*) FROM json_each(?))<=?
      AND EXISTS(SELECT 1 FROM share_groups WHERE id=? AND owner_id=? AND disabled_at IS NULL)
      AND (SELECT COUNT(*) FROM users WHERE id IN (
        SELECT CAST(value AS TEXT) FROM json_each(?)
      ) AND disabled_at IS NULL AND id<>?)=?`,
    [
      JSON.stringify(emails),
      ownerId,
      emails.length,
      JSON.stringify(emails),
      emails.length,
      JSON.stringify(emails),
      ownerId,
      JSON.stringify(emails),
      MAX_MEMBERS,
      groupId,
      ownerId,
      JSON.stringify(memberIds),
      ownerId,
      memberIds.length,
    ],
  );
}

export async function createShareGroup(
  env: Env,
  session: AccessSession,
  input: CreateShareGroupInput,
) {
  const name = normalizedName(input.name);
  const emails = normalizedEmails(input.memberEmails);
  const memberIds = await resolvedMemberIds(env.DB, session.user_id, emails);
  const [duplicate, activeGroups] = await Promise.all([
    primary(env.DB)
      .prepare("SELECT 1 FROM share_groups WHERE owner_id=? AND name_ci=? AND disabled_at IS NULL")
      .bind(session.user_id, name.nameCi)
      .first(),
    primary(env.DB)
      .prepare(
        "SELECT COUNT(*) AS count FROM share_groups WHERE owner_id=? AND disabled_at IS NULL",
      )
      .bind(session.user_id)
      .first<number>("count"),
  ]);
  if (duplicate) throw new Error("group_exists");
  if (activeGroups === null || activeGroups >= MAX_GROUPS) throw new Error("group_limit");
  const id = ulid();
  const now = Date.now();
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "group.create",
  );
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...currentAccess(session),
    assertExists(
      `SELECT 1 WHERE
        (SELECT COUNT(*) FROM share_groups WHERE owner_id=? AND disabled_at IS NULL)<?
        AND NOT EXISTS(SELECT 1 FROM share_groups
          WHERE owner_id=? AND name_ci=? AND disabled_at IS NULL)`,
      [session.user_id, MAX_GROUPS, session.user_id, name.nameCi],
    ),
    {
      sql: `INSERT INTO share_groups(
        id,owner_id,name,name_ci,created_at,updated_at
      ) VALUES(?,?,?,?,?,?)`,
      values: [id, session.user_id, name.name, name.nameCi, now, now],
    },
    exactMembersAssertion(id, session.user_id, emails, memberIds),
    {
      sql: `INSERT INTO share_group_members(group_id,user_id,version,added_at)
        SELECT ?,u.id,1,? FROM users u JOIN json_each(?) requested
          ON lower(u.email)=lower(CAST(requested.value AS TEXT))
        WHERE u.disabled_at IS NULL AND u.id<>?`,
      values: [id, now, JSON.stringify(emails), session.user_id],
    },
  ]);
  return readShareGroup(env.DB, session, id);
}

export async function updateShareGroup(
  env: Env,
  session: AccessSession,
  groupId: string,
  input: UpdateShareGroupInput,
) {
  if (!ID.test(groupId) || (input.name === undefined && input.memberEmails === undefined))
    throw new Error("invalid_group_request");
  const name = input.name === undefined ? undefined : normalizedName(input.name);
  const emails =
    input.memberEmails === undefined ? undefined : normalizedEmails(input.memberEmails);
  const memberIds =
    emails === undefined ? undefined : await resolvedMemberIds(env.DB, session.user_id, emails);
  const [current, duplicate] = await Promise.all([
    primary(env.DB)
      .prepare("SELECT 1 FROM share_groups WHERE id=? AND owner_id=? AND disabled_at IS NULL")
      .bind(groupId, session.user_id)
      .first(),
    name === undefined
      ? Promise.resolve(null)
      : primary(env.DB)
          .prepare(`SELECT 1 FROM share_groups
            WHERE owner_id=? AND id<>? AND name_ci=? AND disabled_at IS NULL`)
          .bind(session.user_id, groupId, name.nameCi)
          .first(),
  ]);
  if (!current) throw new Error("group_not_found");
  if (duplicate) throw new Error("group_exists");
  const now = Date.now();
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "group.update",
  );
  const clock = "strftime('%s','now')*1000";
  const statements: SqlStatement[] = [
    ...currentAccess(session),
    assertExists(
      `SELECT 1 FROM share_groups WHERE id=? AND owner_id=? AND disabled_at IS NULL
        AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM share_groups other
          WHERE other.owner_id=? AND other.id<>? AND other.name_ci=?
            AND other.disabled_at IS NULL))`,
      [
        groupId,
        session.user_id,
        name?.nameCi ?? null,
        session.user_id,
        groupId,
        name?.nameCi ?? "",
      ],
    ),
  ];
  if (emails && memberIds) {
    statements.push(
      exactMembersAssertion(groupId, session.user_id, emails, memberIds),
      {
        sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
          WHERE user_id IN (
            SELECT gm.user_id FROM share_group_members gm
            WHERE gm.group_id=? AND gm.disabled_at IS NULL
              AND gm.user_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ) AND share_id IN (SELECT share_id FROM share_group_grants WHERE group_id=?)`,
        values: [groupId, JSON.stringify(memberIds), groupId],
      },
      {
        sql: `UPDATE budgets SET state='revoked'
          WHERE state='active' AND user_id IN (
            SELECT gm.user_id FROM share_group_members gm
            WHERE gm.group_id=? AND gm.disabled_at IS NULL
              AND gm.user_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ) AND share_id IN (SELECT share_id FROM share_group_grants WHERE group_id=?)`,
        values: [groupId, JSON.stringify(memberIds), groupId],
      },
      {
        sql: `WITH RECURSIVE invalid_share(id) AS (
          SELECT delegation.share_id
          FROM share_delegations delegation
          JOIN share_group_grants grouped ON grouped.share_id=delegation.source_share_id
          JOIN share_group_members member ON member.group_id=grouped.group_id
            AND member.user_id=delegation.delegated_by_user_id
          WHERE grouped.group_id=? AND delegation.source_group_id=?
            AND member.disabled_at IS NULL
            AND member.user_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          UNION ALL
          SELECT child.share_id FROM share_delegations child
          JOIN invalid_share parent ON parent.id=child.source_share_id
        )
        UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE share_id IN (SELECT id FROM invalid_share)`,
        values: [groupId, groupId, JSON.stringify(memberIds)],
      },
      {
        sql: `WITH RECURSIVE invalid_share(id) AS (
          SELECT delegation.share_id
          FROM share_delegations delegation
          JOIN share_group_grants grouped ON grouped.share_id=delegation.source_share_id
          JOIN share_group_members member ON member.group_id=grouped.group_id
            AND member.user_id=delegation.delegated_by_user_id
          WHERE grouped.group_id=? AND delegation.source_group_id=?
            AND member.disabled_at IS NULL
            AND member.user_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          UNION ALL
          SELECT child.share_id FROM share_delegations child
          JOIN invalid_share parent ON parent.id=child.source_share_id
        )
        UPDATE budgets SET state='revoked'
        WHERE state='active' AND share_id IN (SELECT id FROM invalid_share)`,
        values: [groupId, groupId, JSON.stringify(memberIds)],
      },
      {
        sql: `UPDATE share_group_members SET disabled_at=COALESCE(disabled_at,${clock})
          WHERE group_id=? AND disabled_at IS NULL
            AND user_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
        values: [groupId, JSON.stringify(memberIds)],
      },
      {
        sql: `INSERT INTO share_group_members(group_id,user_id,version,added_at)
          SELECT ?,CAST(value AS TEXT),1,? FROM json_each(?)
          WHERE 1
          ON CONFLICT(group_id,user_id) DO UPDATE SET
            version=share_group_members.version+1,disabled_at=NULL,added_at=excluded.added_at
          WHERE share_group_members.disabled_at IS NOT NULL`,
        values: [groupId, now, JSON.stringify(memberIds)],
      },
    );
  }
  statements.push({
    sql: `UPDATE share_groups SET
      name=COALESCE(?,name),name_ci=COALESCE(?,name_ci),version=version+1,updated_at=?
      WHERE id=? AND owner_id=? AND disabled_at IS NULL`,
    values: [name?.name ?? null, name?.nameCi ?? null, now, groupId, session.user_id],
  });
  await commitAccountMutation(env.DB, admission, session.user_id, statements);
  return readShareGroup(env.DB, session, groupId);
}

export async function disableShareGroup(
  env: Env,
  session: AccessSession,
  groupId: string,
): Promise<void> {
  if (!ID.test(groupId)) throw new Error("group_not_found");
  const exists = await primary(env.DB)
    .prepare("SELECT 1 FROM share_groups WHERE id=? AND owner_id=? AND disabled_at IS NULL")
    .bind(groupId, session.user_id)
    .first();
  if (!exists) throw new Error("group_not_found");
  const admission = await acquireAccountMutation(
    env,
    session.user_id,
    session.epoch,
    "group.disable",
  );
  const clock = "strftime('%s','now')*1000";
  await commitAccountMutation(env.DB, admission, session.user_id, [
    ...currentAccess(session),
    assertExists("SELECT 1 FROM share_groups WHERE id=? AND owner_id=? AND disabled_at IS NULL", [
      groupId,
      session.user_id,
    ]),
    {
      sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE share_id IN (SELECT share_id FROM share_group_grants WHERE group_id=?)`,
      values: [groupId],
    },
    {
      sql: `UPDATE budgets SET state='revoked' WHERE state='active'
        AND share_id IN (SELECT share_id FROM share_group_grants WHERE group_id=?)`,
      values: [groupId],
    },
    {
      sql: `WITH RECURSIVE invalid_share(id) AS (
        SELECT share_id FROM share_group_grants WHERE group_id=?
        UNION ALL
        SELECT delegation.share_id FROM share_delegations delegation
        JOIN invalid_share parent ON parent.id=delegation.source_share_id
      )
      UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
      WHERE share_id IN (SELECT id FROM invalid_share)`,
      values: [groupId],
    },
    {
      sql: `WITH RECURSIVE invalid_share(id) AS (
        SELECT share_id FROM share_group_grants WHERE group_id=?
        UNION ALL
        SELECT delegation.share_id FROM share_delegations delegation
        JOIN invalid_share parent ON parent.id=delegation.source_share_id
      )
      UPDATE budgets SET state='revoked'
      WHERE state='active' AND share_id IN (SELECT id FROM invalid_share)`,
      values: [groupId],
    },
    {
      sql: `UPDATE shares SET disabled_at=COALESCE(disabled_at,${clock}),
        version=CASE WHEN disabled_at IS NULL THEN version+1 ELSE version END
        WHERE id IN (SELECT share_id FROM share_group_grants WHERE group_id=?)`,
      values: [groupId],
    },
    {
      sql: `UPDATE share_group_members SET disabled_at=COALESCE(disabled_at,${clock})
        WHERE group_id=?`,
      values: [groupId],
    },
    {
      sql: `UPDATE share_groups SET disabled_at=${clock},version=version+1,updated_at=MAX(updated_at,${clock})
        WHERE id=? AND owner_id=? AND disabled_at IS NULL`,
      values: [groupId, session.user_id],
    },
  ]);
}
