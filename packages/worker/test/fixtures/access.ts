import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AccessVerifier } from "../../src/auth/access";
import { AccessJwks, type JwksCache, type JwksFetch } from "../../src/auth/jwks";

export async function accessFixture(issuer = "https://access.invalid", now = () => Date.now()) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwks = {
    keys: [{ ...(await exportJWK(publicKey)), kid: "key-one", alg: "RS256", use: "sig" }],
  };
  const store = new Map<string, string>();
  const cache = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as JwksCache;
  const fetcher: JwksFetch = async () => Response.json(jwks);
  const keySource = new AccessJwks(issuer, cache, fetcher, now);
  const verifier = new AccessVerifier(keySource, "private-aud", "service-aud", now);
  async function sign(
    changes: Record<string, unknown> = {},
    headers: Record<string, unknown> = {},
  ) {
    const iat = Math.floor(now() / 1000) - 1;
    const payload = {
      iss: issuer,
      aud: ["private-aud"],
      type: "app",
      sub: "owner",
      email: "owner@example.invalid",
      iat,
      nbf: iat,
      exp: iat + 3600,
      ...changes,
    };
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "key-one", ...headers })
      .sign(privateKey);
    return new Request("https://app.invalid/api/v1/me", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
  }
  return { jwks, cache, store, fetcher, verifier, sign, issuer, privateKey };
}
