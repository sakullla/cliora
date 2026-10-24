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
  assert.deepEqual(snippet.env, { ROOT: '/tmp', PORT: '3000' });

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
