import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const transpile = name => ts.transpileModule(readFileSync(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

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
    if (name === 'list_remote_directories') return ['nonempty'];
    return null;
  };
  const code = transpile('native').replace(/^import .+;$/gm, line => {
    if (line.includes("'./remoteOperations'")) return `const { RemoteOperations } = await import('${moduleUrl(transpile('remoteOperations'))}');`;
    if (line.includes("'@tauri-apps/api/core'")) return 'const invoke = (...args) => globalThis.__targetIdentityInvoke(...args); const isTauri = () => true;';
    if (line.includes("'./onboarding'")) return 'const markOnboardingLaunched = () => {};';
    if (line.includes("'../i18n'")) return 'const i18n = { t: key => key }; const bindLanguagePersist = () => {};';
    throw new Error(`Unexpected runtime dependency: ${line}`);
  });
  try {
    const { native, getRemoteIdentity, subscribeRemoteIdentity } = await import(moduleUrl(code));
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
