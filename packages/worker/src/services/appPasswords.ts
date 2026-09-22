import { base64url } from "jose";
import { type AppPasswordPepperRing, hashAppPassword } from "../auth/appPassword";
import { authorizationAssertion, authorizeNode } from "../auth/authorize";
import { type AccessSession, assertLiveAccessCredential } from "../auth/sessions";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MANAGED_SCOPES = ["node:read", "node:create", "node:write", "node:delete"] as const;
type ManagedScope = (typeof MANAGED_SCOPES)[number];
const DAY_MS = 86_400_000;

export interface CreateAppPasswordInput {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly ttlDays?: number;
  readonly spaceId?: string;
  readonly rootNodeId?: string;
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
  return `ap_${result.join("")}`;
}

function validatedInput(input: CreateAppPasswordInput) {
  if (typeof input.name !== "string") throw new Error("invalid_app_password_request");
  const name = input.name.normalize("NFC").trim();
  const nameBytes = new TextEncoder().encode(name);
  if (
    name.length < 1 ||
    Array.from(name).length > 100 ||
    nameBytes.length > 256 ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes) !== name ||
    /[\x00-\x1f\x7f]/.test(name) ||
    !Array.isArray(input.scopes) ||
    input.scopes.length < 1 ||
    input.scopes.length > MANAGED_SCOPES.length ||
    input.scopes.some((scope) => !MANAGED_SCOPES.includes(scope as ManagedScope)) ||
    new Set(input.scopes).size !== input.scopes.length ||
    (input.rootNodeId === undefined) !== (input.spaceId === undefined) ||
    (input.rootNodeId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.rootNodeId)) ||
    (input.spaceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.spaceId)) ||
    (input.ttlDays !== undefined &&
      (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 365))
  )
    throw new Error("invalid_app_password_request");
  return {
    name,
    scopes: [...input.scopes].sort() as ManagedScope[],
    ttlDays: input.ttlDays ?? 90,
    rootNodeId: input.rootNodeId ?? null,
    spaceId: input.spaceId,
  };
}

interface AppPasswordRow {
  id: string;
  credentialId: string;
  name: string;
  rootNodeId: string | null;
  createdAt: number;
  expiresAt: number;
  scopes: string;
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

export async function listAppPasswords(db: D1Database, session: AccessSession) {
  await atomicBatch(db, currentAccess(session));
  const rows = await primary(db)
    .prepare(`SELECT ap.id,c.id AS credentialId,ap.name,ap.root_node_id AS rootNodeId,
      ap.created_at AS createdAt,ap.expires_at AS expiresAt,
      json_group_array(cs.scope) AS scopes
      FROM app_passwords ap JOIN credentials c ON c.app_password_id=ap.id AND c.kind='app_password'
      JOIN credential_scopes cs ON cs.credential_id=c.id
      WHERE ap.user_id=? AND ap.revoked_at IS NULL AND ap.expires_at>strftime('%s','now')*1000
      GROUP BY ap.id ORDER BY ap.created_at DESC,ap.id DESC LIMIT 20`)
    .bind(session.user_id)
    .all<AppPasswordRow>();
  await atomicBatch(db, currentAccess(session));
  return rows.results.map((row) => ({
    id: row.id,
    credentialId: row.credentialId,
    name: row.name,
    rootNodeId: row.rootNodeId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    scopes: (JSON.parse(row.scopes) as string[]).sort(),
  }));
}

export async function createAppPassword(
  db: D1Database,
  session: AccessSession,
  input: CreateAppPasswordInput,
  ring: AppPasswordPepperRing,
) {
  const validated = validatedInput(input);
  const active = await primary(db)
    .prepare(
      "SELECT COUNT(*) AS count FROM app_passwords WHERE user_id=? AND revoked_at IS NULL AND expires_at>strftime('%s','now')*1000",
    )
    .bind(session.user_id)
    .first<number>("count");
  if (active !== null && active >= 20) throw new Error("app_password_limit");
  const id = ulid();
  const credentialId = `ap:${id}`;
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const hashed = await hashAppPassword(secret, ring);
  let root: Awaited<ReturnType<typeof authorizeNode>> | null = null;
  if (validated.rootNodeId) {
    try {
      root = await authorizeNode(
        db,
        {
          kind: "user",
          user_id: session.user_id,
          credential_id: session.credential_id,
          epoch: session.epoch,
        },
        { operation: "node.read", nodeId: validated.rootNodeId, spaceId: validated.spaceId ?? "" },
      );
    } catch {
      throw new Error("invalid_app_password_root");
    }
  }
  if (root && (root.operation !== "node.read" || root.node.owner_id !== session.user_id))
    throw new Error("invalid_app_password_root");
  const clock = "strftime('%s','now')*1000";
  await atomicBatch(db, [
    ...currentAccess(session),
    ...(root ? [authorizationAssertion(root)] : []),
    assertExists(
      `SELECT 1 WHERE (SELECT COUNT(*) FROM app_passwords
        WHERE user_id=? AND revoked_at IS NULL AND expires_at>${clock})<20`,
      [session.user_id],
    ),
    {
      sql: `INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,${clock},${clock}+?)`,
      values: [
        id,
        session.user_id,
        validated.rootNodeId,
        validated.name,
        hashed.secretDigest,
        hashed.salt,
        hashed.kdf,
        hashed.kdfParams,
        hashed.kid,
        validated.ttlDays * DAY_MS,
      ],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: [credentialId, id],
    },
    ...validated.scopes.map((scope) => ({
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,?)",
      values: [credentialId, scope],
    })),
  ]);
  const created = await primary(db)
    .prepare(
      "SELECT created_at AS createdAt,expires_at AS expiresAt FROM app_passwords WHERE id=? AND user_id=?",
    )
    .bind(id, session.user_id)
    .first<{ createdAt: number; expiresAt: number }>();
  if (!created) throw new Error("app_password_commit_unknown");
  await atomicBatch(db, currentAccess(session));
  return {
    id,
    credentialId,
    name: validated.name,
    rootNodeId: validated.rootNodeId,
    scopes: validated.scopes,
    ...created,
    secret,
  };
}

export async function revokeAppPassword(
  db: D1Database,
  session: AccessSession,
  credentialId: string,
): Promise<void> {
  if (!/^ap:ap_[0-9A-HJKMNP-TV-Z]{26}$/.test(credentialId))
    throw new Error("app_password_not_found");
  const clock = "strftime('%s','now')*1000";
  await atomicBatch(db, [
    ...currentAccess(session),
    assertExists(
      `SELECT 1 FROM credentials c JOIN app_passwords ap ON ap.id=c.app_password_id
        WHERE c.id=? AND c.kind='app_password' AND ap.user_id=?`,
      [credentialId, session.user_id],
    ),
    {
      sql: `UPDATE app_passwords SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE id=(SELECT app_password_id FROM credentials WHERE id=?) AND user_id=?`,
      values: [credentialId, session.user_id],
    },
    {
      sql: `UPDATE content_sessions SET revoked_at=COALESCE(revoked_at,${clock})
        WHERE issued_by_credential_id=?`,
      values: [credentialId],
    },
  ]);
}
