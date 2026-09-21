export interface ForeignKey {
  table: string;
  from: string;
  to: string;
}
export interface TableInfo {
  name: string;
  foreignKeys: readonly ForeignKey[];
}

/** Child tables precede parents. Node self-edges need deepest-first row handling. */
export function deletionOrder(tables: readonly TableInfo[]): string[] {
  const names = new Set(tables.map((table) => table.name));
  const incoming = new Map(tables.map((table) => [table.name, 0]));
  const edges = new Map<string, Set<string>>();
  for (const table of tables) {
    const parents = new Set(
      table.foreignKeys.map((fk) => fk.table).filter((parent) => parent !== table.name),
    );
    for (const parent of parents) {
      if (!names.has(parent)) throw new Error(`Missing FK parent: ${parent}`);
      incoming.set(parent, (incoming.get(parent) ?? 0) + 1);
    }
    edges.set(table.name, parents);
  }
  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
    .sort();
  const result: string[] = [];
  while (ready.length) {
    const name = ready.shift();
    if (!name) break;
    result.push(name);
    for (const parent of edges.get(name) ?? []) {
      const count = (incoming.get(parent) ?? 0) - 1;
      incoming.set(parent, count);
      if (count === 0) {
        ready.push(parent);
        ready.sort();
      }
    }
  }
  if (result.length !== tables.length) throw new Error("Cyclic foreign key graph");
  return result;
}
