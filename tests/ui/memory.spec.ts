import { expect, test, type Page } from '@playwright/test';

type MemoryTargetArgs = { toolId?: string; scope?: string; projectPath?: string | null; contextId?: string | null; storeDirectory?: string };
type MemoryCall = { command: string; args: { toolId?: string; target?: MemoryTargetArgs; request?: { target?: MemoryTargetArgs; id?: string | null; text?: string; baseline?: string; confirmExternal?: boolean; enabled?: boolean }; id?: string } };

const readOnlyLimitation = '只读存储，不能新建、编辑、删除或启停';

const alphaGlobalStore = 'C:/home/.alpha/memory';
const alphaAStore = 'C:/home/.alpha/projects/a';
const alphaBStore = 'C:/home/.alpha/projects/b';
const betaStore = 'C:/home/.beta/memory';
const epsilonStores = ['C:/home/.epsilon/projects/one/memory', 'C:/home/.epsilon/projects/two/memory'];

function memoryCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __memory: { calls: MemoryCall[] } }).__memory.calls);
}

async function setMode(page: Page, mode: string) {
  await page.evaluate(value => { (window as unknown as { __memory: { mode: string } }).__memory.mode = value; }, mode);
}

async function install(page: Page, options: { catalog?: 'none' | 'session' | 'memory'; suggestion?: string | null; mode?: string } = {}) {
  const catalog = options.catalog ?? 'memory';
  const suggestion = options.suggestion === undefined ? 'C:/A' : options.suggestion;
  const storePaths = { alphaGlobal: alphaGlobalStore, alphaA: alphaAStore, alphaB: alphaBStore, beta: betaStore, epsilon: epsilonStores };
  await page.addInitScript(({ catalog: kind, suggestion: suggested, mode, stores }) => {
    const state = {
      mode,
      reads: 0,
      deleted: [] as string[],
      texts: { 'a-note': 'from-a', 'b-note': 'from-b', 'beta-note': 'from-beta', 'global-note': 'from-global', 'one-note': 'from-one', 'two-note': 'from-two' } as Record<string, string>,
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
          base('epsilon', 'Epsilon', { scope: { global: false, project: true }, targets: ['project'], operations: ['list', 'open', 'create', 'edit', 'delete', 'master_switch'] }),
        ];
    const ids = registered.map(item => item.id);
    const workspace = () => ({
      effectiveContextId: null,
      probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], installUrl: '', upgradeHint: '', dependencies: [], installCommand: null, upgradeCommand: null, providerPresets: [] },
      profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    const off = () => state.mode === 'master-off';
    const entry = (id: string, store: string, sourceLabel: string, target: Record<string, unknown>) => ({
      id, path: `${store}/${id}.md`, enabled: true, fingerprint: `fp-${id}`, sourceLabel, target, inUse: !off(), detail: off() ? '记忆当前未使用' : '',
    });
    const summarize = (entries: ReturnType<typeof entry>[], labels: [string, string, Record<string, unknown>][]) => labels.map(([label, directory, target]) => ({
      label, directory, target, inUse: !off(), detail: off() ? '记忆当前未使用' : '', entryCount: entries.filter(item => item.target === target).length,
    }));
    const aggregateFor = (toolId: string) => {
      if (toolId === 'beta') {
        const target = { toolId: 'beta', scope: 'global', projectPath: null, storeDirectory: stores.beta };
        const entries = [entry('beta-note', stores.beta, '全局', target)];
        return { toolId, failedSources: [], entries, stores: summarize(entries, [['全局', stores.beta, target]]), switchShared: false };
      }
      if (toolId === 'epsilon') {
        const one = { toolId: 'epsilon', scope: 'project', projectPath: null, storeDirectory: stores.epsilon[0] };
        const two = { toolId: 'epsilon', scope: 'project', projectPath: null, storeDirectory: stores.epsilon[1] };
        const entries = [entry('one-note', stores.epsilon[0], 'C:\\Work\\one', one), entry('two-note', stores.epsilon[1], 'C:\\Work\\two', two)];
        const three = { toolId: 'epsilon', scope: 'project', projectPath: null, storeDirectory: 'C:/home/.epsilon/projects/three/memory' };
        return { toolId, failedSources: [], entries, stores: summarize(entries, [['C:\\Work\\one', stores.epsilon[0], one], ['C:\\Work\\two', stores.epsilon[1], two], ['C:\\Work\\three', 'C:/home/.epsilon/projects/three/memory', three]]), switchShared: true };
      }
      if (toolId !== 'alpha') return { toolId, failedSources: [], entries: [], stores: [], switchShared: false };
      const globalTarget = { toolId: 'alpha', scope: 'global', projectPath: null, storeDirectory: stores.alphaGlobal };
      const aTarget = { toolId: 'alpha', scope: 'project', projectPath: 'C:/A', storeDirectory: stores.alphaA };
      const bTarget = { toolId: 'alpha', scope: 'project', projectPath: 'C:/B', storeDirectory: stores.alphaB };
      const entries = [
        entry('global-note', stores.alphaGlobal, '全局', globalTarget),
        entry('a-note', stores.alphaA, '项目 · 栖点 A', aTarget),
        entry('b-note', stores.alphaB, '项目 · 栖点 B', bTarget),
      ].filter(item => !state.deleted.includes(item.id));
      const failedSources = state.failSource ? [{ label: state.failSource, reason: '项目目录不存在或无法访问' }] : [];
      return { toolId, entries, failedSources, stores: summarize(entries, [['全局', stores.alphaGlobal, globalTarget], ['项目 · 栖点 A', stores.alphaA, aTarget], ['项目 · 栖点 B', stores.alphaB, bTarget]]), switchShared: false };
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
            return { id, path: `${id}.md`, text: state.texts[id] ?? 'hello', fingerprint, enabled: true, inUse: !off(), detail: off() ? '记忆当前未使用' : '' };
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

const entryButton = (page: Page, id: string) => page.getByRole('navigation', { name: '记忆列表' }).getByRole('button', { name: new RegExp(`${id}\\.md`) });
const reader = (page: Page) => page.getByRole('article');
const editor = (page: Page) => page.getByRole('textbox', { name: '记忆正文' });

async function editEntry(page: Page, id: string) {
  await entryButton(page, id).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editor(page)).toBeVisible();
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

test('the memory tab groups stores by source with summaries and no scope selector', async ({ page }) => {
  await install(page);
  await openMemory(page);
  const region = page.getByRole('region', { name: '记忆' });
  const list = page.getByRole('navigation', { name: '记忆列表' });
  await expect(entryButton(page, 'global-note')).toBeVisible();
  await expect(entryButton(page, 'a-note')).toBeVisible();
  await expect(entryButton(page, 'b-note')).toBeVisible();
  await expect(list.getByRole('button', { name: /^全局/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /^项目 · 栖点 A/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /^项目 · 栖点 B/ })).toBeVisible();
  // Each row also carries a body summary read over the existing entry IPC.
  await expect(entryButton(page, 'global-note')).toContainText('from-global');
  await expect(entryButton(page, 'a-note')).toContainText('from-a');
  await expect(entryButton(page, 'b-note')).toContainText('from-b');
  // The workspace scope selector is hidden on this tab; no account selector either.
  await expect(page.getByRole('button', { name: '配置范围' })).toBeHidden();
  await expect(region.getByText(/账号/)).toHaveCount(0);
  await expect(region.getByText('3 条 · 3 个来源')).toBeVisible();
  expect((await memoryCalls(page)).filter(call => call.command === 'list_all_memories').every(call => call.args.toolId === 'alpha')).toBe(true);

  // A CLI without a verified memory declaration never offers the tab.
  await page.getByRole('tab', { name: 'Gamma', exact: true }).click();
  await expect(page.getByRole('tab', { name: '记忆', exact: true })).toHaveCount(0);

  // A read-only CLI lists and reads but hides every write control.
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(page.getByText(readOnlyLimitation)).toBeVisible();
  await expect(entryButton(page, 'beta-note')).toContainText('from-beta');
  await expect(page.getByRole('button', { name: '新建记忆' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await entryButton(page, 'beta-note').click();
  await expect(reader(page)).toContainText('from-beta');
  await expect(reader(page).getByText('只读', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存记忆' })).toHaveCount(0);
});

test('frontmatter supplies titles, types, and descriptions; search and type filters narrow the list', async ({ page }) => {
  await install(page);
  await openWorkspace(page);
  await page.evaluate(() => {
    const texts = (window as unknown as { __memory: { texts: Record<string, string> } }).__memory.texts;
    texts['a-note'] = '---\nname: release-ritual\ndescription: "版本发布步骤"\nmetadata:\n  type: project\n  modified: 2026-10-18T02:45:50.600Z\n---\n\n## 发布流程\n\n1. 同步版本文件\n';
    texts['b-note'] = '# Coding style\n\nTwo-space indentation.\n\nSee [[release-ritual]] and [[gone-note]].';
  });
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(entryButton(page, 'a-note')).toContainText('Release ritual');
  await expect(entryButton(page, 'a-note')).toContainText('版本发布步骤');
  await expect(entryButton(page, 'a-note')).toContainText('项目');
  // A file without frontmatter takes its leading heading as the title.
  await expect(entryButton(page, 'b-note')).toContainText('Coding style');
  await expect(entryButton(page, 'b-note')).toContainText('Two-space indentation.');

  await entryButton(page, 'a-note').click();
  await expect(reader(page).getByRole('heading', { name: 'Release ritual' })).toBeVisible();
  await expect(reader(page).getByRole('heading', { name: '发布流程' })).toBeVisible();
  await expect(reader(page).getByText('版本发布步骤').first()).toBeVisible();

  await page.getByRole('group', { name: '按类型筛选' }).getByRole('button', { name: '项目', exact: true }).click();
  await expect(entryButton(page, 'a-note')).toBeVisible();
  await expect(entryButton(page, 'b-note')).toHaveCount(0);
  await page.getByRole('group', { name: '按类型筛选' }).getByRole('button', { name: '全部', exact: true }).click();

  await page.getByRole('searchbox', { name: '搜索记忆' }).fill('indentation');
  await expect(entryButton(page, 'b-note')).toBeVisible();
  await expect(entryButton(page, 'a-note')).toHaveCount(0);
  await expect(page.getByText('1 / 3 条')).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索记忆' }).fill('不存在');
  await expect(page.getByText('没有匹配「不存在」的记忆')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(entryButton(page, 'global-note')).toBeVisible();

  // `[[name]]` links open the linked entry; unknown targets stay inert.
  await entryButton(page, 'b-note').click();
  await expect(reader(page).getByRole('button', { name: 'gone-note' })).toBeDisabled();
  await reader(page).getByRole('button', { name: 'release-ritual' }).click();
  await expect(reader(page).getByRole('heading', { name: 'Release ritual' })).toBeVisible();
});

test('a failed source is noted inline and does not block the other stores', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await page.evaluate(() => { (window as unknown as { __memory: { failSource: string } }).__memory.failSource = '项目 · 缺失'; });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect(page.getByText('来源「项目 · 缺失」暂时无法读取：项目目录不存在或无法访问。其余来源不受影响。')).toBeVisible();
  await expect(entryButton(page, 'a-note')).toBeVisible();
  await expect(entryButton(page, 'b-note')).toBeVisible();
  await expect(entryButton(page, 'global-note')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an empty aggregate explains the empty state', async ({ page }) => {
  await install(page, { suggestion: null });
  await openMemory(page, 'Delta');
  await expect(page.getByText('本机还没有已落盘的记忆条目。对应 CLI 产生记忆后会出现在这里。')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '记忆列表' })).toHaveCount(0);
});

test('open, edit, and save carry the entry target and only affect that store', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await entryButton(page, 'a-note').click();
  await expect(reader(page)).toContainText('from-a');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editor(page)).toHaveText('from-a');
  await expect(page.getByRole('button', { name: '保存记忆' })).toBeDisabled();
  await editor(page).fill('edited-a');
  await expect(page.getByText('有未保存的更改')).toBeVisible();
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory').length).toBe(1);
  const saved = (await memoryCalls(page)).filter(call => call.command === 'save_memory');
  expect(saved[0].args.request).toMatchObject({ id: 'a-note', text: 'edited-a', baseline: 'from-a', confirmExternal: false, target: { toolId: 'alpha', scope: 'project', projectPath: 'C:/A', storeDirectory: alphaAStore } });
  // Saving returns to reading with the saved text.
  await expect(reader(page)).toContainText('edited-a');
  await expect(editor(page)).toHaveCount(0);
  // The aggregate reload keeps the other stores listed and untouched.
  await entryButton(page, 'b-note').click();
  await expect(reader(page)).toContainText('from-b');
  expect((await memoryCalls(page)).some(call => ['save_configuration_draft', 'begin_configuration_draft', 'update_configuration_draft', 'apply_registered_native_profile', 'apply_common_configuration', 'reapply_account_profile'].includes(call.command))).toBe(false);
  const lists = (await memoryCalls(page)).filter(call => call.command === 'list_all_memories');
  expect(lists.length).toBeGreaterThan(1);
  expect(lists.every(call => call.args.toolId === 'alpha')).toBe(true);
});

test('unsaved edits ask before switching to another entry', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await editEntry(page, 'a-note');
  await editor(page).fill('draft-a');
  await entryButton(page, 'b-note').click();
  await expect(page.getByRole('heading', { name: '放弃未保存的更改？' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(editor(page)).toHaveText('draft-a');
  await entryButton(page, 'b-note').click();
  await page.getByRole('button', { name: '放弃更改' }).click();
  await expect(reader(page)).toContainText('from-b');
  expect((await memoryCalls(page)).some(call => call.command === 'save_memory')).toBe(false);
});

test('delete asks for confirmation and cancel leaves the entry', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await entryButton(page, 'a-note').click();
  await page.getByRole('button', { name: '删除 a-note' }).click();
  await expect(page.getByRole('heading', { name: '删除记忆' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(entryButton(page, 'a-note')).toBeVisible();
  expect((await memoryCalls(page)).some(call => call.command === 'delete_memory')).toBe(false);
  await page.getByRole('button', { name: '删除 a-note' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(entryButton(page, 'a-note')).toHaveCount(0);
  const deleted = (await memoryCalls(page)).filter(call => call.command === 'delete_memory');
  expect(deleted).toHaveLength(1);
  expect(deleted[0].args.request).toMatchObject({ id: 'a-note', baseline: 'from-a', target: { toolId: 'alpha', scope: 'project', projectPath: 'C:/A', storeDirectory: alphaAStore } });
  await expect(entryButton(page, 'b-note')).toBeVisible();
});

test('an external fingerprint or save error waits for confirmation before writing', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await editEntry(page, 'a-note');
  await editor(page).fill('page-text');
  await setMode(page, 'fingerprint');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(page.getByRole('heading', { name: '记忆已被外部修改' })).toBeVisible();
  expect((await memoryCalls(page)).some(call => call.command === 'save_memory')).toBe(false);
  await page.getByRole('button', { name: '取消' }).click();
  await expect(editor(page)).toHaveText('page-text');
  expect((await memoryCalls(page)).some(call => call.command === 'save_memory')).toBe(false);
  await page.getByRole('button', { name: '保存记忆' }).click();
  await page.getByRole('button', { name: '确认写入' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory').length).toBe(1);
  expect((await memoryCalls(page)).find(call => call.command === 'save_memory')?.args.request).toMatchObject({ text: 'page-text', confirmExternal: true, target: { storeDirectory: alphaAStore } });

  await setMode(page, 'external-error');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page).fill('page-text-again');
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
  // Silent summaries: per-entry body reads fail without surfacing an error.
  await expect(entryButton(page, 'a-note')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await entryButton(page, 'a-note').click();
  await expect(page.getByRole('alert')).toContainText('无法读取记忆，请重试');
  await setMode(page, 'normal');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(reader(page)).toContainText('from-a');

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page).fill('retry-save');
  await setMode(page, 'save-fail');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(page.getByRole('alert')).toContainText('无法保存记忆，请重试');
  await setMode(page, 'normal');
  const failedSaves = (await memoryCalls(page)).filter(call => call.command === 'save_memory').length;
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory' && call.args.request?.text === 'retry-save').length).toBe(failedSaves + 1);

  await setMode(page, 'delete-fail');
  await page.getByRole('button', { name: '删除 a-note' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法删除记忆，请重试');
  await expect(entryButton(page, 'a-note')).toBeVisible();
  await setMode(page, 'normal');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(entryButton(page, 'a-note')).toHaveCount(0);
});

test('per-store switches stay readable when off and switch writes carry the store target', async ({ page }) => {
  await install(page, { mode: 'master-off' });
  await openMemory(page);
  await expect(page.getByText('未使用', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('switch', { name: '全局 · 记忆总开关' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('switch', { name: '项目 · 栖点 A · 记忆总开关' })).toHaveAttribute('aria-checked', 'false');
  await entryButton(page, 'a-note').click();
  await expect(reader(page)).toContainText('from-a');

  await page.getByRole('switch', { name: '全局 · 记忆总开关' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'set_memory_enabled').length).toBe(1);
  const master = (await memoryCalls(page)).filter(call => call.command === 'set_memory_enabled');
  expect(master[0].args.request).toMatchObject({ id: null, enabled: true, target: { toolId: 'alpha', scope: 'global', projectPath: null, storeDirectory: alphaGlobalStore } });

  await entryButton(page, 'b-note').click();
  await page.getByRole('switch', { name: '启用 b-note' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'set_memory_enabled' && call.args.request?.id === 'b-note').length).toBe(1);
  const item = (await memoryCalls(page)).find(call => call.command === 'set_memory_enabled' && call.args.request?.id === 'b-note');
  expect(item?.args.request).toMatchObject({ enabled: false, target: { scope: 'project', projectPath: 'C:/B', storeDirectory: alphaBStore } });
});

test('a CLI-wide switch appears once and path labels show their folder name', async ({ page }) => {
  await install(page, { mode: 'master-off' });
  await openMemory(page, 'Epsilon');
  await expect(page.getByRole('switch')).toHaveCount(1);
  await expect(page.getByText('自动记忆')).toBeVisible();
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible();
  const list = page.getByRole('navigation', { name: '记忆列表' });
  await expect(list.getByRole('button', { name: /^one/ })).toContainText('C:\\Work\\one');
  // A store without entries is not listed, but stays a write destination.
  await expect(list.getByRole('button', { name: /^three/ })).toHaveCount(0);
  await expect(page.getByText('2 条 · 2 个来源')).toBeVisible();
  await page.getByRole('switch', { name: '记忆总开关' }).click();
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'set_memory_enabled').length).toBe(1);
  expect((await memoryCalls(page)).find(call => call.command === 'set_memory_enabled')?.args.request).toMatchObject({ id: null, enabled: true, target: { toolId: 'epsilon', storeDirectory: epsilonStores[0] } });
});

test('create picks a destination and states the write location', async ({ page }) => {
  await install(page);
  await openMemory(page);
  await page.getByRole('button', { name: '新建记忆' }).click();
  const form = page.getByRole('form', { name: '新建记忆' });
  await expect(form.getByText('写入位置：全局')).toBeVisible();
  await expect(form.getByRole('button', { name: '保存记忆' })).toBeDisabled();
  await form.getByRole('textbox', { name: '文件名' }).fill('bad name');
  await expect(form.getByText('文件名只能使用字母、数字、连字符和下划线')).toBeVisible();
  await form.getByRole('textbox', { name: '文件名' }).fill('created-note');
  await editor(page).fill('created-body');
  await form.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).some(call => call.command === 'save_memory' && call.args.request?.id === 'created-note')).toBe(true);
  const saved = (await memoryCalls(page)).find(call => call.command === 'save_memory' && call.args.request?.id === 'created-note');
  expect(saved?.args.request).toMatchObject({ baseline: '', confirmExternal: false, target: { toolId: 'alpha', scope: 'global', projectPath: null, storeDirectory: alphaGlobalStore } });

  // Another existing store can be chosen as the destination.
  await page.getByRole('button', { name: '新建记忆' }).click();
  await page.getByRole('button', { name: '写入到' }).click();
  await page.getByRole('option', { name: /项目 · 栖点 B/ }).click();
  await page.getByRole('textbox', { name: '文件名' }).fill('b-created');
  await page.getByRole('form', { name: '新建记忆' }).getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).some(call => call.command === 'save_memory' && call.args.request?.id === 'b-created')).toBe(true);
  expect((await memoryCalls(page)).find(call => call.command === 'save_memory' && call.args.request?.id === 'b-created')?.args.request).toMatchObject({ target: { scope: 'project', projectPath: 'C:/B', storeDirectory: alphaBStore } });

  // A project-only CLI without stores falls back to the stored configuration project.
  await page.getByRole('tab', { name: 'Delta', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '新建记忆' }).first().click();
  await expect(page.getByText('写入位置：C:/A')).toBeVisible();
  await page.getByRole('textbox', { name: '文件名' }).fill('delta-note');
  await editor(page).fill('delta-body');
  await page.getByRole('form', { name: '新建记忆' }).getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).some(call => call.command === 'save_memory' && call.args.request?.id === 'delta-note')).toBe(true);
  const deltaSaved = (await memoryCalls(page)).find(call => call.command === 'save_memory' && call.args.request?.id === 'delta-note');
  expect(deltaSaved?.args.request).toMatchObject({ target: { toolId: 'delta', scope: 'project', projectPath: 'C:/A' } });
  expect(deltaSaved?.args.request?.target).not.toHaveProperty('storeDirectory');
});

test('a project-only CLI without a configured project disables create and explains why', async ({ page }) => {
  await install(page, { suggestion: null });
  await openMemory(page, 'Delta');
  await expect(page.getByRole('button', { name: '新建记忆' })).toBeDisabled();
  await expect(page.getByText('暂无可写入的位置：Delta 在本机还没有记忆来源，也没有可用的项目。')).toBeVisible();
  expect((await memoryCalls(page)).some(call => call.command === 'save_memory')).toBe(false);
});
