import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { verifyAccessJwt } from "../../src/auth/accessJwt.js";

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return encode(new TextEncoder().encode(JSON.stringify(value)));
}

async function createSigner(kid: string): Promise<{
  jwk: JsonWebKey & { kid: string };
  sign: (payload: Record<string, unknown>) => Promise<string>;
}> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { ...exported, alg: "RS256", kid, use: "sig" };
  return {
    jwk,
    async sign(payload) {
      const header = encodeJson({ alg: "RS256", typ: "JWT", kid });
      const body = encodeJson(payload);
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${header}.${body}`),
      );
      return `${header}.${body}.${encode(new Uint8Array(signature))}`;
    },
  };
}

function claims(now: number): Record<string, unknown> {
  return {
    type: "app",
    iss: env.ACCESS_ISSUER,
    aud: [env.ACCESS_USER_AUD],
    iat: Math.floor(now / 1000),
    nbf: Math.floor(now / 1000) - 1,
    exp: Math.floor(now / 1000) + 14_400,
    sub: "subject",
    email: "user@test.invalid",
  };
}

describe("Cloudflare Access JWT verifier", () => {
  it("verifies RS256 and reuses a stale known key when refresh is unavailable", async () => {
    const now = Date.now();
    const signer = await createSigner(`kid-${crypto.randomUUID()}`);
    const token = await signer.sign(claims(now));
    let fetches = 0;
    const fetcher: typeof fetch = () => {
      fetches += 1;
      return Promise.resolve(Response.json({ keys: [signer.jwk] }));
    };
    const verified = await verifyAccessJwt(env, token, "user", { fetcher, now: () => now });
    expect(verified).toMatchObject({
      issuer: env.ACCESS_ISSUER,
      subject: "subject",
      email: "user@test.invalid",
    });
    expect(fetches).toBe(1);

    const stale = await verifyAccessJwt(env, token, "user", {
      fetcher: () => Promise.reject(new Error("offline")),
      now: () => now + 2 * 60 * 60 * 1000,
    });
    expect(stale.subject).toBe("subject");
  });

  it("single-flights an unknown kid and rejects claim/header boundary violations", async () => {
    const now = Date.now();
    const signer = await createSigner(`kid-${crypto.randomUUID()}`);
    const token = await signer.sign(claims(now));
    let fetches = 0;
    const fetcher: typeof fetch = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ keys: [signer.jwk] });
    };
    const results = await Promise.all([
      verifyAccessJwt(env, token, "user", { fetcher, now: () => now }),
      verifyAccessJwt(env, token, "user", { fetcher, now: () => now }),
    ]);
    expect(results).toHaveLength(2);
    expect(fetches).toBe(1);

    const wrongAudience = await signer.sign({ ...claims(now), aud: ["wrong"] });
    await expect(
      verifyAccessJwt(env, wrongAudience, "user", { fetcher, now: () => now }),
    ).rejects.toThrow("invalid_access_claims");
    await expect(
      verifyAccessJwt(env, `${token},${token}`, "user", { fetcher, now: () => now }),
    ).rejects.toThrow("invalid_access_token");
    const future = await signer.sign({
      ...claims(now),
      nbf: Math.floor(now / 1000) + 120,
    });
    await expect(verifyAccessJwt(env, future, "user", { fetcher, now: () => now })).rejects.toThrow(
      "invalid_access_claims",
    );
  });
});
