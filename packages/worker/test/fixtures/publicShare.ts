import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { handlePublicShareHttp } from "../../src/api/publicShares";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { atomicBatch } from "../../src/db/primary";
import { createLinkShare } from "../../src/services/linkShares";
import { unlockShare } from "../../src/services/shareUnlock";
import { foundationFixture } from "./foundation";
import { mutationEnv } from "./mutationAdmission";
import { admitted } from "./uploadEnv";

const origin = "https://app.invalid";
export async function publicShareFixture(
  role: "read" | "edit" = "edit",
  root: "folder" | "file" = "folder",
) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const app = {
    ...admitted(),
    CONTROL: mutationEnv().CONTROL,
    APP_ORIGIN: origin,
    EDGE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createLinkShare(app, owner, { kind: "link", rootNodeId: f.ids[root], role });
  const key = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await contentKeyRing("test", { test: key });
  const tokens = new ShareTokens(ring, origin);
  const deps = {
    tokens,
    csrf: new CsrfTokens({ activeKid: "none", keys: new Map() }, ring, origin),
  };
  const session = await unlockShare(app, (await tokens.challenge(share.id, 1)).claims, {
    secret: share.secret,
  });
  const cookie = `__Host-ncf_share_${share.id}=${await tokens.issue(session.claims)}`;
  const request = (
    suffix: string,
    method = "GET",
    body?: unknown,
    csrf?: string,
    idempotency = crypto.randomUUID(),
  ) =>
    new Request(
      `${origin}${suffix.startsWith("/api/") ? suffix : `/api/v1/public/shares/${share.id}${suffix}`}`,
      {
        method,
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          Cookie: cookie,
          "CF-Connecting-IP": "192.0.2.1",
          "Share-Session": session.claims.session_id,
          "X-Share-Id": share.id,
          ...(method === "GET"
            ? {}
            : { "Content-Type": "application/json", "Idempotency-Key": idempotency }),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  const http = (r: Request, db = env.DB) => handlePublicShareHttp(r, { ...app, DB: db }, 1, deps);
  const { token } = await (await http(request("/csrf", "POST"))).json<{ token: string }>();
  const create = (name = "公開作成", idempotency = crypto.randomUUID()) =>
    request(
      "/nodes",
      "POST",
      {
        kind: "folder",
        parentId: f.ids.folder,
        name,
      },
      token,
      idempotency,
    );
  return { f, app, owner, share, session, cookie, key, deps, request, http, token, create };
}
