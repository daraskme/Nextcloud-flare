import { env } from "cloudflare:workers";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { davUploadRow } from "../../src/services/davUpload";
import { type PutFileRequest, putFile } from "../../src/services/putFile";
import { foundationFixture } from "./foundation";
import { admitted } from "./uploadEnv";

export async function davPutFixture(size = 3) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000),
    id = crypto.randomUUID();
  await atomicBatch(env.DB, [
    ...f.statements,
    {
      sql: `INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
      VALUES(?,?,?,'DAV','hash','salt','PBKDF2-SHA256','{"iterations":100000}','test',?,?)`,
      values: [id, f.ids.user, f.ids.folder, Date.now() - 1000, Date.now() + 600000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: ["ap:" + id, id],
    },
    ...["node:create", "node:write", "node:read"].map((scope) => ({
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,?)",
      values: ["ap:" + id, scope],
    })),
  ]);
  const input: Omit<PutFileRequest, "body"> = {
    principal: { kind: "app_password", user_id: f.ids.user, credential_id: "ap:" + id, epoch: 1 },
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "dav.txt",
    size,
    mime: "text/plain",
    lockTokens: [],
  };
  const app = admitted();
  const run = (
    options: Partial<Env> = {},
    body: ReadableStream<Uint8Array> = new Blob(["abc".slice(0, size)]).stream(),
  ) => putFile({ ...app, ...options }, { ...input, body });
  const op = () =>
    env.DB.prepare("SELECT op_id FROM operations WHERE credential_id=? AND kind='dav.put'")
      .bind(input.principal.credential_id)
      .first<string>("op_id");
  const row = async () => {
    const id = await op();
    return id ? davUploadRow(env.DB, id) : null;
  };
  const counters = () =>
    env.DB.prepare("SELECT reserved_bytes,physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first();
  const conflict = () =>
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'dav.txt','dav.txt','folder',1,1)",
    )
      .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.folder)
      .run();
  return { ...f, input, app, run, op, row, counters, conflict };
}

export function davBucket(overrides: Partial<R2Bucket>): R2Bucket {
  return new Proxy(env.BLOBS, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
