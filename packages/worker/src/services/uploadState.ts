import { assertUploadTransition, type UploadState } from "@ncf/shared";

import type { Env } from "../env.js";

export async function transitionUpload(
  env: Env,
  uploadId: string,
  from: UploadState,
  to: UploadState,
  now = Date.now(),
): Promise<void> {
  assertUploadTransition(from, to);
  await env.DB.batch([
    env.DB.prepare("UPDATE uploads SET state=?1,updated_at=?2 WHERE id=?3 AND state=?4").bind(
      to,
      now,
      uploadId,
      from,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}
