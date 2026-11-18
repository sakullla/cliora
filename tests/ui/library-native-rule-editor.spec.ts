import { expect, test, type Page } from '@playwright/test';

/* 修改当前 CLI 规则 (NativeRuleEditor): the library rule section carries the
 * entry, its visibility follows the descriptors, catalog mode follows the
 * adapter-declared scope (a global catalog turns it on without a project),
 * and the destructive actions follow the per-kind policy the backend
 * reported instead of a hardcoded extension list. */

async function mockLibrary(page: Page, options: { rulesTools?: boolean } = {}) {
  const rulesTools = options.rulesTools ?? true;
  await page.addInitScript(({ rulesTools }) => {
    const descriptor = (tool: { id: string; name: string; rules: unknown }) => ({
      id: tool.id, name: tool.name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false,
      launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' },
      resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
      ...(rulesTools ? { management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false, rules: tool.rules } } : {}),
    });
    const tools = [
      // First tool keeps the historical shape: a single global rule file, no
      // catalog. Second tool declares a dual-scope catalog like agy.
      { id: 'codex', name: 'Codex', rules: { global: true, project: true, catalog: false, catalogGlobal: false, globalReason: '', projectReason: '' } },
      { id: 'antigravity', name: 'Antigravity', rules: { global: true, project: true, catalog: true, catalogGlobal: true, globalReason: '', projectReason: '' } },
    ];
    const state = {
      ruleFileCalls: [] as Array<{ toolId: string; scope: string; projectPath: string | null }>,
      created: [] as Array<{ toolId: string; scope: string; projectPath: string | null; name: string }>,
      ruleReads: 0,
    };
    const ruleFiles = [
      { id: 'md:rules/review.md', path: 'C:/Users/fixture/.gemini/config/rules/review.md', name: 'review.md', kind: 'md', enabled: true, writable: true, removable: true, toggleable: true, detail: '', fingerprint: 'f1', text: '---\ntrigger: manual\n---\n先跑测试。' },
      { id: 'agents:AGENTS.md', path: 'C:/Users/fixture/.gemini/config/AGENTS.md', name: 'AGENTS.md', kind: 'agents', enabled: true, writable: true, removable: false, toggleable: false, detail: '', fingerprint: 'f2', text: '全局 agents 正文' },
    ];
    Object.assign(window, {
      isTauri: true,
      __ruleEditor: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map((tool) => tool.id), theme: 'system' }, tools: tools.map((tool) => ({ id: tool.id, name: tool.name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: tools.map(descriptor), managedIds: tools.map((tool) => tool.id), preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'list_rule_placements') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_library_items') return [];
          if (command === 'get_registered_tool_workspace') return {
            probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
            profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
          };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          if (command === 'list_native_rule_files') {
            state.ruleFileCalls.push({ toolId: args.target.toolId, scope: args.target.scope, projectPath: args.target.projectPath ?? null });
            return ruleFiles;
          }
          if (command === 'read_native_rule') { state.ruleReads += 1; return { contextId: null, path: 'C:/Users/fixture/.codex/AGENTS.md', text: 'codex 全局规则', fingerprint: 'f0' }; }
          if (command === 'create_native_rule_file') {
            state.created.push({ toolId: args.target.toolId, scope: args.target.scope, projectPath: args.target.projectPath ?? null, name: args.name });
            return { transactionId: 't1', changedFiles: [], status: 'written' };
          }
          return [];
        },
      },
    });
  }, { rulesTools });
}

async function openRuleEditor(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: /长期规则/ }).click();
  await library.getByRole('button', { name: '修改当前 CLI 规则' }).click();
  return page.getByRole('dialog');
}

test('the rule editor entry follows descriptors and defers native reads until opened', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: /长期规则/ }).click();
  const entry = library.getByRole('button', { name: '修改当前 CLI 规则' });
  await expect(entry).toBeVisible();
  // Mounting the entry alone never probes native files.
  expect(await page.evaluate(() => (window as any).__ruleEditor.ruleFileCalls.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).__ruleEditor.ruleReads)).toBe(0);
  await entry.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The default tool has no catalog: the single-file editor loads its document.
  await expect(dialog.getByLabel('规则工具')).toHaveValue('codex');
  await expect(dialog.getByLabel('当前原生规则')).toContainText('codex 全局规则');
  expect(await page.evaluate(() => (window as any).__ruleEditor.ruleReads)).toBe(1);
});

test('a declared global catalog lists files without a project and follows the per-kind policy', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/');
  const dialog = await openRuleEditor(page);
  await dialog.getByLabel('规则工具').selectOption('antigravity');
  // Global scope + declared global catalog: the file picker appears without
  // any project selection and the request stays scope-global.
  await expect(dialog.getByLabel('规则文件')).toBeVisible();
  await expect(dialog.getByLabel('规则项目')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__ruleEditor.ruleFileCalls)).toEqual([
    { toolId: 'antigravity', scope: 'global', projectPath: null },
  ]);
  // The trigger rule offers the toggle and delete actions from its policy...
  await expect(dialog.getByLabel('启用规则')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '删除规则' })).toBeVisible();
  // ...while the hierarchical AGENTS.md stays editable only.
  await dialog.getByLabel('规则文件').selectOption('agents:AGENTS.md');
  await expect(dialog.getByLabel('启用规则')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '删除规则' })).toHaveCount(0);
  await expect(dialog.getByText('AGENTS.md 可编辑，不能删除或停用。')).toBeVisible();
  await expect(dialog.getByLabel('当前原生规则')).toContainText('全局 agents 正文');
  // Creating in the global catalog needs no project and keeps the scope.
  await dialog.getByLabel('规则名称').fill('style');
  const create = dialog.getByRole('button', { name: '新建规则文件' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect.poll(() => page.evaluate(() => (window as any).__ruleEditor.created)).toEqual([
    { toolId: 'antigravity', scope: 'global', projectPath: null, name: 'style' },
  ]);
});

test('the entry stays hidden when no managed tool declares rule support', async ({ page }) => {
  await mockLibrary(page, { rulesTools: false });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: /长期规则/ }).click();
  await expect(library.getByRole('button', { name: '修改当前 CLI 规则' })).toHaveCount(0);
});
