import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { expect, it } from "vitest";
import { receiptNames } from "../../src/services/uploads/receiptNames";

const id = `up_${"a".repeat(64)}`;
it.each([
  "File.txt",
  ".hidden",
  "資料📚".repeat(20) + ".PDF",
  "a".repeat(250) + ".txt",
  "ＡＢＣ.txt",
])("keeps automatic receipt names portable and search-consistent: %s", (name) => {
  const names = receiptNames(name, id);
  expect(names).toHaveLength(17);
  expect(new Set(names.map((n) => n.nameCi)).size).toBe(17);
  expect(names[0]?.name).toBe(portableName(name).name);
  for (const candidate of names) {
    expect(candidate).toEqual({ ...portableName(candidate.name), ...searchName(candidate.name) });
    expect(new TextEncoder().encode(candidate.name).length).toBeLessThanOrEqual(255);
  }
  if (name.endsWith(".txt")) expect(names.every((n) => n.name.endsWith(".txt"))).toBe(true);
  expect(receiptNames(name, id)).toEqual(names);
  expect(receiptNames(name, `up_${"b".repeat(64)}`).slice(1)).not.toEqual(names.slice(1));
});
it("rejects an invalid receipt identifier", () =>
  expect(() => receiptNames("a.txt", "x")).toThrow());
