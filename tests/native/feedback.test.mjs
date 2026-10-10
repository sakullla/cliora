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
  const code = ts.transpileModule(`const handler = ${found.getText(file).replace(/^export\s+/, '')};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
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
    setPlacements: noop, setConflict: noop, saveOperation: { current: null }, editorGeneration: { current: 1 }, editorRevision: { current: 0 }, distributeRef: { current: null }, t: translate,
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
    native: { previewMcpTargets: async () => [{ status: 'ready' }], listNativeMcp: async () => [], distributeMcp: async () => [{ status: 'failed', detail: 'write denied' }] },
  });
  await toggle({ id: 'A', name: 'A' }, 'tool', 'global', null, null);
  assert.deepEqual(store.getSnapshot().map(e => [e.tone, e.text]), [['error', 'write denied']]);
});


test('new object identity moves its event and only matching retry resolves it', () => {
  const store = createNotificationStore(); const result = store.begin('library', 'save:new', 'editor');
  result.pending('saving'); const id = store.getSnapshot()[0].id;
  result.identify('save:persisted'); result.committed('saved'); result.error('list offline');
  assert.deepEqual(store.getSnapshot().map(e => [e.id, e.operation, e.tone, e.detail]), [[id, 'save:persisted', 'partial', 'list offline']]);
  result.retry().success('refreshed'); result.error('obsolete');
  assert.equal(store.getSnapshot().length, 1); assert.equal(store.getSnapshot()[0].text, 'refreshed');
});

for (const distribute of [false, true]) test(`late MCP A success preserves B draft and never runs B distribution (${distribute})`, async () => {
  const store = createNotificationStore(); let resolve; let changes = 0; let writes = 0;
  const generation = { current: 1 }; const distribution = { current: { run: async () => { writes++; } } };
  const save = consumer('src/features/library/LibraryResources.tsx', 'save', {
    feedback: { begin: key => store.begin('mcp', key, 'A') }, draft: { id: 'A', args: [] }, formKey: 1,
    busy: false, envText: '', headerText: '', keptArgs: x => x, parseLines: () => ({}), failure: e => e.message,
    setBusy: noop, setDefinitions: () => changes++, setDraft: () => changes++, draftOf: x => x, placements: [], willDistribute: distribute,
    setPlacements: () => changes++, setConflict: () => changes++, saveOperation: { current: null }, editorGeneration: generation, editorRevision: { current: 0 }, distributeRef: distribution, t: translate,
    native: { saveMcpDefinition: () => new Promise(done => { resolve = done; }), listMcpDefinitions: async () => [] },
  });
  const pending = save(); generation.current++; distribution.current = { run: async () => { writes += 100; } };
  resolve({ id: 'A', version: 2 }); await pending;
  assert.equal(changes, 0); assert.equal(writes, 0);
  assert.equal(store.getSnapshot()[0].tone, distribute ? 'partial' : 'success');
  assert.equal(store.getSnapshot()[0].surface, 'A');
});

test('MCP committed version survives list failure; recovery reads without saving twice', async () => {
  const store = createNotificationStore(); let writes = 0; let readsFail = true; let draft;
  const save = consumer('src/features/library/LibraryResources.tsx', 'save', {
    feedback: { begin: key => store.begin('mcp', key), resume: result => result.retry() }, draft: { id: null, args: [] }, formKey: 1,
    busy: false, envText: '', headerText: '', keptArgs: x => x, parseLines: () => ({}), failure: e => e.message,
    setBusy: noop, setDefinitions: noop, setDraft: value => { draft = value; }, draftOf: x => x, placements: [], willDistribute: false,
    setPlacements: noop, setConflict: noop, saveOperation: { current: null }, editorGeneration: { current: 1 }, editorRevision: { current: 0 }, distributeRef: { current: null }, t: translate,
    native: { saveMcpDefinition: async () => { writes++; return { id: 'saved', version: 7 }; }, listMcpDefinitions: async () => { if (readsFail) throw Error('list failed'); return []; } },
  });
  await save(); assert.equal(draft.version, 7); assert.equal(store.getSnapshot()[0].tone, 'partial');
  assert.match(store.getSnapshot()[0].operation, /saved/); assert.equal(store.getSnapshot()[0].detail, 'list failed');
  readsFail = false; await store.recover(store.getSnapshot()[0].id);
  assert.equal(writes, 1); assert.equal(draft.version, 7); assert.equal(store.getSnapshot()[0].tone, 'success');
});

test('home profile B success preserves profile A failure; conflict retry resolves A', async () => {
  const store = createNotificationStore(); let failure = true;
  const bindings = { notifications: store, conflictFeedback: { begin: key => store.begin('home-tool:tool', key, 'conflict') },
    states: { tool: { workspace: { profiles: [{ id: 'A' }, { id: 'B' }] } } }, acting: { current: new Set() }, requests: { current: new Map() },
    setChecking: noop, tools: [{ id: 'tool', name: 'Tool' }], t: translate, setStates: noop, setConflict: noop, rememberHome: noop,
    lineNotice: (tone, text) => ({ text }), message: e => e.message, settle: x => x,
    conflict: { toolId: 'tool', toolName: 'Tool', comparison: { profile: { id: 'A' } } },
    native: { applyRegisteredNativeProfile: async (_, id) => { if (id === 'A') throw Error('A failed'); }, applyComparedApplication: async () => { if (failure) throw Error('conflict failed'); } },
  };
  const apply = consumer('src/features/home/ManagedTools.tsx', 'switchProfile', bindings);
  await apply('tool', 'A'); await apply('tool', 'B'); assert.equal(store.getSnapshot().filter(e => e.tone === 'error').length, 1);
  const recover = consumer('src/features/home/ManagedTools.tsx', 'useComparedFile', bindings);
  await recover(); assert.equal(store.getSnapshot().find(e => e.tone === 'error').surface, 'conflict');
  failure = false; await recover(); assert.equal(store.getSnapshot().some(e => e.tone === 'error'), false);
});

test('home launch identity includes selected directory', async () => {
  const store = createNotificationStore(); const directories = new Map([['tool', 'A']]);
  const launch = consumer('src/features/home/ManagedTools.tsx', 'launchTool', {
    notifications: store, states: { tool: {} }, acting: { current: new Set() }, requests: { current: new Map() }, setChecking: noop, setStates: noop,
    tools: [{ id: 'tool' }], launchDirectories: directories, launchSettings: {}, preferredLaunchMode: () => 'normal', t: translate,
    lineNotice: (tone, text) => ({ text }), message: e => e.message, settle: x => x,
    native: { launchCli: async ({ directory }) => { if (directory === 'A') throw Error('A failed'); } },
  });
  await launch('tool'); directories.set('tool', 'B'); await launch('tool');
  assert.deepEqual(store.getSnapshot().map(e => e.tone), ['error', 'success']);
});

test('common per-target retries retain remaining failures and clear aggregate after last recovery', async () => {
  const store = createNotificationStore(); let outcomes = [{ scopeKey: 'A', status: 'failed', detail: 'A failed' }, { scopeKey: 'B', status: 'failed', detail: 'B failed' }];
  store.begin('config', 'save').partial('saved, apply failed');
  const retry = async key => consumer('src/features/tools/configuration/ConfigurationWorkspaceEditor.tsx', 'retryScope', {
    influence: { targets: [{ scopeKey: 'A' }, { scopeKey: 'B' }] }, saved: { common: {} }, busy: false,
    feedback: { begin: key => store.begin('config', key) }, setBusy: noop, alive: { current: true }, t: translate, messageOf: e => e.message,
    applications: outcomes, setApplications: value => { outcomes = value; }, applyCommonConfiguration: async (_, targets) => targets.map(t => ({ ...t, status: 'applied', detail: '' })),
  })(key);
  await retry('A'); assert.equal(store.getSnapshot()[0].detail, 'B failed');
  await retry('B'); assert.deepEqual(store.getSnapshot().map(e => e.tone), ['success']);
});

test('account read failure has one authority and polling success cannot clear a mutation error', async () => {
  const store = createNotificationStore(); const effects = []; let fail = true;
  const use = consumer('src/features/tools/AccountsPanel.tsx', 'useAccounts', {
    useRef: current => ({ current }), useState: value => [value, noop], useEffect: run => effects.push(run),
    useFeedback: context => ({ context, begin: key => store.begin(context, key) }), nativeAvailable: true,
    i18n: { t: translate }, window: { setInterval: noop, clearInterval: noop },
    native: { listAccounts: async () => { if (fail) throw Error('read failed'); return []; }, accountCapabilities: async () => [] },
  });
  const state = use('tool'); effects[0](); await state.refresh();
  assert.equal(store.getSnapshot().length, 1); assert.equal(store.getSnapshot()[0].text, 'read failed');
  store.begin('accounts', 'logout:A').error('logout failed'); fail = false; await state.refresh();
  assert.deepEqual(store.getSnapshot().map(e => e.text), ['logout failed']);
});


test('tool MCP accepts ID/version before list failure and read recovery never writes or closes', async () => {
  const store = createNotificationStore(); let writes = 0; let fails = true; let accepted; let applied = 0;
  const latest = { current: 'draft' };
  const save = consumer('src/features/tools/ResourceWorkspace.tsx', 'save', {
    feedback: { begin: key => store.begin('tool-mcp', key), resume: result => result.retry() }, draft: { name: 'new', args: [] },
    scope: 'global', project: null, nativeOrigin: null, editorGeneration: { current: 1 }, editorRevision: { current: 0 }, latestForm: latest, mounted: { current: true }, definitions: [], syncLibrary: true,
    setBusy: noop, keptArgs: x => x, parseLines: () => ({}), envText: '', headerText: '', enabled: true, setDefinitions: noop,
    select: value => { accepted = value; latest.current = value.id; }, target: {}, setCurrentConflict: noop,
    applyItems: async (_, __, ___, result) => { applied++; result.success('written'); return true; }, leaveComposer: noop,
    t: translate, errorText: e => e.message,
    native: { saveMcpDefinition: async () => { writes++; return { id: 'saved', version: 3 }; }, listMcpDefinitions: async () => { if (fails) throw Error('read failed'); return []; }, previewMcpTargets: async () => [{ status: 'ready' }], listNativeMcp: async () => [] },
  });
  await save(); assert.equal(accepted.version, 3); assert.equal(store.getSnapshot()[0].operation, 'save:saved'); assert.equal(store.getSnapshot()[0].tone, 'partial');
  fails = false; await store.recover(store.getSnapshot()[0].id);
  assert.equal(writes, 1); assert.equal(applied, 0); assert.equal(store.getSnapshot()[0].tone, 'partial');
});

test('configuration compare recovery replaces saved partial on both failure and success', async () => {
  const store = createNotificationStore(); let fail = true;
  store.begin('editor', 'save').partial('saved but not applied');
  const retry = consumer('src/features/tools/configuration/ConfigurationWorkspaceEditor.tsx', 'applyComparison', {
    feedback: { begin: key => store.begin('editor', key) }, comparison: {}, scope: 'global', projectPath: '', setBusy: noop,
    setComparison: noop, alive: { current: true }, t: translate, messageOf: e => e.message,
    native: { applyComparedApplication: async () => { if (fail) throw Error('apply failed'); } },
  });
  await retry(); assert.equal(store.getSnapshot().length, 1); assert.equal(store.getSnapshot()[0].detail, 'apply failed');
  fail = false; await retry(); assert.deepEqual(store.getSnapshot().map(e => e.tone), ['success']);
});

test('account mutation success plus failed read produces one read error and preserves successful mutation', async () => {
  const store = createNotificationStore();
  const run = consumer('src/features/tools/AccountsPanel.tsx', 'run', {
    feedback: { begin: key => store.begin('accounts', key) }, setBusy: noop, live: { current: true }, currentTool: { current: 'tool' }, toolId: 'tool', t: translate,
    state: { refresh: async () => { store.begin('read', 'refresh').error('read failed'); return null; } },
  });
  await run('rename:A', async () => true, 'renamed');
  assert.deepEqual(store.getSnapshot().map(e => [e.tone, e.text]), [['success', 'renamed'], ['error', 'read failed']]);
  await run('logout:B', async () => { throw Error('logout failed'); }, 'logged out');
  assert.equal(store.getSnapshot().filter(e => e.text === 'read failed').length, 1);
  assert.equal(store.getSnapshot().at(-1).text, 'logout failed');
});


for (const change of ['revision', 'session']) test(`library refresh recovery cannot close later draft after ${change} changes`, async () => {
  const store = createNotificationStore(); let read = 0; let resolve; let draft = { id: 'A', name: 'initial' };
  const generation = { current: 1 }; const revision = { current: 0 };
  const save = consumer('src/features/library/LibraryResources.tsx', 'save', {
    feedback: { begin: key => store.begin('mcp', key), resume: result => result.retry() }, draft: { id: 'A', args: [] }, formKey: 1,
    busy: false, envText: '', headerText: '', keptArgs: x => x, parseLines: () => ({}), failure: e => e.message,
    setBusy: noop, setDefinitions: noop, setDraft: value => { draft = typeof value === 'function' ? value(draft) : value; }, draftOf: x => x, placements: [], willDistribute: false,
    setPlacements: noop, setConflict: noop, saveOperation: { current: null }, editorGeneration: generation, editorRevision: revision, distributeRef: { current: null }, t: translate,
    native: { saveMcpDefinition: async () => ({ id: 'A', version: 2 }), listMcpDefinitions: async () => { if (++read === 1) throw Error('offline'); return new Promise(done => { resolve = done; }); } },
  });
  await save(); const recovery = store.recover(store.getSnapshot()[0].id);
  if (change === 'session') generation.current++; else revision.current++;
  draft = { id: change === 'session' ? 'B' : 'A', name: 'keep typing' };
  resolve([]); await recovery; assert.equal(draft.name, 'keep typing');
});

for (const change of ['none', 'revision', 'session']) test(`tool conflict uses one guard through distribute and list refresh (${change})`, async () => {
  const store = createNotificationStore(); let resolve; let closed = 0; let stateWrites = 0;
  const generation = { current: 1 }; const revision = { current: 0 }; const form = { current: 'A' };
  const common = { feedback: { begin: key => store.begin('mcp', key), resume: result => result.retry() }, t: translate, errorText: e => e.message,
    mounted: { current: true }, editorGeneration: generation, editorRevision: revision, latestForm: form, busy: false, setBusy: noop,
    currentConflict: { id: 'A', items: [{ toolId: 'tool', status: 'conflict' }], generation: 1, revision: 0, form: 'A' },
    setNativeEntries: () => stateWrites++, setCurrentConflict: () => stateWrites++, contextId: null, enabled: true, target: {},
    native: { distributeMcp: () => new Promise(done => { resolve = done; }), listNativeMcp: async () => [] },
  };
  const applyItems = consumer('src/features/tools/ResourceWorkspace.tsx', 'applyItems', common);
  const apply = consumer('src/features/tools/ResourceWorkspace.tsx', 'applyConflict', { ...common, applyItems, leaveComposer: () => closed++ });
  const pending = apply(); const changed = change !== 'none'; if (change === 'session') { generation.current++; form.current = 'B'; } else if (changed) { revision.current++; form.current = 'edited A'; }
  resolve([{ status: 'written' }]); await pending;
  assert.equal(closed, changed ? 0 : 1); assert.equal(stateWrites, changed ? 0 : 2);
});

test('old conflict preview cannot apply after continuing to edit the same draft', async () => {
  const store = createNotificationStore(); let writes = 0;
  const apply = consumer('src/features/tools/ResourceWorkspace.tsx', 'applyConflict', {
    feedback: { begin: key => store.begin('mcp', key) }, t: translate, errorText: e => e.message,
    mounted: { current: true }, editorGeneration: { current: 1 }, editorRevision: { current: 2 }, latestForm: { current: 'edited' }, busy: false,
    currentConflict: { id: 'A', items: [], generation: 1, revision: 1, form: 'initial' }, setBusy: noop,
    applyItems: async () => { writes++; return true; }, leaveComposer: noop,
  });
  await apply(); assert.equal(writes, 0); assert.equal(store.getSnapshot()[0].detail, 'common.feedback.stale');
});

for (const written of [false, true]) test(`repeated list failures retain saved and distribution stages with read-only recovery (${written})`, async () => {
  const store = createNotificationStore(); let writes = 0; let reads = 0; let closed = 0;
  const apply = consumer('src/features/tools/ResourceWorkspace.tsx', 'applyItems', {
    feedback: { resume: result => result.retry() }, t: translate, errorText: e => e.message,
    contextId: null, enabled: true, target: {}, setNativeEntries: noop, setCurrentConflict: () => closed++,
    native: { distributeMcp: async () => { writes++; return [{ status: written ? 'written' : 'failed', detail: 'target denied' }]; },
      listNativeMcp: async () => { if (++reads <= 3) throw Error('list offline ' + reads); return []; } },
  });
  await apply('A', [{ status: 'ready' }], false, store.begin('mcp', 'save:A'), () => true);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const event = store.getSnapshot()[0]; assert.equal(event.tone, 'partial'); assert.ok(event.recovery);
    assert.match(event.detail, new RegExp('list offline ' + attempt));
    if (!written) { assert.match(event.text, /definitionSaved/); assert.match(event.detail, /target denied/); }
    await store.recover(event.id);
  }
  assert.equal(writes, 1); assert.equal(reads, 4); assert.equal(closed, 0);
  const last = store.getSnapshot()[0]; assert.equal(last.tone, written ? 'success' : 'partial');
  if (!written) { assert.match(last.text, /definitionSaved/); assert.equal(last.detail, 'target denied'); }
});
