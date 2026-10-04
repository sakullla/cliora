import { expect, test, type Locator, type Page } from '@playwright/test';

async function install(page: Page, seed: Record<string, boolean> = {}) {
  await page.addInitScript((initial: Record<string, boolean>) => {
    const control = { copyFails: false, launchFails: false, terminalFails: false, ruleSaveFails: false, resumeFails: false, projectsFail: false, withProject: false, renameFails: false, portableFails: false, settingsLoadFails: false, usageFails: false, librarySaveFails: false, libraryListFails: false, lastLibraryVersion: null as number | null, ...initial };
    const library = [{ id: 'prompt-1', kind: 'prompt', title: '发布检查', body: '请核对发布说明', category: '写作', projectId: null, version: 1, updatedAt: 1 }];
    let theme = 'light';
    let rule = '原规则';
    const facet = { state: 'available', reason: '' };
    const codex = { id: 'codex', name: 'Codex', interfaceFormats: [], projectModelOverride: false, yoloAvailable: true, nativeConfig: facet, launch: facet, resume: facet, resources: facet, history: facet };
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: ['codex'], theme, tool_icons: {} }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] });
    const launchSettings = () => ({ selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }, { id: 'windows_terminal', label: 'Windows Terminal', available: true }], cliMode: 'normal', projectMode: 'normal' });
    const workspace = { probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
    const session = { id: 'record-a', toolId: 'codex', nativeId: '1111', title: 'Review change', cwd: 'C:\\project', model: 'gpt', projectId: null, startedAt: 1, updatedAt: 1, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { if (control.copyFails) throw new Error('clipboard denied'); }, readText: async () => '' } });
    Object.assign(window, {
      isTauri: true,
      __statusCopy: control,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return bootstrap();
        if (command === 'set_theme') { theme = args.theme ?? theme; return bootstrap(); }
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
          const zero = { requests: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 };
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

async function dangerColor(locator: Locator) {
  return locator.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const actual = getComputedStyle(element).color;
    return { actual, expected, same: actual === expected, fixed: actual === 'rgb(169, 54, 38)' };
  });
}

test('library filter empty points at create, and copy failure replaces copied', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await expect(library.getByRole('button', { name: '发布检查' })).toBeVisible();
  await library.getByRole('button', { name: '复制全文' }).click();
  await expect(library.getByText('完整正文已复制，可以粘贴使用。')).toBeVisible();
  await expect(library.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = true; });
  await library.getByRole('button', { name: '复制全文' }).click();
  await expect(library.getByRole('alert')).toHaveText('复制失败，正文仍在页面上，可以手动选择。');
  await expect(library.getByText('已复制')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = false; });
  await library.getByRole('button', { name: '复制全文' }).click();
  await expect(library.getByText('完整正文已复制，可以粘贴使用。')).toBeVisible();
  await expect(library.getByRole('alert')).toHaveCount(0);
  await library.getByLabel('搜索资料').fill('没有这项');
  await expect(library.getByText('筛选结果为空，没有符合条件的提示词。请使用上方的「新建」。')).toBeVisible();
  await expect(library.getByRole('button', { name: '发布检查' })).toHaveCount(0);
  await expect(library.getByRole('button', { name: '＋ 新建提示词' })).toBeVisible();
  await expect(library.getByRole('button', { name: /清空筛选/ })).toHaveCount(0);
  await expect(library.getByText('清空筛选')).toHaveCount(0);
});

test('empty export says nothing can be taken and points at existing pages', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '迁移与同步' }).click();
  await page.getByRole('button', { name: '导出加密配置包' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('当前没有可带走的资料。请先在快速开始、工具与连接或资料库中产生配置或资料。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '快速开始' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '工具与连接' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '资料库' })).toHaveCount(0);
});

test('terminal errors stay readable in light and dark and can be chosen again', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await expect(page.getByLabel('启动终端')).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __statusCopy: { terminalFails: boolean } }).__statusCopy.terminalFails = true; });
  await page.getByLabel('启动终端').selectOption('windows_terminal');
  const alert = page.getByRole('region', { name: '外部终端' }).getByRole('alert');
  await expect(alert).toContainText('终端不可用');
  await expect(alert).toContainText('可以重新选择终端');
  await expect(alert).toHaveAttribute('style', /var\(--danger\)/);
  await expect(alert).not.toHaveAttribute('style', /#a93626/i);
  await expect.poll(async () => (await dangerColor(alert)).same).toBe(true);
  const light = await dangerColor(alert);
  expect(light.same).toBe(true);
  expect(light.fixed).toBe(false);
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await dangerColor(alert)).same).toBe(true);
  const dark = await dangerColor(alert);
  expect(dark.same).toBe(true);
  expect(dark.fixed).toBe(false);
  expect(dark.actual).not.toBe(light.actual);
});

test('project launch success and failure replace each other', async ({ page }) => {
  await install(page, { withProject: true });
  await page.goto('/');
  const region = page.getByRole('region', { name: '项目与启动' });
  await region.getByRole('button', { name: '启动', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('已向外部终端发送启动请求');
  await expect(region.getByRole('status')).not.toContainText('已登录');
  await expect(region.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { launchFails: boolean } }).__statusCopy.launchFails = true; });
  await region.getByRole('button', { name: '启动', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('终端没有打开');
  await expect(region.getByRole('alert')).toContainText('请重试');
  await expect(region.getByRole('status')).toHaveCount(0);
  await expect(region.getByText('已向外部终端发送启动请求')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { launchFails: boolean } }).__statusCopy.launchFails = false; });
  await region.getByRole('button', { name: '启动', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('已向外部终端发送启动请求');
  await expect(region.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { projectsFail: boolean } }).__statusCopy.projectsFail = true; });
  await region.getByRole('button', { name: '启动', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('已向外部终端发送启动请求');
  await expect(region.getByRole('alert')).toContainText('项目列表读取失败');
  await expect(region.getByRole('alert')).toContainText('可再次启动，或在设置中检查终端');
});

test('record copy and resume replace the previous result', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  const records = page.getByRole('region', { name: '使用记录内容' });
  await expect(records.getByLabel('原生恢复命令')).toContainText('codex resume 1111');
  await records.getByText('会话选项', { exact: true }).click();
  await records.getByRole('button', { name: '复制命令' }).click();
  await expect(records.getByText('已复制原生恢复命令，粘贴后由终端执行。')).toBeVisible();
  await expect(records.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = true; });
  await records.getByRole('button', { name: '复制命令' }).click();
  await expect(records.getByRole('alert')).toHaveText('复制失败，恢复命令仍在页面上，可以手动选择。');
  await expect(records.getByText('已复制')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = false; });
  await records.getByRole('button', { name: '复制命令' }).click();
  await expect(records.getByText('已复制原生恢复命令，粘贴后由终端执行。')).toBeVisible();
  await expect(records.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { resumeFails: boolean } }).__statusCopy.resumeFails = true; });
  await records.getByRole('button', { name: '在外部终端继续' }).click();
  await expect(records.getByRole('alert')).toContainText('终端没有打开');
  await expect(records.getByText('已复制')).toHaveCount(0);
  await expect(records.getByText('已请求外部终端恢复会话')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { resumeFails: boolean } }).__statusCopy.resumeFails = false; });
  await records.getByRole('button', { name: '在外部终端继续' }).click();
  await expect(records.getByText('已请求外部终端恢复会话。')).toBeVisible();
  await expect(records.getByRole('alert')).toHaveCount(0);
});

test('native rule save failure is an alert and success stays a status', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: '长期规则' }).click();
  await page.getByRole('button', { name: '＋ 新建规则' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('标题').fill('一条规则');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const library = page.getByRole('region', { name: '资料库内容' });
  const icon = library.getByRole('button', { name: 'Codex · 未写入' });
  await page.evaluate(() => { (window as unknown as { __statusCopy: { ruleSaveFails: boolean } }).__statusCopy.ruleSaveFails = true; });
  await icon.click();
  const alert = library.getByRole('alert');
  await expect(alert).toContainText('规则保存失败');
  await expect(alert).toContainText('可以再次点击该 CLI 图标');
  await expect(library.getByRole('status')).toHaveCount(0);
  const color = await dangerColor(alert);
  expect(color.same).toBe(true);
  expect(color.fixed).toBe(false);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { ruleSaveFails: boolean } }).__statusCopy.ruleSaveFails = false; });
  await icon.click();
  await expect(library.getByText('已写入 Codex。')).toBeVisible();
  await expect(library.getByRole('alert')).toHaveCount(0);
});

test('export list failure stays in the dialog and is not an empty list', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.evaluate(() => { (window as unknown as { __statusCopy: { portableFails: boolean } }).__statusCopy.portableFails = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '迁移与同步' }).click();
  await page.getByRole('button', { name: '导出加密配置包' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('迁移列表读取失败');
  await expect(dialog.getByRole('alert')).toContainText('可先离开再回到迁移与同步重新读取');
  await expect(dialog.getByText('当前没有可带走的资料')).toHaveCount(0);
});

test('terminal load failure does not ask to reselect a disabled terminal', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.evaluate(() => { (window as unknown as { __statusCopy: { settingsLoadFails: boolean } }).__statusCopy.settingsLoadFails = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  const terminal = page.getByRole('region', { name: '外部终端' });
  await expect(terminal.getByLabel('启动终端')).toBeDisabled();
  const alert = terminal.getByRole('alert');
  await expect(alert).toContainText('无法读取终端设置');
  await expect(alert).toContainText('迁移与同步');
  await expect(alert).toContainText('常规');
  await expect(alert).not.toContainText('重新选择终端');
});

test('library save closes the dialog and copy results stay in the dialog', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await page.evaluate(() => { (window as unknown as { __statusCopy: { librarySaveFails: boolean } }).__statusCopy.librarySaveFails = true; });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('资料没有写入');
  await expect(dialog.getByRole('alert')).toContainText('可修改后再次点击保存');
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { librarySaveFails: boolean } }).__statusCopy.librarySaveFails = false; });
  await page.keyboard.press('Control+s');
  await expect(dialog).toHaveCount(0);
  await expect(library.getByRole('status')).toContainText('已保存在本机资料库');
  await expect(library.getByRole('alert')).toHaveCount(0);
  await library.getByRole('button', { name: '修改' }).click();
  const again = page.getByRole('dialog');
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = true; });
  await again.getByRole('button', { name: '复制全文' }).click();
  await expect(again.getByRole('alert')).toHaveText('复制失败，正文仍在页面上，可以手动选择。');
  await expect(again.getByText('已复制')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = false; });
  await again.getByRole('button', { name: '复制全文' }).click();
  await expect(again.getByRole('status')).toContainText('完整正文已复制，可以粘贴使用。');
  await expect(again.getByRole('alert')).toHaveCount(0);
});

test('project edit failure stays inside the dialog', async ({ page }) => {
  await install(page, { withProject: true });
  await page.goto('/');
  const region = page.getByRole('region', { name: '项目与启动' });
  await region.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('示例项目 项目名称').fill('新名字');
  await page.evaluate(() => { (window as unknown as { __statusCopy: { renameFails: boolean } }).__statusCopy.renameFails = true; });
  await dialog.getByRole('button', { name: '保存名称' }).click();
  await expect(dialog.getByRole('alert')).toContainText('名称没有保存');
  await expect(dialog.getByRole('alert')).toContainText('可再次点击保存名称');
  await expect(region.locator(':scope > [role="alert"]')).toHaveCount(0);
});

test('saved price stays visible when the following usage read fails', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  const records = page.getByRole('region', { name: '使用记录内容' });
  await records.getByRole('tab', { name: '用量' }).click();
  await expect(records.getByRole('button', { name: '设置估算价格' })).toBeVisible();
  await expect(records.getByText('正在筛选已缓存记录…')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { usageFails: boolean } }).__statusCopy.usageFails = true; });
  await records.getByRole('button', { name: '设置估算价格' }).click();
  await records.getByRole('button', { name: '价格工具' }).click();
  await records.getByRole('option', { name: 'Codex' }).click();
  await records.getByLabel('价格模型').fill('gpt');
  await records.getByLabel('输入单价').fill('1');
  await records.getByLabel('输出单价').fill('1');
  await records.getByLabel('缓存读取单价').fill('1');
  await records.getByLabel('缓存写入单价').fill('1');
  await records.getByRole('button', { name: '保存价格' }).click();
  await expect(records.getByText('估算价格已保存；只影响本机统计。')).toBeVisible();
  await expect(records.getByRole('alert')).toContainText('用量读取失败');
  await expect(records.getByRole('alert')).toContainText('可点击刷新本机记录或调整筛选');
});

test('dialog launch success stays with the list failure after the dialog closes', async ({ page }) => {
  await install(page, { withProject: true });
  await page.goto('/');
  const region = page.getByRole('region', { name: '项目与启动' });
  await region.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await page.evaluate(() => { (window as unknown as { __statusCopy: { projectsFail: boolean } }).__statusCopy.projectsFail = true; });
  await dialog.getByRole('button', { name: 'YOLO' }).click();
  const pageStatus = region.locator(':scope > [role="status"]');
  const pageAlert = region.locator(':scope > [role="alert"]');
  await expect(pageStatus).toContainText('已向外部终端发送启动 YOLO请求');
  await expect(pageAlert).toContainText('项目列表读取失败');
  await expect(dialog.getByRole('status')).toContainText('已向外部终端发送启动 YOLO请求');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pageStatus).toContainText('已向外部终端发送启动 YOLO请求');
  await expect(pageAlert).toContainText('项目列表读取失败');
});

test('saved library item stays visible when the following list read fails', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('标题').fill('发布检查已更新');
  await page.evaluate(() => { (window as unknown as { __statusCopy: { libraryListFails: boolean } }).__statusCopy.libraryListFails = true; });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存在本机资料库');
  const dialogAlert = dialog.getByRole('alert');
  await expect(dialogAlert).toContainText('资料列表读取失败');
  await expect(dialogAlert).toContainText('关闭');
  await expect(dialogAlert).not.toContainText('搜索');
  await expect(dialogAlert).not.toContainText('新建');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(library.getByRole('status')).toContainText('已保存在本机资料库');
  const alert = library.getByRole('alert');
  await expect(alert).toContainText('资料列表读取失败');
  await expect(alert).not.toContainText('搜索');
  await expect(alert).not.toContainText('新建');
  await expect(library.getByRole('button', { name: '发布检查已更新', exact: true })).toBeVisible();
  await library.getByRole('button', { name: '修改' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __statusCopy: { lastLibraryVersion: number | null } }).__statusCopy.lastLibraryVersion)).toBe(2);
});

test('page search answers Ctrl+F and slash, and Escape clears it', async ({ page }) => {
  await install(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await expect(library.getByRole('button', { name: '发布检查' })).toBeVisible();
  await page.keyboard.press('Control+f');
  const search = library.getByLabel('搜索资料');
  await expect(search).toBeFocused();
  await page.keyboard.type('没有这项');
  await expect(library.getByText('筛选结果为空')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(library.getByRole('button', { name: '发布检查' })).toBeVisible();
  await nav.getByRole('button', { name: '使用记录' }).click();
  await page.keyboard.press('/');
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toHaveValue('');
});

test('the automatic record scan stays quiet and a manual refresh reports', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  const records = page.getByRole('region', { name: '使用记录内容' });
  await expect(records.getByLabel('原生恢复命令')).toContainText('codex resume 1111');
  await expect(records.getByText('已刷新本机记录。')).toHaveCount(0);
  await records.getByRole('button', { name: '刷新本机记录' }).click();
  await expect(records.getByText('已刷新本机记录。')).toBeVisible();
});

test('an empty library offers to create the first item', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: '长期规则' }).click();
  await expect(library.getByText('还没有规则')).toBeVisible();
  await library.getByRole('button', { name: '＋ 新建第一条规则' }).click();
  await expect(page.getByRole('dialog')).toContainText('新建规则');
});

test('export password can be revealed and explains what is still missing', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '迁移与同步' }).click();
  await page.getByRole('button', { name: '导出加密配置包' }).click();
  const dialog = page.getByRole('dialog');
  const password = dialog.getByRole('textbox', { name: '配置包口令' }).or(dialog.getByLabel('配置包口令'));
  await expect(password).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: '显示口令' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(dialog.getByRole('button', { name: '隐藏口令' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText('至少勾选一项资料。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '导出配置包' })).toBeDisabled();
});
