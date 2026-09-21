export interface DavConditionContext {
  etag: string | null;
  lockTokens: ReadonlySet<string>;
}

interface Condition {
  negate: boolean;
  kind: "etag" | "token";
  value: string;
}

interface ConditionList {
  resource: string | null;
  conditions: Condition[];
}

export interface ParsedDavIf {
  lists: ConditionList[];
  submittedTokens: Set<string>;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) index += 1;
  return index;
}

export function parseDavIf(value: string | null): ParsedDavIf {
  if (value === null || value.trim() === "") return { lists: [], submittedTokens: new Set() };
  if (value.length > 16_384) throw new RangeError("DAV If header exceeds the limit");
  const lists: ConditionList[] = [];
  const submittedTokens = new Set<string>();
  let index = 0;
  let resource: string | null = null;
  while (index < value.length) {
    index = skipWhitespace(value, index);
    if (value[index] === "<") {
      const end = value.indexOf(">", index + 1);
      if (end < 0) throw new RangeError("DAV If header is invalid");
      resource = value.slice(index + 1, end);
      index = end + 1;
      index = skipWhitespace(value, index);
    }
    if (value[index] !== "(") throw new RangeError("DAV If header is invalid");
    index += 1;
    const conditions: Condition[] = [];
    for (;;) {
      index = skipWhitespace(value, index);
      if (value[index] === ")") {
        index += 1;
        break;
      }
      let negate = false;
      if (value.slice(index, index + 3).toLowerCase() === "not") {
        const next = value[index + 3];
        if (next !== undefined && !/\s|<|\[/u.test(next)) {
          throw new RangeError("DAV If header is invalid");
        }
        negate = true;
        index = skipWhitespace(value, index + 3);
      }
      const opener = value[index];
      const closer = opener === "<" ? ">" : opener === "[" ? "]" : "";
      if (closer === "") throw new RangeError("DAV If header is invalid");
      const end = value.indexOf(closer, index + 1);
      if (end < 0) throw new RangeError("DAV If header is invalid");
      const token = value.slice(index + 1, end);
      if (token.length === 0 || token.length > 1024)
        throw new RangeError("DAV If header is invalid");
      const kind = opener === "<" ? "token" : "etag";
      conditions.push({ negate, kind, value: token });
      if (kind === "token") submittedTokens.add(token);
      if (conditions.length > 16) throw new RangeError("DAV If condition limit exceeded");
      index = end + 1;
    }
    if (conditions.length === 0) throw new RangeError("DAV If header is invalid");
    lists.push({ resource, conditions });
    if (lists.length > 16) throw new RangeError("DAV If list limit exceeded");
    index = skipWhitespace(value, index);
    if (value[index] === "<") resource = null;
  }
  return { lists, submittedTokens };
}

export function evaluateDavIf(
  parsed: ParsedDavIf,
  requestResource: string,
  contexts: ReadonlyMap<string, DavConditionContext>,
): boolean {
  if (parsed.lists.length === 0) return true;
  return parsed.lists.some((list) => {
    const context = contexts.get(list.resource ?? requestResource);
    if (context === undefined) return false;
    return list.conditions.every((condition) => {
      const matched =
        condition.kind === "etag"
          ? context.etag === condition.value
          : context.lockTokens.has(condition.value);
      return condition.negate ? !matched : matched;
    });
  });
}
