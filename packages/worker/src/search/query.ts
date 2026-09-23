import { normalizeSearchText, SEARCH_NAME_VERSION } from "@next-cloud-flare/shared/names";

// unicode61 uses Unicode 6.1. These stable letter/number ranges are known token
// characters. Other scalars still participate in the final literal comparison.
const INDEXED_PAIR = /^[a-z0-9\u03b1-\u03c9\u0430-\u044f\u3041-\u3096\u4e00-\u9fcc]{2}$/u;

export function searchQuery(input: string) {
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  if (typeof input !== "string" || input.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(input))
    throw new Error("invalid_search_query");
  const text = normalizeSearchText(input.trim());
  if (!text || bytes(input) > 256 || bytes(text) > 256) throw new Error("invalid_search_query");
  const scalars = [...text];
  const pairs = [...new Set(scalars.slice(0, -1).map((c, i) => c + scalars[i + 1]))].filter(
    (pair) => INDEXED_PAIR.test(pair),
  );
  const match = pairs.map((pair) => `"${pair.replaceAll('"', '""')}"`).join(" AND ");
  const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
  if (!match && bytes(pattern) > 50) throw new Error("invalid_search_query");
  return Object.freeze({ text, match, pattern, version: SEARCH_NAME_VERSION });
}
