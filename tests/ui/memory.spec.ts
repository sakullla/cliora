import { expect, test, type Page } from '@playwright/test';

type MemoryCall = { command: string; args: { toolId?: string; target?: { toolId?: string; scope?: string; projectPath?: string | null; contextId?: string | null; storeDirectory?: string }; request?: { target?: { toolId?: string; scope?: string; projectPath?: string | null; contextId?: string | null; storeDirectory?: string }; id?: string | null; text?: string; baseline?: string; confirmExternal?: boolean; enabled?: boolean }; id?: string } };

const readOnlyLimitation = '只读存储，不能新建、编辑、删除或启停';

const alphaGlobalStore = 'C:/home/.alpha/memory';
const alphaAStore = 'C:/home/.alpha/projects/a';
const alphaBStore = 'C:/home/.alpha/projects/b';
const betaStore = 'C:/home/.beta/memory';

function memoryCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __memory: { calls: MemoryCall[] } }).__memory.calls);
}

async function install(page: Page, options: { catalog?: 'none' | 'session' | 'memory'; suggestion?: string | null; mode?: string } = {}) {
  const catalog = options.catalog ?? 'memory';
  const suggestion = options.suggestion === undefined ? 'C:/A' : options.suggestion;
  const storePaths = { alphaGlobal: alphaGlobalStore, alphaA: alphaAStore, alphaB: alphaBStore, beta: betaStore };
  await page.addInitScript(({ catalog: kind, suggestion: suggested, mode, stores }) => {
    const state = {
      mode,
      reads: 0,
      deleted: [] as string[],
      texts: { 'a-note': 'from-a', 'b-note': 'from-b', 'beta-note': 'from-beta', 'global-note': 'from-global' } as Record<string, string>,
      fingerprints: {} as Record<string, string>,
      failSource: null as string | null,
      calls: [] as MemoryCall[],
    };
    (window as unknown as { __memory: typeof state }).__memory = state;
    // The suggestion is the stored workspace context of the project-only CLI (delta).
    if (suggested) localStorage.setItem('cliora:workspace-context', JSON.stringify({ delta: { scope: 'project', projectPath: suggested, resource: 'config' } }));
    else localStorage.removeItem('cliora:workspace-context');
    const full = ['list', 'open', 'create', 'edit', 'delete', 'master_switch', 'item_enable'];
    const base = (id: string, name: string, memory?: unknown) => ({
      id, name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'planned', reason: '' }, resume: { state: 'planned', reason: '' },
      resources: { state: 'planned', reason: '' }, history: { state: 'planned', reason: '' },
      management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false, ...(memory ? { memory } : {}) },
    });
    const registered = kind === 'none'
      ? [base('codex', 'Codex')]
      : kind === 'session'
        ? [base('gamma', 'Gamma')]
        : [
          base('alpha', 'Alpha', { scope: { global: true, project: true }, targets: ['project'], operations: full }),
          base('beta', 'Beta', { scope: { global: true, project: false }, targets: [], operations: ['list', 'open'], limitation: '只读存储，不能新建、编辑、删除或启停' }),
          base('gamma', 'Gamma'),
          base('delta', 'Delta', { scope: { global: false, project: true }, targets: ['project'], operations: full }),
        ];
    const ids = registered.map(item => item.id);
    const workspace = () => ({
      effectiveContextId: null,
      probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], installUrl: '', upgradeHint: '', dependencies: [], installCommand: null, upgradeCommand: null, providerPresets: [] },
      profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    const entry = (id: string, store: string, sourceLabel: string, target: Record<string, unknown>) => ({
      id, path: `${store}/${id}.md`, enabled: true, fingerprint: `fp-${id}`, sourceLabel, target, inUse: state.mode !== 'master-off', detail: state.mode === 'master-off' ? '记忆当前未使用' : '',
    });
    const aggregateFor = (toolId: string) => {
      if (toolId === 'beta') return { toolId, failedSources: [], entries: [entry('beta-note', stores.beta, '全局', { toolId: 'beta', scope: 'global', projectPath: null, storeDirectory: stores.beta })] };
      if (toolId !== 'alpha') return { toolId, failedSources: [], entries: [] };
      const entries = [
        entry('global-note', stores.alphaGlobal, '全局', { toolId: 'alpha', scope: 'global', projectPath: null, storeDirectory: stores.alphaGlobal }),
        entry('a-note', stores.alphaA, '项目 · 栖点 A', { toolId: 'alpha', scope: 'project', projectPath: 'C:/A', storeDirectory: stores.alphaA }),
        entry('b-note', stores.alphaB, '项目 · 栖点 B', { toolId: 'alpha', scope: 'project', projectPath: 'C:/B', storeDirectory: stores.alphaB }),
      ].filter(item => !state.deleted.includes(item.id));
      const failedSources = state.failSource ? [{ label: state.failSource, reason: '项目目录不存在或无法访问' }] : [];
      return { toolId, entries, failedSources };
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: MemoryCall['args'] = {}) => {
          state.calls.push({ command, args });
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ids, theme: 'system', tool_icons: {} }, tools: registered.map(item => ({ id: item.id, name: item.name })) };
          if (command === 'list_cli_adapters') return { registered, managedIds: ids, preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_registered_tool_workspace' || command === 'get_registered_tool_context') return workspace();
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_all_memories') return aggregateFor(args.toolId ?? '');
          if (command === 'read_memory') {
            state.reads += 1;
            if (state.mode === 'read-fail') throw new Error('无法读取记忆，请重试');
            const id = args.id ?? '';
            const fingerprint = state.mode === 'fingerprint' ? `external-${state.reads}` : (state.fingerprints[id] ?? `fp-${id}`);
            return { id, path: `${id}.md`, text: state.texts[id] ?? 'hello', fingerprint, enabled: true, inUse: state.mode !== 'master-off', detail: state.mode === 'master-off' ? '记忆当前未使用' : '' };
          }
          if (command === 'save_memory') {
            if (state.mode === 'save-fail') throw new Error('无法保存记忆，请重试');
            if (state.mode === 'external-error' && !args.request?.confirmExternal) throw new Error('记忆已被外部修改，确认后才会写入，请重试');
            const id = args.request?.id ?? '';
            const text = args.request?.text ?? '';
            state.texts[id] = text;
            state.fingerprints[id] = 'fp-saved';
            return { id, path: `${id}.md`, text, fingerprint: 'fp-saved', enabled: true, inUse: true, detail: '' };
          }
          if (command === 'delete_memory') {
            if (state.mode === 'delete-fail') throw new Error('无法删除记忆，请重试');
            if (args.request?.id) state.deleted.push(args.request.id);
            return null;
          }
          if (command === 'set_memory_enabled') return null;
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return () => {};
          return null;
        },
      },
    });
  }, { catalog, suggestion, mode: options.mode ?? 'normal', stores: storePaths });
}

async function openWorkspace(page: Page) {
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByRole('heading', { name: '工具与连接' })).toBeVisible();
}

async function openMemory(page: Page, tool = 'Alpha') {
  await openWorkspace(page);
  if (tool !== 'Alpha') await page.getByRole('tab', { name: tool, exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(page.getByRole('region', { name: '记忆' })).toBeVisible();
}

test('the memory tab stays out of the workspace and navigation when no CLI declares it', async ({ page }) => {
  await install(page, { catalog: 'none', suggestion: null });
  await openWorkspace(page);
  await expect(page.getByRole('tab', { name: '记忆', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '记忆', exact: true })).toHaveCount(0);
});

test('a session-only CLI does not get a memory tab', async ({ page }) => {
  await install(page, { catalog: 'session', suggestion: null });
  await openWorkspace(page);
  await expect(page.getByRole('tab', { name: '记忆', exact: true })).toHaveCount(0);
});

test('the memory tab aggregates stores with source labels and no target selectors', async ({ page }) => {
  await install(page);
  await openMemory(page);
  const region = page.getByRole('region', { name: '记忆' });
  await expect(page.getByRole('button', { name: '打开 global-note' })).toBeVisible();
  await expect(page.getByText('来源：全局').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await expect(page.getByText('来源：项目 · 栖点 A')).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 b-note' })).toBeVisible();
  await expect(page.getByText('来源：项目 · 栖点 B')).toBeVisible();
  // No scope switch, project dropdown, or account selector on this tab.
  await expect(region.getByRole('combobox')).toHaveCount(0);
  await expect(region.getByRole('button', { name: '全局', exact: true })).toHaveCount(0);
  await expect(region.getByRole('button', { name: '项目', exact: true })).toHaveCount(0);
  await expect(region.getByText(/账号/)).toHaveCount(0);
  expect((await memoryCalls(page)).filter(call => call.command === 'list_all_memories').every(call => call.args.toolId === 'alpha')).toBe(true);

  // A CLI without a verified memory declaration never offers the tab.
  await page.getByRole('tab', { name: 'Gamma', exact: true }).click();
  await expect(page.getByRole('tab', { name: '记忆', exact: true })).toHaveCount(0);

  // A read-only CLI lists and opens but hides every write control.
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(page.getByText(readOnlyLimitation)).toBeVisible();
  await expect(page.getByRole('button', { name: '新建记忆' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /记忆总开关|启用/ })).toHaveCount(0);
  await page.getByRole('button', { name: '打开 beta-note' }).click();
  const body = page.getByRole('textbox', { name: '记忆正文' });
  await expect(body).toHaveAttribute('readonly', '');
  await expect(body).toHaveValue('from-beta');
  await expect(page.getByRole('button', { name: '保存记忆' })).toHaveCount(0);
});

test('a failed source is noted inline and does not block the other stores', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await page.evaluate(() => { (window as unknown as { __memory: { failSource: string } }).__memory.failSource = '项目 · 缺失'; });
  await page.getByRole('checkbox', { name: '全局 · 记忆总开关' }).click();
  await expect(page.getByText('来源「项目 · 缺失」暂时无法读取：项目目录不存在或无法访问。其余来源不受影响。')).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 b-note' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 global-note' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an empty aggregate explains the empty state', async ({ page }) => {
  await install(page, { suggestion: null });
  await openMemory(page, 'Delta');
  await expect(page.getByText('本机还没有已落盘的记忆条目。对应 CLI 产生记忆后会出现在这里。')).toBeVisible();
  await expect(page.getByRole('button', { name: /打开/ })).toHaveCount(0);
});

test('open, edit, and save carry the entry target and only affect that store', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await page.getByRole('button', { name: '打开 a-note' }).click();
  const body = page.getByRole('textbox', { name: '记忆正文' });
  await expect(body).toHaveValue('from-a');
  await body.fill('edited-a');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory').length).toBe(1);
  const saved = (await memoryCalls(page)).filter(call => call.command === 'save_memory');
  expect(saved[0].args.request).toMatchObject({ id: 'a-note', text: 'edited-a', baseline: 'from-a', confirmExternal: false, target: { toolId: 'alpha', scope: 'project', projectPath: 'C:/A', storeDirectory: alphaAStore } });
  expect((await memoryCalls(page)).filter(call => call.command === 'save_memory').every(call => call.args.request?.target?.storeDirectory === alphaAStore)).toBe(true);
  // The aggregate reload keeps the other stores listed and untouched.
  await expect(page.getByRole('button', { name: '打开 b-note' })).toBeVisible();
  await page.getByRole('button', { name: '打开 b-note' }).click();
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveValue('from-b');
  expect((await memoryCalls(page)).some(call => ['save_configuration_draft', 'begin_configuration_draft', 'update_configuration_draft', 'apply_registered_native_profile', 'apply_common_configuration', 'reapply_account_profile'].includes(call.command))).toBe(false);
  const lists = (await memoryCalls(page)).filter(call => call.command === 'list_all_memories');
  expect(lists.length).toBeGreaterThan(1);
  expect(lists.every(call => call.args.toolId === 'alpha')).toBe(true);
});

test('delete asks for confirmation and cancel leaves the entry', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await page.getByRole('button', { name: '删除 a-note' }).click();
  await expect(page.getByRole('heading', { name: '删除记忆' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  expect((await memoryCalls(page)).some(call => call.command === 'delete_memory')).toBe(false);
  await page.getByRole('button', { name: '删除 a-note' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开 a-note' })).toHaveCount(0);
  const deleted = (await memoryCalls(page)).filter(call => call.command === 'delete_memory');
  expect(deleted).toHaveLength(1);
  expect(deleted[0].args.request).toMatchObject({ id: 'a-note', baseline: 'from-a', target: { toolId: 'alpha', scope: 'project', projectPath: 'C:/A', storeDirectory: alphaAStore } });
  await expect(page.getByRole('button', { name: '打开 b-note' })).toBeVisible();
});

test('an external fingerprint or save error waits for confirmation before writing', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await page.getByRole('button', { name: '打开 a-note' }).click();
  await page.getByRole('textbox', { name: '记忆正文' }).fill('page-text');
  await page.evaluate(() => { (window as unknown as { __memory: { mode: string } }).__memory.mode = 'fingerprint'; });
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(page.getByRole('heading', { name: '记忆已被外部修改' })).toBeVisible();
  expect((await memoryCalls(page)).some(call => call.command === 'save_memory')).toBe(false);
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveValue('page-text');
  expect((await memoryCalls(page)).some(call => call.command === 'save_memory')).toBe(false);
  await page.getByRole('button', { name: '保存记忆' }).click();
  await page.getByRole('button', { name: '确认写入' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory').length).toBe(1);
  expect((await memoryCalls(page)).find(call => call.command === 'save_memory')?.args.request).toMatchObject({ text: 'page-text', confirmExternal: true, target: { storeDirectory: alphaAStore } });

  await page.evaluate(() => { (window as unknown as { __memory: { mode: string } }).__memory.mode = 'external-error'; });
  await page.getByRole('textbox', { name: '记忆正文' }).fill('page-text-again');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(page.getByRole('heading', { name: '记忆已被外部修改' })).toBeVisible();
  const rejected = (await memoryCalls(page)).filter(call => call.command === 'save_memory' && call.args.request?.text === 'page-text-again');
  expect(rejected).toHaveLength(1);
  expect(rejected[0].args.request?.confirmExternal).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __memory: { texts: Record<string, string> } }).__memory.texts['a-note'])).toBe('page-text');
  await page.getByRole('button', { name: '确认写入' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory' && call.args.request?.confirmExternal === true && call.args.request?.text === 'page-text-again').length).toBe(1);
});

test('failed read, save, and delete show the error and a retry', async ({ page }) => {
  await install(page, { mode: 'read-fail' });
  await openMemory(page);
  await page.getByRole('button', { name: '打开 a-note' }).click();
  await expect(page.getByRole('alert')).toContainText('无法读取记忆，请重试');
  await page.evaluate(() => { (window as unknown as { __memory: { mode: string } }).__memory.mode = 'normal'; });
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveValue('from-a');

  await page.getByRole('textbox', { name: '记忆正文' }).fill('retry-save');
  await page.evaluate(() => { (window as unknown as { __memory: { mode: string } }).__memory.mode = 'save-fail'; });
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(page.getByRole('alert')).toContainText('无法保存记忆，请重试');
  await page.evaluate(() => { (window as unknown as { __memory: { mode: string } }).__memory.mode = 'normal'; });
  const failedSaves = (await memoryCalls(page)).filter(call => call.command === 'save_memory').length;
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory' && call.args.request?.text === 'retry-save').length).toBe(failedSaves + 1);

  await page.evaluate(() => { (window as unknown as { __memory: { mode: string } }).__memory.mode = 'delete-fail'; });
  await page.getByRole('button', { name: '删除 a-note' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法删除记忆，请重试');
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __memory: { mode: string } }).__memory.mode = 'normal'; });
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('button', { name: '打开 a-note' })).toHaveCount(0);
});

test('a master switch that is off still lists and opens, and switch writes carry the store target', async ({ page }) => {
  await install(page, { mode: 'master-off' });
  await openMemory(page);
  await expect(page.getByText('记忆当前未使用').first()).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '全局 · 记忆总开关' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: '项目 · 栖点 A · 记忆总开关' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await page.getByRole('button', { name: '打开 a-note' }).click();
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveValue('from-a');

  await page.getByRole('checkbox', { name: '全局 · 记忆总开关' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'set_memory_enabled').length).toBe(1);
  const master = (await memoryCalls(page)).filter(call => call.command === 'set_memory_enabled');
  expect(master[0].args.request).toMatchObject({ id: null, enabled: true, target: { toolId: 'alpha', scope: 'global', projectPath: null, storeDirectory: alphaGlobalStore } });

  await page.getByRole('checkbox', { name: '启用 b-note' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'set_memory_enabled' && call.args.request?.id === 'b-note').length).toBe(1);
  const item = (await memoryCalls(page)).find(call => call.command === 'set_memory_enabled' && call.args.request?.id === 'b-note');
  expect(item?.args.request).toMatchObject({ enabled: false, target: { scope: 'project', projectPath: 'C:/B', storeDirectory: alphaBStore } });
});

test('create states the write location: global root, configured project, or disabled', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await expect(page.getByText('写入位置：全局')).toBeVisible();
  await page.getByRole('button', { name: '新建记忆' }).click();
  await expect(page.getByText('写入位置：全局')).toBeVisible();
  await page.getByRole('textbox', { name: '记忆标识' }).fill('created-note');
  await page.getByRole('textbox', { name: '记忆正文' }).fill('created-body');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).some(call => call.command === 'save_memory' && call.args.request?.id === 'created-note')).toBe(true);
  const saved = (await memoryCalls(page)).find(call => call.command === 'save_memory' && call.args.request?.id === 'created-note');
  expect(saved?.args.request).toMatchObject({ baseline: '', confirmExternal: false, target: { toolId: 'alpha', scope: 'global', projectPath: null } });
  expect(saved?.args.request?.target).not.toHaveProperty('storeDirectory');

  // A project-only CLI falls back to the stored configuration project.
  await page.getByRole('tab', { name: 'Delta', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(page.getByText('写入位置：项目 · C:/A')).toBeVisible();
  await page.getByRole('button', { name: '新建记忆' }).click();
  await page.getByRole('textbox', { name: '记忆标识' }).fill('delta-note');
  await page.getByRole('textbox', { name: '记忆正文' }).fill('delta-body');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).some(call => call.command === 'save_memory' && call.args.request?.id === 'delta-note')).toBe(true);
  const deltaSaved = (await memoryCalls(page)).find(call => call.command === 'save_memory' && call.args.request?.id === 'delta-note');
  expect(deltaSaved?.args.request).toMatchObject({ target: { toolId: 'delta', scope: 'project', projectPath: 'C:/A' } });
  expect(deltaSaved?.args.request?.target).not.toHaveProperty('storeDirectory');
});

test('a project-only CLI without a configured project disables create and explains why', async ({ page }) => {
  await install(page, { suggestion: null });
  await openMemory(page, 'Delta');
  await expect(page.getByRole('button', { name: '新建记忆' })).toBeDisabled();
  await expect(page.getByText('暂无默认写入位置：既没有全局根，也没有当前配置项目，无法新建。')).toBeVisible();
  expect((await memoryCalls(page)).some(call => call.command === 'save_memory')).toBe(false);
});
