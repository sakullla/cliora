import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const transpile = name => ts.transpileModule(readFileSync(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

async function loadNative() {
  const code = transpile('native').replace(/^import .+;$/gm, line => {
    if (line.includes("'./remoteOperations'")) return `const { RemoteOperations } = await import('${moduleUrl(transpile('remoteOperations'))}');`;
    if (line.includes("'@tauri-apps/api/core'")) return 'const invoke = (...args) => globalThis.__targetIdentityInvoke(...args); const isTauri = () => true;';
    if (line.includes("'./onboarding'")) return 'const markOnboardingLaunched = () => {};';
    if (line.includes("'../i18n'")) return 'const i18n = { t: key => key }; const bindLanguagePersist = () => {};';
    if (line.includes("remote/writeReceipts")) return "const getWriteReceipts = () => globalThis.__writeReceipts ?? []; const getWriteFaults = () => globalThis.__writeFaults ?? []; const rememberWriteReceipt = () => {}; const unresolvedWrite = item => !['committed', 'rolled_back', 'prepare_failed', 'conflict_before_commit'].includes(item.outcome); const rememberWriteFault = (targetId, targetRevision) => globalThis.__writeFaults.push({ targetId, targetRevision }); const requestWriteRecovery = targetId => globalThis.window.dispatchEvent(new CustomEvent('cliora:remote-write-recovery', { detail: { targetId } }));";
    throw new Error(`Unexpected runtime dependency: ${line}`);
  });
  return import(moduleUrl(code));
}

test('a local unresolved write exposes recovery with the original receipt and makes no native submission', async () => {
  const receipt = { id: 'receipt', targetId: 'local-blocked', targetRevision: 7, outcome: 'recovering', items: [] };
  const calls = [];
  const events = [];
  const oldWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.window.addEventListener('cliora:remote-write', event => events.push(event.detail));
  globalThis.__writeReceipts = [receipt];
  globalThis.__targetIdentityInvoke = async name => { calls.push(name); return null; };
  try {
    const { native } = await loadNative();
    await assert.rejects(native.saveRemoteLibraryItem(receipt.targetId, { title: 'draft' }), error => error.remote.receipt === receipt);
    assert.deepEqual(calls, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].targetId, receipt.targetId);
    assert.equal(events[0].error.remote.receipt.targetRevision, 7);
  } finally {
    globalThis.window = oldWindow; delete globalThis.__writeReceipts; delete globalThis.__targetIdentityInvoke;
  }
});

test('a receipt-less transaction failure preserves its captured host revision for fault-only discovery', async () => {
  const calls = [];
  const events = [];
  const oldWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.window.addEventListener('cliora:remote-write', event => events.push(event.detail));
  globalThis.__writeFaults = [];
  globalThis.__targetIdentityInvoke = async name => { calls.push(name); throw { message: 'durable journal guard', remote: { outcome: 'failed' } }; };
  try {
    const { native } = await loadNative();
    await assert.rejects(native.saveRemoteLibraryItem('remote-blocked', { title: 'draft' }, { targetRevision: 3 }));
    assert.deepEqual(calls, ['save_remote_library_item']);
    assert.deepEqual(globalThis.__writeFaults, [{ targetId: 'remote-blocked', targetRevision: 3 }]);
    assert.equal(events[0].targetId, 'remote-blocked');
    const recovery = [];
    globalThis.window.addEventListener('cliora:remote-write-recovery', event => recovery.push(event.detail));
    await assert.rejects(native.saveRemoteLibraryItem('remote-blocked', { title: 'retain draft' }, { targetRevision: 4 }));
    assert.deepEqual(calls, ['save_remote_library_item'], 'pending discovery also blocks blind replay');
    assert.deepEqual(recovery, [{ targetId: 'remote-blocked' }]);
    assert.equal(globalThis.__writeFaults[0].targetRevision, 3, 'a new view cannot claim the failed write revision');
  } finally {
    globalThis.window = oldWindow; delete globalThis.__writeFaults; delete globalThis.__targetIdentityInvoke;
  }
});

test('a late target list cannot roll back saved identity, notify consumers, or invalidate their warm reads', async () => {
  const old = { id: 'revision-race', name: 'before', host: 'old.invalid', port: 22, user: 'fixture', authMethod: 'key', enabled: true, createdAt: 1, updatedAt: 1 };
  const saved = { ...old, name: 'after', host: 'new.invalid', updatedAt: 2 };
  let hold = false;
  let release;
  const calls = [];
  globalThis.__targetIdentityInvoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'list_remote_targets') return hold ? new Promise(resolve => { release = () => resolve([old]); }) : [old];
    if (name === 'save_remote_target') return saved;
    if (name === 'list_remote_directories') return { parent: args.parent, items: ['nonempty'], truncated: false };
    return null;
  };
  try {
    const { native, getRemoteIdentity, subscribeRemoteIdentity } = await loadNative();
    await native.listRemoteTargets();
    let notifications = 0;
    const stop = subscribeRemoteIdentity(() => notifications++);
    hold = true;
    const pendingList = native.listRemoteTargets();
    await native.saveRemoteTarget(saved, 'synthetic-password');
    const identity = getRemoteIdentity(old.id);
    assert.equal(identity, 'revision-race:2');
    await native.listRemoteDirectories(old.id, '/fixture');
    const readsBeforeLateList = calls.filter(call => call.name === 'list_remote_directories').length;
    release();
    const consumerTargets = await pendingList;
    assert.deepEqual(consumerTargets, [saved], 'the actual list consumer receives the latest connection, too');
    assert.equal(getRemoteIdentity(old.id), identity);
    assert.equal(notifications, 1, 'old observations must not emit an identity change');
    await native.listRemoteDirectories(consumerTargets[0].id, '/fixture');
    assert.equal(calls.filter(call => call.name === 'list_remote_directories').length, readsBeforeLateList);
    await native.listRemoteDirectories(consumerTargets[0].id, '/another-resource');
    assert.equal(calls.at(-1).args.operation.targetRevision, 2);
    stop();
  } finally {
    delete globalThis.__targetIdentityInvoke;
  }
});

test('name-only confirmed saves survive late equal-revision lists and subsequent relists without changing identity', async () => {
  const old = { id: 'name-race', name: 'old name', host: 'same.invalid', port: 22, user: 'fixture', authMethod: 'key', enabled: true, createdAt: 1, updatedAt: 7 };
  let backend = old;
  let hold = false;
  let release;
  let reads = 0;
  globalThis.__targetIdentityInvoke = async (name, args) => {
    if (name === 'list_remote_targets') {
      const snapshot = structuredClone(backend);
      return hold ? new Promise(resolve => { release = () => resolve([snapshot]); }) : [snapshot];
    }
    if (name === 'save_remote_target') { backend = { ...args.target }; return structuredClone(backend); }
    if (name === 'list_remote_directories') { reads++; return { parent: args.parent, items: ['/fixture/child'], truncated: false }; }
    return null;
  };
  try {
    const { native, getRemoteIdentity, subscribeRemoteIdentity } = await loadNative();
    await native.listRemoteTargets();
    const identity = getRemoteIdentity(old.id);
    await native.listRemoteDirectories(old.id, '/fixture');
    let notifications = 0;
    const stop = subscribeRemoteIdentity(() => notifications++);
    hold = true;
    const pending = native.listRemoteTargets();
    const renamed = { ...old, name: 'renamed host' };
    assert.deepEqual(await native.saveRemoteTarget(renamed), renamed);
    release();
    assert.deepEqual(await pending, [renamed]);
    hold = false;
    assert.deepEqual(await native.listRemoteTargets(), [renamed]);
    assert.equal(getRemoteIdentity(old.id), identity);
    assert.equal(notifications, 0);
    await native.listRemoteDirectories(old.id, '/fixture');
    assert.equal(reads, 1, 'display labels do not invalidate connection-bound warm reads');
    stop();
  } finally { delete globalThis.__targetIdentityInvoke; }
});
