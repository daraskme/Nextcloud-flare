import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { assertBlobRecoverable } from "../../src/services/restore.js";
import { seedFoundation } from "../helpers/foundation.js";

beforeEach(() => seedFoundation());

describe("restore deleting blob", () => {
  it("treats deleting as irrecoverable", async () => {
    await env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,ref_count,state,created_at) VALUES('blob','user','u/user/b/blob',1,'etag',0,'deleting',?1)",
    )
      .bind(Date.now())
      .run();
    await expect(assertBlobRecoverable(env, "blob")).rejects.toThrow("blob_unrecoverable");
  });
});
