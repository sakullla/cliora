import { expect, test, type Page } from '@playwright/test';

type MemoryCall = { command: string; args: { target?: { toolId?: string; scope?: string; projectPath?: string | null; contextId?: string | null }; request?: { target?: { toolId?: string; scope?: string; projectPath?: string | null }; id?: string; text?: string; baseline?: string; confirmExternal?: boolean }; id?: string } };

const readOnlyLimitation = '只读存储，不能新建、编辑、删除或启停';

function memoryCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __memory: { calls: MemoryCall[] } }).__memory.calls);
}

async function install(page: Page, options: { catalog?: 'none' | 'session' | 'memory'; suggestion?: string | null; mode?: string } = {}) {
  const catalog = options.catalog ?? 'memory';
  const suggestion = options.suggestion === undefined ? 'C:/A' : options.suggestion;
  await page.addInitScript(({ catalog: kind, suggestion: suggested, mode }) => {
    const state = {
      mode,
      reads: 0,
      deleted: [] as string[],
      texts: { 'a-note': 'from-a', 'b-note': 'from-b', 'beta-note': 'from-beta', 'global-note': 'from-global', 'custom-note': 'from-custom' } as Record<string, string>,
      picked: null as string | null,
      unavailable: null as string | null,
      fingerprints: {} as Record<string, string>,
      calls: [] as MemoryCall[],
    };
    (window as unknown as { __memory: typeof state }).__memory = state;
    if (suggested) localStorage.setItem('cliora:workspace-context', JSON.stringify({ alpha: { scope: 'project', projectPath: suggested, resource: 'config' } }));
    else localStorage.removeItem('cliora:workspace-context');
    const full = ['list', 'open', 'create', 'edit', 'delete', 'master_switch', 'item_enable'];
    const facet = (history: 'planned' | 'available') => ({ state: history, reason: history === 'available' ? '仅有会话日志' : '' });
    const base = (id: string, name: string, memory?: unknown) => ({
      id, name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'planned', reason: '' }, resume: { state: 'planned', reason: '' },
      resources: { state: 'planned', reason: '' }, history: facet(id === 'gamma' ? 'available' : 'planned'),
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
        ];
    const ids = registered.map(item => item.id);
    const projects = [
      { id: 'a', name: '栖点 A', path: 'C:/A', available: true, preferredTool: 'alpha', lastOpened: 3, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
      { id: 'b', name: '栖点 B', path: 'C:/B', available: true, preferredTool: 'alpha', lastOpened: 2, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
      { id: 'gone', name: '缺失', path: 'C:/Gone', available: false, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
    ];
    const workspace = () => ({
      effectiveContextId: null,
      probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], installUrl: '', upgradeHint: '', dependencies: [], installCommand: null, upgradeCommand: null, providerPresets: [] },
      profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    const listFor = (target: { toolId?: string; scope?: string; projectPath?: string | null }) => {
      if (target.toolId === 'beta') return { inUse: true, detail: '', operations: ['list', 'open'], limitation: '只读存储，不能新建、编辑、删除或启停', entries: [{ id: 'beta-note', path: 'beta.md', enabled: true, fingerprint: 'fp-beta' }] };
      const entries = (target.scope === 'global'
        ? [{ id: 'global-note', path: 'global.md', enabled: true, fingerprint: 'fp-global' }]
        : target.projectPath === 'C:/B'
          ? [{ id: 'b-note', path: 'b.md', enabled: true, fingerprint: 'fp-b' }]
          : target.projectPath === 'C:/custom'
            ? [{ id: 'custom-note', path: 'custom.md', enabled: true, fingerprint: 'fp-custom' }]
            : [{ id: 'a-note', path: 'a.md', enabled: true, fingerprint: 'fp-a' }]).filter(entry => !state.deleted.includes(entry.id));
      const inUse = state.mode !== 'master-off';
      return { inUse, detail: inUse ? '' : '记忆当前未使用', operations: full, limitation: '', entries };
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: MemoryCall['args'] = {}) => {
          state.calls.push({ command, args });
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ids, theme: 'system', tool_icons: {} }, tools: registered.map(item => ({ id: item.id, name: item.name })) };
          if (command === 'list_cli_adapters') return { registered, managedIds: ids, preservedUnknown: [] };
          if (command === 'list_projects') return projects;
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_registered_tool_workspace' || command === 'get_registered_tool_context') return workspace();
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_memories') {
            if (state.unavailable && args.target?.projectPath === state.unavailable) throw new Error('项目目录不存在或无法访问，请重新关联目录');
            return listFor(args.target ?? {});
          }
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
          if (command === 'set_memory_enabled') return listFor(args.request?.target ?? {});
          if (command === 'plugin:dialog|open') return state.picked;
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return () => {};
          return null;
        },
      },
    });
  }, { catalog, suggestion, mode: options.mode ?? 'normal' });
}

async function openMemory(page: Page) {
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '记忆' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Alpha' })).toBeVisible();
}

test('memory stays out of navigation when no managed CLI declares it', async ({ page }) => {
  await install(page, { catalog: 'none', suggestion: null });
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  await expect(page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '记忆', exact: true })).toHaveCount(0);
});

test('a session-only CLI does not get a memory entry', async ({ page }) => {
  await install(page, { catalog: 'session', suggestion: null });
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  await expect(page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '记忆', exact: true })).toHaveCount(0);
});

test('each memory CLI keeps its own scope and target, and read-only storage hides writes', async ({ page }) => {
  await install(page, { suggestion: 'C:/A' });
  await openMemory(page);
  await expect(page.getByRole('tab', { name: 'Gamma' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Beta' })).toBeVisible();
  await expect(page.getByText('当前记忆目标：项目 · 栖点 A')).toBeVisible();
  await expect(page.getByRole('button', { name: '全局', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '项目', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建记忆' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '记忆总开关' })).toBeVisible();

  await page.getByRole('tab', { name: 'Beta' }).click();
  await expect(page.getByText('当前记忆目标：全局')).toBeVisible();
  await expect(page.getByRole('button', { name: '项目', exact: true })).toHaveCount(0);
  await expect(page.getByText(readOnlyLimitation)).toBeVisible();
  await expect(page.getByRole('button', { name: '新建记忆' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存记忆' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '记忆总开关' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /启用/ })).toHaveCount(0);
  await page.getByRole('button', { name: '打开 beta-note' }).click();
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveValue('from-beta');

  await page.getByRole('tab', { name: 'Alpha' }).click();
  await expect(page.getByText('当前记忆目标：项目 · 栖点 A')).toBeVisible();
  const beforeGone = (await memoryCalls(page)).filter(call => call.command === 'list_memories').length;
  await page.getByRole('combobox', { name: '记忆项目' }).evaluate((element, value) => {
    const select = element as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'C:/Gone');
  await expect(page.getByText('目标目录不可用，请重新选择。已保留原来的记忆目标。')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '记忆项目' })).toHaveValue('C:/A');
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'list_memories' && call.args.target?.projectPath === 'C:/Gone').length).toBe(0);
  expect((await memoryCalls(page)).filter(call => call.command === 'list_memories').length).toBe(beforeGone);

  await page.getByRole('combobox', { name: '记忆项目' }).selectOption('C:/B');
  await expect(page.getByText('当前记忆目标：项目 · 栖点 B')).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 b-note' })).toBeVisible();
  await page.getByRole('button', { name: '打开 b-note' }).click();
  await page.getByRole('textbox', { name: '记忆正文' }).fill('edited-b');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory').length).toBe(1);
  const saved = (await memoryCalls(page)).filter(call => call.command === 'save_memory');
  expect(saved[0].args.request).toMatchObject({ id: 'b-note', text: 'edited-b', baseline: 'from-b', confirmExternal: false, target: { toolId: 'alpha', scope: 'project', projectPath: 'C:/B' } });
  const listed = (await memoryCalls(page)).filter(call => call.command === 'list_memories');
  const switched = listed.findIndex(call => call.args.target?.projectPath === 'C:/B');
  expect(switched).toBeGreaterThanOrEqual(0);
  expect(listed.slice(switched).every(call => call.args.target?.toolId === 'alpha' && call.args.target?.projectPath === 'C:/B')).toBe(true);
  expect((await memoryCalls(page)).some(call => ['save_configuration_draft', 'begin_configuration_draft', 'update_configuration_draft', 'apply_registered_native_profile', 'apply_common_configuration', 'reapply_account_profile'].includes(call.command))).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('cliora:workspace-context'))).toBe(JSON.stringify({ alpha: { scope: 'project', projectPath: 'C:/A', resource: 'config' } }));
});

test('project memory without a target asks for one, and global memory still works', async ({ page }) => {
  await install(page, { suggestion: null });
  await openMemory(page);
  await expect(page.getByRole('button', { name: '打开 global-note' })).toBeVisible();
  const before = (await memoryCalls(page)).filter(call => call.command === 'list_memories').length;
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await expect(page.getByText('请选择项目。项目级记忆不会列出其他项目。')).toBeVisible();
  await expect(page.getByRole('button', { name: /打开/ })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '记忆项目' }).locator('option')).toHaveText(['请选择项目', '栖点 A', '栖点 B', '缺失（目录不可用）']);
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'list_memories').length).toBe(before);
  await page.getByRole('combobox', { name: '记忆项目' }).selectOption('C:/B');
  await expect(page.getByRole('button', { name: '打开 b-note' })).toBeVisible();
  expect((await memoryCalls(page)).filter(call => call.command === 'list_memories' && call.args.target?.scope === 'project').every(call => call.args.target?.projectPath === 'C:/B')).toBe(true);
  await page.getByRole('button', { name: '全局', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开 global-note' })).toBeVisible();
  const globalLists = (await memoryCalls(page)).filter(call => call.command === 'list_memories' && call.args.target?.scope === 'global');
  expect(globalLists.length).toBeGreaterThan(0);
  expect(globalLists.every(call => call.args.target?.projectPath == null)).toBe(true);
});

test('delete asks for confirmation and cancel leaves the entry', async ({ page }) => {
  await install(page, { suggestion: 'C:/A' });
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
  expect(deleted[0].args.request).toMatchObject({ id: 'a-note', baseline: 'from-a', target: { toolId: 'alpha', scope: 'project', projectPath: 'C:/A' } });
});

test('an external fingerprint or save error waits for confirmation before writing', async ({ page }) => {
  await install(page, { suggestion: 'C:/A' });
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
  expect((await memoryCalls(page)).find(call => call.command === 'save_memory')?.args.request).toMatchObject({ text: 'page-text', confirmExternal: true, target: { projectPath: 'C:/A' } });

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
  await install(page, { suggestion: 'C:/A', mode: 'read-fail' });
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

test('a directory that is not a recorded project becomes the memory target only', async ({ page }) => {
  await install(page, { suggestion: 'C:/A' });
  await openMemory(page);
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  const stored = JSON.stringify({ alpha: { scope: 'project', projectPath: 'C:/A', resource: 'config' } });
  await page.evaluate(() => { (window as unknown as { __memory: { picked: string } }).__memory.picked = 'C:/Gone'; });
  await page.getByRole('button', { name: '选择目录' }).click();
  await expect(page.getByText('目标目录不可用，请重新选择。已保留原来的记忆目标。')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '记忆项目' })).toHaveValue('C:/A');
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  expect((await memoryCalls(page)).some(call => call.command === 'list_memories' && call.args.target?.projectPath === 'C:/Gone')).toBe(false);

  await page.evaluate(() => { (window as unknown as { __memory: { picked: string } }).__memory.picked = 'C:/custom'; });
  await page.getByRole('button', { name: '选择目录' }).click();
  await expect(page.getByText('当前记忆目标：项目 · C:/custom')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '记忆项目' })).toHaveValue('C:/custom');
  await expect(page.getByRole('button', { name: '打开 custom-note' })).toBeVisible();
  await page.getByRole('button', { name: '打开 custom-note' }).click();
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveValue('from-custom');
  await page.getByRole('textbox', { name: '记忆正文' }).fill('edited-custom');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).some(call => call.command === 'save_memory' && call.args.request?.target?.projectPath === 'C:/custom' && call.args.request?.text === 'edited-custom')).toBe(true);
  const customReads = (await memoryCalls(page)).filter(call => call.command === 'read_memory' && call.args.target?.projectPath === 'C:/custom');
  expect(customReads.length).toBeGreaterThan(0);
  expect((await memoryCalls(page)).some(call => call.command === 'add_project' || call.command === 'relink_project' || call.command === 'save_configuration_draft' || call.command === 'apply_registered_native_profile')).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('cliora:workspace-context'))).toBe(stored);
  const lists = (await memoryCalls(page)).filter(call => call.command === 'list_memories' && call.args.target?.projectPath === 'C:/custom');
  expect(lists.length).toBeGreaterThan(0);
  expect(lists.every(call => call.args.target?.toolId === 'alpha' && call.args.target?.scope === 'project')).toBe(true);
});

test('an unavailable project stays selected after global memory has listed', async ({ page }) => {
  await install(page, { suggestion: 'C:/A' });
  await openMemory(page);
  const stored = JSON.stringify({ alpha: { scope: 'project', projectPath: 'C:/A', resource: 'config' } });
  await page.getByRole('combobox', { name: '记忆项目' }).selectOption('C:/B');
  await expect(page.getByRole('button', { name: '打开 b-note' })).toBeVisible();
  await page.getByRole('button', { name: '全局', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开 global-note' })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __memory: { unavailable: string } }).__memory.unavailable = 'C:/B'; });
  const mark = (await memoryCalls(page)).length;
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await expect(page.getByText('目标目录不可用，请重新选择。已保留原来的记忆目标。')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '记忆项目' })).toHaveValue('C:/B');
  await expect(page.getByText('当前记忆目标：项目 · 栖点 B')).toBeVisible();
  await expect(page.getByRole('button', { name: '全局', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const later = (await memoryCalls(page)).slice(mark);
  expect(later.some(call => call.command === 'list_memories' && call.args.target?.projectPath === 'C:/B')).toBe(true);
  expect(later.some(call => call.command === 'list_memories' && (call.args.target?.scope === 'global' || call.args.target?.projectPath === 'C:/A'))).toBe(false);
  expect(later.some(call => call.command === 'read_memory' || call.command === 'save_memory')).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('cliora:workspace-context'))).toBe(stored);
});

test('a master switch that is off still lists and opens memory', async ({ page }) => {
  await install(page, { suggestion: 'C:/A', mode: 'master-off' });
  await openMemory(page);
  await expect(page.getByText('记忆当前未使用')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '记忆总开关' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '打开 a-note' })).toBeVisible();
  await page.getByRole('button', { name: '打开 a-note' }).click();
  await expect(page.getByRole('textbox', { name: '记忆正文' })).toHaveValue('from-a');
});
