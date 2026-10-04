import { base64url } from "jose";

/** Canonical source scope: exact IPv4 address or IPv6 /64; unknown is one bucket. */
export function shareSourceScope(input: string | null): string {
  if (!input || input.length > 64) return "unknown";
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(input)) {
    const parts = input.split(".").map(Number);
    if (parts.every((part) => Number.isInteger(part) && part <= 255))
      return `v4:${parts.join(".")}`;
    return "unknown";
  }
  if (!input.includes(":") || /[%\[\]]/.test(input)) return "unknown";
  let canonical: string;
  try {
    const url = new URL(`http://[${input}]/`);
    canonical = url.hostname.slice(1, -1);
  } catch {
    return "unknown";
  }
  const halves = canonical.split("::");
  if (halves.length > 2) return "unknown";
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
    return "unknown";
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return "unknown";
  if (
    words.slice(0, 5).every((word) => Number.parseInt(word, 16) === 0) &&
    Number.parseInt(words[5]!, 16) === 0xffff
  ) {
    const high = Number.parseInt(words[6]!, 16);
    const low = Number.parseInt(words[7]!, 16);
    return `v4:${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return `v6:${words
    .slice(0, 4)
    .map((word) => word.padStart(4, "0"))
    .join(":")}`;
}

/** Never persist or log the platform-provided address/prefix. */
export async function shareSourceDigest(
  key: CryptoKey,
  shareId: string,
  source: string | null,
): Promise<string> {
  const message = new TextEncoder().encode(
    JSON.stringify(["ncf-share-session-source-v1", shareId, shareSourceScope(source)]),
  );
  return base64url.encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
}
