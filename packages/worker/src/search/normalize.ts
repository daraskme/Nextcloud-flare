const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const HIRAGANA_OFFSET = 0x60;

export function normalizeSearchText(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
  return Array.from(normalized, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= KATAKANA_START && code <= KATAKANA_END
      ? String.fromCodePoint(code - HIRAGANA_OFFSET)
      : character;
  })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export function searchBigrams(value: string): string[] {
  const characters = Array.from(value);
  if (characters.length < 2) return [];
  return Array.from(
    { length: characters.length - 1 },
    (_, index) => `${characters[index] ?? ""}${characters[index + 1] ?? ""}`,
  );
}

export function searchTokens(value: string): string {
  return searchBigrams(value).join(" ");
}

export function ftsBigramQuery(value: string): string {
  return searchBigrams(value)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
