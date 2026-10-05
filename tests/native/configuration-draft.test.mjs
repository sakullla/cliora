import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/lib/configurationDraft.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { createConfigurationSession, configurationAction } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const initial = { sessionId: 'one', revision: 0, issues: [], profile: { files: {} } };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('late draft responses cannot overwrite a newer text edit or a closed session', async () => {
  const session = createConfigurationSession(initial);
  const first = deferred();
  const second = deferred();
  const pendingFirst = session.update(() => first.promise);
  const pendingSecond = session.update(() => second.promise);
  assert.equal(session.canSubmit, false);
  second.resolve({ ...initial, revision: 2 });
  assert.equal(await pendingSecond, true);
  first.resolve({ ...initial, revision: 1 });
  assert.equal(await pendingFirst, false);
  assert.equal(session.draft.revision, 2);
  const late = deferred();
  const pendingLate = session.update(() => late.promise);
  session.close();
  late.resolve({ ...initial, revision: 3 });
  assert.equal(await pendingLate, false);
  assert.equal(session.canSubmit, false);
});

test('invalid text and field issues block submit; a failed request retains the draft', async () => {
  const session = createConfigurationSession(initial);
  await session.update(async () => ({ ...initial, revision: 1, profile: { files: { settings: '{broken' } }, issues: [{ field: 'settings', message: 'invalid' }] }));
  assert.equal(session.canSubmit, false);
  assert.equal(session.draft.profile.files.settings, '{broken');
  await assert.rejects(session.update(async () => { throw new Error('service unavailable'); }));
  assert.equal(session.draft.revision, 1);
  assert.equal(session.pending, false);
  assert.deepEqual(configurationAction('delete', { model: 'a' }), { version: 1, operation: 'delete', target: { model: 'a' }, field: null, value: null });
});

test('foreign session and backwards revision responses are rejected', async () => {
  const session = createConfigurationSession({ ...initial, revision: 4 });
  assert.equal(await session.update(async () => ({ ...initial, sessionId: 'two', revision: 5 })), false);
  assert.equal(await session.update(async () => ({ ...initial, revision: 3 })), false);
  assert.equal(session.draft.revision, 4);
});

test('consecutive form actions preserve both edits and invalid control input blocks submit', async () => {
  const session = createConfigurationSession(initial);
  const first = deferred();
  const editA = session.edit(async current => { await first.promise; return { ...current, revision: current.revision + 1, profile: { files: { ...current.profile.files, a: 'one' } } }; });
  const editB = session.edit(async current => ({ ...current, revision: current.revision + 1, profile: { files: { ...current.profile.files, b: 'two' } } }));
  assert.equal(session.canSubmit, false);
  first.resolve();
  assert.equal(await editA, true);
  assert.equal(await editB, true);
  assert.deepEqual(session.draft.profile.files, { a: 'one', b: 'two' });
  session.setFieldValidity('window', false);
  assert.equal(session.canSubmit, false);
  session.setFieldValidity('window', true);
  assert.equal(session.canSubmit, true);
});
