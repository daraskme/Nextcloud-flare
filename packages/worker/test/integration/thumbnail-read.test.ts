import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import { issueContentTicket } from "../../src/services/contentTicket";
import { loadTargetManifest } from "../../src/services/targetManifest";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function tokens(): Promise<ContentTokens> {
  const ticket = await contentKeyRing("ticket", {
    ticket: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cookie = await contentKeyRing("cookie", {
    cookie: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  return new ContentTokens(ticket, cookie, "https://content.invalid");
}

it("serves only ready thumb targets with immutable HTTP semantics", async () => {
  const now = Date.now() - 1_000;
  const f = foundationFixture(crypto.randomUUID(), now);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0,epoch=1 WHERE singleton=1").run();
  const originalKey = `u/${f.ids.user}/b/${f.ids.blob}`;
  const original = await env.BLOBS.put(originalKey, "abc");
  if (!original) throw new Error("fixture_r2_put_failed");
  const derivativeId = crypto.randomUUID();
  const claim = crypto.randomUUID();
  const derivativeKey = `u/${f.ids.user}/d/${f.ids.blob}/image-sm256-v1/sm256/${claim}.webp`;
  const derivative = await env.BLOBS.put(derivativeKey, "thumb");
  if (!derivative) throw new Error("fixture_r2_put_failed");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
      values: [f.ids.blob, original.etag, now],
    },
    {
      sql: `INSERT INTO node_media(node_id,blob_id,generator_version,width,height)
        VALUES(?,?,'image-metadata-v1',1,1)`,
      values: [f.ids.file, f.ids.blob],
    },
    {
      sql: `INSERT INTO derivative_results
        (id,blob_id,kind,variant,generator_version,state,epoch,attempts,r2_key,size,r2_etag)
        VALUES(?,?,'thumbnail','sm256','image-sm256-v1','ready',1,1,?,?,?)`,
      values: [derivativeId, f.ids.blob, derivativeKey, derivative.size, derivative.etag],
    },
  ]);
  const contentTokens = await tokens();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const issued = [];
  try {
    const thumb = await issueContentTicket(
      mutationEnv(),
      env.BLOBS,
      contentTokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "thumb",
      Date.now() + 300_000,
    );
    issued.push(thumb.targetSetId);
    const target = await env.DB.prepare(
      "SELECT id,manifest_ref AS ref,manifest_hash AS hash,total_bytes AS totalBytes FROM target_sets WHERE id=?",
    )
      .bind(thumb.targetSetId)
      .first<{ id: string; ref: string; hash: string; totalBytes: number }>();
    if (!target) throw new Error("fixture_target_missing");
    expect(target.totalBytes).toBe(derivative.size);
    expect(await loadTargetManifest(env.BLOBS, target)).toMatchObject({
      targets: [
        {
          nodeId: f.ids.file,
          blobId: f.ids.blob,
          purpose: "thumb",
          size: derivative.size,
        },
      ],
    });
    const accepted = await acceptContentTicket(mutationEnv(), contentTokens, thumb.ticket);
    const cookie = accepted.setCookie.split(";", 1)[0]!;
    const appEnv = {
      ...mutationEnv(),
      APP_ORIGIN: "https://app.invalid",
      CONTENT_ORIGIN: "https://content.invalid",
    };
    const request = (path: string, init?: RequestInit) =>
      handleContentHttp(
        new Request(`https://content.invalid${path}`, {
          ...init,
          headers: { Cookie: cookie, Origin: "https://app.invalid", ...init?.headers },
        }),
        appEnv,
        contentTokens,
      );
    const mismatchedBucket = new Proxy(env.BLOBS, {
      get(target, property, receiver) {
        if (property !== "head") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (key: string) => {
          const object = await target.head(key);
          if (!object || key !== derivativeKey) return object;
          return { ...object, etag: "wrong" } as R2Object;
        };
      },
    });
    expect(
      (
        await handleContentHttp(
          new Request(`https://content.invalid/c/${f.ids.file}/${f.ids.blob}/thumb`, {
            headers: { Cookie: cookie },
          }),
          { ...appEnv, BLOBS: mismatchedBucket },
          contentTokens,
        )
      ).status,
    ).toBe(503);
    const full = await request(`/c/${f.ids.file}/${f.ids.blob}/thumb`);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("image/webp");
    expect(full.headers.get("Cache-Control")).toBe("private, no-store");
    expect(full.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(full.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(new TextDecoder().decode(await full.arrayBuffer())).toBe("thumb");
    const etag = full.headers.get("ETag");
    expect(etag).toMatch(/^"thumb-/);
    const partial = await request(`/c/${f.ids.file}/${f.ids.blob}/thumb`, {
      headers: { Range: "bytes=1-3" },
    });
    expect(partial.status).toBe(206);
    expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe("hum");
    const unsatisfiable = await request(`/c/${f.ids.file}/${f.ids.blob}/thumb`, {
      headers: { Range: "bytes=5-" },
    });
    expect(unsatisfiable.status).toBe(416);
    const head = await request(`/c/${f.ids.file}/${f.ids.blob}/thumb`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("5");
    expect(await head.text()).toBe("");
    const cached = await request(`/c/${f.ids.file}/${f.ids.blob}/thumb`, {
      headers: { "If-None-Match": etag! },
    });
    expect(cached.status).toBe(304);
    expect(await request(`/c/${f.ids.file}/${f.ids.blob}`)).toMatchObject({ status: 404 });

    const content = await issueContentTicket(
      mutationEnv(),
      env.BLOBS,
      contentTokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      Date.now() + 300_000,
    );
    issued.push(content.targetSetId);
    const contentAccepted = await acceptContentTicket(mutationEnv(), contentTokens, content.ticket);
    const contentCookie = contentAccepted.setCookie.split(";", 1)[0]!;
    const isolated = await handleContentHttp(
      new Request(`https://content.invalid/c/${f.ids.file}/${f.ids.blob}/thumb`, {
        headers: { Cookie: contentCookie },
      }),
      appEnv,
      contentTokens,
    );
    expect(isolated.status).toBe(404);
    await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(f.ids.file).run();
    expect(await request(`/c/${f.ids.file}/${f.ids.blob}/thumb`)).toMatchObject({ status: 404 });
  } finally {
    await env.BLOBS.delete([
      originalKey,
      derivativeKey,
      ...issued.map((id) => `target-sets/${id}`),
    ]);
  }
});
