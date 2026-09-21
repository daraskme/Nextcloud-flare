const TOKEN_TTL_MS = 60 * 60 * 1000;

interface CsrfPayload {
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function issueCsrfToken(
  secret: string,
  sessionId: string,
  now = Date.now(),
): Promise<string> {
  const payload: CsrfPayload = { sessionId, issuedAt: now, expiresAt: now + TOKEN_TTL_MS };
  const encodedPayload = encode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${encode(new Uint8Array(signature))}`;
}

export async function verifyCsrfToken(
  secret: string,
  token: string,
  sessionId: string,
  now = Date.now(),
): Promise<boolean> {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (encodedPayload === undefined || encodedSignature === undefined || extra !== undefined) {
    return false;
  }
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await importKey(secret),
    decode(encodedSignature),
    new TextEncoder().encode(encodedPayload),
  );
  if (!validSignature) {
    return false;
  }
  let payload: CsrfPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decode(encodedPayload))) as CsrfPayload;
  } catch {
    return false;
  }
  return (
    payload.sessionId === sessionId &&
    Number.isInteger(payload.issuedAt) &&
    Number.isInteger(payload.expiresAt) &&
    payload.expiresAt - payload.issuedAt === TOKEN_TTL_MS &&
    payload.issuedAt <= now &&
    payload.expiresAt > now
  );
}
