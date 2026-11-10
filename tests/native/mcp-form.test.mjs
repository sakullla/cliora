import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as mcp from '../../src/lib/mcp.ts';

test('paste import accepts mcpServers, servers, name maps, snippets and bare servers', () => {
  const wrapped = mcp.parseMcpServerJson(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'pkg'] }, other: { url: 'https://x.test/mcp' } } }));
  assert.equal(wrapped.name, 'fs');
  assert.equal(wrapped.total, 2);
  assert.deepEqual(wrapped.args, ['-y', 'pkg']);

  const vscode = mcp.parseMcpServerJson(JSON.stringify({ servers: { remote: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${T}' } } } }));
  assert.equal(vscode.transport, 'http');
  assert.equal(vscode.name, 'remote');
  assert.deepEqual(vscode.headers, { Authorization: 'Bearer ${T}' });

  const map = mcp.parseMcpServerJson(JSON.stringify({ devtools: { command: 'npx', args: ['chrome-devtools-mcp@latest'] } }));
  assert.equal(map.name, 'devtools');
  assert.equal(map.total, 1);

  const snippet = mcp.parseMcpServerJson('"filesystem": { "command": "npx", "env": { "ROOT": "/tmp", "PORT": 3000 } },');
  assert.equal(snippet.name, 'filesystem');
  assert.deepEqual(snippet.env, { ROOT: '/tmp' });
  assert.deepEqual(snippet.invalid, ['envInvalid']);

  const stdioBare = mcp.parseMcpServerJson(JSON.stringify({ command: 'npx', args: ['-y', 'pkg'], env: { ROOT: '/tmp' } }));
  assert.equal(stdioBare.name, '');
  assert.equal(stdioBare.command, 'npx');
  assert.deepEqual(stdioBare.args, ['-y', 'pkg']);

  const bare = mcp.parseMcpServerJson(JSON.stringify({ url: 'https://x.test/sse', type: 'sse' }));
  assert.equal(bare.name, '');
  assert.equal(bare.transport, 'sse');

  assert.equal(mcp.parseMcpServerJson('not json'), null);
  assert.equal(mcp.parseMcpServerJson(JSON.stringify({ mcpServers: { broken: { args: [] } } })), null);
  assert.equal(mcp.parseMcpServerJson('[]'), null);
});

test('collection paste keeps every server, including entries needing field validation', () => {
  const parsed = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: {
    first: { command: 'npx', args: ['first'] },
    second: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer token' } },
    broken: { args: [] },
  } }));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map(item => item.name), ['first', 'second', 'broken']);
  assert.equal(parsed[1].transport, 'http');
  assert.equal(mcp.mcpDraftIssues(parsed[2]).command, 'commandEmpty');
  assert.deepEqual(mcp.parseMcpServerCollection('not json'), []);
});

test('a config pasted with typographic quotes and dashed flags still imports', () => {
  const pasted = `{
”type“: ”stdio“,
”command“: ”npx“,
”args“: [
”—registry=https://registry.example.test/“,
”-y“,
”@example/server“,
”–stdio“
],
”env“: {
”DB_HOST“: ”db.example.test“,
”DB_PASSWORD“: ”fixture-secret“
}
}`;
  const [server] = mcp.parseMcpServerCollection(pasted);
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['--registry=https://registry.example.test/', '-y', '@example/server', '--stdio']);
  assert.deepEqual(server.env, { DB_HOST: 'db.example.test', DB_PASSWORD: 'fixture-secret' });
  // Valid JSON is never rewritten: a literal em dash inside a real string stays as typed.
  const [literal] = mcp.parseMcpServerCollection(JSON.stringify({ command: 'npx', args: ['—note'] }));
  assert.deepEqual(literal.args, ['—note']);
});

test('collection paste diagnoses invalid entries instead of silently dropping data', () => {
  const parsed = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: {
    scalar: 'not-a-server',
    badArgs: { command: 'npx', args: ['-y', 42, null] },
    badEnv: { command: 'npx', env: { VALID: 'yes', INVALID: null } },
    badHeaders: { url: 'https://example.test/mcp', headers: ['Authorization'] },
  } }));
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map(item => item.name), ['scalar', 'badArgs', 'badEnv', 'badHeaders']);
  assert.deepEqual(parsed[0].invalid, ['serverInvalid']);
  assert.deepEqual(parsed[1].invalid, ['argsInvalid']);
  assert.deepEqual(parsed[1].args, ['-y']);
  assert.deepEqual(parsed[2].invalid, ['envInvalid']);
  assert.deepEqual(parsed[2].env, { VALID: 'yes' });
  assert.deepEqual(parsed[3].invalid, ['headersInvalid']);
  assert.equal(mcp.parseMcpServerJson(JSON.stringify({ command: 'npx', args: [false] })).invalid.includes('argsInvalid'), true);
});

test('collection paste rejects every non-string env and header value without coercion', () => {
  const parsed = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: {
    local: { command: 'npx', env: { VALID: 'yes', NUMBER: 3000, BOOLEAN: false, NULL: null, ARRAY: ['x'], OBJECT: { value: 'x' } } },
    remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer token', NUMBER: 2, BOOLEAN: true, NULL: null, ARRAY: ['x'], OBJECT: { value: 'x' } } },
  } }));
  assert.deepEqual(parsed[0].env, { VALID: 'yes' });
  assert.deepEqual(parsed[0].invalid, ['envInvalid']);
  assert.deepEqual(parsed[1].headers, { Authorization: 'Bearer token' });
  assert.deepEqual(parsed[1].invalid, ['headersInvalid']);
});

test('bare maps preserve every entry name and diagnostic without a bare-server feature', () => {
  const allInvalid = mcp.parseMcpServerCollection(JSON.stringify({ text: 'not-a-server', number: 42, nil: null, bool: false }));
  assert.equal(allInvalid.length, 4);
  assert.deepEqual(allInvalid.map(item => item.name), ['text', 'number', 'nil', 'bool']);
  assert.deepEqual(allInvalid.map(item => item.total), [4, 4, 4, 4]);
  assert.ok(allInvalid.every(item => item.invalid.includes('serverInvalid')));

  const mixed = mcp.parseMcpServerCollection(JSON.stringify({ valid: { command: 'npx' }, broken: 'not-a-server', count: 3 }));
  assert.equal(mixed.length, 3);
  assert.deepEqual(mixed.map(item => item.name), ['valid', 'broken', 'count']);
  assert.deepEqual(mixed[0].invalid, []);
  assert.deepEqual(mixed[1].invalid, ['serverInvalid']);
  assert.deepEqual(mixed[2].invalid, ['serverInvalid']);
});

test('server-like fields do not turn maps with unsupported keys into bare servers', () => {
  const nonObjects = mcp.parseMcpServerCollection(JSON.stringify({ command: 'not-a-server', other: 42 }));
  assert.equal(nonObjects.length, 2);
  assert.deepEqual(nonObjects.map(item => item.name), ['command', 'other']);
  assert.deepEqual(nonObjects.map(item => item.total), [2, 2]);
  assert.ok(nonObjects.every(item => item.invalid.includes('serverInvalid')));

  const mixed = mcp.parseMcpServerCollection(JSON.stringify({ valid: { command: 'npx' }, url: 'not-a-server' }));
  assert.equal(mixed.length, 2);
  assert.deepEqual(mixed.map(item => item.name), ['valid', 'url']);
  assert.deepEqual(mixed[0].invalid, []);
  assert.equal(mixed[0].command, 'npx');
  assert.deepEqual(mixed[1].invalid, ['serverInvalid']);
});

test('draft issues mirror the backend validation', () => {
  const base = { name: 'filesystem', transport: 'stdio', command: 'npx', url: '' };
  assert.deepEqual(mcp.mcpDraftIssues(base), {});
  assert.equal(mcp.mcpDraftIssues({ ...base, name: '' }).name, 'nameEmpty');
  assert.equal(mcp.mcpDraftIssues({ ...base, name: 'has space' }).name, 'nameInvalid');
  assert.equal(mcp.mcpDraftIssues({ ...base, name: '中文' }).name, 'nameInvalid');
  assert.equal(mcp.mcpDraftIssues({ ...base, name: 'a'.repeat(81) }).name, 'nameInvalid');
  assert.equal(mcp.mcpDraftIssues({ ...base, name: 'a'.repeat(80) }).name, undefined);
  assert.equal(mcp.mcpDraftIssues({ ...base, command: '  ' }).command, 'commandEmpty');
  assert.equal(mcp.mcpDraftIssues({ ...base, transport: 'http' }).url, 'urlEmpty');
  assert.equal(mcp.mcpDraftIssues({ ...base, transport: 'http', url: 'ftp://x.test' }).url, 'urlInvalid');
  assert.equal(mcp.mcpDraftIssues({ ...base, transport: 'http', url: 'example.com/mcp' }).url, 'urlInvalid');
  assert.deepEqual(mcp.mcpDraftIssues({ ...base, transport: 'http', command: '', url: 'http://127.0.0.1:3845/mcp' }), {});
});

test('command preview quotes arguments with spaces and drops empty rows', () => {
  assert.equal(mcp.mcpCommandLine('npx', ['-y', '', 'C:/Program Files/app']), 'npx -y "C:/Program Files/app"');
  assert.equal(mcp.mcpCommandLine('', []), '');
  assert.equal(mcp.mcpSummary({ transport: 'http', command: 'ignored', args: [], url: ' https://x.test/mcp ' }), 'https://x.test/mcp');
});

test('secret masking only applies to literal values under sensitive keys', () => {
  assert.equal(mcp.isSensitiveKey('GITHUB_TOKEN'), true);
  assert.equal(mcp.isSensitiveKey('Authorization'), true);
  assert.equal(mcp.isSensitiveKey('ROOT'), false);
  assert.equal(mcp.isValueReference('${GITHUB_TOKEN}'), true);
  assert.equal(mcp.isValueReference('Bearer ${API_TOKEN}'), true);
  assert.equal(mcp.isValueReference('$API_TOKEN'), true);
  assert.equal(mcp.isValueReference('ghp_literal'), false);
});

test('cc-switch copies, records, config.json and ccswitch:// links import every server', () => {
  // "Copy as JSON" in cc-switch: an mcpServers block whose specs may carry type and cwd.
  const copied = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: {
    fetch: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], env: {} },
    docs: { type: 'sse', url: 'https://docs.test/sse', headers: { Authorization: 'Bearer t' } },
    local: { type: 'stdio', command: 'node', args: ['server.js'], cwd: 'C:/work/mcp' },
    blankCwd: { type: 'stdio', command: 'npx', cwd: '' },
  } }));
  assert.deepEqual(copied.map(item => [item.name, item.transport, item.cwd, item.invalid]), [
    ['fetch', 'stdio', '', []], ['docs', 'sse', '', []], ['local', 'stdio', 'C:/work/mcp', []], ['blankCwd', 'stdio', '', []],
  ]);

  // Its stored records: the spec sits under `server`, the record key is the server name.
  const record = (id, server) => ({ id, name: `${id} display`, server, apps: { claude: true, codex: false }, description: 'from cc-switch', tags: [] });
  const map = mcp.parseMcpServerCollection(JSON.stringify({ fetch: record('fetch', { command: 'uvx', args: ['mcp-server-fetch'] }), remote: record('remote', { type: 'http', url: 'https://x.test/mcp' }) }));
  assert.deepEqual(map.map(item => [item.name, item.transport, item.command || item.url, item.invalid]), [['fetch', 'stdio', 'uvx', []], ['remote', 'http', 'https://x.test/mcp', []]]);
  const single = mcp.parseMcpServerCollection(JSON.stringify(record('memory', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] })));
  assert.equal(single.length, 1);
  assert.equal(single[0].name, 'memory');
  assert.deepEqual(single[0].args, ['-y', '@modelcontextprotocol/server-memory']);
  const config = mcp.parseMcpServerCollection(JSON.stringify({ version: 2, providers: {}, mcp: { servers: { time: record('time', { command: 'uvx', args: ['mcp-server-time'] }) } } }));
  assert.deepEqual(config.map(item => [item.name, item.command]), [['time', 'uvx']]);
  const broken = mcp.parseMcpServerCollection(JSON.stringify({ servers: { bad: { id: 'bad', server: { command: 'npx', args: [1] }, apps: {} } } }));
  assert.deepEqual(broken[0].invalid, ['argsInvalid']);

  // Deep links carry base64 mcpServers JSON, including an unescaped '+' and non-ASCII text.
  const body = JSON.stringify({ mcpServers: { 'mcp-fetch': { command: 'uvx', args: ['mcp-server-fetch', '说明'] } } });
  const base64 = Buffer.from(body, 'utf8').toString('base64');
  const link = `ccswitch://v1/import?resource=mcp&apps=claude,codex&config=${encodeURIComponent(base64)}`;
  const linked = mcp.parseMcpServerCollection(link);
  assert.deepEqual(linked.map(item => [item.name, item.command, item.args]), [['mcp-fetch', 'uvx', ['mcp-server-fetch', '说明']]]);
  assert.equal(mcp.parseMcpServerCollection(`ccswitch://v1/import?resource=mcp&config=${base64}`)[0].name, 'mcp-fetch');
  assert.deepEqual(mcp.parseMcpServerCollection(`ccswitch://v1/import?resource=provider&app=claude&name=x&config=${base64}`), []);
  assert.deepEqual(mcp.parseMcpServerCollection('ccswitch://v1/import?resource=mcp&config=%%%'), []);
});

test('stdio cwd is kept as a real field and clears when blank', () => {
  const [local] = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'], cwd: '  C:/work/mcp  ' } } }));
  assert.equal(local.cwd, 'C:/work/mcp');
  assert.deepEqual(local.invalid, []);
  const [blank] = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: { blank: { command: 'node', cwd: '   ' } } }));
  assert.equal(blank.cwd, '');
  assert.deepEqual(blank.invalid, []);

  const draft = mcp.applyParsedServer(mcp.blankMcpDraft(), local).draft;
  assert.equal(draft.cwd, 'C:/work/mcp');
  assert.equal(mcp.mcpDraftOf({ ...draft, id: 'x', version: 3 }).cwd, 'C:/work/mcp');
  assert.equal(mcp.blankMcpDraft().cwd, '');
  // Older definitions saved before cwd existed read back as unspecified.
  assert.equal(mcp.mcpDraftOf({ id: 'old', name: 'old', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 }).cwd, '');
  // A remote draft has no working directory; the saved value drops it.
  assert.equal(mcp.mcpCwdOf({ transport: 'http', cwd: '/tmp' }), '');
  assert.equal(mcp.mcpCwdOf({ transport: 'stdio', cwd: ' /tmp ' }), '/tmp');
});

test('cwd that cannot be stored stays a diagnostic instead of being dropped', () => {
  const parsed = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: {
    number: { command: 'node', cwd: 7 },
    remote: { url: 'https://x.test/mcp', cwd: '/tmp' },
  } }));
  assert.deepEqual(parsed.map(item => item.invalid), [['cwdInvalid'], ['cwdInvalid']]);
  assert.equal(parsed[0].command, 'node');
  assert.equal(parsed[1].url, 'https://x.test/mcp');
});

test('Streamable HTTP and legacy SSE stay distinct through parsing, drafts and summaries', () => {
  const parsed = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: {
    typeHttp: { type: 'http', url: 'https://x.test/mcp' },
    streamable: { type: 'streamable-http', url: 'https://x.test/mcp' },
    camel: { transport: 'streamableHttp', url: 'https://x.test/mcp' },
    sseType: { type: 'sse', url: 'https://x.test/sse' },
    sseTransport: { transport: 'SSE', serverUrl: 'https://x.test/sse' },
    urlOnly: { url: 'https://x.test/mcp' },
  } }));
  assert.deepEqual(parsed.map(item => item.transport), ['http', 'http', 'http', 'sse', 'sse', 'http']);
  assert.ok(parsed.every(item => item.invalid.length === 0));
  assert.equal(parsed[4].url, 'https://x.test/sse');
  assert.equal(mcp.isRemoteMcp('sse'), true);
  assert.equal(mcp.isRemoteMcp('http'), true);
  assert.equal(mcp.isRemoteMcp('stdio'), false);
  assert.deepEqual(['stdio', 'http', 'sse'].map(mcp.mcpTransportBadge), ['stdio', 'HTTP', 'SSE']);
  assert.equal(mcp.mcpSummary({ transport: 'sse', command: 'ignored', args: [], url: ' https://x.test/sse ' }), 'https://x.test/sse');
  const base = { name: 'docs', command: '', url: '' };
  assert.equal(mcp.mcpDraftIssues({ ...base, transport: 'sse' }).url, 'urlEmpty');
  assert.equal(mcp.mcpDraftIssues({ ...base, transport: 'sse', url: 'ftp://x.test' }).url, 'urlInvalid');
  assert.deepEqual(mcp.mcpDraftIssues({ ...base, transport: 'sse', url: 'https://x.test/sse' }), {});
  assert.equal(mcp.parseMcpServerJson(JSON.stringify({ type: 'sse', url: 'https://x.test/sse' })).transport, 'sse');
  assert.equal(mcp.parseMcpServerJson(JSON.stringify({ type: 'sse', command: 'npx' })), null);
});

test('unknown transports and unrepresentable fields are diagnosed with their names', () => {
  const parsed = mcp.parseMcpServerCollection(JSON.stringify({ mcpServers: {
    websocket: { type: 'websocket', url: 'wss://x.test/mcp' },
    typed: { type: 5, command: 'npx' },
    extra: { command: 'npx', timeout: 30, autoApprove: ['read'] },
    constructor: { command: 'npx', type: 'constructor' },
    fine: { command: 'npx', type: 'stdio' },
  } }));
  assert.deepEqual(parsed.map(item => item.invalid), [['transportUnknown'], ['transportUnknown'], ['fieldUnknown'], ['transportUnknown'], []]);
  assert.equal(parsed[0].unknownTransport, 'websocket');
  assert.deepEqual(parsed[2].unknownFields, ['timeout', 'autoApprove']);
  assert.equal(parsed[2].command, 'npx');
  // The unknown spelling is never guessed into a protocol.
  assert.equal(parsed[0].transport, 'http');
  const keys = [];
  const texts = mcp.mcpParseIssueTexts((key, options) => { keys.push([key, options]); return key; }, parsed[2]);
  assert.deepEqual(texts, ['tools.mcp.parseIssue.fieldUnknown']);
  assert.deepEqual(keys[0][1].fields, 'timeout, autoApprove');
});

test('cc-switch records without a name keep every field and wait for a default name', () => {
  const record = { server: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], cwd: '/srv/fetch', env: { REGION: 'eu' } }, apps: { claude: true } };
  const [single] = mcp.parseMcpServerCollection(JSON.stringify(record));
  assert.equal(single.name, '');
  assert.deepEqual([single.command, single.args, single.cwd, single.env, single.invalid], ['uvx', ['mcp-server-fetch'], '/srv/fetch', { REGION: 'eu' }, []]);

  const link = `ccswitch://v1/import?resource=mcp&config=${encodeURIComponent(Buffer.from(JSON.stringify({ mcpServers: { '': { command: 'npx', args: ['pkg'] } } })).toString('base64'))}`;
  const [linked] = mcp.parseMcpServerCollection(link);
  assert.equal(linked.name, '');
  assert.equal(linked.command, 'npx');

  // Invalid siblings still surface even though the name is missing.
  const [broken] = mcp.parseMcpServerCollection(JSON.stringify({ server: { command: 'npx', args: [1], env: { N: 2 } }, apps: {} }));
  assert.equal(broken.name, '');
  assert.deepEqual(broken.invalid, ['argsInvalid', 'envInvalid']);
});

test('default names are valid, ascii, and avoid every taken name', () => {
  assert.equal(mcp.mcpDefaultName([]), 'mcp-server');
  assert.equal(mcp.mcpDefaultName(['mcp-server']), 'mcp-server-2');
  assert.equal(mcp.mcpDefaultName(new Set(['mcp-server', 'mcp-server-2', 'mcp-server-4'])), 'mcp-server-3');
  const taken = [];
  for (let index = 0; index < 5; index += 1) taken.push(mcp.mcpDefaultName(taken));
  assert.deepEqual(taken, ['mcp-server', 'mcp-server-2', 'mcp-server-3', 'mcp-server-4', 'mcp-server-5']);
  assert.ok(taken.every(name => mcp.MCP_NAME_PATTERN.test(name)));
  assert.deepEqual(mcp.mcpDraftIssues({ name: mcp.mcpDefaultName([]), transport: 'stdio', command: 'npx', url: '' }), {});
});