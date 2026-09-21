import { describe, expect, it } from "vitest";

import { buildExportArguments, exportTables } from "../../src/backup/exportTables.js";

describe("logical export table list", () => {
  it("exports every normal table without virtual FTS tables", () => {
    expect(exportTables).toContain("search_index");
    expect(exportTables.some((table) => table.includes("fts"))).toBe(false);
    expect(buildExportArguments("database")).not.toContain("--table=search_fts");
  });
});
