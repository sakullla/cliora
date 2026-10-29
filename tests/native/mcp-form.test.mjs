import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/mcp.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const mcp = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

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
  assert.equal(bare.transport, 'http');

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
  assert.deepEqual(copied.map(item => [item.name, item.transport, item.invalid]), [
    ['fetch', 'stdio', []], ['docs', 'http', []], ['local', 'stdio', ['cwdUnsupported']], ['blankCwd', 'stdio', []],
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
