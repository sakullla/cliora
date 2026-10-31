import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

let serial = 0;
async function loadStore(native) {
  globalThis.__directoryReceiptNative = native;
  const source = readFileSync(new URL('../../src/features/remote/directoryReceipts.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("import { useSyncExternalStore } from 'react';", 'const useSyncExternalStore = (_subscribe, snapshot) => snapshot();')
    .replace("import { native } from '../../lib/native';", 'const native = globalThis.__directoryReceiptNative;');
  return import(`data:text/javascript;base64,${Buffer.from(`${code}\n// store ${++serial}`).toString('base64')}`);
}
const target = { id: 'fixture', name: 'fixture', host: 'fixture.invalid', port: 22, user: 'fixture', updatedAt: 7 };

test('a late intent from a cancelled consumer preserves another path unknown receipt on normal reopen', async () => {
  let release;
  let lists = 0;
  const durable = new Map();
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => { lists++; return [...durable.values()].map(item => structuredClone(item)); },
    saveRemoteDirectoryReceipt: async receipt => {
      durable.set(receipt.id, structuredClone(receipt));
      if (receipt.path === '/fixture/A' && receipt.outcome === 'pending') await new Promise(resolve => { release = resolve; });
    },
  });
  const obsolete = new AbortController();
  const pendingA = store.beginDirectoryReceipt(target, '/fixture/A');
  await new Promise(resolve => setImmediate(resolve));
  obsolete.abort();
  const b = await store.beginDirectoryReceipt(target, '/fixture/B');
  await store.updateDirectoryReceipt(b.id, { outcome: 'unknown', detail: 'B may already exist' });
  release();
  const a = await pendingA;
  if (obsolete.signal.aborted) await store.updateDirectoryReceipt(a.id, { outcome: 'failed', detail: 'aborted before mkdir' });
  await store.loadDirectoryReceipts();
  assert.equal(lists, 1, 'ordinary consumer reopen uses the current store');
  assert.equal(durable.get(b.id).outcome, 'unknown');
  assert.equal(store.useDirectoryReceipts().find(item => item.id === b.id)?.outcome, 'unknown');
  assert.equal(store.useDirectoryReceipts().find(item => item.id === a.id)?.outcome, 'failed');
  assert.equal(store.useDirectoryReceipts().some(item => store.blocksDirectoryCreation(item, target, b.path)), true);
  assert.equal(await store.beginDirectoryReceipt(target, b.path), null);
});

test('pending intent reservations enforce capacity and same-path exclusion before a delayed save returns', async () => {
  const initial = Array.from({ length: 31 }, (_, index) => ({ id: `existing-${index}`, target, path: `/fixture/${index}`, outcome: 'unknown', detail: '' }));
  let release;
  let saves = 0;
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => initial,
    saveRemoteDirectoryReceipt: async receipt => {
      saves++;
      if (receipt.path === '/fixture/A') await new Promise(resolve => { release = resolve; });
    },
  });
  const a = store.beginDirectoryReceipt(target, '/fixture/A');
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(await store.beginDirectoryReceipt(target, '/fixture/B'), null);
    assert.equal(saves, 1, 'do not persist a 33rd unresolved intent');
  } finally { release(); await a; }
});

test('out-of-order different-path intents evict only current resolved feedback at the 32 receipt limit', async () => {
  const initial = Array.from({ length: 32 }, (_, index) => ({ id: `existing-${index}`, target, path: `/fixture/${index}`, outcome: 'unknown', detail: '' }));
  let release;
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => initial,
    saveRemoteDirectoryReceipt: async receipt => {
      if (receipt.path === '/fixture/A' && receipt.outcome === 'pending') await new Promise(resolve => { release = resolve; });
    },
  });
  await store.loadDirectoryReceipts();
  await store.updateDirectoryReceipt('existing-0', { outcome: 'created' });
  await store.updateDirectoryReceipt('existing-1', { inspection: { state: 'missing', detail: 'confirmed missing' } });
  const pendingA = store.beginDirectoryReceipt(target, '/fixture/A');
  await new Promise(resolve => setImmediate(resolve));
  const b = await store.beginDirectoryReceipt(target, '/fixture/B');
  await store.updateDirectoryReceipt(b.id, { outcome: 'unknown' });
  release(); const a = await pendingA;
  const current = store.useDirectoryReceipts();
  assert.equal(current.length, 32);
  assert.equal(new Set(current.map(item => item.id)).size, 32);
  assert.equal(current.some(item => item.id === a.id), true);
  assert.equal(current.some(item => item.id === b.id), true);
  assert.equal(current.some(item => item.id === 'existing-0' || item.id === 'existing-1'), false);
  assert.equal(initial.slice(2).every(item => current.some(visible => visible.id === item.id)), true);
  assert.equal(await store.beginDirectoryReceipt(target, '/fixture/full'), null);
});

test('a same-path intent is not admitted while the first durable response is pending', async () => {
  let release;
  let saves = 0;
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => [],
    saveRemoteDirectoryReceipt: async () => {
      saves++;
      if (saves === 1) await new Promise(resolve => { release = resolve; });
    },
  });
  const pending = store.beginDirectoryReceipt(target, '/fixture/same');
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(await store.beginDirectoryReceipt(target, '/fixture/same'), null);
    assert.equal(saves, 1);
  } finally { release(); await pending; }
  assert.equal(store.useDirectoryReceipts().length, 1);
});

test('a late intent acknowledgement deduplicates its ID and preserves a newer hydrated inspection', async () => {
  let release;
  const durable = new Map();
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => [...durable.values()].map(item => ({ ...structuredClone(item), outcome: item.outcome === 'pending' ? 'unknown' : item.outcome })),
    saveRemoteDirectoryReceipt: async receipt => {
      durable.set(receipt.id, structuredClone(receipt));
      if (receipt.outcome === 'pending') await new Promise(resolve => { release = resolve; });
    },
  });
  const pending = store.beginDirectoryReceipt(target, '/fixture/hydrated');
  await new Promise(resolve => setImmediate(resolve));
  await store.loadDirectoryReceipts(true);
  const hydrated = store.useDirectoryReceipts()[0];
  await store.updateDirectoryReceipt(hydrated.id, { inspection: { state: 'exists', detail: 'newer observation' } });
  release(); await pending;
  assert.equal(store.useDirectoryReceipts().length, 1);
  assert.equal(store.useDirectoryReceipts()[0].outcome, 'unknown');
  assert.equal(store.useDirectoryReceipts()[0].inspection.state, 'exists');
});

test('pending is published only after durable intent and failed persistence permits a safe explicit retry', async () => {
  let release;
  let reject = true;
  const saved = [];
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => [],
    saveRemoteDirectoryReceipt: async receipt => {
      if (reject) throw new Error('database unavailable');
      await new Promise(resolve => { release = resolve; }); saved.push(receipt);
    },
  });
  await assert.rejects(store.beginDirectoryReceipt(target, '/fixture/new'), /database unavailable/);
  assert.deepEqual(store.useDirectoryReceipts(), []);
  reject = false;
  const pending = store.beginDirectoryReceipt(target, '/fixture/new');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.useDirectoryReceipts().length, 0);
  release();
  const receipt = await pending;
  assert.equal(saved[0].outcome, 'pending');
  assert.equal(store.useDirectoryReceipts()[0].id, receipt.id);
  assert.equal(store.blocksDirectoryCreation(receipt, target, receipt.path), true);
  assert.equal(await store.beginDirectoryReceipt(target, receipt.path), null);
});

test('native active pending is preserved across fresh modules; only native completion releases busy state', async () => {
  let receipt = { id: 'active', target, path: '/fixture/active', outcome: 'pending', detail: '', active: true };
  const native = { listRemoteDirectoryReceipts: async () => [structuredClone(receipt)] };
  const original = await loadStore(native);
  const refreshed = await loadStore(native);
  for (const store of [original, refreshed]) {
    await store.loadDirectoryReceipts();
    await store.loadDirectoryReceipts(true);
    assert.equal(store.useDirectoryReceipts()[0].outcome, 'pending');
    assert.equal(store.blocksDirectoryCreation(store.useDirectoryReceipts()[0], target, receipt.path), true);
  }
  receipt = { ...receipt, outcome: 'unknown', active: false };
  for (const store of [original, refreshed]) {
    await store.loadDirectoryReceipts(true);
    assert.equal(store.useDirectoryReceipts()[0].outcome, 'unknown');
    assert.equal(store.blocksDirectoryCreation(store.useDirectoryReceipts()[0], target, receipt.path), true);
  }
});

test('an older list cannot overwrite a newer saved outcome', async () => {
  let release;
  let hold = false;
  let saved = { id: 'race', target, path: '/fixture/race', outcome: 'unknown', detail: '' };
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => {
      const captured = structuredClone(saved);
      if (hold) await new Promise(resolve => { release = resolve; });
      return [captured];
    },
    saveRemoteDirectoryReceipt: async receipt => { saved = receipt; },
  });
  await store.loadDirectoryReceipts();
  hold = true;
  const stale = store.loadDirectoryReceipts(true);
  await store.updateDirectoryReceipt(saved.id, { outcome: 'created' });
  release(); await stale;
  assert.equal(store.useDirectoryReceipts()[0].outcome, 'created');
});

test('rejected late inspection rehydrates the authoritative native terminal result', async () => {
  let saved = { id: 'terminal', target, path: '/fixture/terminal', outcome: 'unknown', detail: '' };
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => [structuredClone(saved)],
    saveRemoteDirectoryReceipt: async () => { saved = { ...saved, outcome: 'created' }; throw new Error('native result already final'); },
  });
  await store.loadDirectoryReceipts();
  assert.equal(await store.updateDirectoryReceipt(saved.id, { inspection: { state: 'missing', detail: 'late observation' } }), false);
  assert.equal(store.useDirectoryReceipts()[0].outcome, 'created');
  assert.equal(store.useDirectoryReceipts()[0].inspection, undefined);
});

test('fresh application restores only unresolved faults, while a current view retains its completion feedback', async () => {
  const records = [
    { id: 'success', target, path: '/fixture/success', outcome: 'created', detail: '' },
    { id: 'missing', target, path: '/fixture/missing', outcome: 'unknown', detail: '', inspection: { state: 'missing', detail: 'confirmed' } },
    { id: 'unknown', target, path: '/fixture/unknown', outcome: 'unknown', detail: '' },
  ];
  const store = await loadStore({ listRemoteDirectoryReceipts: async () => records.map(item => structuredClone(item)) });
  await store.loadDirectoryReceipts();
  assert.deepEqual(store.useDirectoryReceipts().map(item => item.id), ['unknown']);
  records[2].outcome = 'created';
  await store.loadDirectoryReceipts(true);
  assert.equal(store.useDirectoryReceipts()[0].outcome, 'created');
});

test('a replaced inspection cannot publish or persist its late missing result over the newer check', async () => {
  let saved = { id: 'inspection', target, path: '/fixture/inspection', outcome: 'unknown', detail: '' };
  let release;
  let hold = true;
  const store = await loadStore({
    listRemoteDirectoryReceipts: async () => [structuredClone(saved)],
    saveRemoteDirectoryReceipt: async next => {
      if (hold) await new Promise(resolve => { release = resolve; });
      saved = structuredClone(next);
    },
  });
  await store.loadDirectoryReceipts();
  const older = store.beginDirectoryInspection(saved.id);
  const oldChecking = store.updateDirectoryReceipt(saved.id, { inspection: { state: 'checking', detail: '' } }, older);
  const newer = store.beginDirectoryInspection(saved.id);
  const newChecking = store.updateDirectoryReceipt(saved.id, { inspection: { state: 'checking', detail: '' } }, newer);
  hold = false; release();
  assert.equal(await oldChecking, false);
  assert.equal(await newChecking, true);
  assert.equal(await store.updateDirectoryReceipt(saved.id, { inspection: { state: 'exists', detail: 'new observation' } }, newer), true);
  assert.equal(await store.updateDirectoryReceipt(saved.id, { inspection: { state: 'missing', detail: 'old observation' } }, older), false);
  assert.equal(saved.inspection.state, 'exists');
  assert.equal(store.useDirectoryReceipts()[0].inspection.state, 'exists');
});
