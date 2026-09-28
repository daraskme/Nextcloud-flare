import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { handleDavHttp } from "../../src/api/dav";
import { appPasswordPepperRing, hashAppPassword } from "../../src/auth/appPassword";
import type { AccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { admittedDavEnv } from "./davEnvironment";
import { foundationFixture } from "./foundation";
import { localKdf } from "./kdf";
import { mutationEnv } from "./mutationAdmission";

const origin = "https://app.invalid";
export async function davSharedFixture(file = false, role = "edit") {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const recipient = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...recipient.statements,
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [`${recipient.ids.user}@example.invalid`, recipient.ids.user],
    },
  ]);
  const search = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [owner.ids.file, owner.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [owner.ids.file],
    },
  ]);
  const session: AccessSession = {
    user_id: owner.ids.user,
    credential_id: owner.ids.credential,
    session_id: owner.ids.session,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const input = {
    kind: "internal",
    rootNodeId: file ? owner.ids.file : owner.ids.folder,
    recipients: [`${recipient.ids.user}@example.invalid`],
    role,
    expiresAt: null,
  };
  const share = await createInternalShare(mutationEnv(), session, input);
  const broader = await createInternalShare(mutationEnv(), session, {
    ...input,
    rootNodeId: owner.ids.root,
    role: "edit",
  });
  const mount = await env.DB.prepare("SELECT mount_name FROM shares WHERE id=?")
    .bind(share.id)
    .first<string>("mount_name");
  const broaderMount = await env.DB.prepare("SELECT mount_name FROM shares WHERE id=?")
    .bind(broader.id)
    .first<string>("mount_name");
  const id = `ap_${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`;
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await appPasswordPepperRing(
    "v1",
    { v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) },
    localKdf,
  );
  const record = await hashAppPassword(secret, ring);
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO app_passwords(id,user_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
    VALUES(?,?,'DAV',?,?,?,?,?,?,?)`,
      values: [
        id,
        recipient.ids.user,
        record.secretDigest,
        record.salt,
        record.kdf,
        record.kdfParams,
        record.kid,
        Date.now() - 1000,
        Date.now() + 600000,
      ],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: [`ap:${id}`, id],
    },
    ...["node:read", "node:create", "node:write", "node:delete"].map((scope) => ({
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,?)",
      values: [`ap:${id}`, scope],
    })),
  ]);
  const principal = {
    kind: "app_password" as const,
    user_id: recipient.ids.user,
    credential_id: `ap:${id}`,
    epoch: 1,
  };
  const app = admittedDavEnv();
  const base = `/dav/Shared/${encodeURIComponent(mount!)}`;
  const call = (method: string, path = base, headers: Record<string, string> = {}, body?: string) =>
    handleDavHttp(
      new Request(origin + path, {
        method,
        headers: {
          Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
          ...(body !== undefined && ["PROPPATCH", "LOCK", "PROPFIND"].includes(method)
            ? { "Content-Type": "application/xml" }
            : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
      }),
      app,
      1,
      ring,
    );
  const revoke = () => updateInternalShare(mutationEnv(), session, share.id, share.version, null);
  return {
    owner,
    recipient,
    session,
    share,
    broader,
    broaderMount,
    mount,
    id,
    principal,
    app,
    base,
    call,
    revoke,
  };
}
