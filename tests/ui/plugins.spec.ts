import { expect, test, type Page } from '@playwright/test';

test('plugin search and read-only filter expose relevant actions without changing state', async ({ page }) => {
  await setup(page);
  await page.getByLabel('搜索插件').fill('no-match');
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await page.getByLabel('插件状态筛选').selectOption('readonly');
  await expect(page.getByText('Organization plugin', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture plugin', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('listitem').getByRole('button', { name: '卸载', exact: true })).toBeDisabled();
});

async function setup(page: Page, deferFull = false, deferWorkspace = false, deferContext = deferWorkspace, catalog = false, extended = false, noPreview = false, emptyEntries = false, installless = false) {
  const extendedPath = String.raw`\\?\C:\Users\fixture\.grok\plugins\sakullla-dev`;
  const extendedResource = String.raw`\\?\UNC\server\share\plugins\sakullla-dev\agents`;
  await page.addInitScript(({ holdFull, holdWorkspace, holdContext, catalog, extended, noPreview, emptyEntries, installless, extendedPath, extendedResource }) => {
    const entry = { id: 'fixture@market', name: 'Fixture plugin', source: 'fixture@market', version: '1.0.0', scope: 'user', enabled: true, state: 'installed_load_unknown', policy: 'AVAILABLE · ON_INSTALL', readOnly: false, root: '/fixture/plugins/fixture', resources: [{ kind: 'agents', path: '/fixture/plugins/fixture/agents', ownerId: 'fixture@market' }] };
    const state = { calls: [] as any[], entries: emptyEntries ? [] : [entry, { ...entry, id: 'required@market', name: 'Organization plugin', policy: 'REQUIRED', readOnly: true }], fail: false, releaseFull: null as (() => void) | null, releaseWorkspace: null as (() => void) | null, releaseContext: null as (() => void) | null, contextId: 'ctx-fixture' };
    if (catalog) state.entries.push({ ...entry, id: 'lark@official', name: 'Lark', source: 'lark@official', enabled: null, readOnly: true, state: 'not_installed', policy: '官方市场条目未安装', resources: [] });
    if (extended) state.entries.push({ ...entry, id: 'sakullla-dev', name: 'sakullla-dev', source: extendedPath, root: extendedPath, readOnly: true, resources: [{ kind: 'agents', path: extendedResource, ownerId: 'sakullla-dev' }] });
    const snapshot = (target: any) => ({ target, capability: { version: '2.1.287', sources: 'plugin@marketplace', actions: installless ? ['enable', 'disable', 'uninstall'] : ['install', 'update', 'enable', 'disable', 'uninstall'], project: true, detail: '重启会话后加载' }, entries: state.entries, baseline: 'fixture-baseline', detail: '静态列表，加载未验证' });
    Object.assign(window, { isTauri: true, pluginsHarness: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      state.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'], login: { hint: '原生登录' } }], managedIds: ['claude_code'], preservedUnknown: [] };
      if (command === 'list_projects') return [{ id: 'project', name: '测试项目', path: '/fixture/project', available: true, selectedProfiles: {}, appliedProfiles: {} }];
      if (['list_usage_queries', 'list_usage_cache', 'list_accounts'].includes(command)) return [];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'get_registered_tool_context') {
        if (holdContext) await new Promise<void>(resolve => { state.releaseContext = resolve; });
        return { effectiveContextId: state.contextId, nativeContextError: null };
      }
      if (command === 'get_registered_tool_workspace') {
        if (holdWorkspace && !args.summary) await new Promise<void>(resolve => { state.releaseWorkspace = resolve; });
        return { probe: { tool: 'claude_code', selectedPath: 'C:/claude.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [] }, profiles: [], effectiveContextId: 'ctx-fixture', binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [] };
      }
      if (command === 'preview_native_plugins') {
        if (noPreview) return null;
        if (holdFull) return { ...snapshot(args.target), baseline: '', capability: { ...snapshot(args.target).capability, actions: [] }, entries: [{ ...entry, readOnly: true, enabled: null, state: 'inventory_pending' }] };
      }
      if (command === 'scan_native_plugins') {
        if (holdFull) await new Promise<void>(resolve => { state.releaseFull = resolve; });
        return snapshot(args.target);
      }
      if (command === 'operate_native_plugin') {
        const req = args.request;
        if (req.target.contextId !== 'ctx-fixture' || req.baseline !== 'fixture-baseline') throw { message: '目标或基线错误' };
        if (state.fail) return { status: 'failed_possible_side_effects', detail: '原生命令失败；已重新扫描实际状态，未宣称原子回滚', transactionId: null, snapshot: snapshot(req.target) };
        if (req.action === 'install') state.entries.push({ ...entry, id: req.source, name: req.source, source: req.source });
        if (req.action === 'disable' || req.action === 'enable') state.entries.find(item => item.id === req.source)!.enabled = req.action === 'enable';
        if (req.action === 'uninstall') state.entries = state.entries.filter(item => item.id !== req.source);
        return { status: 'native_command_completed', detail: '原生命令已完成；现有会话未热加载。已重新扫描', transactionId: null, snapshot: snapshot(req.target) };
      }
      return null;
    } } });
  }, { holdFull: deferFull, holdWorkspace: deferWorkspace, holdContext: deferContext, catalog, extended, noPreview, emptyEntries, installless, extendedPath, extendedResource });
  await page.goto('/'); await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  if (!deferWorkspace && !emptyEntries && !(deferFull && noPreview)) await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
}

test('resources wait for their bound context but do not wait for slow installation probes', async ({ page }) => {
  await setup(page, false, true);
  await expect(page.getByText('正在读取工具上下文…')).toBeVisible();
  const reads = await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'get_registered_tool_workspace' && !call.args.summary));
  expect(reads).toHaveLength(1);
  expect(reads[0].args.fresh).toBe(false);
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins'))).toEqual([]);
  await page.evaluate(() => (window as any).pluginsHarness.releaseContext());
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  const scans = await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins'));
  expect(scans).toHaveLength(1);
  expect(scans[0].args.target.contextId).toBe('ctx-fixture');
  await page.evaluate(() => (window as any).pluginsHarness.releaseWorkspace());
  await page.getByRole('tab', { name: '配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建配置', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins').length)).toBe(1);
});

test('a late lightweight context cannot replace the completed workspace binding', async ({ page }) => {
  await setup(page, false, false, true);
  await page.evaluate(() => { const state = (window as any).pluginsHarness; state.contextId = 'stale-context'; state.releaseContext(); });
  await page.getByRole('tab', { name: '配置', exact: true }).click();
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  const scans = await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins'));
  expect(scans).toHaveLength(1);
  expect(scans[0].args.target.contextId).toBe('ctx-fixture');
});

test('native plugin lifecycle retains context, policy, ownership and load distinction', { tag: '@integration' }, async ({ page }) => {
  await setup(page);
  const card = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await expect(card.getByText(/原生已安装 · 加载未验证/)).toBeVisible();
  await card.getByText('包内资源（随插件管理）').click(); await expect(card.getByText(/agents ·/)).toBeVisible();
  await card.getByRole('button', { name: '禁用', exact: true }).click(); await expect(card.getByRole('button', { name: '启用' })).toBeVisible();
  await card.getByRole('button', { name: '启用' }).click();
  const managed = page.getByRole('listitem').filter({ has: page.getByText('Organization plugin', { exact: true }) });
  await expect(managed.getByRole('button', { name: '禁用' })).toBeDisabled(); await expect(managed.getByRole('button', { name: '卸载' })).toBeDisabled();
  await page.getByLabel('插件来源', { exact: true }).fill('second@market'); await expect(page.getByRole('button', { name: '安装插件' })).toBeDisabled();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '安装插件' }).click(); await expect(page.getByText('second@market', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '更新' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '更新', exact: true }).click();
  await page.screenshot({ path: 'test-results/native-plugins.png', fullPage: true });
  await card.getByRole('button', { name: '卸载' }).click(); await page.getByRole('dialog').getByRole('button', { name: '卸载', exact: true }).click(); await expect(page.getByText('Fixture plugin', { exact: true })).toHaveCount(0);
  const actions = await page.evaluate(() => (window as any).pluginsHarness.calls.filter((c: any) => c.command === 'operate_native_plugin').map((c: any) => c.args.request.action));
  expect(actions).toEqual(['disable', 'enable', 'install', 'update', 'uninstall']);
});

test('inventory appears before the slow native scan and unfinished scans are shared', async ({ page }) => {
  await setup(page, true);
  await expect(page.getByText('正在核对插件状态', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '安装插件' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '禁用', exact: true })).toHaveCount(0);
  await page.getByLabel('搜索插件').fill('Fixture');
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '配置', exact: true }).click();
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins').length)).toBe(1);
  await page.evaluate(() => (window as any).pluginsHarness.releaseFull());
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) }).getByRole('button', { name: '禁用', exact: true })).toBeEnabled();
  await expect(page.getByText('正在核对插件状态', { exact: true })).toHaveCount(0);
});

test('failed native operation retains rescanned state and allows explicit recovery scan', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).pluginsHarness.fail = true; });
  const card = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await card.getByRole('button', { name: '禁用' }).click(); await expect(page.getByRole('alert')).toContainText('可能留下部分变更');
  await expect(card.getByRole('button', { name: '禁用' })).toBeEnabled(); await page.getByRole('button', { name: '重新扫描' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((c: any) => c.command === 'scan_native_plugins').length)).toBeGreaterThan(1);
});

test('changing plugin scope clears the previous source trust before a project operation', async ({ page }) => {
  await setup(page);
  await page.getByLabel('插件来源', { exact: true }).fill('second@market');
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: '安装插件' })).toBeEnabled();
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByLabel('插件来源', { exact: true }).fill('second@market');
  await expect(page.getByRole('button', { name: '安装插件' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'operate_native_plugin'))).toEqual([]);
});


test('returning to plugins uses the scoped snapshot and explicit scan refreshes it', async ({ page }) => {
  await setup(page);
  const scans = () => page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins').length);
  const first = await scans();
  await page.getByRole('tab', { name: '配置', exact: true }).click();
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  expect(await scans()).toBe(first);
  await page.getByRole('button', { name: '重新扫描' }).click();
  await expect(page.getByRole('button', { name: '重新扫描' })).toBeEnabled();
  expect(await scans()).toBe(first + 1);
});

test('windows extended plugin paths are shown as ordinary paths', async ({ page }) => {
  await setup(page, false, false, false, false, true);
  const card = page.getByRole('listitem').filter({ has: page.getByText('sakullla-dev', { exact: true }) });
  const drive = 'C:\\Users\\fixture\\.grok\\plugins\\sakullla-dev';
  await expect(card.getByText(`${drive} · 全局`)).toBeVisible();
  await expect(card).not.toContainText('\\\\?\\');
  await card.getByText('安装位置').click();
  await expect(card.getByText(drive, { exact: true })).toBeVisible();
  await card.getByText('包内资源（随插件管理）').click();
  await expect(card.getByText('agents · \\\\server\\share\\plugins\\sakullla-dev\\agents')).toBeVisible();
  const market = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await expect(market.getByText('fixture@market · 全局')).toBeVisible();
});

test('uninstalled catalog rows stay out of the installed plugin count', async ({ page }) => {
  await setup(page, false, false, false, true);
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  await expect(page.getByText('2 个插件')).toBeVisible();
  const summary = page.getByText('未安装（1，当前不会加载）');
  await expect(summary).toBeVisible();
  await summary.click();
  const lark = page.getByRole('listitem').filter({ has: page.getByText('Lark', { exact: true }) });
  await expect(lark).toBeVisible();
  await expect(lark.getByText('未安装，当前不会加载').first()).toBeVisible();
  await expect(lark.getByRole('button', { name: '禁用', exact: true })).toHaveCount(0);
  await expect(lark.getByRole('button', { name: '卸载', exact: true })).toHaveCount(0);
});

test('first load without an inventory preview shows skeleton rows until the scan returns', async ({ page }) => {
  await setup(page, true, false, false, false, false, true);
  const skeleton = page.locator('[role="status"] .skeleton-page');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Fixture plugin', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).pluginsHarness.releaseFull());
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  await expect(skeleton).toHaveCount(0);
});

test('empty plugin workspace with install capability offers the install entry', async ({ page }) => {
  await setup(page, false, false, false, false, false, false, true);
  const emptyState = page.locator('.empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState.getByRole('button')).toHaveCount(1);
  const entry = emptyState.getByRole('button', { name: '安装插件' });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.getByLabel('插件来源', { exact: true })).toBeFocused();
});

test('empty plugin workspace without install capability offers a rescan instead', async ({ page }) => {
  await setup(page, false, false, false, false, false, false, true, true);
  const emptyState = page.locator('.empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState.getByRole('button')).toHaveCount(1);
  const scans = () => page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins').length);
  const before = await scans();
  await emptyState.getByRole('button', { name: '重新扫描' }).click();
  await expect.poll(scans).toBe(before + 1);
  await expect(emptyState.getByRole('button', { name: '安装插件' })).toHaveCount(0);
});
