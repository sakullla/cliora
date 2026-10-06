import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/lib/configurationDraft.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { createConfigurationSession, configurationAction, configurationApplicationState, configurationConnectionIdentity, rememberConfigurationApiBuffer, configurationRequestMatches } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const initial = { sessionId: 'one', revision: 0, issues: [], profile: { files: {} } };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('text writes consume their shared queue and closed sessions reject late responses', async () => {
  const session = createConfigurationSession(initial);
  const first = deferred();
  const second = deferred();
  const pendingFirst = session.update(() => first.promise);
  const pendingSecond = session.update(() => second.promise);
  assert.equal(session.canSubmit, false);
  second.resolve({ ...initial, revision: 2 });
  first.resolve({ ...initial, revision: 1 });
  assert.equal(await pendingFirst, true);
  assert.equal(await pendingSecond, true);
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


test('a delayed text replacement becomes the baseline of the next form action', async () => {
  const session = createConfigurationSession(initial);
  const raw = deferred();
  const pendingRaw = session.update(() => raw.promise);
  let formBase;
  const pendingForm = session.edit(async current => {
    formBase = current;
    return { ...current, revision: current.revision + 1, profile: { files: { ...current.profile.files, newField: 'kept' } } };
  });
  raw.resolve({ ...initial, revision: 1, profile: { files: { raw: 'text' } } });
  assert.equal(await pendingRaw, true);
  assert.equal(await pendingForm, true);
  assert.deepEqual(formBase.profile.files, { raw: 'text' });
  assert.deepEqual(session.draft.profile.files, { raw: 'text', newField: 'kept' });
  assert.equal(session.canSubmit, true);
});

test('a delayed form action becomes the baseline of the next text replacement', async () => {
  const session = createConfigurationSession(initial);
  const form = deferred();
  const pendingForm = session.edit(() => form.promise);
  const pendingRaw = session.update(async current => ({ ...current, revision: current.revision + 1, profile: { files: { ...current.profile.files, raw: 'updated' } } }));
  form.resolve({ ...initial, revision: 1, profile: { files: { newField: 'kept' } } });
  assert.equal(await pendingForm, true);
  assert.equal(await pendingRaw, true);
  assert.deepEqual(session.draft.profile.files, { newField: 'kept', raw: 'updated' });
  assert.equal(await session.update(async current => ({ ...current })), false);
});

test('saved identity is accepted only for the same idle live session without inventing a revision', async () => {
  const session = createConfigurationSession(initial);
  const wait = deferred(); const operation = session.edit(() => wait.promise);
  assert.equal(session.acceptSaved({ ...initial, profile: { id: 'saved' } }), false);
  wait.resolve({ ...initial, revision: 1 }); await operation;
  assert.equal(session.acceptSaved({ ...initial, revision: 1, profile: { id: 'saved' } }), true);
  assert.equal(session.draft.revision, 1);
  assert.equal(session.draft.profile.id, 'saved');
  assert.equal(session.acceptSaved({ ...initial, sessionId: 'foreign', revision: 2 }), false);
  session.close(); assert.equal(session.acceptSaved({ ...initial, revision: 2 }), false);
});

test('unsubmitted connection input blocks submission and can be recovered independently', () => {
  const session = createConfigurationSession(initial);
  session.setFieldValidity('connection-form', false);
  assert.equal(session.canSubmit, false); assert.equal(session.isFieldValid('connection-form'), false);
  assert.equal(session.isFieldValid('unrelated'), true);
  session.setFieldValidity('connection-form', true); assert.equal(session.canSubmit, true);
});


test('application state requires a trusted full version/revision snapshot and matching common identity', () => {
  const profile = { id:'p', version:3, revision:'r3', inheritCommon:true };
  const common = { version:2, revision:'c2' };
  const binding = { profileId:'p', profileVersion:3, commonVersion:2, commonRevision:'c2', appliedProfileAvailable:true, appliedSummary:{profileVersion:3,profileRevision:'r3'} };
  assert.equal(configurationApplicationState(profile,binding,common).applied,true);
  for (const altered of [ { ...binding, appliedProfileAvailable:false }, { ...binding, appliedSummary:null }, { ...binding, appliedSummary:{profileVersion:3,profileRevision:'old'} }, { ...binding, commonRevision:'old' }, { ...binding, commonRevision:null } ]) assert.equal(configurationApplicationState(profile,altered,common).applied,false);
  assert.equal(configurationApplicationState({...profile,revision:'same-version-new'},binding,common).applied,false);
  assert.equal(configurationApplicationState(profile,binding,null).applied,false);
  assert.equal(configurationApplicationState(profile,{...binding,commonVersion:null,commonRevision:null},null).applied,true);
  assert.equal(configurationApplicationState(profile,binding,{version:2}).applied,false);
});

test('API buffers are separated by provider, protocol and endpoint without using model names', () => {
  const a = {providerId:'a',interfaceFormat:'openai_responses',baseUrl:'https://a.example.test',model:'one'};
  const b = {...a,providerId:'b',baseUrl:'https://b.example.test'};
  const buffers = new Map([[configurationConnectionIdentity(a),{credential:{source:'api_key',secretRef:'old-a'},input:'unfinished-a'}]]);
  assert.equal(buffers.get(configurationConnectionIdentity(b)),undefined);
  assert.equal(buffers.get(configurationConnectionIdentity({...a,model:'two'})).credential.secretRef,'old-a');
  buffers.set(configurationConnectionIdentity(b),{credential:{source:'api_key',secretRef:null},input:'new-b'});
  assert.equal(buffers.get(configurationConnectionIdentity(a)).input,'unfinished-a');
  assert.equal(buffers.get(configurationConnectionIdentity(b)).credential.secretRef,null);
});


test('request cancellation advances generation without changing files, revision or invalid input', () => {
  const draft = { ...initial, revision: 7, requestGeneration: 3, profile: { files: { settings: '{"model":"one"}' } } };
  const session = createConfigurationSession(draft);
  session.setFieldValidity('unsubmitted-number', false);
  const result = { sessionId: draft.sessionId, revision: draft.revision, requestGeneration: 3 };
  assert.equal(configurationRequestMatches(session.draft, draft, result), true);
  assert.equal(session.acceptSaved({ ...draft, requestGeneration: 4 }), true);
  assert.equal(session.draft.revision, 7);
  assert.deepEqual(session.draft.profile.files, draft.profile.files);
  assert.equal(session.canSubmit, false);
  assert.equal(configurationRequestMatches(session.draft, draft, result), false);
  assert.equal(configurationRequestMatches(session.draft, session.draft, { ...result, requestGeneration: 4 }), true);
  assert.equal(configurationRequestMatches(session.draft, session.draft, { ...result, requestGeneration: 4, revision: 6 }), false);
  assert.equal(configurationRequestMatches(session.draft, session.draft, { ...result, requestGeneration: 4, sessionId: 'foreign' }), false);
  session.setFieldValidity('unsubmitted-number', true);
  assert.equal(session.canSubmit, true);
});


test('API edits cannot rebucket confirmed A references or A input under browsed B', () => {
  const a = 'confirmed-A'; const b = 'browsed-B';
  for (const secretRef of ['stored-a', 'lease-a']) {
    const credential = { source: 'api_key', secretRef };
    const buffers = new Map();
    rememberConfigurationApiBuffer(buffers, a, credential, a, 'unfinished-a', true);
    // The credential and input keep their acquired identity when the form browses B.
    rememberConfigurationApiBuffer(buffers, a, credential, a, 'unfinished-a', true);
    assert.equal(buffers.get(b), undefined);
    assert.equal(buffers.get(a).credential.secretRef, secretRef);
    // Explicit B input gets its own null-ref entry; the prior A input remains intact.
    rememberConfigurationApiBuffer(buffers, a, credential, b, 'new-b', true);
    assert.deepEqual(buffers.get(b), { credential: { source: 'api_key', secretRef: null }, input: 'new-b', replacing: true });
    assert.deepEqual(buffers.get(a), { credential, input: 'unfinished-a', replacing: true });
    rememberConfigurationApiBuffer(buffers, b, { source: 'api_key', secretRef: 'lease-b' }, b, '', false);
    assert.equal(buffers.get(a).credential.secretRef, secretRef);
    assert.equal(buffers.get(b).credential.secretRef, 'lease-b');
  }
});
