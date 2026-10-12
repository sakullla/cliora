import type { McpDefinition, McpDraft, McpTransport } from '../types/resources';

export type KeyValueRow = { key: string; value: string };

export function blankMcpDraft(): McpDraft {
  return { id: null, name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, inLibrary: true, expectedVersion: null };
}

export function mcpDraftOf(item: McpDefinition): McpDraft {
  return { id: item.id, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url, env: item.env, headers: item.headers, inLibrary: item.inLibrary !== false, expectedVersion: item.version };
}

export function keyValueRowsOf(value: Record<string, string>): KeyValueRow[] {
  return Object.entries(value).map(([key, item]) => ({ key, value: item }));
}

export function editableRowsOf(value: Record<string, string>): KeyValueRow[] {
  const rows = keyValueRowsOf(value);
  return rows.length ? rows : [{ key: '', value: '' }];
}

export function recordOfRows(rows: KeyValueRow[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    output[key] = row.value;
  }
  return output;
}

export function keptMcpArgs(args: string[]): string[] {
  return args.map((item) => item.trim()).filter((item) => item.length > 0);
}

export function duplicateKeys(rows: KeyValueRow[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (seen.has(key)) repeated.add(key);
    else seen.add(key);
  }
  return [...repeated];
}

// Returns null when any non-empty line is not KEY=value, so paste can fall
// back to the default single-field insertion instead of eating the text.
export function parseKeyValueLines(text: string): KeyValueRow[] | null {
  const rows: KeyValueRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const equals = line.indexOf('=');
    if (equals < 1) return null;
    rows.push({ key: line.slice(0, equals).trim(), value: line.slice(equals + 1).trim() });
  }
  return rows;
}

// The backend valid_name (mcp.rs) only accepts ASCII alphanumerics, '-' and
// '_' within 1–80 bytes, so the copy suffix is fixed ASCII instead of a
// localized word. The base name is truncated to keep the result in range.
export function mcpCopyName(name: string, existing: string[]): string {
  const build = (index: number) => {
    const suffix = index < 2 ? '-copy' : `-copy-${index}`;
    return `${name.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
  };
  let index = 1;
  let candidate = build(index);
  while (existing.includes(candidate)) {
    index += 1;
    candidate = build(index);
  }
  return candidate;
}

export type McpParsedServer = {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
};

function stringMap(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') output[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') output[key] = String(item);
  }
  return output;
}

// Accepts an mcpServers wrapper or a bare server object; returns null when the
// text is not recognizable MCP JSON so callers keep the form untouched.
export function parseMcpServerJson(text: string): McpParsedServer | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  let name = '';
  let server = parsed as Record<string, unknown>;
  const wrapped = server.mcpServers;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    const entries = Object.entries(wrapped as Record<string, unknown>);
    const first = entries[0];
    if (!first || !first[1] || typeof first[1] !== 'object' || Array.isArray(first[1])) return null;
    [name] = first;
    server = first[1] as Record<string, unknown>;
  }
  const command = typeof server.command === 'string' ? server.command : '';
  const url = typeof server.url === 'string' ? server.url : typeof server.serverUrl === 'string' ? server.serverUrl : '';
  const hint = typeof server.type === 'string' ? server.type : typeof server.transport === 'string' ? server.transport : '';
  const transport: McpTransport = url || /^(http|sse|streamable)/i.test(hint) ? 'http' : 'stdio';
  if (transport === 'http' && !url) return null;
  if (transport === 'stdio' && !command) return null;
  const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === 'string') : [];
  return { name, transport, command, args, url, env: stringMap(server.env), headers: stringMap(server.headers) };
}
