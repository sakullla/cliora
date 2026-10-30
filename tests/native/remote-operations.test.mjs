import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/remoteOperations.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { RemoteOperations } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

test('freshness follows the full cached resource across subscriptions and recovers only after revalidation', async () => {
  let fail = false;
  let calls = 0;
  const operations = new RemoteOperations(async () => { calls++; if (fail) throw new Error('denied'); return ['nonempty']; });
  const states = [];
  const options = { shareKey: 'resource', targetRevision: 1, onFreshness: value => states.push(value) };
  await operations.start('read', { query: 'bad' }, 'host', 'read', options).promise;
  fail = true;
  await assert.rejects(operations.start('read', { query: 'bad' }, 'host', 'read', { ...options, fresh: true }).promise);
  await operations.start('read', { query: 'bad' }, 'host', 'read', options).promise;
  assert.equal(calls, 2);
  assert.equal(states.at(-1).stale, true);
  assert.ok(states.at(-1).at > 0);
  fail = false;
  await operations.start('read', { query: 'good' }, 'host', 'read', options).promise;
  assert.equal(states.at(-1).stale, false);
  await operations.start('read', { query: 'bad' }, 'host', 'read', options).promise;
  assert.equal(states.at(-1).stale, true);
  await operations.start('read', { query: 'bad' }, 'host', 'read', { ...options, fresh: true }).promise;
  await operations.start('read', { query: 'bad' }, 'host', 'read', options).promise;
  assert.equal(states.at(-1).stale, false);
  assert.equal(calls, 4);
});

function fixture() {
  const calls = [];
  let finish, fail;
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const operations = new RemoteOperations(async (name, args) => {
    calls.push({ name, args });
    if (name === 'cancel_remote_operation') return true;
    return result;
  });
  return { calls, operations, finish, fail };
}

test('IPC carries immutable identity, revision, kind, priority, and a total deadline', async () => {
  const f = fixture();
  const before = Date.now();
  const handle = f.operations.start('read', {}, 'host', 'read', { timeoutMs: 5000, targetRevision: 7, priority: 'background' });
  const request = f.calls[0].args.operation;
  assert.equal(request.targetId, 'host');
  assert.equal(request.targetRevision, 7);
  assert.equal(request.kind, 'read');
  assert.equal(request.priority, 'background');
  assert.ok(request.deadlineUnixMs >= before + 5000 && request.deadlineUnixMs <= Date.now() + 5000);
  assert.notEqual(request.cancelToken, request.requestId);
  f.finish('ok');
  assert.equal(await handle.promise, 'ok');
});

test('one shared subscriber cancels without cancelling the remaining native read', async () => {
  const f = fixture();
  const a = f.operations.start('read', { scope: 'global' }, 'host', 'read', { timeoutMs: 5000, shareKey: 'resource', targetRevision: 7 });
  // A shorter subscriber budget fits inside the existing flight deadline.
  const b = f.operations.start('read', { scope: 'global' }, 'host', 'read', { timeoutMs: 4000, shareKey: 'resource', targetRevision: 7 });
  assert.equal(f.calls.length, 1);
  a.cancel();
  await assert.rejects(a.promise, { reason: 'cancelled', outcome: 'failed' });
  assert.equal(f.calls.length, 1);
  f.finish('remaining');
  assert.equal(await b.promise, 'remaining');
});

test('the final subscriber releases its native request, once, with its token', async () => {
  const f = fixture();
  const controller = new AbortController();
  const handle = f.operations.start('read', {}, 'host', 'read', { signal: controller.signal });
  controller.abort();
  handle.cancel();
  await assert.rejects(handle.promise, { reason: 'cancelled' });
  assert.equal(f.calls.filter(c => c.name === 'cancel_remote_operation').length, 1);
  assert.equal(f.calls[1].args.cancelToken, f.calls[0].args.operation.cancelToken);
  f.finish('late');
});

test('cancel before starting performs no remote work and a read timeout cancels the native wait', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  const abandoned = f.operations.start('read', {}, 'host', 'read', { signal: controller.signal });
  await assert.rejects(abandoned.promise, { reason: 'cancelled' });
  assert.equal(f.calls.filter(c => c.name === 'read').length, 0);
  const timed = f.operations.start('read', {}, 'host', 'read', { timeoutMs: 15 });
  await assert.rejects(timed.promise, { reason: 'timeout' });
  assert.equal(f.calls.filter(c => c.name === 'cancel_remote_operation').length, 2);
  f.finish('late');
});

test('sharing isolates revisions/scopes and a new read after cancellation starts new work', async () => {
  const f = fixture();
  const handles = [
    f.operations.start('read', { scope: 'global' }, 'host', 'read', { shareKey: 'same', targetRevision: 1 }),
    f.operations.start('read', { scope: 'project' }, 'host', 'read', { shareKey: 'same', targetRevision: 1 }),
    f.operations.start('read', { scope: 'global' }, 'host', 'read', { shareKey: 'same', targetRevision: 2 }),
  ];
  assert.equal(f.calls.length, 3);
  handles[0].cancel();
  await assert.rejects(handles[0].promise);
  const next = f.operations.start('read', { scope: 'global' }, 'host', 'read', { shareKey: 'same', targetRevision: 1 });
  assert.equal(f.calls.filter(c => c.name === 'read').length, 4);
  f.finish('ok');
  await Promise.all([handles[1].promise, handles[2].promise, next.promise]);
});

test('writes never share or replay and cancellation waits for the native unknown outcome', async () => {
  const f = fixture();
  const a = f.operations.start('write', {}, 'host', 'write', { shareKey: 'ignored' });
  const b = f.operations.start('write', {}, 'host', 'write', { shareKey: 'ignored' });
  a.cancel();
  assert.equal(f.calls.filter(c => c.name === 'write').length, 2);
  const unknown = { code: 'remote_error', remote: { reason: 'cancelled', outcome: 'unknown', action: 'verify' } };
  f.fail(unknown);
  await assert.rejects(a.promise, error => error === unknown);
  await assert.rejects(b.promise, error => error === unknown);
});

test('nonempty cold/hot reads avoid transport, clone editable values, and merge refreshes', async () => {
  let calls = 0;
  let finish;
  const operations = new RemoteOperations(async () => {
    calls++;
    return calls === 1 ? { entries: [{ name: 'real-row' }] } : new Promise(resolve => { finish = resolve; });
  });
  const read = options => operations.start('resource', { toolId: 'fixture', scope: 'project', projectPath: '/one' }, 'host', 'read', { shareKey: 'resource', targetRevision: 7, ...options }).promise;
  const first = await read();
  first.entries[0].name = 'unsaved draft';
  assert.equal((await read()).entries[0].name, 'real-row');
  assert.equal(calls, 1, 'hot load must do zero additional remote work');
  const a = read({ fresh: true });
  const b = read({ fresh: true });
  assert.equal(calls, 2, 'concurrent refreshes must add exactly one transport request');
  finish({ entries: [{ name: 'external edit' }] });
  assert.deepEqual(await a, await b);
  assert.equal((await read()).entries[0].name, 'external edit');
  assert.equal(calls, 2);
});

test('invalidation rejects a late old result and cannot refill a replacement identity', async () => {
  let finishOld;
  let calls = 0;
  const operations = new RemoteOperations(async () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; }) : ['new-host-history']);
  const read = revision => operations.start('history', {}, 'same-id', 'read', { shareKey: 'history', targetRevision: revision }).promise;
  const old = read(1);
  const rejected = assert.rejects(old, { reason: 'identity' });
  operations.invalidate('same-id');
  assert.deepEqual(await read(2), ['new-host-history']);
  finishOld(['old-host-history']);
  await rejected;
  assert.deepEqual(await read(2), ['new-host-history']);
  assert.equal(calls, 2);
});

test('a failed refresh preserves no successful replacement and another host remains independently warm', async () => {
  const calls = [];
  const operations = new RemoteOperations(async (name, args) => {
    calls.push(args.operation.targetId);
    if (args.operation.targetId === 'slow') throw new Error('offline');
    return [{ name }];
  });
  const read = host => operations.start('read', {}, host, 'read', { shareKey: 'rows' }).promise;
  await read('fast');
  await assert.rejects(read('slow'), /offline/);
  operations.invalidate('slow');
  assert.equal((await read('fast')).length, 1);
  await assert.rejects(read('slow'), /offline/);
  assert.deepEqual(calls, ['fast', 'slow', 'slow']);
});

test('settled cache is bounded and isolates tools, scopes, projects, and revisions', async () => {
  let calls = 0;
  const operations = new RemoteOperations(async (_name, args) => { calls++; return [args]; });
  const read = (project, revision = 1, scope = 'project', toolId = 'one') => operations.start('store', { project, scope, toolId }, 'host', 'read', { shareKey: 'store', targetRevision: revision }).promise;
  await read('/first');
  await read('/first', 2);
  await read('/first', 1, 'global');
  await read('/first', 1, 'project', 'two');
  assert.equal(calls, 4);
  for (let i = 0; i < 100; i++) await read(`/project-${i}`);
  await read('/first');
  assert.equal(calls, 105, 'oldest entries must be evicted instead of growing without bound');
});

test('expired reads revalidate and a cancelled final subscriber never populates the settled cache', async () => {
  const f = fixture();
  const first = f.operations.start('read', {}, 'host', 'read', { shareKey: 'rows', cacheTtlMs: 1 });
  first.cancel();
  await assert.rejects(first.promise, { reason: 'cancelled' });
  f.finish(['late']);
  await new Promise(resolve => setTimeout(resolve, 3));
  await f.operations.start('read', {}, 'host', 'read', { shareKey: 'rows', cacheTtlMs: 1 }).promise;
  await new Promise(resolve => setTimeout(resolve, 3));
  await f.operations.start('read', {}, 'host', 'read', { shareKey: 'rows', cacheTtlMs: 1 }).promise;
  assert.equal(f.calls.filter(call => call.name === 'read').length, 3);
});
