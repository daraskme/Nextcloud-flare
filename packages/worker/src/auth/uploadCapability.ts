import { base64url } from "jose";
import type { ContentKeyRing } from "./contentTokens";

export interface UploadCapabilityIdentity {
  readonly id: string;
  readonly credential_id: string;
  readonly epoch: number;
  readonly expires_at: number;
  readonly capability_kid: string;
}

/** Dedicated HMAC ring; deterministic issuance permits recovery of a lost create response. */
export class UploadCapabilities {
  constructor(readonly ring: ContentKeyRing) {}

  #input(row: UploadCapabilityIdentity): Uint8Array {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
      !/^[A-Za-z0-9:_-]{1,256}$/.test(row.credential_id) ||
      !Number.isSafeInteger(row.epoch) ||
      row.epoch < 1 ||
      !Number.isSafeInteger(row.expires_at) ||
      row.expires_at <= 0
    )
      throw new Error("invalid_upload_capability");
    return new TextEncoder().encode(
      JSON.stringify([
        "ncf-upload-capability-v1",
        row.id,
        row.credential_id,
        row.epoch,
        row.expires_at,
      ]),
    );
  }

  async issue(row: UploadCapabilityIdentity): Promise<string> {
    const key = this.ring.keys.get(row.capability_kid);
    if (!key) throw new Error("upload_capability_key_unavailable");
    return `${row.capability_kid}.${base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, this.#input(row))),
    )}`;
  }

  async verify(row: UploadCapabilityIdentity, token: string): Promise<void> {
    if (token.length > 108 || !/^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("invalid_upload_capability");
    const [kid, signature] = token.split(".");
    const key = kid === row.capability_kid ? this.ring.keys.get(kid) : undefined;
    if (
      !key ||
      !signature ||
      base64url.encode(base64url.decode(signature)) !== signature ||
      !(await crypto.subtle.verify("HMAC", key, base64url.decode(signature), this.#input(row)))
    )
      throw new Error("invalid_upload_capability");
  }
}
