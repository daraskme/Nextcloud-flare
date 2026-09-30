const MAX_HEADER_BYTES = 8192;
const MAX_RESOURCE_TAGS = 16;
const MAX_LISTS = 16;
const MAX_CONDITIONS = 64;
const MAX_CONDITIONS_PER_LIST = 16;
const MAX_TOKEN_BYTES = 256;
const MAX_ETAG_BYTES = 512;
const MAX_RESOURCE_TAG_BYTES = 16_384;

export type DavIfCondition =
  | { readonly kind: "token"; readonly value: string; readonly not: boolean }
  | {
      readonly kind: "etag";
      readonly value: string;
      readonly weak: boolean;
      readonly not: boolean;
    };

export interface DavIfList {
  readonly resourceTag: string | null;
  readonly conditions: readonly DavIfCondition[];
}

export interface DavIfHeader {
  readonly form: "tagged" | "untagged";
  readonly lists: readonly DavIfList[];
  /** Every state token in every branch. Condition truth is evaluated separately. */
  readonly submittedTokens: readonly string[];
}

export interface DavResourceState {
  readonly tokens: ReadonlySet<string>;
  /** Current HTTP entity tag, including quotes and an optional W/ prefix. */
  readonly etag: string | null;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validDelimited(value: string, limit: number): boolean {
  return value.length > 0 && bytes(value) <= limit && !/[\x00-\x20\x7f<>]/.test(value);
}

class Scanner {
  position = 0;

  constructor(readonly source: string) {}

  whitespace(required = false): void {
    const start = this.position;
    while (this.position < this.source.length && /[\t ]/.test(this.source[this.position]!))
      this.position++;
    if (required && this.position === start) throw new Error("invalid_dav_if");
  }

  peek(value: string): boolean {
    return this.source.startsWith(value, this.position);
  }

  take(value: string): void {
    if (!this.peek(value)) throw new Error("invalid_dav_if");
    this.position += value.length;
  }

  delimited(open: "<" | "[", close: ">" | "]", limit: number): string {
    this.take(open);
    const end = this.source.indexOf(close, this.position);
    if (end < 0) throw new Error("invalid_dav_if");
    const value = this.source.slice(this.position, end);
    this.position = end + 1;
    if (!validDelimited(value, limit)) throw new Error("invalid_dav_if");
    return value;
  }
}

function parseEntityTag(raw: string): { value: string; weak: boolean } {
  const weak = raw.startsWith("W/");
  const value = weak ? raw.slice(2) : raw;
  if (
    bytes(raw) > MAX_ETAG_BYTES ||
    value.length < 2 ||
    value[0] !== '"' ||
    value.at(-1) !== '"' ||
    /[\x00-\x20\x7f"]/u.test(value.slice(1, -1))
  )
    throw new Error("invalid_dav_if");
  return { value, weak };
}

function parseList(scanner: Scanner, submitted: Set<string>): DavIfCondition[] {
  scanner.take("(");
  scanner.whitespace();
  const conditions: DavIfCondition[] = [];
  while (!scanner.peek(")")) {
    if (conditions.length >= MAX_CONDITIONS_PER_LIST) throw new Error("invalid_dav_if");
    let not = false;
    if (scanner.peek("Not")) {
      scanner.take("Not");
      scanner.whitespace(true);
      not = true;
    }
    if (scanner.peek("<")) {
      const value = scanner.delimited("<", ">", MAX_TOKEN_BYTES);
      submitted.add(value);
      conditions.push({ kind: "token", value, not });
    } else if (scanner.peek("[")) {
      const parsed = parseEntityTag(scanner.delimited("[", "]", MAX_ETAG_BYTES));
      conditions.push({ kind: "etag", ...parsed, not });
    } else {
      throw new Error("invalid_dav_if");
    }
    scanner.whitespace();
    if (scanner.position >= scanner.source.length) throw new Error("invalid_dav_if");
  }
  scanner.take(")");
  if (conditions.length === 0) throw new Error("invalid_dav_if");
  return conditions;
}

/** Parse RFC 4918 If grammar without evaluating resource state. */
export function parseDavIfHeader(value: string | null): DavIfHeader | null {
  if (value === null) return null;
  if (bytes(value) > MAX_HEADER_BYTES || /[\r\n\x00]/.test(value))
    throw new Error("invalid_dav_if");
  const scanner = new Scanner(value);
  const lists: DavIfList[] = [];
  const submitted = new Set<string>();
  const resourceTags = new Set<string>();
  scanner.whitespace();
  if (scanner.position === value.length) throw new Error("invalid_dav_if");
  const form = scanner.peek("<") ? "tagged" : "untagged";
  let currentTag: string | null = null;
  while (scanner.position < value.length) {
    if (lists.length >= MAX_LISTS) throw new Error("invalid_dav_if");
    if (form === "tagged") {
      if (!scanner.peek("<")) throw new Error("invalid_dav_if");
      currentTag = scanner.delimited("<", ">", MAX_RESOURCE_TAG_BYTES);
      try {
        const parsed = new URL(currentTag);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
          throw new Error("invalid_dav_if");
      } catch {
        throw new Error("invalid_dav_if");
      }
      resourceTags.add(currentTag);
      if (resourceTags.size > MAX_RESOURCE_TAGS) throw new Error("invalid_dav_if");
      scanner.whitespace(true);
      if (!scanner.peek("(")) throw new Error("invalid_dav_if");
    } else if (!scanner.peek("(")) {
      throw new Error("invalid_dav_if");
    }
    do {
      const conditions = parseList(scanner, submitted);
      lists.push({ resourceTag: currentTag, conditions });
      if (lists.length > MAX_LISTS) throw new Error("invalid_dav_if");
      scanner.whitespace();
    } while (scanner.peek("("));
    if (form === "untagged" && scanner.position < value.length) throw new Error("invalid_dav_if");
  }
  if (
    lists.length === 0 ||
    lists.reduce((count, list) => count + list.conditions.length, 0) > MAX_CONDITIONS
  )
    throw new Error("invalid_dav_if");
  return Object.freeze({
    form,
    lists: Object.freeze(
      lists.map((list) =>
        Object.freeze({
          ...list,
          conditions: Object.freeze(list.conditions.map((condition) => Object.freeze(condition))),
        }),
      ),
    ),
    submittedTokens: Object.freeze([...submitted].sort()),
  });
}

/** LOCK/UNLOCK Lock-Token is one state token, including its angle brackets. */
export function parseDavLockTokenHeader(value: string | null): string | null {
  if (value === null) return null;
  if (bytes(value) > MAX_TOKEN_BYTES + 2 || /[\r\n]/.test(value))
    throw new Error("invalid_dav_lock_token");
  try {
    const scanner = new Scanner(value);
    scanner.whitespace();
    const token = scanner.delimited("<", ">", MAX_TOKEN_BYTES);
    scanner.whitespace();
    if (scanner.position !== value.length) throw new Error("invalid_dav_lock_token");
    return token;
  } catch {
    throw new Error("invalid_dav_lock_token");
  }
}

function etagMatches(condition: Extract<DavIfCondition, { kind: "etag" }>, current: string | null) {
  if (current === null) return false;
  const weak = current.startsWith("W/");
  const value = weak ? current.slice(2) : current;
  return value === condition.value && weak === condition.weak;
}

function listMatches(list: DavIfList, state: DavResourceState): boolean {
  return list.conditions.every((condition) => {
    const matched =
      condition.kind === "token"
        ? state.tokens.has(condition.value)
        : etagMatches(condition, state.etag);
    return condition.not ? !matched : matched;
  });
}

/**
 * Evaluate parsed conditions. Every no-tag or tagged list production participates in the final OR.
 * Token submission remains the parser's independent submittedTokens set.
 */
export async function evaluateDavIf(
  header: DavIfHeader | null,
  requestResource: string,
  load: (resource: string) => Promise<DavResourceState>,
): Promise<boolean> {
  if (header === null) return true;
  if (header.form === "untagged") {
    const state = await load(requestResource);
    return header.lists.some((list) => listMatches(list, state));
  }
  const states = new Map<string, DavResourceState>();
  for (const list of header.lists) {
    if (list.resourceTag === null) throw new Error("invalid_dav_if");
    let state = states.get(list.resourceTag);
    if (!state) {
      state = await load(list.resourceTag);
      states.set(list.resourceTag, state);
    }
    if (listMatches(list, state)) return true;
  }
  return false;
}
