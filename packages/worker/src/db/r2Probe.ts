import { BINDING_PROBE_KEY, isProbeNonce } from "../r2/bindingProbe";
import { assertExists, type SqlStatement } from "./primary";
import type { R2WriteRequest } from "./r2Write";

export interface R2ProbeProof {
  token: string;
  nonce: string;
  source: string;
  expectedEtag: string | null;
  stop?: { revision: number; token: string; expiresAt: number };
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function validateProbeWrite(request: R2WriteRequest): void {
  const p = request.probe;
  if (
    !p ||
    request.ownerId !== null ||
    request.key !== BINDING_PROBE_KEY ||
    request.gc !== undefined ||
    request.upload !== undefined ||
    request.abort !== undefined ||
    !uuid.test(p.token) ||
    !isProbeNonce(p.nonce) ||
    typeof p.source !== "string" ||
    p.source.length < 1 ||
    p.source.length > 512 ||
    !(
      p.expectedEtag === null ||
      (typeof p.expectedEtag === "string" &&
        p.expectedEtag.length > 0 &&
        p.expectedEtag.length <= 256)
    ) ||
    (p.stop !== undefined &&
      (!Number.isSafeInteger(p.stop.revision) ||
        p.stop.revision < 1 ||
        !uuid.test(p.stop.token) ||
        !Number.isSafeInteger(p.stop.expiresAt) ||
        p.stop.expiresAt < request.deadline))
  )
    throw new Error("invalid_r2_write");
}

/** Match the immutable challenge and original CAS in the same batch as its dispatch receipt. */
export function probeWriteProof(request: R2WriteRequest): SqlStatement[] {
  const p = request.probe!;
  return [
    assertExists(
      `SELECT 1 FROM r2_binding_probe p JOIN control c ON c.singleton=p.singleton
      WHERE p.singleton=1 AND p.epoch=? AND c.epoch=p.epoch AND c.maintenance=1 AND c.gc_paused=1
      AND p.r2_key=? AND p.lease_token=? AND p.lease_expires_at>=? AND p.nonce=? AND p.source=?
      AND p.phase='prepared' AND p.expected_etag IS ?`,
      [request.epoch, request.key, p.token, request.deadline, p.nonce, p.source, p.expectedEtag],
    ),
    ...(p.stop
      ? [
          assertExists(
            "SELECT 1 FROM control WHERE singleton=1 AND admission_revision=? AND admission_token=?",
            [p.stop.revision, p.stop.token],
          ),
        ]
      : []),
  ];
}
