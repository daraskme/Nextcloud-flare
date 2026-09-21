import { LIMITS } from "@ncf/shared";

export async function derivePbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number = LIMITS.pbkdf2Iterations,
): Promise<ArrayBuffer> {
  const passwordBytes = new TextEncoder().encode(password);
  if (passwordBytes.byteLength > LIMITS.maxPasswordBytes) {
    throw new RangeError("Password exceeds the configured byte limit");
  }
  if (salt.byteLength !== 16) {
    throw new RangeError("PBKDF2 salt must be 16 bytes");
  }
  if (iterations !== LIMITS.pbkdf2Iterations) {
    throw new RangeError("PBKDF2 iteration count is not approved");
  }

  const key = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
