import { CONTROL_NAME } from "../do/ControlDO";
import type { Env } from "../env";
import { KdfUnavailableError } from "./kdf";

export type KdfDeriver = (
  input: ArrayBuffer,
  salt: Uint8Array,
  signal?: AbortSignal,
) => Promise<ArrayBuffer>;
export interface KdfRequest {
  id: string;
  epoch: number;
  deadline: number;
  input: ArrayBuffer;
  salt: Uint8Array;
}

/** No local fallback and no automatic RPC retry: every derivation spends a distinct attempt. */
export function globalKdf(control: Env["CONTROL"], epoch: number): KdfDeriver {
  return async (input, salt, signal) => {
    if (signal?.aborted) throw new KdfUnavailableError();
    try {
      const result = await control.get(control.idFromName(CONTROL_NAME)).deriveKdf({
        id: crypto.randomUUID(),
        epoch,
        deadline: Date.now() + 5000,
        input,
        salt,
      });
      if (signal?.aborted || !(result instanceof ArrayBuffer) || result.byteLength !== 32)
        throw new KdfUnavailableError();
      return result;
    } catch {
      // RPC errors do not preserve Error subclasses. Never misreport overload as bad credentials.
      throw new KdfUnavailableError();
    }
  };
}
