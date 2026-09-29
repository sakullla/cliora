import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/draftGuard.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { sameDraftRequest } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

test('late native IPC result cannot replace an edited or switched draft', () => {
  const draft = { id: 'profile-1', files: { settings: 'original' } };
  const started = { context: JSON.stringify(['codex', 'global', '', 'profile-1', 'profile']), revision: 8, draft };
  assert.equal(sameDraftRequest(started, { ...started }), true);
  assert.equal(sameDraftRequest(started, { ...started, revision: 9 }), false);
  assert.equal(sameDraftRequest(started, { ...started, draft: { ...draft, files: { settings: 'new typing' } } }), false);
  for (const context of [
    ['pi', 'global', '', 'profile-1', 'profile'],
    ['codex', 'project', '/repo', 'profile-1', 'profile'],
    ['codex', 'global', '', 'profile-2', 'profile'],
    ['codex', 'global', '', 'profile-1', 'common'],
  ]) {
    assert.equal(sameDraftRequest(started, { ...started, context: JSON.stringify(context) }), false);
  }
});
