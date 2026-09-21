import type { Env } from "../env.js";

export async function reserveQuota(env: Env, userId: string, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError("Reservation bytes are invalid");
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes+?1 WHERE id=?2 AND disabled_at IS NULL AND used_bytes+reserved_bytes+?1<=quota_bytes AND (physical_bytes+reserved_bytes+?1)*10<=quota_bytes*12",
    ).bind(bytes, userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}
