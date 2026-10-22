import type { ParsedMemory } from './memoryDocument';

type LinkRow = { store: string; entry: { id: string }; parsed: Pick<ParsedMemory, 'properties'> | null };

const normalize = (value: string) => value.trim().toLowerCase().replace(/\.md$/, '').replace(/[_\s]+/g, '-');

/** Index ids and frontmatter names once, preserving source order and same-store preference. */
export function memoryLinks<T extends LinkRow>(rows: readonly T[]): (target: string, store: string) => T | null {
  const aliases = new Map<string, { first: T; stores: Map<string, T> }>();
  const add = (alias: string, row: T) => {
    const key = normalize(alias);
    const existing = aliases.get(key);
    if (!existing) aliases.set(key, { first: row, stores: new Map([[row.store, row]]) });
    else if (!existing.stores.has(row.store)) existing.stores.set(row.store, row);
  };
  for (const row of rows) {
    add(row.entry.id, row);
    const name = row.parsed?.properties.find(item => item.key.toLowerCase() === 'name')?.value;
    if (name) add(name, row);
  }
  return (target, store) => {
    const matches = aliases.get(normalize(target));
    return matches?.stores.get(store) ?? matches?.first ?? null;
  };
}
