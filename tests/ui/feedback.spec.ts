import { expect, test, type Page } from '@playwright/test';

async function install(page: Page, seed: Record<string, boolean> = {}) {
  await page.addInitScript((initial: Record<string, boolean>) => {
    const control = { copyDelay: 0, themeFails: false, copyFails: false, launchFails: false, terminalFails: false, ruleSaveFails: false, resumeFails: false, projectsFail: false, withProject: false, renameFails: false, portableFails: false, settingsLoadFails: false, usageFails: false, librarySaveFails: false, libraryListFails: false, lastLibraryVersion: null as number | null, ...initial };
    const library = [{ id: 'prompt-1', kind: 'prompt', title: '发布检查', body: '请核对发布说明', category: '写作', projectId: null, version: 1, updatedAt: 1 }];
    let theme = 'light';
    let rule = '原规则';
    const facet = { state: 'available', reason: '' };
    const codex = { id: 'codex', name: 'Codex', interfaceFormats: [], projectModelOverride: false, yoloAvailable: true, nativeConfig: facet, launch: facet, resume: facet, resources: facet, history: facet };
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: ['codex'], theme, tool_icons: {} }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] });
    const launchSettings = () => ({ selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }, { id: 'windows_terminal', label: 'Windows Terminal', available: true }], cliMode: 'normal', projectMode: 'normal' });
    const workspace = { probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null, effectiveContextId: null };
    const session = { id: 'record-a', toolId: 'codex', nativeId: '1111', title: 'Review change', cwd: 'C:\\project', model: 'gpt', projectId: null, startedAt: 1, updatedAt: 1, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { if (control.copyDelay) await new Promise(resolve => setTimeout(resolve, control.copyDelay)); if (control.copyFails) throw new Error('clipboard denied'); }, readText: async () => '' } });
    Object.assign(window, {
      isTauri: true,
      __statusCopy: control,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return bootstrap();
        if (command === 'set_theme') { if (control.themeFails) throw { message: '主题写入失败', action: '请重新选择主题' }; theme = args.theme ?? theme; return bootstrap(); }
        if (command === 'list_cli_adapters') return { registered: [codex], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') {
          if (control.projectsFail) throw { message: '项目列表读取失败', action: '可再次启动，或在设置中检查终端。' };
          if (control.withProject) return [{ id: 'p1', name: '示例项目', path: 'C:/work', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
          return [];
        }
        if (command === 'rename_project') {
          if (control.renameFails) throw { message: '名称没有保存', action: '可再次点击保存名称。' };
          return { id: 'p1', name: args.name, path: 'C:/work', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} };
        }
        if (command === 'get_launch_settings' && control.settingsLoadFails) throw { message: '无法读取终端设置', action: '请重试。' };
        if (command === 'get_launch_settings' || command === 'set_default_launch_mode') return launchSettings();
        if (command === 'set_preferred_terminal') { if (control.terminalFails) throw new Error('终端不可用'); return { ...launchSettings(), selected: args.terminal }; }
        if (command === 'get_tray_status') return { available: true, error: null };
        if (command === 'get_registered_tool_workspace') return workspace;
        if (command === 'list_library_items') {
          if (control.libraryListFails) throw { message: '资料列表读取失败', action: '可调整搜索，或点击上方的新建。' };
          return library.filter((item) => item.kind === args.kind && (!args.search || `${item.title}${item.body}${item.category}`.includes(args.search)));
        }
        if (command === 'read_native_rule') return { text: rule, path: 'C:/rules/AGENTS.md', fingerprint: 'fp' };
        if (command === 'save_native_rule') { if (control.ruleSaveFails) throw new Error('磁盘拒绝写入'); rule = args.edited; return { status: 'applied' }; }
        if (command === 'list_rule_placements') return [];
        if (command === 'sync_rule_clients') { if (control.ruleSaveFails) throw new Error('磁盘拒绝写入'); return [{ toolId: 'codex', path: 'C:/rules/AGENTS.md', status: 'written', detail: '已写入拼接后的规则', existing: '', proposed: '' }]; }
        if (command === 'save_library_item') {
          if (control.librarySaveFails) throw { message: '资料没有写入', action: '可修改后再次点击保存。' };
          const draft = args.draft ?? {};
          control.lastLibraryVersion = typeof draft.expectedVersion === 'number' ? draft.expectedVersion : null;
          const saved = { id: draft.id ?? 'prompt-new', kind: draft.kind, title: draft.title, body: draft.body, category: draft.category, projectId: draft.projectId ?? null, version: (draft.expectedVersion ?? 0) + 1, updatedAt: 2 };
          const index = library.findIndex((item) => item.id === saved.id);
          if (index < 0) library.push(saved); else library[index] = saved;
          return saved;
        }
        if (command === 'list_portable_items') {
          if (control.portableFails) throw { message: '迁移列表读取失败', action: '可先离开再回到迁移与同步重新读取。' };
          return [];
        }
        if (command === 'get_webdav_status') return { configured: false, enabled: false, endpoint: null, lastSuccess: null, lastError: null, retryAfter: null, uploaded: 0, downloaded: 0, pendingChanges: 0, conflicts: [] };
        if (command === 'launch_cli') { if (control.launchFails) throw new Error('终端没有打开'); return { toolId: args.request?.toolId, projectId: args.request?.projectId ?? null, mode: args.request?.mode ?? 'normal', terminal: 'auto', status: 'terminal_requested' }; }
        if (command === 'refresh_history') return [];
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'list_history_prices') return [];
        if (command === 'list_history_sessions') return [session];
        if (command === 'get_history_session') return { session, messages: [{ id: 'm1', role: 'user', text: 'Review change', timestamp: 1 }], usage: [], resumeReason: null };
        if (command === 'get_usage_report') {
          if (control.usageFails) throw { message: '用量读取失败', action: '可点击刷新本机记录或调整筛选。' };
          const zero = { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 };
          return { generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', totals: zero, previous: null, timeline: [], byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0, partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans: [] };
        }
        if (command === 'save_history_price') return { ...args.price, updatedAt: 2 };
        if (command === 'copy_history_resume_command') return 'codex resume 1111';
        if (command === 'resume_history_session') { if (control.resumeFails) throw new Error('终端没有打开'); return { toolId: 'codex', projectId: null, mode: args.mode, terminal: 'auto', status: 'terminal_requested' }; }
        if (command === 'cancel_history_refresh') return null;
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  }, seed);
}

test('dialog feedback keeps focus and control positions; unrelated success preserves a save error', async ({ page }) => {
  await install(page, { librarySaveFails: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  const copy = dialog.getByRole('button', { name: '复制全文' });
  await expect(dialog.locator('.cm-content')).toBeVisible();
  const before = await save.boundingBox();
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('资料没有写入');
  await expect(save).toBeFocused();
  await copy.click();
  await expect(copy).toBeFocused();
  await expect(dialog.getByRole('alert')).toContainText('资料没有写入');
  await expect(dialog.getByRole('status').filter({ hasText: '完整正文已复制' })).toBeVisible();
  expect(await save.boundingBox()).toEqual(before);
  // Native dialog top layer owns the event, no duplicate is rendered underneath.
  await expect(page.locator('.feedback-item').filter({ hasText: '资料没有写入' })).toHaveCount(1);
  expect(await dialog.locator('.feedback-item').first().evaluate(node => node.closest('dialog')?.matches(':modal'))).toBe(true);
});

test('copy failures deduplicate and recovery checks the edited draft before writing', async ({ page }) => {
  await install(page, { copyFails: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '复制全文' }).click();
  await dialog.getByRole('button', { name: '复制全文' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(1);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = false; });
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = true; });
  await dialog.getByRole('button', { name: '复制全文' }).click();
  await dialog.getByLabel('标题').fill('changed after failure');
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '操作对象已变化' })).toBeVisible();
});

test('a late copy result stays in the originating context and remains reachable from the shell', async ({ page }) => {
  await install(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '资料库' }).click();
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyDelay: number } }).__statusCopy.copyDelay = 800; });
  await page.getByRole('button', { name: '复制全文' }).click();
  await nav.getByRole('button', { name: '快速开始' }).click();
  await expect(page.locator('main .feedback-item').filter({ hasText: '完整正文已复制' })).not.toBeVisible();
  await page.getByRole('button', { name: '操作消息', exact: true }).click();
  await expect(page.locator('.feedback-center-panel .feedback-item')).toContainText('完整正文已复制');
  await expect(page.getByRole('button', { name: '操作消息', exact: true })).toHaveAttribute('aria-expanded', 'true');
});

test('hover and keyboard interaction keep success available until interaction ends', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '复制全文' }).click();
  const result = page.locator('.feedback-item').filter({ hasText: '完整正文已复制' });
  await result.hover();
  await page.waitForTimeout(5300);
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: '忽略此消息', exact: true }).focus();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(5300);
  await expect(result).toBeVisible();
});

test('reopening an editor cannot receive a late result from its previous opening', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '修改' }).click();
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyDelay: number } }).__statusCopy.copyDelay = 800; });
  await page.getByRole('dialog').getByRole('button', { name: '复制全文' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '新建提示词', exact: true }).click();
  await page.waitForTimeout(1000);
  await expect(page.getByRole('dialog').getByRole('status').filter({ hasText: '完整正文已复制' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '完整正文已复制' })).toBeVisible();
});


test('terminal setting failure survives unrelated mode change and resolves on retry', async ({ page }) => {
  await install(page, { terminalFails: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  const terminal = page.getByRole('region', { name: '外部终端' });
  await terminal.getByLabel('启动终端').selectOption('windows_terminal');
  await expect(terminal.getByRole('alert')).toContainText('终端不可用');
  await terminal.locator('select').nth(1).selectOption('yolo');
  await expect(terminal.getByRole('alert')).toContainText('终端不可用');
  await page.evaluate(() => { (window as any).__statusCopy.terminalFails = false; });
  await terminal.getByLabel('启动终端').selectOption('windows_terminal');
  await expect(terminal.getByRole('alert')).toHaveCount(0);
});

test('shell-only failure is announced while collapsed without focus movement or repeated panel alerts', async ({ page }) => {
  await install(page, { themeFails: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  const dark = page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色' });
  await dark.click();
  await expect(dark).toBeFocused();
  await expect(page.locator('.feedback-center > [aria-live=assertive]')).toContainText('主题写入失败');
  const center = page.getByRole('button', { name: '操作消息', exact: true });
  await expect(center).toHaveAttribute('aria-expanded', 'false');
  await center.click();
  await expect(page.locator('.feedback-center-panel .feedback-item')).toContainText('主题写入失败');
  await expect(page.locator('.feedback-center-panel [role=alert]')).toHaveCount(0);
});

test('delayed MCP A save failure never appears in newly opened MCP B editor', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const host = window as any;
    const invoke = host.__TAURI_INTERNALS__.invoke;
    const definitions = ['A', 'B'].map(id => ({ id, name: `MCP ${id}`, transport: 'stdio', command: 'node', args: [], env: {}, headers: {}, url: '', version: 1, inLibrary: true }));
    host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_mcp_definitions') return definitions;
      if (command === 'list_mcp_placements') return [];
      if (command === 'save_mcp_definition') return new Promise((_, reject) => { host.rejectMcpSave = () => reject({ message: `${args.draft.name} 写入失败` }); });
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'MCP A', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).rejectMcpSave)).toBe('function');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'MCP B', exact: true }).click();
  await page.evaluate(() => (window as any).rejectMcpSave());
  await expect(page.locator('main .feedback-item').filter({ hasText: 'MCP A 写入失败' })).toHaveCount(1);
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '名称', exact: true })).toHaveValue('MCP B');
});


for (const distribute of [false, true]) test(`late successful MCP save preserves the new editor and selected targets (${distribute})`, async ({ page }) => {
  await install(page);
  await page.addInitScript(({ distribute }) => {
    const host = window as any; const invoke = host.__TAURI_INTERNALS__.invoke;
    const definitions = ['A', 'B'].map(id => ({ id, name: `MCP ${id}`, transport: 'stdio', command: 'node', args: [], env: {}, headers: {}, url: '', version: 1, inLibrary: true }));
    host.mcpWrites = [];
    host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_mcp_definitions') return definitions;
      if (command === 'list_mcp_placements') return distribute ? [{ definitionId: 'A', toolId: 'codex', scope: 'global', projectPath: null, enabled: true, contextId: null }] : [];
      if (command === 'save_mcp_definition') return new Promise(resolve => { host.resolveMcpSave = () => resolve({ ...definitions[0], ...args.draft, version: 2 }); });
      if (command === 'preview_mcp_targets' || command === 'distribute_mcp') { host.mcpWrites.push({ command, args }); return []; }
      return invoke(command, args);
    };
  }, { distribute });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'MCP A', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolveMcpSave)).toBe('function');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'MCP B', exact: true }).click();
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('B draft kept');
  await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  const before = await dialog.locator('input:checked, [aria-pressed=true]').count();
  await page.evaluate(() => (window as any).resolveMcpSave());
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('B draft kept');
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  expect(await dialog.locator('input:checked, [aria-pressed=true]').count()).toBe(before);
  expect(await page.evaluate(() => (window as any).mcpWrites)).toEqual([]);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('profile conflict failure is visible inside modal and successful retry clears original event', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const host = window as any; const invoke = host.__TAURI_INTERNALS__.invoke;
    const profile = { id: 'saved-1', tool: 'codex', name: '配置 A', version: 1, revision: '', inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} };
    host.conflictFails = true;
    host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'get_registered_tool_workspace') { const workspace = await invoke(command, args); return { ...workspace, probe: { ...workspace.probe, dependencies: [], providerPresets: [], interfaceFormats: [], installUrl: '', upgradeHint: '' }, profiles: [profile] }; }
      if (command === 'apply_registered_native_profile') throw { message: '请确认接管' };
      if (command === 'compare_registered_application') return { profile, common: null, files: [{ role: 'config', format: 'toml', current: 'model = "old"', proposedText: 'model = "new"' }] };
      if (command === 'apply_compared_application') { if (host.conflictFails) throw { message: '冲突写入失败' }; return null; }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.locator('[data-profile-id="saved-1"]').getByRole('button', { name: '使用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '比较当前文件与本次配置' });
  await dialog.getByRole('button', { name: '使用本次内容' }).click();
  await expect(dialog.getByRole('alert')).toContainText('冲突写入失败');
  await expect(page.locator('main .feedback-item').filter({ hasText: '冲突写入失败' })).toHaveCount(1);
  await page.evaluate(() => { (window as any).conflictFails = false; });
  await dialog.getByRole('button', { name: '使用本次内容' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('main .feedback-item').filter({ hasText: '冲突写入失败' })).toHaveCount(0);
  await expect(page.locator('main .feedback-item').filter({ hasText: '请确认接管' })).toHaveCount(0);
});


test('MCP save keeps subsequent input in the same editor and accepts the saved version', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const host = window as any; const invoke = host.__TAURI_INTERNALS__.invoke;
    const definition = { id: 'A', name: 'MCP A', transport: 'stdio', command: 'node', args: [], env: {}, headers: {}, url: '', version: 1, inLibrary: true };
    host.saveDrafts = [];
    host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_mcp_definitions') return [definition];
      if (command === 'list_mcp_placements') return [];
      if (command === 'save_mcp_definition') { host.saveDrafts.push(args.draft); return new Promise(resolve => { host.resolveMcpSave = () => resolve({ ...definition, ...args.draft, version: 2 }); }); }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'MCP A', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => page.evaluate(() => (window as any).saveDrafts.length)).toBe(1);
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('New unsaved name');
  await page.evaluate(() => (window as any).resolveMcpSave());
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('New unsaved name');
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => page.evaluate(() => (window as any).saveDrafts[1]?.expectedVersion)).toBe(2);
});

for (const editBeforeRetry of [true, false]) test(`MCP read recovery preserves further input (${editBeforeRetry})`, async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const host = window as any; const invoke = host.__TAURI_INTERNALS__.invoke;
    const definition = { id: 'A', name: 'MCP A', transport: 'stdio', command: 'node', args: [], env: {}, headers: {}, url: '', version: 1, inLibrary: true };
    let saved = false; let reads = 0; host.saves = 0;
    host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_mcp_definitions') {
        if (!saved) return [definition];
        if (++reads === 1) throw { message: 'list offline' };
        return new Promise(resolve => { host.resolveMcpRead = () => resolve([definition]); });
      }
      if (command === 'list_mcp_placements') return [];
      if (command === 'save_mcp_definition') { saved = true; host.saves++; return { ...definition, ...args.draft, version: 2 }; }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'MCP A', exact: true }).click();
  const dialog = page.getByRole('dialog'); const name = dialog.getByRole('textbox', { name: '名称', exact: true });
  await dialog.locator('[data-dialog-save]').click();
  const retry = dialog.getByRole('button', { name: '重试', exact: true });
  await expect(retry).toBeVisible();
  if (editBeforeRetry) await name.fill('Keep newer draft');
  await retry.click();
  if (editBeforeRetry) await expect(dialog.getByRole('alert').filter({ hasText: '操作对象已变化' })).toBeVisible();
  else {
    await expect.poll(() => page.evaluate(() => typeof (window as any).resolveMcpRead)).toBe('function');
    await name.fill('Keep newer draft');
    await page.evaluate(() => (window as any).resolveMcpRead());
    await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  }
  await expect(name).toHaveValue('Keep newer draft');
  expect(await page.evaluate(() => (window as any).saves)).toBe(1);
});


for (const externalChange of [false, true]) test(`tool MCP continuous editing saves against its accepted revision (${externalChange})`, async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const host = window as any; const invoke = host.__TAURI_INTERNALS__.invoke;
    let definition = { id: 'A', name: 'MCP A', transport: 'stdio', command: 'node', args: [], env: {}, headers: {}, url: '', version: 1, inLibrary: true };
    host.mcpSaveRequests = [];
    host.externalMcpEdit = () => { definition = { ...definition, command: 'external', version: definition.version + 1 }; };
    host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'get_registered_tool_workspace') { const workspace = await invoke(command, args); return { ...workspace, probe: { ...workspace.probe, dependencies: [], providerPresets: [], interfaceFormats: [], installUrl: '', upgradeHint: '' } }; }
      if (command === 'list_mcp_definitions') return [definition];
      if (command === 'list_native_mcp') return [{ ...definition, enabled: true }];
      if (command === 'save_mcp_definition') {
        host.mcpSaveRequests.push(args.draft);
        if (args.draft.expectedVersion !== definition.version) throw { message: 'MCP 已被外部修改，请重新读取' };
        definition = { ...definition, ...args.draft, version: definition.version + 1 };
        if (host.mcpSaveRequests.length === 1) return new Promise(resolve => { host.finishFirstMcpSave = () => resolve(definition); });
        return definition;
      }
      if (command === 'preview_mcp_targets') return args.targets.map((target: any) => ({ ...target, status: 'ready', detail: '', baselineHash: 'baseline', previewToken: 'preview' }));
      if (command === 'distribute_mcp') return args.targets.map((target: any) => ({ ...target, status: 'written', detail: '' }));
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: /MCP A/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishFirstMcpSave)).toBe('function');
  await dialog.getByRole('textbox', { name: '命令', exact: true }).fill('continued-command');
  await page.evaluate(() => (window as any).finishFirstMcpSave());
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  await expect(dialog.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('continued-command');
  if (externalChange) await page.evaluate(() => (window as any).externalMcpEdit());
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => page.evaluate(() => (window as any).mcpSaveRequests.map((item: any) => item.expectedVersion))).toEqual([1, 2]);
  if (externalChange) {
    await expect(dialog.getByRole('alert')).toContainText('MCP 已被外部修改');
    await expect(dialog.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('continued-command');
  } else {
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.feedback-item').filter({ hasText: '已写入当前工具' })).toBeVisible();
  }
});
