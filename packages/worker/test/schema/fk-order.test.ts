import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { purgeOrder } from "../../src/services/purgeOrder.js";
import { applyFoundationMigration } from "../helpers/foundation.js";

describe("foundation schema FK graph", () => {
  it("applies with foreign keys enabled and no violations", async () => {
    await applyFoundationMigration();
    const enabled = await env.DB.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
    expect(enabled?.foreign_keys).toBe(1);
    const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(violations.results).toEqual([]);
  });

  it("keeps purgeOrder topological for every node-owned FK", async () => {
    await applyFoundationMigration();
    const order: readonly string[] = purgeOrder;
    const required = [
      "trash_members",
      "node_props",
      "node_tags",
      "node_media",
      "node_audio",
      "library_roots",
      "library_items",
      "library_jobs",
      "archive_index",
      "user_reading_state",
      "user_playback_state",
      "shares",
      "share_grants",
      "node_versions",
      "locks",
      "uploads",
      "search_index",
      "nodes",
    ];
    expect(order).toEqual(expect.arrayContaining(required));

    for (const child of order) {
      const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list(${child})`).all<{
        table: string;
      }>();
      for (const foreignKey of foreignKeys.results) {
        const parentIndex = order.indexOf(foreignKey.table);
        if (parentIndex >= 0 && foreignKey.table !== child) {
          expect(order.indexOf(child), `${child} must precede ${foreignKey.table}`).toBeLessThan(
            parentIndex,
          );
        }
      }
    }
  });
});
