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

// Execute the real consumer handlers with native ports substituted. These cases
// exercise the identity and completion branches, not a duplicate implementation.
function consumer(path, name, bindings) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, `${path}#${name}`);
  const code = ts.transpileModule(`const handler = ${found.getText(file)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return handler;`)(...Object.values(bindings));
}
const noop = () => {};
const translate = (key) => key;

test('plugin B success preserves plugin A failure and A retry replaces only A', async () => {
  const store = createNotificationStore();
  let fails = true;
  const operate = consumer('src/features/tools/PluginsWorkspace.tsx', 'operate', {
    feedback: { begin: key => store.begin('plugins', key) }, snapshot: { baseline: 'base' }, busy: false,
    generation: { current: 1 }, target: {}, source: '', trusted: true, cacheKey: 'plugins',
    remembered: new Map(), remember: noop, setBusy: noop, setSnapshot: noop, setSource: noop, setTrusted: noop,
    t: translate, actionLabel: translate, message: e => e.message, confirmAction: async () => true,
    native: { operateNativePlugin: async ({ source }) => {
      if (source === 'A' && fails) throw Error('A denied');
      return { snapshot: null, status: 'written', detail: source + ' changed' };
    } },
  });
  await operate('disable', { id: 'A' });
  await operate('enable', { id: 'B' });
  assert.deepEqual(store.getSnapshot().map(e => e.text), ['A denied', 'B changed']);
  fails = false;
  await operate('disable', { id: 'A' });
  assert.equal(store.getSnapshot().some(e => e.tone === 'error'), false);
});

test('WebDAV successful silent retry resolves the same failed toggle', async () => {
  const store = createNotificationStore(); let fails = true;
  const toggle = consumer('src/features/settings/WebdavSettings.tsx', 'toggleEnabled', {
    feedback: { begin: key => store.begin('webdav', key) }, busy: false, status: { enabled: false },
    setBusy: noop, setStatus: noop, t: translate,
    native: { setWebdavEnabled: async () => { if (fails) throw Error('offline'); return {}; } },
  });
  await toggle(); assert.equal(store.getSnapshot()[0].tone, 'error');
  fails = false; await toggle(); assert.equal(store.getSnapshot().length, 0);
});

test('save-and-use publishes one persistent partial result with saved state and cause', async () => {
  let now = 0; const store = createNotificationStore(() => now);
  const apply = consumer('src/features/tools/configuration/ConfigurationWorkspaceEditor.tsx', 'applyStored', {
    toolId: 'tool', scope: 'global', projectPath: '', t: translate, setComparison: noop, messageOf: e => e.message,
    native: { applyRegisteredNativeProfile: async () => { throw Error('disk denied'); }, compareRegisteredApplication: async () => null },
  });
  assert.equal(await apply({ profile: { id: 'p1' } }, store.begin('config', 'save')), false);
  now = 10000; store.expire();
  assert.equal(store.getSnapshot().length, 1);
  assert.equal(store.getSnapshot()[0].tone, 'partial');
  assert.equal(store.getSnapshot()[0].text, 'tools.config.savedNotUsed');
  assert.equal(store.getSnapshot()[0].detail, 'disk denied');
});

test('late MCP save failure retains origin surface and successful retry clears it', async () => {
  const store = createNotificationStore(); let surface = 'dialog-A'; let reject;
  let pending = new Promise((_, fail) => { reject = fail; });
  const save = consumer('src/features/library/LibraryResources.tsx', 'save', {
    feedback: { begin: key => store.begin('mcp', key, surface) }, draft: { id: 'A', args: [] }, formKey: 1,
    busy: false, envText: '', headerText: '', keptArgs: x => x, parseLines: () => ({}), failure: e => e.message,
    setBusy: noop, setDefinitions: noop, setDraft: noop, draftOf: x => x, placements: [], willDistribute: false,
    setPlacements: noop, t: translate,
    native: { saveMcpDefinition: () => pending, listMcpDefinitions: async () => [], listMcpPlacements: async () => [] },
  });
  const first = save(); surface = 'dialog-B'; reject(Error('A failed')); await first;
  assert.equal(store.getSnapshot()[0].surface, 'dialog-A');
  assert.equal(store.getSnapshot()[0].text, 'A failed');
  surface = 'dialog-A'; pending = Promise.resolve({ id: 'A' }); await save();
  assert.deepEqual(store.getSnapshot().map(e => e.tone), ['success']);
});

test('terminal mode success cannot clear failed terminal selection', async () => {
  const store = createNotificationStore(); let fails = true;
  const bindings = {
    feedback: { begin: key => store.begin('terminal', key) }, setShowCustom: noop, setBusy: noop, setSettings: noop,
    settings: { presets: [] }, message: e => e.message,
    native: { setPreferredTerminal: async () => { if (fails) throw Error('terminal denied'); return {}; }, setDefaultLaunchMode: async () => ({}) },
  };
  const choose = consumer('src/features/settings/TerminalSettings.tsx', 'choose', bindings);
  const mode = consumer('src/features/settings/TerminalSettings.tsx', 'chooseMode', bindings);
  await choose('windows_terminal'); await mode('cli', 'yolo');
  assert.equal(store.getSnapshot()[0].text, 'terminal denied');
  fails = false; await choose('windows_terminal'); assert.equal(store.getSnapshot().length, 0);
});

test('quota query refresh success does not hide another query failure', async () => {
  const store = createNotificationStore();
  const refresh = consumer('src/features/tools/UsageQuota.tsx', 'refresh', {
    feedback: { begin: key => store.begin('quota', key) }, message: e => e.message, state: { reload: async () => {} },
    native: { refreshUsageQuery: async id => { if (id === 'A') throw Error('A unavailable'); } },
  });
  await refresh({ id: 'A' }); await refresh({ id: 'B' });
  assert.equal(store.getSnapshot()[0].text, 'A unavailable');
});

test('library MCP checks fulfilled business failure instead of announcing written', async () => {
  const store = createNotificationStore();
  const toggle = consumer('src/features/library/LibraryResources.tsx', 'toggleMcp', {
    feedback: { begin: key => store.begin('mcp', key) }, busy: false, tools: [], placements: [],
    setBusy: noop, setPlacements: noop, t: translate, failure: e => e.message,
    native: { previewMcpTargets: async () => [{ status: 'ready' }], distributeMcp: async () => [{ status: 'failed', detail: 'write denied' }] },
  });
  await toggle({ id: 'A', name: 'A' }, 'tool', 'global', null, null);
  assert.deepEqual(store.getSnapshot().map(e => [e.tone, e.text]), [['error', 'write denied']]);
});
