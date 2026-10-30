import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/remoteOperations.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { RemoteOperations } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

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
