import type { KdfDeriver } from "../../src/auth/globalKdf";

/** Explicit crypto backend for isolated credential fixtures; production always uses ControlDO. */
export const localKdf: KdfDeriver = async (input, salt) => {
  const key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
};
