// Parse data-only exports as values. Never execute SQL supplied by a backup file.
export function textLiteral(value) {
  const bytes = Buffer.from(value, "utf8");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== value)
    throw new Error("backup_unsupported_value");
  // A NUL must be represented as data: it cannot occur in SQLite SQL text.
  if (value.includes("\0")) return `CAST(X'${bytes.toString("hex")}' AS TEXT)`;
  return "'" + value.replaceAll("'", "''") + "'";
}

export async function* statements(chunks, maxBytes = 8 * 1024 * 1024) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    quote = null,
    bytes = 0;
  for await (const chunk of chunks) {
    const part = decoder.decode(chunk, { stream: true });
    for (const char of part) {
      text += char;
      bytes += Buffer.byteLength(char);
      if (bytes > maxBytes) throw new Error("backup_statement_too_large");
      // A doubled quote closes then immediately reopens the quoted string.
      if (char === quote) quote = null;
      else if (quote === null && (char === "'" || char === '"')) quote = char;
      else if (quote === null && char === ";") {
        yield text.trim();
        text = "";
        bytes = 0;
      }
    }
  }
  text += decoder.decode();
  if (quote !== null || text.trim()) throw new Error("backup_incomplete_statement");
}

export function parseInsert(sql) {
  if (/^PRAGMA\s+defer_foreign_keys\s*=\s*(TRUE|ON|1)\s*;$/i.test(sql)) return null;
  let index = 0;
  const fail = () => {
    throw new Error("backup_invalid_data_sql");
  };
  const whitespace = () => {
    while (/\s/.test(sql[index] ?? "!")) index++;
  };
  const take = (word) => {
    whitespace();
    if (sql.slice(index, index + word.length).toUpperCase() !== word) fail();
    index += word.length;
  };
  const quoted = (quote) => {
    whitespace();
    if (sql[index++] !== quote) fail();
    let result = "";
    while (index < sql.length) {
      const char = sql[index++];
      if (char === quote) {
        if (sql[index] === quote) {
          result += quote;
          index++;
        } else return result;
      } else result += char;
    }
    return fail();
  };
  const value = (depth = 0) => {
    if (depth > 3) fail();
    whitespace();
    if (sql[index] === "'") return quoted("'");
    if (/^NULL\b/i.test(sql.slice(index))) {
      index += 4;
      return null;
    }
    if (/^X'/i.test(sql.slice(index))) {
      index++;
      const hex = quoted("'");
      if (!/^(?:[a-f0-9]{2})*$/i.test(hex)) fail();
      return Buffer.from(hex, "hex");
    }
    if (/^CAST\b/i.test(sql.slice(index))) {
      take("CAST");
      take("(");
      whitespace();
      if (!/^X'/i.test(sql.slice(index))) fail();
      const bytes = value(depth + 1);
      take("AS TEXT");
      take(")");
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return fail();
      }
    }
    // Wrangler escapes CR/LF using these exact deterministic functions.
    if (/^REPLACE\b/i.test(sql.slice(index))) {
      take("REPLACE");
      take("(");
      const input = value(depth + 1);
      take(",");
      const from = quoted("'");
      take(",");
      take("CHAR");
      take("(");
      const number = value(depth + 1);
      take(")");
      take(")");
      if (
        typeof input !== "string" ||
        ![10, 13].includes(number) ||
        from !== (number === 10 ? "\\n" : "\\r")
      )
        fail();
      return input.replaceAll(from, String.fromCharCode(number));
    }
    const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(index));
    if (!match) return fail();
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
      fail();
    return number;
  };
  take("INSERT INTO");
  const table = quoted('"');
  take("(");
  const columns = [];
  do {
    columns.push(quoted('"'));
    whitespace();
    if (sql[index] !== ",") break;
    index++;
  } while (true);
  take(")");
  take("VALUES");
  take("(");
  const values = [];
  do {
    values.push(value());
    whitespace();
    if (sql[index] !== ",") break;
    index++;
  } while (true);
  take(")");
  take(";");
  whitespace();
  if (
    index !== sql.length ||
    columns.length !== values.length ||
    new Set(columns).size !== columns.length
  )
    fail();
  return { table, columns, values };
}
