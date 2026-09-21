import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { seedFoundation } from "../helpers/foundation.js";

beforeEach(() => seedFoundation());

describe("purge parent with independently trashed child", () => {
  it("detaches only the already-deleted child before deleting its parent", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,deleted_at,deleted_op_id,hidden) VALUES('parent','space','user','root','parent','parent','folder',NULL,1,?1,?1,NULL,NULL,0)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES('trash-child','user','space','child','trashed',?1,1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,deleted_at,deleted_op_id,hidden) VALUES('child','space','user','parent','child','child','folder',NULL,1,?1,?1,?1,'trash-child',0)",
      ).bind(now),
    ]);

    await expect(env.DB.prepare("DELETE FROM nodes WHERE id='parent'").run()).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE nodes SET parent_id=NULL WHERE id='child' AND deleted_at IS NOT NULL AND deleted_op_id='trash-child'",
    ).run();
    await expect(
      env.DB.prepare("DELETE FROM nodes WHERE id='parent'").run(),
    ).resolves.toBeDefined();

    const child = await env.DB.prepare("SELECT parent_id FROM nodes WHERE id='child'").first<{
      parent_id: string | null;
    }>();
    expect(child?.parent_id).toBeNull();
  });
});
