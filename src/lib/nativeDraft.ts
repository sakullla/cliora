import type { Connection, NativeImport } from '../types/native';

/** A newly imported native key wins over an older form key. A key-only
 * Claude file keeps CLI defaults, so an old explicit connection must not
 * silently re-enable the previous account. */
export function importedConnection(imported: NativeImport, current: Connection | null): Connection | null {
  const found = imported.inspection.connection;
  if (!found) return imported.migratedSecret ? null : current;
  const sameAccount = current?.providerId === found.providerId && current?.baseUrl === found.baseUrl && current?.interfaceFormat === found.interfaceFormat;
  return { ...found, secretRef: found.secretRef ?? (sameAccount ? current?.secretRef ?? null : null) };
}
