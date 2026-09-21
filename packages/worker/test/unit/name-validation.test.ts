import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mapError, type AppContext } from "../../src/api/http.js";
import { normalizePortableName } from "../../src/services/fsMutation.js";
import { NameConflictError } from "../../src/services/nameConflict.js";

describe("portable name validation", () => {
  it("normalizes NFC and accepts Unicode names within the UTF-8 byte limit", () => {
    expect(normalizePortableName("旅行メモ.txt")).toEqual({
      name: "旅行メモ.txt",
      nameCi: "旅行メモ.txt",
    });
    expect(normalizePortableName("同人誌 vol.1.cbz").name).toBe("同人誌 vol.1.cbz");
    expect(normalizePortableName("写真📷.jpg").name).toBe("写真📷.jpg");
    expect(normalizePortableName("Cafe\u0301.txt").name).toBe("Café.txt");
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    " leading.txt",
    "trailing.txt ",
    ".hidden-leading-dot",
    "trailing.",
    "CON.txt",
    "bad:name",
    "bad/name",
    "bad\\name",
    "bad\u0000name",
    "あ".repeat(86),
  ])("rejects invalid portable name %j", (name) => {
    expect(() => normalizePortableName(name)).toThrow("invalid_name");
  });

  it("maps invalid names before duplicate-name handling", async () => {
    const app = new Hono();
    app.get("/", (context) =>
      mapError(context as unknown as AppContext, new RangeError("invalid_name")),
    );
    const response = await app.request("http://localhost/");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_name",
        message: "The name contains a forbidden character or exceeds 255 UTF-8 bytes",
      },
    });
  });

  it("returns the conflicting node and revision in a name conflict", async () => {
    const app = new Hono();
    app.get("/", (context) =>
      mapError(context as unknown as AppContext, new NameConflictError("node", 7)),
    );
    const response = await app.request("http://localhost/");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "name_conflict", existingNodeId: "node", revision: 7 },
    });
  });
});
