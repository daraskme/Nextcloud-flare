import { caseFold } from "unicode-case-folding";

export const NAME_FOLD_VERSION = "unicode-17.0.0";
export interface PortableName {
  readonly name: string;
  readonly nameCi: string;
  readonly hidden: boolean;
}

/** JSON names are not URL-decoded. A URL adapter must decode exactly once before this call. */
export function portableName(input: string): PortableName {
  if (typeof input !== "string" || input.length > 1024 || /[\p{Cc}\p{Cs}<>:"/\\|?*]/u.test(input))
    throw new Error("invalid_name");
  const name = input.normalize("NFC");
  if (!name || name === "." || name === ".." || /[. ]$/.test(name)) throw new Error("invalid_name");
  const base = name.split(".")[0]?.trimEnd() ?? "";
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(base)) throw new Error("invalid_name");
  const encoder = new TextEncoder();
  if ([...name].length >= 255 || encoder.encode(name).byteLength > 255)
    throw new Error("name_too_long");
  const nameCi = caseFold(name);
  if (nameCi === "shared" || nameCi.startsWith(".ncf-")) throw new Error("reserved_name");
  if (encoder.encode(nameCi).byteLength > 1024) throw new Error("name_too_long");
  return Object.freeze({ name, nameCi, hidden: name.startsWith(".") });
}

export const SEARCH_NAME_VERSION = `ncf-name-bigram-1-${NAME_FOLD_VERSION}`;

/** Shared by persisted names and queries; queries are text, not portable filenames. */
export function normalizeSearchText(input: string): string {
  return [...caseFold(input.normalize("NFKC")).normalize("NFD")]
    .map((char) => {
      const cp = char.codePointAt(0) ?? 0;
      return (cp >= 0x30a1 && cp <= 0x30f6) || cp === 0x30fd || cp === 0x30fe
        ? String.fromCodePoint(cp - 0x60)
        : char;
    })
    .join("")
    .normalize("NFC");
}

/** Initial folder-name index. Media metadata composition is added by its own bounded parser. */
export function searchName(input: string): { textNorm: string; tokens: string; version: string } {
  const { name } = portableName(input);
  const textNorm = normalizeSearchText(name);
  const scalars = [...textNorm];
  const tokens =
    scalars.length === 1
      ? textNorm
      : scalars
          .slice(0, -1)
          .map((char, i) => char + scalars[i + 1])
          .join(" ");
  return { textNorm, tokens, version: SEARCH_NAME_VERSION };
}
