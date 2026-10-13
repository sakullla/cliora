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

// Mirrors backend validate() in resources/mcp.rs so the form can point at the
// field before a save round-trip fails.
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export type McpFieldIssue = 'nameEmpty' | 'nameInvalid' | 'commandEmpty' | 'urlEmpty' | 'urlInvalid';
export type McpDraftIssues = { name?: McpFieldIssue; command?: McpFieldIssue; url?: McpFieldIssue };

export function mcpDraftIssues(draft: Pick<McpDraft, 'name' | 'transport' | 'command' | 'url'>): McpDraftIssues {
  const issues: McpDraftIssues = {};
  const name = draft.name.trim();
  if (!name) issues.name = 'nameEmpty';
  else if (!MCP_NAME_PATTERN.test(name)) issues.name = 'nameInvalid';
  if (draft.transport === 'stdio' && !draft.command.trim()) issues.command = 'commandEmpty';
  if (draft.transport === 'http') {
    const url = draft.url.trim();
    if (!url) issues.url = 'urlEmpty';
    else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') issues.url = 'urlInvalid';
      } catch { issues.url = 'urlInvalid'; }
    }
  }
  return issues;
}

export function hasMcpIssues(issues: McpDraftIssues): boolean {
  return !!(issues.name || issues.command || issues.url);
}

// Same words the backend treats as sensitive when exporting.
export function isSensitiveKey(key: string): boolean {
  const name = key.toLowerCase();
  return ['key', 'token', 'secret', 'authorization', 'password'].some((word) => name.includes(word));
}

// `${VAR}` / `$VAR` references carry no secret themselves and stay readable.
export function isValueReference(value: string): boolean {
  return /\$\{[^}]+\}|^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function mcpCommandLine(command: string, args: string[]): string {
  return [command.trim(), ...keptMcpArgs(args)].filter(Boolean).map(quoteArg).join(' ');
}

export function mcpSummary(item: { transport: McpTransport; command: string; args: string[]; url: string | null }): string {
  return item.transport === 'http' ? (item.url ?? '').trim() : mcpCommandLine(item.command, item.args);
}

export type McpParsedServer = {
  total: number;
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

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeServer(value: unknown): value is Record<string, unknown> {
  return plainObject(value) && (typeof value.command === 'string' || typeof value.url === 'string' || typeof value.serverUrl === 'string');
}

// A `"name": { ... }` snippet copied out of an mcpServers block is not valid
// JSON on its own; wrapping it in braces (and dropping a trailing comma) is.
function parseLenient(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* try the snippet form */ }
  if (!trimmed.startsWith('"')) return null;
  try { return JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`); } catch { return null; }
}

// Accepts an mcpServers / servers wrapper, a `name: server` map, or a bare
// server object; returns null when the text is not recognizable MCP JSON so
// callers keep the form untouched. Only the first server is used; `total`
// lets callers say how many were skipped.
export function parseMcpServerJson(text: string): McpParsedServer | null {
  const parsed = parseLenient(text);
  if (!plainObject(parsed)) return null;
  let name = '';
  let total = 1;
  let server = parsed;
  const wrapped = plainObject(parsed.mcpServers) ? parsed.mcpServers : plainObject(parsed.servers) ? parsed.servers : null;
  const map = wrapped ?? (!looksLikeServer(parsed) && Object.values(parsed).some(looksLikeServer) ? parsed : null);
  if (map) {
    const entries = Object.entries(map).filter(([, value]) => plainObject(value));
    const first = entries[0];
    if (!first) return null;
    [name] = first;
    server = first[1] as Record<string, unknown>;
    total = entries.length;
  }
  const command = typeof server.command === 'string' ? server.command : '';
  const url = typeof server.url === 'string' ? server.url : typeof server.serverUrl === 'string' ? server.serverUrl : '';
  const hint = typeof server.type === 'string' ? server.type : typeof server.transport === 'string' ? server.transport : '';
  const transport: McpTransport = url || /^(http|sse|streamable)/i.test(hint) ? 'http' : 'stdio';
  if (transport === 'http' && !url) return null;
  if (transport === 'stdio' && !command) return null;
  const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === 'string') : [];
  return { total, name, transport, command, args, url, env: stringMap(server.env), headers: stringMap(server.headers) };
}

export function applyParsedServer(draft: McpDraft, parsed: McpParsedServer): { draft: McpDraft; envRows: KeyValueRow[]; headerRows: KeyValueRow[] } {
  return {
    draft: { ...draft, name: parsed.name || draft.name, transport: parsed.transport, command: parsed.command, args: parsed.args, url: parsed.url },
    envRows: editableRowsOf(parsed.env),
    headerRows: editableRowsOf(parsed.headers),
  };
}
