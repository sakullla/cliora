import { expect, test, type Page } from '@playwright/test';

type MemoryTargetArgs = { toolId?: string; scope?: string; projectPath?: string | null; contextId?: string | null; storeDirectory?: string };
type MemoryCall = { command: string; args: { toolId?: string; target?: MemoryTargetArgs; request?: { target?: MemoryTargetArgs; id?: string | null; text?: string; baseline?: string; confirmExternal?: boolean; enabled?: boolean }; id?: string; requests?: { target: MemoryTargetArgs; id: string }[] } };

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

async function install(page: Page, options: { catalog?: 'none' | 'session' | 'memory'; suggestion?: string | null; mode?: string; copies?: number } = {}) {
  const catalog = options.catalog ?? 'memory';
  const suggestion = options.suggestion === undefined ? 'C:/A' : options.suggestion;
  const copies = options.copies ?? 0;
  const storePaths = { alphaGlobal: alphaGlobalStore, alphaA: alphaAStore, alphaB: alphaBStore, beta: betaStore, epsilon: epsilonStores };
  await page.addInitScript(({ catalog: kind, suggestion: suggested, mode, stores, copies }) => {
    const state = {
      mode,
      reads: 0,
      deleted: [] as string[],
      texts: {
        'a-note': 'from-a', 'b-note': 'from-b', 'beta-note': 'from-beta', 'global-note': 'from-global', 'one-note': 'from-one', 'two-note': 'from-two',
        ...Object.fromEntries(Array.from({ length: copies }, (_, index) => [`copy-${index}`, `---\nname: Requirement docs new not revise ${index}\ndescription: 延续已关闭 workflow 的需求时新建独立需求文档，不复用旧编号，避免和已发布的需求混在一起。\ntype: ${['user', 'feedback', 'project', 'reference'][index % 4]}\nmodified: 2026-10-${String((index % 20) + 1).padStart(2, '0')}T08:00:00Z\n---\n\n本机 Windows 宿主机跑不了 player 真实子进程测试用例。\n`])),
      } as Record<string, string>,
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
      id, path: `${store}/${id}.md`, enabled: true, fingerprint: state.fingerprints[id] ?? `fp-${id}`, sourceLabel, target, inUse: !off(), detail: off() ? '记忆当前未使用' : '',
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
        ...Array.from({ length: copies }, (_, index) => entry(`copy-${index}`, stores.alphaA, '项目 · 栖点 A', aTarget)),
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
          if (command === 'read_memories') return (args.requests ?? []).map(({ id }) => ({ document: state.mode === 'read-fail' ? null : { id, path: `${id}.md`, text: state.texts[id] ?? 'hello', fingerprint: state.fingerprints[id] ?? `fp-${id}`, enabled: true, inUse: !off(), detail: '' }, error: state.mode === 'read-fail' ? 'read failed' : null }));
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
  }, { catalog, suggestion, mode: options.mode ?? 'normal', stores: storePaths, copies });
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

const entryButton = (page: Page, id: string) => page.getByRole('navigation', { name: '记忆列表' }).locator(`button[data-entry-id="${id}"]`);
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

test('memory rows keep title, summary, and meta apart when the list scrolls', async ({ page }) => {
  await install(page, { copies: 16 });
  await openMemory(page);
  await expect(entryButton(page, 'copy-0')).toContainText('Requirement docs new not revise 0');
  const report = await page.getByRole('navigation', { name: '记忆列表' }).evaluate(list => {
    const buttons = [...list.querySelectorAll('button')];
    const boxes = buttons.map(node => {
      const rect = node.getBoundingClientRect();
      const children = [...node.children].map(child => child.getBoundingClientRect());
      return {
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        escaped: children.some(box => box.bottom > rect.bottom + 1 || box.top < rect.top - 1),
      };
    });
    return {
      count: boxes.length,
      short: boxes.filter(box => box.height < 64).length,
      escaped: boxes.filter(box => box.escaped).length,
      overlaps: boxes.slice(1).filter((box, index) => box.top < boxes[index].bottom - 1).length,
      scrolls: list.scrollHeight > list.clientHeight,
    };
  });
  expect(report).toEqual({ count: 19, short: 0, escaped: 0, overlaps: 0, scrolls: true });
});

test('the memory list leads with title, summary, and user or project scope', async ({ page }) => {
  await install(page);
  await openMemory(page);
  const region = page.getByRole('region', { name: '记忆' });
  const list = page.getByRole('navigation', { name: '记忆列表' });
  const global = entryButton(page, 'global-note');
  const projectA = entryButton(page, 'a-note');
  const projectB = entryButton(page, 'b-note');
  await expect(list.getByRole('button')).toHaveCount(3);
  await expect(global).toContainText('Global note');
  await expect(global).toContainText('from-global');
  await expect(global).toContainText('用户');
  await expect(global).not.toContainText('global-note.md');
  await expect(global).not.toContainText(alphaGlobalStore);
  await expect(projectA).toContainText('A note');
  await expect(projectA).toContainText('from-a');
  await expect(projectA).toContainText('项目');
  await expect(projectA).not.toContainText('a-note.md');
  await expect(projectA).not.toContainText(alphaAStore);
  await expect(projectB).toContainText('B note');
  await expect(projectB).toContainText('from-b');
  await expect(projectB).toContainText('项目');
  await page.getByRole('button', { name: '筛选来源' }).click();
  await page.getByRole('option', { name: /项目 · 栖点 B/ }).click();
  await expect(projectB).toBeVisible();
  await expect(global).toHaveCount(0);
  await expect(projectA).toHaveCount(0);
  await page.getByRole('button', { name: '筛选来源' }).click();
  await page.getByRole('option', { name: '全部来源' }).click();
  await expect(global).toBeVisible();
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
  await expect(page.getByTitle(readOnlyLimitation)).toBeVisible();
  await expect(region.getByRole('heading', { name: '记忆', exact: true })).toHaveCount(0);
  await expect(region.getByText(/跨会话保留/)).toHaveCount(0);
  await expect(entryButton(page, 'beta-note')).toContainText('Beta note');
  await expect(entryButton(page, 'beta-note')).toContainText('from-beta');
  await expect(entryButton(page, 'beta-note')).toContainText('用户');
  await expect(entryButton(page, 'beta-note')).not.toContainText('beta-note.md');
  await expect(page.getByRole('button', { name: '新建记忆' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await entryButton(page, 'beta-note').click();
  await expect(reader(page).getByRole('region', { name: '记忆正文' })).toContainText('from-beta');
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
  await expect(entryButton(page, 'b-note')).toContainText('项目');
  await expect(entryButton(page, 'a-note')).not.toContainText('a-note.md');
  await expect(entryButton(page, 'b-note')).not.toContainText('b-note.md');

  await entryButton(page, 'a-note').click();
  await expect(reader(page).getByRole('heading', { name: 'Release ritual' })).toBeVisible();
  await expect(reader(page).getByRole('region', { name: '记忆正文' })).toContainText('同步版本文件');
  await expect(reader(page).getByRole('heading', { name: '发布流程' })).toBeVisible();
  await expect(reader(page).getByText('a-note.md')).toHaveCount(0);
  await reader(page).getByRole('button', { name: /属性/ }).click();
  await expect(reader(page).getByText('a-note.md')).toBeVisible();
  await expect(reader(page).locator('dt').filter({ hasText: 'description' })).toBeVisible();
  await expect(reader(page).locator('dd').filter({ hasText: '版本发布步骤' })).toBeVisible();

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
  await expect(reader(page).getByRole('link', { name: 'gone-note' })).toHaveAttribute('aria-disabled', 'true');
  await reader(page).getByRole('link', { name: 'release-ritual' }).click();
  await expect(reader(page).getByRole('heading', { name: 'Release ritual' })).toBeVisible();
});

test('memory links prefer their own store and refresh renamed or removed associations', async ({ page }) => {
  await install(page);
  await openWorkspace(page);
  await page.evaluate(() => {
    const state = (window as unknown as { __memory: { texts: Record<string, string> } }).__memory;
    state.texts['global-note'] = '---\nname: Shared name\n---\nGLOBAL_TARGET';
    state.texts['a-note'] = '---\nname: Shared name\n---\nLOCAL_TARGET\n\n[[SHARED_NAME.md|same store]]';
    state.texts['b-note'] = '[[shared name|fallback]] and [[global-note|by id]]';
  });
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await entryButton(page, 'a-note').click();
  await reader(page).getByRole('link', { name: 'same store' }).click();
  await expect(reader(page)).toContainText('LOCAL_TARGET');
  await entryButton(page, 'b-note').click();
  await reader(page).getByRole('link', { name: 'fallback' }).click();
  await expect(reader(page)).toContainText('GLOBAL_TARGET');

  await page.evaluate(() => {
    const state = (window as unknown as { __memory: { texts: Record<string, string>; fingerprints: Record<string, string>; deleted: string[] } }).__memory;
    state.texts['global-note'] = '---\nname: Renamed\n---\nUPDATED_TARGET';
    state.fingerprints['global-note'] = 'changed';
    state.deleted.push('a-note');
  });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect(reader(page)).toContainText('UPDATED_TARGET');
  await entryButton(page, 'b-note').click();
  await expect(reader(page).getByRole('link', { name: 'fallback' })).toHaveAttribute('aria-disabled', 'true');
  await reader(page).getByRole('link', { name: 'by id' }).click();
  await expect(reader(page)).toContainText('UPDATED_TARGET');
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
  await expect(reader(page).getByRole('region', { name: '记忆正文' })).toContainText('from-a');
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
  await expect(reader(page).getByRole('region', { name: '记忆正文' })).toContainText('edited-a');
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
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(reader(page)).toContainText('from-a');

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page).fill('retry-save');
  await setMode(page, 'save-fail');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(page.getByRole('alert')).toContainText('无法保存记忆，请重试');
  await setMode(page, 'normal');
  const failedSaves = (await memoryCalls(page)).filter(call => call.command === 'save_memory').length;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await memoryCalls(page)).filter(call => call.command === 'save_memory' && call.args.request?.text === 'retry-save').length).toBe(failedSaves + 1);

  await setMode(page, 'delete-fail');
  await page.getByRole('button', { name: '删除 a-note' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法删除记忆，请重试');
  await expect(entryButton(page, 'a-note')).toBeVisible();
  await setMode(page, 'normal');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(entryButton(page, 'a-note')).toHaveCount(0);
});

test('per-store switches stay readable when off and switch writes carry the store target', async ({ page }) => {
  await install(page, { mode: 'master-off' });
  await openMemory(page);
  await expect(page.getByText('未使用', { exact: true }).first()).toBeVisible();
  const toolbar = page.getByRole('group', { name: '记忆开关' });
  await expect(toolbar.getByRole('switch', { name: '全局 · 记忆总开关' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('navigation', { name: '记忆列表' }).getByRole('switch')).toHaveCount(0);
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

test('a CLI-wide switch appears once and list rows keep folder names secondary to the title', async ({ page }) => {
  await install(page, { mode: 'master-off' });
  await openMemory(page, 'Epsilon');
  await expect(page.getByRole('switch')).toHaveCount(1);
  await expect(page.getByRole('group', { name: '记忆开关' }).getByText('自动记忆')).toBeVisible();
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: '记忆开关' }).getByText('记忆当前未使用')).toBeVisible();
  const list = page.getByRole('navigation', { name: '记忆列表' });
  await expect(list.getByRole('button')).toHaveCount(2);
  const one = entryButton(page, 'one-note');
  await expect(one).toContainText('One note');
  await expect(one).toContainText('from-one');
  await expect(one).toContainText('项目');
  await expect(one).toContainText('one');
  await expect(one).not.toContainText('C:\\Work\\one');
  await one.click();
  await expect(reader(page).getByRole('heading', { name: 'One note' })).toBeVisible();
  await expect(reader(page).getByRole('region', { name: '记忆正文' })).toContainText('from-one');
  await expect(reader(page).getByText('C:\\Work\\one')).toHaveCount(0);
  await reader(page).getByRole('button', { name: /属性/ }).click();
  await expect(reader(page).getByText('C:\\Work\\one')).toBeVisible();
  await expect(reader(page).getByText('one-note.md')).toBeVisible();
  await page.getByRole('button', { name: '筛选来源' }).click();
  await expect(page.getByRole('option', { name: /^one/ })).toContainText('C:\\Work\\one');
  await page.getByRole('button', { name: '筛选来源' }).click();
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


type BatchProbe = {
  calls: number; bodies: number; focusedReads: number; active: number; peak: number; lists: number;
  revision: number; changed: number; hold: boolean; releases: (() => void)[];
  failId: string | null; saved: Record<string, string>;
};
async function installBatchProbe(page: Page, count = 1000, previews = 0) {
  await install(page);
  await page.addInitScript(({ count, previews }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    const probe: BatchProbe = { calls: 0, bodies: 0, focusedReads: 0, active: 0, peak: 0, lists: 0, revision: 0, changed: 0, hold: false, releases: [], failId: null, saved: {} };
    (window as unknown as { __batch: BatchProbe }).__batch = probe;
    const target = (store: number) => ({ toolId: 'alpha', scope: 'global', projectPath: null, storeDirectory: `C:/perf/${store}` });
    const number = (id: string) => Number(id.replace('entry-', ''));
    const fingerprint = (id: string) => probe.saved[id] ?? (number(id) < probe.changed ? `changed-${probe.revision}` : `fp-${id}`);
    const document = (id: string, store: unknown) => ({ id, path: `${store}/${id}.md`, text: probe.saved[id] ?? `---\nname: Memo ${number(id)}\ntype: ${number(id) % 2 ? 'project' : 'user'}\n---\nBody ${id} ${fingerprint(id)}`, fingerprint: fingerprint(id), enabled: true, inUse: true, detail: '' });
    internals.invoke = async (command, args = {}) => {
      if (command === 'list_all_memories' && args.toolId === 'alpha') {
        probe.lists++;
        const entries = Array.from({ length: count }, (_, index) => ({ id: `entry-${index}`, path: `C:/perf/${Math.floor(index / 100)}/entry-${index}.md`, enabled: true, fingerprint: fingerprint(`entry-${index}`), sourceLabel: `Store ${Math.floor(index / 100)}`, target: target(Math.floor(index / 100)), inUse: true, detail: '', previewText: index < previews ? document(`entry-${index}`, `C:/perf/${Math.floor(index / 100)}`).text : undefined }));
        const stores = Array.from({ length: Math.ceil(count / 100) }, (_, index) => ({ label: `Store ${index}`, directory: `C:/perf/${index}`, target: target(index), inUse: true, detail: '', entryCount: entries.filter(entry => entry.target.storeDirectory === target(index).storeDirectory).length }));
        return { toolId: 'alpha', entries, stores, failedSources: [], switchShared: false };
      }
      if (command === 'read_memories') {
        probe.calls++; probe.active++; probe.peak = Math.max(probe.peak, probe.active);
        const requests = args.requests as { id: string; target: { storeDirectory: string } }[];
        probe.bodies += requests.length;
        const results = requests.map(request => request.id === probe.failId ? { document: null, error: 'fixture body unavailable' } : { document: document(request.id, request.target.storeDirectory), error: null });
        if (probe.hold) await new Promise<void>(resolve => probe.releases.push(resolve));
        else await new Promise(resolve => setTimeout(resolve, probe.calls % 2 ? 25 : 1));
        probe.active--;
        return results;
      }
      if (command === 'read_memory' && (args.target as { toolId?: string })?.toolId === 'alpha') { probe.focusedReads++; return document(args.id as string, (args.target as { storeDirectory: string }).storeDirectory); }
      if (command === 'save_memory') {
        const request = args.request as { id: string; text: string; target: { storeDirectory: string } };
        probe.saved[request.id] = request.text;
        return document(request.id, request.target.storeDirectory);
      }
      return original(command, args);
    };
  }, { count, previews });
}
const batchState = (page: Page) => page.evaluate(() => {
  const value = (window as unknown as { __batch: BatchProbe }).__batch;
  return { calls: value.calls, bodies: value.bodies, focusedReads: value.focusedReads, active: value.active, peak: value.peak, lists: value.lists };
});

test('1000 memory previews avoid background reads and refresh the open body', async ({ page }) => {
  await installBatchProbe(page, 1000, 1000);
  const start = Date.now();
  await openMemory(page);
  await expect(entryButton(page, 'entry-999')).toContainText('Memo 999');
  expect(await batchState(page)).toMatchObject({ calls: 0, bodies: 0, lists: 1 });
  console.log('MEMORY_UI_PERF previews', { ...await batchState(page), elapsedMs: Date.now() - start });
  await entryButton(page, 'entry-0').click();
  await expect(reader(page)).toContainText('fp-entry-0');
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.changed = 3; p.revision = 2; });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect(reader(page)).toContainText('changed-2');
  await page.getByRole('searchbox', { name: '搜索记忆' }).fill('changed-2');
  await expect(page.getByText('3 / 1000 条')).toBeVisible();
  expect(await batchState(page)).toMatchObject({ calls: 0, bodies: 0, focusedReads: 1, lists: 2 });
});

test('entries beyond the preview budget still load through bounded batches', async ({ page }) => {
  await installBatchProbe(page, 100, 60);
  await openMemory(page);
  await expect(entryButton(page, 'entry-99')).toContainText('Memo 99');
  expect(await batchState(page)).toMatchObject({ calls: 2, bodies: 40, peak: 2, lists: 1 });
});

test('1000 memories use bounded batches, reuse fingerprints, and refresh an open body', async ({ page }) => {
  await installBatchProbe(page);
  const start = Date.now();
  await openMemory(page);
  await expect.poll(async () => (await batchState(page)).bodies, { timeout: 20_000 }).toBe(1000);
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  expect(await batchState(page)).toMatchObject({ calls: 32, bodies: 1000, peak: 2, lists: 1 });
  console.log('MEMORY_UI_PERF cold', { ...await batchState(page), elapsedMs: Date.now() - start });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect.poll(async () => (await batchState(page)).lists).toBe(2);
  await expect(page.getByRole('button', { name: '刷新记忆' })).toBeEnabled();
  expect(await batchState(page)).toMatchObject({ calls: 32, bodies: 1000 });
  await entryButton(page, 'entry-0').click();
  await expect(reader(page)).toContainText('fp-entry-0');
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.changed = 3; p.revision = 1; });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect(reader(page)).toContainText('changed-1');
  expect(await batchState(page)).toMatchObject({ calls: 33, bodies: 1002, focusedReads: 2, peak: 2, lists: 3 });
  await page.getByRole('searchbox', { name: '搜索记忆' }).fill('changed-1');
  await expect(page.getByText('3 / 1000 条')).toBeVisible();
  console.log('MEMORY_UI_PERF warm_and_changed3', await batchState(page));
});

test('late batches cannot overwrite refreshed or saved bodies; failed entries can retry', async ({ page }) => {
  await installBatchProbe(page, 100);
  await page.addInitScript(() => { (window as unknown as { __batch: BatchProbe }).__batch.hold = true; });
  await openMemory(page);
  await expect.poll(async () => (await batchState(page)).active).toBe(2);
  // A focused open bypasses the batch queue.
  await entryButton(page, 'entry-0').click();
  await expect(reader(page)).toContainText('fp-entry-0');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page).fill('saved fresh body');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(reader(page)).toContainText('saved fresh body');
  await page.evaluate(() => {
    const p = (window as unknown as { __batch: BatchProbe }).__batch;
    p.hold = false; p.failId = 'entry-1';
    p.releases.splice(0).forEach(release => release());
  });
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  await expect(reader(page)).toContainText('saved fresh body');
  expect((await batchState(page)).peak).toBe(2);
  await expect(page.getByRole('status').filter({ hasText: '搜索结果可能不完整' })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __batch: BatchProbe }).__batch.failId = null; });
  await page.getByRole('button', { name: '重试正文读取', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '搜索结果可能不完整' })).toHaveCount(0);
  await expect(entryButton(page, 'entry-1')).toContainText('Memo 1');
});

test('refresh preserves drafts and switching tools ignores old queued batches', async ({ page }) => {
  await installBatchProbe(page, 100);
  await openMemory(page);
  await expect.poll(async () => (await batchState(page)).bodies).toBe(100);
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  await entryButton(page, 'entry-0').click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page).fill('unsaved draft');
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.changed = 100; p.revision = 2; p.hold = true; });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect.poll(async () => (await batchState(page)).active).toBe(2);
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.hold = false; p.releases.splice(0).forEach(release => release()); });
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  await expect(editor(page)).toContainText('unsaved draft');
  await page.getByRole('button', { name: '撤销修改', exact: true }).click();
  await page.getByRole('button', { name: '放弃更改', exact: true }).click();
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.revision = 3; p.hold = true; });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect.poll(async () => (await batchState(page)).active).toBe(2);
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.hold = false; p.releases.splice(0).forEach(release => release()); });
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  await expect(entryButton(page, 'beta-note')).toBeVisible();
  await expect(entryButton(page, 'entry-0')).toHaveCount(0);
});

test('switching tools reuses a recent memory index instead of enumerating again', async ({ page }) => {
  await installBatchProbe(page, 100, 100);
  await openMemory(page);
  await expect(entryButton(page, 'entry-99')).toBeVisible();
  expect(await batchState(page)).toMatchObject({ lists: 1, bodies: 0 });
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(entryButton(page, 'beta-note')).toBeVisible();
  await page.getByRole('tab', { name: 'Alpha', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(entryButton(page, 'entry-99')).toBeVisible();
  expect(await batchState(page)).toMatchObject({ lists: 1 });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect.poll(async () => (await batchState(page)).lists).toBe(2);
});

test('scope switches remain reachable with no stores and preserve native-default unknown', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    const groups = [{ id: 'user', scope: 'global', enabled: null as boolean | null, detail: '' }, { id: 'project', scope: 'project', enabled: null as boolean | null, detail: '' }];
    api.invoke = async (command, args = {}) => {
      if (command === 'list_all_memories') return { toolId: args.toolId, entries: [], stores: [], failedSources: [], switchShared: false, switchGroups: groups.map(group => ({ ...group })) };
      if (command === 'set_memory_switch_group') { groups.find(group => group.id === args.groupId)!.enabled = args.enabled as boolean; return null; }
      return original(command, args);
    };
  });
  await openMemory(page);
  await expect(page.getByRole('group', { name: '记忆开关' }).getByRole('combobox', { name: '所有项目记忆' })).toBeVisible();
  await expect(page.getByText('跟随原生默认，当前生效状态未知')).toHaveCount(2);
  await expect(page.getByText('未使用', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '所有项目记忆' }).selectOption('off');
  await expect(page.getByRole('combobox', { name: '所有项目记忆' })).toHaveValue('off');
  await expect(page.getByRole('combobox', { name: '用户记忆' })).toHaveValue('default');
  await page.getByRole('combobox', { name: '用户记忆' }).selectOption('on');
  await expect(page.getByRole('combobox', { name: '用户记忆' })).toHaveValue('on');
  await expect(page.getByRole('button', { name: '新建记忆' }).first()).toBeEnabled();
});


test('refresh replaces a pending generation without starting extra concurrent batches', async ({ page }) => {
  await installBatchProbe(page, 100);
  await page.addInitScript(() => { (window as unknown as { __batch: BatchProbe }).__batch.hold = true; });
  await openMemory(page);
  await expect.poll(async () => (await batchState(page)).active).toBe(2);
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.changed = 100; p.revision = 9; });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect.poll(async () => (await batchState(page)).lists).toBe(2);
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.hold = false; p.releases.splice(0).forEach(release => release()); });
  await expect.poll(async () => (await batchState(page)).bodies).toBe(164);
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  expect((await batchState(page)).peak).toBe(2);
  await page.getByRole('searchbox', { name: '搜索记忆' }).fill('changed-9');
  await expect(page.getByText('100 / 100 条')).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索记忆' }).fill('fp-entry');
  await expect(page.getByText('0 / 100 条')).toBeVisible();
});


test('an externally deleted entry keeps its unsaved editor reachable after refresh', async ({ page }) => {
  await installBatchProbe(page, 3);
  await openMemory(page);
  await entryButton(page, 'entry-0').click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page).fill('recoverable draft after deletion');
  await page.evaluate(() => {
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = async (command, args = {}) => {
      const value = await original(command, args);
      if (command === 'list_all_memories') {
        const result = value as { entries: { id: string }[] };
        return { ...result, entries: result.entries.filter(entry => entry.id !== 'entry-0') };
      }
      return value;
    };
  });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect(page.getByRole('button', { name: '刷新记忆' })).toBeEnabled();
  await expect(editor(page)).toContainText('recoverable draft after deletion');
  await expect(page.getByRole('button', { name: '保存记忆' })).toBeEnabled();
});


test('refreshing the open body bypasses held background batches', async ({ page }) => {
  await installBatchProbe(page, 100);
  await openMemory(page);
  await expect.poll(async () => (await batchState(page)).bodies).toBe(100);
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  await entryButton(page, 'entry-0').click();
  await expect(reader(page)).toContainText('fp-entry-0');
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.changed = 100; p.revision = 7; p.hold = true; });
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect(reader(page)).toContainText('changed-7');
  await expect.poll(async () => (await batchState(page)).active).toBe(2);
  expect((await batchState(page)).focusedReads).toBe(2);
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.hold = false; p.releases.splice(0).forEach(release => release()); });
  await expect.poll(async () => (await batchState(page)).active).toBe(0);
  await expect(reader(page)).toContainText('changed-7');
});


for (const conflict of ['preflight', 'write'] as const) test(`cancelling ${conflict} conflict preserves pending background bodies`, async ({ page }) => {
  await installBatchProbe(page, 100);
  await page.addInitScript(() => { (window as unknown as { __batch: BatchProbe }).__batch.hold = true; });
  await openMemory(page);
  await expect.poll(async () => (await batchState(page)).active).toBe(2);
  await entryButton(page, 'entry-0').click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page).fill('draft must survive cancellation');
  if (conflict === 'preflight') {
    await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.changed = 1; p.revision = 1; });
  } else {
    await page.evaluate(() => {
      const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const original = api.invoke;
      api.invoke = async (command, args) => { if (command === 'save_memory') throw new Error('记忆已被外部修改'); return original(command, args); };
    });
  }
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(page.getByRole('heading', { name: '记忆已被外部修改' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page)).toContainText('draft must survive cancellation');
  await page.evaluate(() => { const p = (window as unknown as { __batch: BatchProbe }).__batch; p.hold = false; p.releases.splice(0).forEach(release => release()); });
  await expect(entryButton(page, 'entry-99')).toContainText('Memo 99');
  await page.getByRole('searchbox', { name: '搜索记忆' }).fill('Body entry-99');
  await expect(page.getByText('1 / 100 条')).toBeVisible();
  expect(await page.evaluate(() => Object.keys((window as unknown as { __batch: BatchProbe }).__batch.saved))).toHaveLength(0);
});

test('a list fingerprint failure remains an individual readable retry row', async ({ page }) => {
  await installBatchProbe(page, 3);
  await page.addInitScript(() => {
    const state = (window as unknown as { __batch: BatchProbe }).__batch;
    state.failId = 'entry-1';
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = async (command, args) => {
      const value = await original(command, args);
      if (command === 'list_all_memories') {
        const result = value as { entries: { id: string; fingerprint: string; readError?: string }[] };
        result.entries = result.entries.map(entry => entry.id === state.failId ? { ...entry, fingerprint: '', readError: 'sharing violation' } : entry);
      }
      return value;
    };
  });
  await openMemory(page);
  await expect(entryButton(page, 'entry-0')).toContainText('Memo 0');
  await expect(entryButton(page, 'entry-1')).toContainText('正文暂不可读，点击重试');
  await expect(entryButton(page, 'entry-2')).toContainText('Memo 2');
  await page.evaluate(() => { (window as unknown as { __batch: BatchProbe }).__batch.failId = null; });
  await entryButton(page, 'entry-1').click();
  await expect(reader(page)).toContainText('Body entry-1');
  await expect(entryButton(page, 'entry-1')).not.toContainText('正文暂不可读');
  await page.getByRole('button', { name: '刷新记忆' }).click();
  await expect(page.getByRole('status').filter({ hasText: '搜索结果可能不完整' })).toHaveCount(0);
});

test('native filename capability permits Unicode and internal dots without changing simple families', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = async (command, args) => {
      const value = await original(command, args);
      return command === 'list_all_memories' ? { ...(value as Record<string, unknown>), nativeFileNames: true } : value;
    };
  });
  await openMemory(page);
  await page.getByRole('button', { name: '新建记忆' }).click();
  await page.getByRole('textbox', { name: '文件名' }).fill('用户.preferences');
  await editor(page).fill('native name body');
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect.poll(async () => (await memoryCalls(page)).some(call => call.command === 'save_memory' && call.args.request?.id === '用户.preferences')).toBe(true);
  await page.getByRole('button', { name: '新建记忆' }).click();
  for (const unsafe of ['../outside', 'C:stream', 'CON.notes', 'COM¹', '.hidden', 'trailing.']) {
    await page.getByRole('textbox', { name: '文件名' }).fill(unsafe);
    await expect(page.getByRole('button', { name: '保存记忆' })).toBeDisabled();
  }
});

test('a long memory keeps the body in view while the list and toolbar stay put', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await install(page);
  await page.addInitScript(() => {
    const clips: string[] = [];
    (window as unknown as { __clips: string[] }).__clips = clips;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { clips.push(value); } } });
  });
  await openWorkspace(page);
  await page.evaluate(() => {
    const texts = (window as unknown as { __memory: { texts: Record<string, string> } }).__memory.texts;
    const body = Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 段。记忆正文需要长过阅读区，滚动后后续段落进入视野，列表和工具栏留在原位。`).join('\n\n');
    texts['a-note'] = `---\nname: Long note\ndescription: "摘要只留在列表"\ntype: project\n---\n\n${body}\n\n段落末尾标记\n`;
  });
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  const list = page.getByRole('navigation', { name: '记忆列表' });
  const article = reader(page);
  const bodyRegion = article.getByRole('region', { name: '记忆正文' });
  await expect(entryButton(page, 'a-note')).toContainText('摘要只留在列表');
  await entryButton(page, 'a-note').click();
  await expect(article.getByRole('heading', { name: 'Long note' })).toBeVisible();
  await expect(bodyRegion.locator('p').filter({ hasText: '第 1 段' })).toBeVisible();
  await expect(bodyRegion).not.toContainText('摘要只留在列表');
  await expect(article.getByText('a-note.md')).toHaveCount(0);
  const placed = await page.evaluate(() => {
    const listNode = document.querySelector('[aria-label="记忆列表"]') as HTMLElement;
    const articleNode = document.querySelector('article') as HTMLElement;
    const header = articleNode.querySelector('h3')!.parentElement!.getBoundingClientRect();
    const region = articleNode.querySelector('[aria-label="记忆正文"]')!.getBoundingClientRect();
    const listBox = listNode.getBoundingClientRect();
    const articleBox = articleNode.getBoundingClientRect();
    const toolbar = document.querySelector('[aria-label="记忆工具栏"]') as HTMLElement;
    const content = document.querySelector('.content') as HTMLElement;
    return {
      sideBySide: listBox.right <= articleBox.left + 2 && articleBox.top < listBox.bottom && listBox.top < articleBox.bottom,
      bodyTaller: region.height > header.height,
      scrollTop: content.scrollTop,
      toolbarTop: toolbar.getBoundingClientRect().top,
      listTop: listBox.top,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  expect(placed.sideBySide).toBe(true);
  expect(placed.bodyTaller).toBe(true);
  expect(placed.scrollTop).toBe(0);
  expect(placed.overflow).toBe(false);
  const shownInBody = (label: string) => bodyRegion.getByText(label).evaluate(node => {
    const region = node.closest('[role="region"]')!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return Math.min(box.bottom, region.bottom) - Math.max(box.top, region.top);
  });
  expect(await shownInBody('段落末尾标记')).toBeLessThanOrEqual(0);
  await bodyRegion.evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(await shownInBody('段落末尾标记')).toBeGreaterThan(12);
  const after = await page.evaluate(() => {
    const listNode = document.querySelector('[aria-label="记忆列表"]') as HTMLElement;
    const toolbar = document.querySelector('[aria-label="记忆工具栏"]') as HTMLElement;
    const content = document.querySelector('.content') as HTMLElement;
    return {
      scrollTop: content.scrollTop,
      fits: content.scrollHeight <= content.clientHeight + 1,
      toolbarTop: toolbar.getBoundingClientRect().top,
      listTop: listNode.getBoundingClientRect().top,
    };
  });
  expect(after.scrollTop).toBe(0);
  expect(after.fits).toBe(true);
  expect(Math.abs(after.toolbarTop - placed.toolbarTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.listTop - placed.listTop)).toBeLessThanOrEqual(1);

  await article.getByRole('button', { name: /属性/ }).click();
  await expect(article.getByText('a-note.md')).toBeVisible();
  await expect(article.getByRole('button', { name: '复制文件路径' })).toBeVisible();
  await article.getByRole('button', { name: '复制文件路径' }).click();
  await expect(page.getByText('已复制文件路径')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __clips: string[] }).__clips)).toContain(`${alphaAStore}/a-note.md`);
  const opened = await article.evaluate(node => {
    const header = node.querySelector('h3')!.parentElement!.getBoundingClientRect().height;
    const panel = node.querySelector('[data-memory-path]')!.getBoundingClientRect().height;
    const regionNode = node.querySelector('[aria-label="记忆正文"]') as HTMLElement;
    regionNode.scrollTop = 0;
    const region = regionNode.getBoundingClientRect();
    const prose = [...regionNode.querySelectorAll('p')].reduce((sum, item) => {
      const box = item.getBoundingClientRect();
      return sum + Math.max(0, Math.min(box.bottom, region.bottom) - Math.max(box.top, region.top));
    }, 0);
    return { header, panel, body: region.height, prose };
  });
  expect(opened.body).toBeGreaterThan(opened.header);
  expect(opened.body).toBeGreaterThan(opened.panel);
  expect(opened.prose).toBeGreaterThan(48);
  await article.getByRole('button', { name: /属性/ }).click();

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(article.locator('.code-editor')).toBeVisible();
  const editing = await article.evaluate(node => {
    const header = node.querySelector('h3')!.parentElement!.getBoundingClientRect().height;
    const editor = node.querySelector('.code-editor')!.getBoundingClientRect();
    const save = [...node.querySelectorAll('button')].find(button => button.textContent?.includes('保存记忆'))!.getBoundingClientRect();
    const articleBox = node.getBoundingClientRect();
    return { header, editor: editor.height, saveVisible: save.top >= editor.bottom - 12 && save.bottom <= articleBox.bottom + 1 };
  });
  expect(editing.editor).toBeGreaterThan(editing.header);
  expect(editing.saveVisible).toBe(true);
  const saved = `---\nname: Long note\ndescription: "摘要只留在列表"\ntype: project\n---\n\n${Array.from({ length: 24 }, (_, index) => `保存后的第 ${index + 1} 段。`).join('\n\n')}\n\n已保存的正文`;
  await editor(page).fill(saved);
  await page.getByRole('button', { name: '保存记忆' }).click();
  await expect(bodyRegion).toContainText('已保存的正文');
  await expect(editor(page)).toHaveCount(0);

  await page.setViewportSize({ width: 640, height: 900 });
  await expect(list).toBeHidden();
  await expect(page.getByRole('button', { name: '返回列表' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索记忆' })).toBeHidden();
  await expect(article.getByRole('heading', { name: 'Long note' })).toBeVisible();
  expect(await shownInBody('已保存的正文')).toBeLessThanOrEqual(0);
  await bodyRegion.evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(await shownInBody('已保存的正文')).toBeGreaterThan(12);
  const narrow = await article.evaluate(node => {
    const heading = node.querySelector('h3')!.getBoundingClientRect();
    const region = node.querySelector('[aria-label="记忆正文"]')!.getBoundingClientRect();
    return {
      headingSeen: heading.top >= 0 && heading.bottom <= window.innerHeight && heading.width > 24,
      bodyMain: region.height > heading.height * 2,
      pageScroll: (document.querySelector('.content') as HTMLElement).scrollTop,
    };
  });
  expect(narrow.headingSeen).toBe(true);
  expect(narrow.bodyMain).toBe(true);
  expect(narrow.pageScroll).toBe(0);
  await article.getByRole('button', { name: /属性/ }).click();
  await expect(article.getByText('a-note.md')).toBeVisible();
  const squeezed = await article.evaluate(node => {
    const region = node.querySelector('[aria-label="记忆正文"]')!.getBoundingClientRect().height;
    const panel = node.querySelector('[data-memory-path]')!.getBoundingClientRect().height;
    return { region, panel };
  });
  expect(squeezed.region).toBeGreaterThan(squeezed.panel);
  expect(squeezed.region).toBeGreaterThan(120);
  const overflows = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(await overflows()).toBe(false);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await overflows()).toBe(false);
  await page.setViewportSize({ width: 1360, height: 900 });
  expect(await overflows()).toBe(false);
  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(list).toBeVisible();
  await expect(article).toBeHidden();
  await expect(page.getByRole('searchbox', { name: '搜索记忆' })).toBeVisible();
});
