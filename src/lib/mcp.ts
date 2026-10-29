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

export type McpParseIssue = 'serverInvalid' | 'argsInvalid' | 'envInvalid' | 'headersInvalid' | 'cwdUnsupported';

export type McpParsedServer = {
  total: number;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  invalid: McpParseIssue[];
};

function stringMap(value: unknown, issue: McpParseIssue, invalid: McpParseIssue[]): Record<string, string> {
  const output: Record<string, string> = {};
  if (value === undefined) return output;
  if (!plainObject(value)) {
    invalid.push(issue);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') output[key] = item;
    else invalid.push(issue);
  }
  return output;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const MCP_SERVER_FIELDS = new Set(['command', 'args', 'env', 'cwd', 'url', 'serverUrl', 'headers', 'type', 'transport']);

function looksLikeServer(value: unknown): value is Record<string, unknown> {
  return plainObject(value)
    && Object.keys(value).every(key => MCP_SERVER_FIELDS.has(key))
    && (typeof value.command === 'string' || typeof value.url === 'string' || typeof value.serverUrl === 'string');
}

// cc-switch stores each server as `{ id, name, server: { ...spec }, apps: { claude: true, ... } }`;
// the spec is the part every CLI reads, and `id` is the name written into their configs.
function ccSwitchRecord(value: unknown): value is Record<string, unknown> & { server: Record<string, unknown> } {
  return plainObject(value) && plainObject(value.server) && (plainObject(value.apps) || typeof value.id === 'string');
}

// cc-switch shares servers as `ccswitch://v1/import?resource=mcp&config=<base64 mcpServers JSON>`.
function ccSwitchLinkConfig(text: string): string | null {
  if (!/^ccswitch:\/\//i.test(text)) return null;
  try {
    const params = new URL(text).searchParams;
    const config = params.get('config');
    if ((params.get('resource') ?? '').toLowerCase() !== 'mcp' || !config) return null;
    // URLSearchParams turns an unescaped base64 '+' into a space; URL-safe base64 is accepted too.
    const base64 = config.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch { return null; }
}

// A `"name": { ... }` snippet copied out of an mcpServers block is not valid
// JSON on its own; wrapping it in braces (and dropping a trailing comma) is.
function parseLenient(text: string): unknown {
  const trimmed = text.trim();
  const linked = ccSwitchLinkConfig(trimmed);
  if (linked !== null) { try { return JSON.parse(linked); } catch { return null; } }
  try { return JSON.parse(trimmed); } catch { /* try the snippet form */ }
  if (!trimmed.startsWith('"')) return null;
  try { return JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`); } catch { return null; }
}

// Accepts mcpServers / servers wrappers, name maps, snippets and bare servers, plus cc-switch
// exports: its server records (single, map, or the `mcp.servers` block of its config.json)
// and `ccswitch://` MCP links. Collection parsing keeps every entry so import review never
// silently drops servers.
export function parseMcpServerCollection(text: string): McpParsedServer[] {
  const parsed = parseLenient(text);
  if (!plainObject(parsed)) return [];
  const ccSwitchConfig = plainObject(parsed.mcp) && plainObject(parsed.mcp.servers) ? parsed.mcp.servers : null;
  const wrapped = plainObject(parsed.mcpServers) ? parsed.mcpServers : plainObject(parsed.servers) ? parsed.servers : ccSwitchConfig;
  const single = !wrapped && ccSwitchRecord(parsed);
  const map = wrapped ?? (!single && !looksLikeServer(parsed) ? parsed : null);
  const entries: Array<[string, unknown]> = map ? Object.entries(map)
    : single ? [[typeof parsed.id === 'string' ? parsed.id : '', parsed]]
    : [['', parsed]];
  const total = entries.length;
  return entries.map(([name, entry]) => {
    const invalid: McpParseIssue[] = [];
    const value = ccSwitchRecord(entry) ? entry.server : entry;
    const server = plainObject(value) ? value : {};
    if (!plainObject(value)) invalid.push('serverInvalid');
    // Cliora has no working-directory field; keep the entry visible but not importable as is.
    if (server.cwd !== undefined && !(typeof server.cwd === 'string' && !server.cwd.trim())) invalid.push('cwdUnsupported');
    const command = typeof server.command === 'string' ? server.command : '';
    const url = typeof server.url === 'string' ? server.url : typeof server.serverUrl === 'string' ? server.serverUrl : '';
    const hint = typeof server.type === 'string' ? server.type : typeof server.transport === 'string' ? server.transport : '';
    const transport: McpTransport = url || /^(http|sse|streamable)/i.test(hint) ? 'http' : 'stdio';
    const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === 'string') : [];
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(item => typeof item !== 'string'))) invalid.push('argsInvalid');
    return { total, name, transport, command, args, url, env: stringMap(server.env, 'envInvalid', invalid), headers: stringMap(server.headers, 'headersInvalid', invalid), invalid: [...new Set(invalid)] };
  });
}

export function applyParsedServer(draft: McpDraft, parsed: McpParsedServer): { draft: McpDraft; envRows: KeyValueRow[]; headerRows: KeyValueRow[] } {
  return {
    draft: { ...draft, name: parsed.name || draft.name, transport: parsed.transport, command: parsed.command, args: parsed.args, url: parsed.url },
    envRows: editableRowsOf(parsed.env),
    headerRows: editableRowsOf(parsed.headers),
  };
}

// Single-item compatibility helper for paste targets that intentionally fill one draft.
export function parseMcpServerJson(text: string): McpParsedServer | null {
  const first = parseMcpServerCollection(text)[0];
  if (!first || (first.transport === 'http' ? !first.url : !first.command)) return null;
  return first;
}
