import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/remoteOperations.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { RemoteOperations } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

function fixture() {
  const calls = [];
  let finish;
  const operations = new RemoteOperations(async (name, args) => {
    calls.push({ name, args });
    if (name === 'cancel_remote_operation') return true;
    return new Promise(resolve => { finish = resolve; });
  });
  return { calls, operations, finish: () => finish('ok') };
}

test('an upload request keeps its 600-second deadline end to end', async () => {
  const f = fixture();
  const before = Date.now();
  const handle = f.operations.start('upload_session_files', {}, 'host', 'write', {
    timeoutMs: 600_000, timeoutCeilingMs: 600_000,
  });
  const request = f.calls[0].args.operation;
  assert.equal(request.deadlineCeilingMs, 600_000, 'the explicit ceiling travels with the request');
  assert.ok(request.deadlineUnixMs >= before + 599_000, `deadline is not clamped to 120s: ${request.deadlineUnixMs - before}`);
  assert.ok(request.deadlineUnixMs <= Date.now() + 600_000);
  f.finish();
  assert.equal(await handle.promise, 'ok');
});

test('without an explicit ceiling every operation keeps the 120-second clamp', async () => {
  const f = fixture();
  const before = Date.now();
  const handle = f.operations.start('write', {}, 'host', 'write', { timeoutMs: 600_000 });
  const request = f.calls[0].args.operation;
  assert.equal(request.deadlineCeilingMs, undefined, 'ordinary requests do not opt in');
  assert.ok(request.deadlineUnixMs <= before + 120_000, `still clamped: ${request.deadlineUnixMs - before}`);
  assert.ok(request.deadlineUnixMs >= before + 119_000);
  f.finish();
  await handle.promise;
});

test('the explicit ceiling itself is bounded to 600 seconds', async () => {
  const f = fixture();
  const before = Date.now();
  const handle = f.operations.start('write', {}, 'host', 'write', { timeoutMs: 900_000, timeoutCeilingMs: 900_000 });
  const request = f.calls[0].args.operation;
  assert.equal(request.deadlineCeilingMs, 600_000, 'the ceiling cannot exceed the backend maximum');
  assert.ok(request.deadlineUnixMs <= before + 600_000);
  f.finish();
  await handle.promise;
});

test('ordinary timeouts below the clamp are untouched', async () => {
  const f = fixture();
  const before = Date.now();
  const handle = f.operations.start('read', {}, 'host', 'read', { timeoutMs: 5_000 });
  const request = f.calls[0].args.operation;
  assert.ok(request.deadlineUnixMs >= before + 5_000 && request.deadlineUnixMs <= Date.now() + 5_000);
  f.finish();
  await handle.promise;
});

test('the upload wrappers in native.ts request the dedicated 600-second budget', () => {
  const native = readFileSync(new URL('../../src/lib/native.ts', import.meta.url), 'utf8');
  const wrappers = native.match(/upload_session_files[\s\S]{0,220}/g) ?? [];
  assert.ok(wrappers.length >= 2, 'both upload wrappers found');
  for (const wrapper of wrappers) {
    assert.match(wrapper, /timeoutMs: 600_000/, 'the request deadline is 600 seconds');
    assert.match(wrapper, /timeoutCeilingMs: 600_000/, 'the explicit ceiling lifts the 120-second clamp');
  }
});
