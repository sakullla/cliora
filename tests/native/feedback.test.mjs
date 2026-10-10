import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/notifications.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { createNotificationStore } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

test('only a successful retry of the same operation resolves its error', () => {
  const store = createNotificationStore();
  store.begin('project-a', 'save').error('Save failed');
  store.begin('project-a', 'copy').success('Copied');
  assert.deepEqual(store.getSnapshot().map(item => item.tone), ['error', 'success']);
  store.begin('project-a', 'save').success('Saved');
  assert.equal(store.getSnapshot().some(item => item.tone === 'error'), false);
});

test('late results stay bound to their original context and obsolete attempts are ignored', () => {
  const store = createNotificationStore();
  const old = store.begin('account-a/version-1', 'save', 'dialog-a');
  store.begin('account-b/version-2', 'save', 'dialog-b').success('B saved');
  old.error('A failed');
  assert.deepEqual(store.getSnapshot().map(item => [item.context, item.surface]), [['account-b/version-2', 'dialog-b'], ['account-a/version-1', 'dialog-a']]);
  const retry = store.begin('account-a/version-1', 'save');
  retry.success('A saved');
  old.error('Obsolete error');
  assert.equal(store.getSnapshot().at(-1).text, 'A saved');
});

test('duplicates merge, errors and partial completion do not expire', () => {
  let now = 0;
  const store = createNotificationStore(() => now);
  for (let index = 0; index < 20; index++) store.begin('batch', 'install').partial('8 succeeded, 2 failed', { detail: 'Retry only failed items' });
  store.begin('copy', 'copy').success('Copied');
  assert.equal(store.getSnapshot().length, 2);
  now = 6000;
  store.expire();
  assert.equal(store.getSnapshot().length, 1);
  assert.equal(store.getSnapshot()[0].tone, 'partial');
});

test('hovered or focused results keep their action reachable', () => {
  let now = 0;
  const store = createNotificationStore(() => now);
  store.begin('copy', 'copy').success('Copied');
  const id = store.getSnapshot()[0].id;
  now = 6000;
  store.expire(new Set([id]));
  assert.equal(store.getSnapshot().length, 1);
  store.pause(id);
  now = 9500;
  store.expire();
  assert.equal(store.getSnapshot().length, 1);
  now = 12000;
  store.expire();
  assert.equal(store.getSnapshot().length, 0);
});

test('recovery checks current object/version and does not silently dismiss failures', async () => {
  const store = createNotificationStore();
  let revision = 1;
  let calls = 0;
  store.begin('item', 'save').error('Failed', { recovery: { label: 'Retry', valid: () => revision === 1, run: async () => { calls++; } } });
  const id = store.getSnapshot()[0].id;
  assert.equal(await store.recover(id), true);
  revision++;
  assert.equal(await store.recover(id), false);
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot()[0].tone, 'error');
});
