import { NAME_FOLD_VERSION, portableName, searchName } from "@next-cloud-flare/shared/names";
import { expect, it } from "vitest";

it.each([
  "",
  ".",
  "..",
  "tail.",
  "tail ",
  "a/b",
  "a\\b",
  "a:b",
  "a?b",
  "a*b",
  "a|b",
  "a<b",
  'a"b',
  "a\0b",
  "a\nb",
  "a\u0085b",
  "\ud800",
  "\udfff",
  "CON",
  "con.txt",
  "CON .txt",
  "NUL",
  "aux.jpg",
  "COM1",
  "LPT9.log",
  "COM¹.txt",
  "LPT²",
  "Shared",
  "SHARED",
  ".ncf-cache",
])("rejects non-portable or reserved name %j", (name) => {
  expect(() => portableName(name)).toThrow();
});

it("normalizes NFC and uses locale-independent full case folding", () => {
  expect(NAME_FOLD_VERSION).toBe("unicode-17.0.0");
  expect(portableName("e\u0301")).toEqual(portableName("é"));
  expect(portableName("Straße").nameCi).toBe(portableName("STRASSE").nameCi);
  expect(portableName("Σςσ").nameCi).toBe("σσσ");
  expect(portableName("İ").nameCi).toBe("i\u0307");
  expect(portableName("I").nameCi).not.toBe(portableName("ı").nameCi);
  expect(portableName("\u{1e900}").nameCi).toBe("\u{1e922}");
});

it("allows hidden sidecars, astral scalars and literal percent escapes without decoding twice", () => {
  for (const name of [".DS_Store", "._picture.avif"]) expect(portableName(name).hidden).toBe(true);
  expect(portableName("photo😀.avif").name).toBe("photo😀.avif");
  expect(portableName("%2F").name).toBe("%2F");
  expect(portableName("LPT10.txt").hidden).toBe(false);
});

it("enforces both UTF-8 bytes and scalar count after NFC", () => {
  expect(portableName("a".repeat(254)).name.length).toBe(254);
  expect(() => portableName("a".repeat(255))).toThrow("name_too_long");
  expect(portableName("あ".repeat(85)).name.length).toBe(85);
  expect(() => portableName("あ".repeat(86))).toThrow("name_too_long");
  expect(portableName("😀".repeat(63)).name).toBe("😀".repeat(63));
  expect(() => portableName("😀".repeat(64))).toThrow("name_too_long");
  expect(portableName("e\u0301".repeat(127)).name).toBe("é".repeat(127));
});

it("builds name search text and scalar bigrams with a versioned normalization", () => {
  expect(searchName("ｶﾀｶﾅＡＢＣ")).toMatchObject({
    textNorm: "かたかなabc",
    tokens: "かた たか かな なa ab bc",
  });
  expect(searchName("ヷ").textNorm).toBe("わ\u3099");
  expect(searchName("😀a").tokens).toBe("😀a");
  expect(searchName("本").tokens).toBe("本");
  expect(searchName("Straße").textNorm).toBe("strasse");
});
