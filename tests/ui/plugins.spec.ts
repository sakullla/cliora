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
  await page.getByRole('listitem').getByRole('button').click();
  await expect(page.getByRole('article', { name: '插件详情' }).getByRole('button', { name: '卸载', exact: true })).toBeDisabled();
});

/** Install lives in a dialog opened from the list header's + button. */
async function openInstall(page: Page) {
  await page.getByRole('button', { name: '安装新插件', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '安装新插件' })).toBeVisible();
}
async function closeInstall(page: Page) {
  await page.getByRole('dialog', { name: '安装新插件' }).getByRole('button', { name: '取消', exact: true }).click();
}

async function setup(page: Page, deferFull = false, deferWorkspace = false, deferContext = deferWorkspace, catalog = false, extended = false, noPreview = false, emptyEntries = false, installless = false, updateOnly = false, toolId = 'claude_code', initialScanFailure = false) {
  const extendedPath = String.raw`\\?\C:\Users\fixture\.grok\plugins\example-dev`;
  const extendedResource = String.raw`\\?\UNC\server\share\plugins\example-dev\agents`;
  await page.addInitScript(({ holdFull, holdWorkspace, holdContext, catalog, extended, noPreview, emptyEntries, installless, updateOnly, toolId, initialScanFailure, extendedPath, extendedResource }) => {
    const entry = { id: 'fixture@market', name: 'Fixture plugin', source: 'fixture@market', version: '1.0.0', scope: 'user', enabled: true, state: 'installed_load_unknown', policy: 'AVAILABLE · ON_INSTALL', readOnly: false, root: '/fixture/plugins/fixture', resources: [{ kind: 'agents', path: '/fixture/plugins/fixture/agents', ownerId: 'fixture@market' }] };
    const state = { calls: [] as any[], entries: emptyEntries ? [] : [entry, { ...entry, id: 'required@market', name: 'Organization plugin', policy: 'REQUIRED', readOnly: true }], fail: false, releaseFull: null as (() => void) | null, releaseWorkspace: null as (() => void) | null, releaseContext: null as (() => void) | null, contextId: 'ctx-fixture', baseline: 'fixture-baseline', failScan: initialScanFailure, holdFirstOperation: false, releaseOperation: null as (() => void) | null, operationCalls: 0, nullOperationSnapshot: false, rewriteInstall: false, holdNextScan: false, releaseNextScan: null as (() => void) | null, inspectCalls: [] as string[], readCalls: [] as string[], revealCalls: [] as Array<string | null>, failInspect: false };
    if (catalog) state.entries.push({ ...entry, id: 'lark@official', name: 'Lark', source: 'lark@official', enabled: null, readOnly: true, state: 'not_installed', policy: '官方市场条目未安装', resources: [] });
    if (extended) state.entries.push({ ...entry, id: 'example-dev', name: 'example-dev', source: extendedPath, root: extendedPath, readOnly: true, resources: [{ kind: 'agents', path: extendedResource, ownerId: 'example-dev' }] });
    const snapshot = (target: any) => ({ target, capability: { version: '2.1.287', sources: 'plugin@marketplace', actions: updateOnly ? ['update'] : installless ? ['enable', 'disable', 'uninstall'] : ['install', 'update', 'enable', 'disable', 'uninstall'], project: true, detail: '重启会话后加载' }, entries: state.entries.map(item => ({ ...item })), baseline: state.baseline, detail: '静态列表，加载未验证' });
    Object.assign(window, { isTauri: true, pluginsHarness: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      state.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [toolId], theme: 'system' }, tools: [{ id: toolId, name: toolId === 'pi' ? 'Pi' : 'Claude Code' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: toolId, name: toolId === 'pi' ? 'Pi' : 'Claude Code', interfaceFormats: ['anthropic_messages'], login: { hint: '原生登录' } }], managedIds: [toolId], preservedUnknown: [] };
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
        return { probe: { tool: toolId, selectedPath: 'C:/claude.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [] }, profiles: [], effectiveContextId: 'ctx-fixture', binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [] };
      }
      if (command === 'preview_native_plugins') {
        if (noPreview) return null;
        if (holdFull) return { ...snapshot(args.target), baseline: '', capability: { ...snapshot(args.target).capability, actions: [] }, entries: emptyEntries ? [] : [{ ...entry, readOnly: true, enabled: null, state: 'inventory_pending' }] };
      }
      if (command === 'scan_native_plugins') {
        if (state.failScan) throw { message: '扫描暂时失败' };
        if (state.holdNextScan) {
          state.holdNextScan = false;
          await new Promise<void>(resolve => { state.releaseNextScan = resolve; });
        }
        if (holdFull) await new Promise<void>(resolve => { state.releaseFull = resolve; });
        return snapshot(args.target);
      }
      if (command === 'inspect_native_plugin') {
        state.inspectCalls.push(args.pluginId);
        if (state.failInspect) throw { message: '读取插件目录失败' };
        const root = '/fixture/plugins/fixture';
        const items = args.pluginId === 'fixture@market' ? [
          { kind: 'agents', name: 'reviewer', description: 'Reviews code', path: `${root}/agents/reviewer.md`, location: `${root}/agents/reviewer.md`, format: 'markdown' },
          { kind: 'agents', name: 'planner', description: null, path: `${root}/agents/planner.md`, location: `${root}/agents/planner.md`, format: 'markdown' },
          { kind: 'skills', name: 'lint-check', description: 'Runs lint', path: `${root}/skills/lint/SKILL.md`, location: `${root}/skills/lint`, format: 'markdown' },
          { kind: 'commands', name: 'review', description: 'Review the current diff', path: `${root}/commands/review.md`, location: `${root}/commands/review.md`, format: 'markdown' },
          { kind: 'mcp', name: 'docs', description: 'npx -y docs-server', path: `${root}/.mcp.json`, location: `${root}/.mcp.json`, format: 'json' },
          { kind: 'hooks', name: 'PreToolUse', description: '2', path: `${root}/hooks/hooks.json`, location: `${root}/hooks/hooks.json`, format: 'json' },
        ] : args.pluginId === 'example-dev' ? [
          { kind: 'agents', name: 'explorer', description: 'Explore', path: `${extendedResource}\\explorer.md`, location: `${extendedResource}\\explorer.md`, format: 'markdown' },
        ] : [];
        return { pluginId: args.pluginId, root, manifest: args.pluginId === 'fixture@market' ? { description: 'Review helpers for pull requests.', author: 'Example Team', homepage: 'https://example.test/fixture', license: 'MIT', keywords: ['review', 'git'], path: `${root}/.claude-plugin/plugin.json` } : { description: null, author: null, homepage: null, license: null, keywords: [], path: null }, items, truncated: false };
      }
      if (command === 'read_native_plugin_file') {
        state.readCalls.push(args.path);
        const content = args.path.endsWith('.json') ? '{\n  "mcpServers": { "docs": { "command": "npx" } }\n}' : '---\nname: reviewer\ndescription: Reviews code\n---\n# Reviewer\n\nRead the diff first.';
        return { path: args.path, content, format: args.path.endsWith('.json') ? 'json' : 'markdown', truncated: false };
      }
      if (command === 'reveal_native_plugin_path') { state.revealCalls.push(args.path ?? null); return null; }
      if (command === 'scan_native_agents') return { target: args.target, capability: { version: '2.1.287', supported: true, format: 'markdown', template: '---\nname: new\n---\n', detail: '下一次委派加载' }, entries: [{ id: 'fixture@market:reviewer', name: 'reviewer', description: 'Reviews code', path: '/fixture/plugins/fixture/agents/reviewer.md', format: 'markdown', content: '---\nname: reviewer\ndescription: Reviews code\n---\nRead the diff first.', enabled: true, readOnly: true, owner: '插件：fixture@market', detail: '' }], baseline: 'agents-baseline', detail: '原生定义管理' };
      if (command === 'operate_native_plugin') {
        const req = args.request;
        if (req.target.contextId !== 'ctx-fixture' || req.baseline !== state.baseline) throw { message: '目标或基线错误' };
        state.operationCalls += 1;
        if (state.holdFirstOperation && state.operationCalls === 1) await new Promise<void>(resolve => { state.releaseOperation = resolve; });
        if (state.fail) return { status: 'failed_possible_side_effects', detail: '原生命令失败；已重新扫描实际状态，未宣称原子回滚', transactionId: null, snapshot: state.nullOperationSnapshot ? null : snapshot(req.target) };
        if (req.action === 'install') state.entries.push(state.rewriteInstall
          ? { ...entry, id: 'cursor-plugin', name: 'Cursor plugin', source: 'C:/Users/fixture/.cursor/plugins/cursor-plugin', root: 'C:/Users/fixture/.cursor/plugins/cursor-plugin' }
          : { ...entry, id: req.source, name: req.source, source: req.source });
        if (req.action === 'disable' || req.action === 'enable') state.entries.find(item => item.id === req.source)!.enabled = req.action === 'enable';
        if (req.action === 'uninstall') state.entries = state.entries.filter(item => item.id !== req.source);
        return { status: 'native_command_completed', detail: '原生命令已完成；现有会话未热加载。已重新扫描', transactionId: null, snapshot: state.nullOperationSnapshot ? null : snapshot(req.target) };
      }
      return null;
    } } });
  }, { holdFull: deferFull, holdWorkspace: deferWorkspace, holdContext: deferContext, catalog, extended, noPreview, emptyEntries, installless, updateOnly, toolId, initialScanFailure, extendedPath, extendedResource });
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
  await expect(card.getByText('已启用', { exact: true })).toBeVisible();
  await card.getByRole('button').click();
  const details = page.getByRole('article', { name: '插件详情' });
  await expect(details.getByText('原生已安装 · 加载未验证')).toBeVisible();
  await expect(details.getByRole('heading', { name: '包含内容' })).toBeVisible();
  await expect(details.getByRole('list', { name: '插件内容' }).getByText('reviewer', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: '禁用', exact: true }).click(); await expect(details.getByRole('button', { name: '启用' })).toBeVisible();
  await details.getByRole('button', { name: '启用' }).click();
  const managed = page.getByRole('listitem').filter({ has: page.getByText('Organization plugin', { exact: true }) });
  await managed.getByRole('button').click();
  await expect(details.getByRole('button', { name: '禁用' })).toBeDisabled(); await expect(details.getByRole('button', { name: '卸载' })).toBeDisabled();
  await openInstall(page);
  await page.getByLabel('插件来源', { exact: true }).fill('second@market'); await expect(page.getByRole('dialog').getByRole('button', { name: '安装插件' })).toBeDisabled();
  await page.getByRole('checkbox').check(); await page.getByRole('dialog').getByRole('button', { name: '安装插件' }).click();
  await expect(page.getByRole('dialog', { name: '安装新插件' })).toHaveCount(0);
  await expect(details.getByRole('heading', { name: 'second@market', exact: true })).toBeVisible();
  await expect(details.getByText('版本', { exact: true })).toBeVisible();
  await card.getByRole('button').click();
  await details.getByRole('button', { name: '更新' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '更新', exact: true }).click();
  await page.screenshot({ path: 'test-results/native-plugins.png', fullPage: true });
  await details.getByRole('button', { name: '卸载' }).click(); await page.getByRole('dialog').getByRole('button', { name: '卸载', exact: true }).click(); await expect(page.getByText('Fixture plugin', { exact: true })).toHaveCount(0);
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
  const readyCard = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await readyCard.getByRole('button').click();
  await expect(page.getByRole('article', { name: '插件详情' }).getByRole('button', { name: '禁用', exact: true })).toBeEnabled();
  await expect(page.getByText('正在核对插件状态', { exact: true })).toHaveCount(0);
});

test('failed native operation retains rescanned state and allows explicit recovery scan', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).pluginsHarness.fail = true; });
  const card = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await card.getByRole('button').click();
  const details = page.getByRole('article', { name: '插件详情' });
  await details.getByRole('button', { name: '禁用' }).click(); await expect(page.getByRole('alert')).toContainText('可能留下部分变更');
  await expect(page.getByRole('alert')).toContainText('原生命令失败；已重新扫描实际状态');
  await expect(details.getByRole('button', { name: '禁用' })).toBeEnabled(); await page.getByRole('button', { name: '重新扫描' }).first().click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((c: any) => c.command === 'scan_native_plugins').length)).toBeGreaterThan(1);
});


for (const failed of [false, true]) {
  test(`${failed ? 'failed' : 'successful'} operation without a rescan snapshot retains stale entries and offers recovery`, async ({ page }) => {
    await setup(page);
    await page.evaluate((failed) => {
      const state = (window as any).pluginsHarness;
      state.fail = failed;
      state.nullOperationSnapshot = true;
    }, failed);
    await page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) }).getByRole('button').click();
    await page.getByRole('article', { name: '插件详情' }).getByRole('button', { name: '禁用', exact: true }).click();
    const stale = page.getByRole('status').filter({ has: page.getByText('列表可能已过期') });
    await expect(stale).toBeVisible();
    await expect(page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) })).toBeVisible();
    await expect(page.getByLabel('插件操作队列')).toContainText(failed ? '失败' : '已完成');
    if (failed) await expect(page.getByRole('alert')).toContainText('可能留下部分变更');
    await stale.getByRole('button', { name: '重新扫描' }).click();
    await expect(page.getByText('列表可能已过期')).toHaveCount(0);
  });
}

test('editing a failed install source requires new trust and retries only the current source', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).pluginsHarness.fail = true; });
  await openInstall(page);
  await page.getByLabel('插件来源', { exact: true }).fill('first@market');
  await page.getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: '安装插件', exact: true }).click();
  const queue = page.getByLabel('插件操作队列');
  await expect(queue).toContainText('安装 · first@market');
  await expect(queue).toContainText('失败');
  const retry = queue.getByRole('button', { name: '重试', exact: true });
  await expect(retry).toBeEnabled();

  await openInstall(page);
  await expect(page.getByLabel('插件来源', { exact: true })).toHaveValue('first@market');
  await page.getByLabel('插件来源', { exact: true }).fill('second@market');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await closeInstall(page);
  await expect(retry).toBeDisabled();
  await page.evaluate(() => { (window as any).pluginsHarness.fail = false; });
  await openInstall(page);
  await page.getByRole('checkbox').check();
  await closeInstall(page);
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(queue).toContainText('安装 · second@market');
  await expect(queue).toContainText('已完成');
  await expect(queue).not.toContainText('安装 · first@market');

  const requests = await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'operate_native_plugin').map((call: any) => call.args.request));
  expect(requests).toHaveLength(2);
  expect(requests.map((request: any) => request.source)).toEqual(['first@market', 'second@market']);
  expect(requests.map((request: any) => request.trusted)).toEqual([true, true]);
});

test('local Cursor install opens the added snapshot entry when its installed path differs', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).pluginsHarness.rewriteInstall = true; });
  await openInstall(page);
  await page.getByLabel('插件来源', { exact: true }).fill('C:/fixture/downloads/cursor-plugin');
  await page.getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: '安装插件' }).click();
  const details = page.getByRole('article', { name: '插件详情' });
  await expect(details.getByRole('heading', { name: 'Cursor plugin', exact: true })).toBeVisible();
  await expect(details.getByText('C:/Users/fixture/.cursor/plugins/cursor-plugin', { exact: true }).first()).toBeVisible();
});

test('an empty preview followed by a failed first scan shows only the load failure', async ({ page }) => {
  await setup(page, true, false, false, false, false, false, true, false, false, 'claude_code', true);
  await expect(page.getByText('暂时无法读取插件', { exact: true })).toBeVisible();
  await expect(page.getByText('还没有已安装的原生插件。')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toHaveCount(1);
  await expect(page.getByText('列表可能已过期')).toHaveCount(0);
});

test('stale rescan is single-flight while its delayed retry is pending', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).pluginsHarness.failScan = true; });
  await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  const stale = page.getByRole('status').filter({ has: page.getByText('列表可能已过期') });
  await expect(stale).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).pluginsHarness;
    state.failScan = false;
    state.holdNextScan = true;
  });
  const retry = stale.getByRole('button', { name: '重新扫描' });
  await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(retry).toBeDisabled();
  const scans = () => page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins').length);
  expect(await scans()).toBe(3);
  await page.evaluate(() => (window as any).pluginsHarness.releaseNextScan());
  await expect(page.getByText('列表可能已过期')).toHaveCount(0);
  expect(await scans()).toBe(3);
});

test('Pi project plugin details visibly explain why update is unavailable', async ({ page }) => {
  await setup(page, false, false, false, false, false, false, false, false, false, 'pi');
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  await page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) }).getByRole('button').click();
  const details = page.getByRole('article', { name: '插件详情' });
  await expect(details.getByRole('button', { name: '更新', exact: true })).toBeDisabled();
  await expect(details.getByText('这个工具的项目插件请在原生 CLI 里更新', { exact: true })).toBeVisible();
});

test('changing plugin scope clears the previous source trust before a project operation', async ({ page }) => {
  await setup(page);
  await openInstall(page);
  await page.getByLabel('插件来源', { exact: true }).fill('second@market');
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('dialog').getByRole('button', { name: '安装插件' })).toBeEnabled();
  await closeInstall(page);
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  await openInstall(page);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByLabel('插件来源', { exact: true }).fill('second@market');
  await expect(page.getByRole('dialog').getByRole('button', { name: '安装插件' })).toBeDisabled();
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
  const card = page.getByRole('listitem').filter({ has: page.getByText('example-dev', { exact: true }) });
  const drive = 'C:\\Users\\fixture\\.grok\\plugins\\example-dev';
  await expect(card.getByText(`${drive} · 全局`)).toBeVisible();
  await expect(card).not.toContainText('\\\\?\\');
  await card.getByRole('button').click();
  const details = page.getByRole('article', { name: '插件详情' });
  await expect(details.getByText('安装位置', { exact: true })).toBeVisible();
  await expect(details.getByText(drive, { exact: true }).first()).toBeVisible();
  const explorer = details.getByRole('list', { name: '插件内容' }).getByRole('button', { name: /explorer/ });
  await expect(explorer).toHaveAttribute('title', '\\\\server\\share\\plugins\\example-dev\\agents\\explorer.md');
  const market = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await expect(market.getByText('fixture@market · 全局')).toBeVisible();
});

test('uninstalled catalog rows stay out of the installed plugin count', async ({ page }) => {
  await setup(page, false, false, false, true);
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  await expect(page.getByText('2 个插件')).toBeVisible();
  await expect(page.locator('.empty-state')).toHaveCount(0);
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


test('update-only capability does not render an install form', async ({ page }) => {
  await setup(page, false, false, false, false, false, false, false, false, true);
  await expect(page.getByLabel('插件来源', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '安装插件' })).toHaveCount(0);
  await page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) }).getByRole('button').click();
  await expect(page.getByRole('article', { name: '插件详情' }).getByRole('button', { name: '更新', exact: true })).toBeVisible();
});

test('invalid install source explains the problem and cannot be submitted', async ({ page }) => {
  await setup(page);
  await openInstall(page);
  await page.getByLabel('插件来源', { exact: true }).fill('-unsafe');
  await page.getByRole('checkbox').check();
  await expect(page.getByText('来源不能以连字符开头。')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '安装插件' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'operate_native_plugin'))).toEqual([]);
});

test('failed manual rescan keeps the previous list stale until recovery', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).pluginsHarness.failScan = true; });
  await page.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.getByText('列表可能已过期')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) })).toBeVisible();
  await page.evaluate(() => { (window as any).pluginsHarness.failScan = false; });
  await page.getByRole('status').filter({ has: page.getByText('列表可能已过期') }).getByRole('button', { name: '重新扫描' }).click();
  await expect(page.getByText('列表可能已过期')).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) })).toBeVisible();
});

test('different plugin operations run serially and queued work uses the latest baseline', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const state = (window as any).pluginsHarness;
    state.holdFirstOperation = true;
    state.entries.push({ ...state.entries[0], id: 'second@market', name: 'Second plugin', source: 'second@market' });
  });
  const fixture = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  const second = page.getByRole('listitem').filter({ has: page.getByText('Second plugin', { exact: true }) });
  const details = page.getByRole('article', { name: '插件详情' });
  await fixture.getByRole('button').click();
  await details.getByRole('button', { name: '禁用', exact: true }).click();
  await expect(details.getByRole('button', { name: '禁用', exact: true })).toBeDisabled();
  await second.getByRole('button').click();
  await details.getByRole('button', { name: '禁用', exact: true }).click();
  await expect(page.getByLabel('插件操作队列')).toContainText('排队中');
  const rescan = page.getByRole('button', { name: '重新扫描', exact: true });
  await expect(rescan).toBeDisabled();
  const scansBefore = await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins').length);
  await rescan.evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'scan_native_plugins').length)).toBe(scansBefore);
  expect(await page.evaluate(() => (window as any).pluginsHarness.operationCalls)).toBe(1);
  await page.evaluate(() => { const state = (window as any).pluginsHarness; state.baseline = 'latest-baseline'; state.releaseOperation(); });
  await expect.poll(() => page.evaluate(() => (window as any).pluginsHarness.operationCalls)).toBe(2);
  await expect(page.getByLabel('插件操作队列')).toContainText('已完成');
  const requests = await page.evaluate(() => (window as any).pluginsHarness.calls.filter((call: any) => call.command === 'operate_native_plugin').map((call: any) => call.args.request));
  expect(requests.map((request: any) => request.baseline)).toEqual(['fixture-baseline', 'latest-baseline']);
});

test('changing context cancels queued plugin operations and ignores the running result', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const state = (window as any).pluginsHarness;
    state.holdFirstOperation = true;
    state.entries.push({ ...state.entries[0], id: 'second@market', name: 'Second plugin', source: 'second@market' });
  });
  const details = page.getByRole('article', { name: '插件详情' });
  await page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) }).getByRole('button').click();
  await details.getByRole('button', { name: '禁用', exact: true }).click();
  await page.getByRole('listitem').filter({ has: page.getByText('Second plugin', { exact: true }) }).getByRole('button').click();
  await details.getByRole('button', { name: '禁用', exact: true }).click();
  await expect(page.getByLabel('插件操作队列')).toContainText('排队中');
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  await page.evaluate(() => (window as any).pluginsHarness.releaseOperation());
  await expect(page.getByLabel('插件操作队列')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pluginsHarness.operationCalls)).toBe(1);
});

test('catalog-only and filtered-empty states stay distinct', async ({ page }) => {
  await setup(page, false, false, false, true, false, false, true);
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Lark', { exact: true }) })).toBeVisible();
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await expect(page.getByText('0 个插件')).toBeVisible();
  await page.getByLabel('搜索插件').fill('no-match');
  await expect(page.getByText('没有匹配的插件。')).toBeVisible();
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
});

test('resource list opens the next plugin from the keyboard and returns to that row', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await setup(page);
  const rows = page.getByRole('list', { name: '插件' }).getByRole('button');
  await rows.first().focus();
  await rows.first().press('ArrowDown');
  await expect(page.getByRole('article', { name: '插件详情' }).getByRole('heading', { name: 'Organization plugin', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page.getByRole('article', { name: '插件详情' })).toHaveCount(0);
  await expect(rows.nth(1)).toBeFocused();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`plugin workspace stays within the viewport at target widths in ${colorScheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await setup(page);
    for (const width of [1360, 900, 640]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const back = page.getByRole('button', { name: '返回列表' });
      // A document opened on a wide layout fills the pane once the page is narrow, so the list is hidden until the user goes back.
      if (await back.isVisible()) await back.click();
      await page.getByRole('list', { name: '插件' }).getByRole('button').first().click();
      await expect(page.getByRole('article', { name: '插件详情' })).toBeVisible();
      if (await back.isVisible()) await back.click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
}

async function openFixture(page: Page) {
  await page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) }).getByRole('button').first().click();
  const details = page.getByRole('article', { name: '插件详情' });
  await expect(details.getByRole('list', { name: '插件内容' })).toBeVisible();
  return details;
}

test('plugin details list bundled contents and filter them by kind', async ({ page }) => {
  await setup(page);
  const details = await openFixture(page);
  await expect(details.getByText('Review helpers for pull requests.')).toBeVisible();
  const items = details.getByRole('list', { name: '插件内容' });
  await expect(items.getByRole('listitem')).toHaveCount(6);
  await expect(items.getByText('2 个处理器')).toBeVisible();
  const filter = details.getByRole('group', { name: '按类型筛选' });
  await filter.getByRole('button', { name: /^Skill/ }).click();
  await expect(filter.getByRole('button', { name: /^Skill/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(items.getByRole('listitem')).toHaveCount(1);
  await expect(items.getByText('lint-check', { exact: true })).toBeVisible();
  await filter.getByRole('button', { name: /^全部/ }).click();
  await expect(items.getByRole('listitem')).toHaveCount(6);
  expect(await page.evaluate(() => (window as any).pluginsHarness.inspectCalls)).toContain('fixture@market');
});

test('bundled files open in a read-only preview, reveal through the backend and return to the plugin', async ({ page }) => {
  await setup(page);
  const details = await openFixture(page);
  const items = details.getByRole('list', { name: '插件内容' });
  await items.getByRole('button', { name: /reviewer/ }).first().click();
  await expect(page.getByText('Read the diff first.')).toBeVisible();
  await page.getByRole('button', { name: '在文件夹中显示' }).click();
  expect(await page.evaluate(() => (window as any).pluginsHarness.revealCalls)).toEqual(['/fixture/plugins/fixture/agents/reviewer.md']);
  await page.getByRole('button', { name: '返回插件' }).click();
  await items.getByRole('button', { name: /docs/ }).first().click();
  await expect(page.getByRole('textbox', { name: /docs/ })).toContainText('mcpServers');
  expect(await page.evaluate(() => (window as any).pluginsHarness.readCalls)).toEqual(['/fixture/plugins/fixture/agents/reviewer.md', '/fixture/plugins/fixture/.mcp.json']);
  await page.getByRole('button', { name: '返回插件' }).click();
  await expect(details.getByRole('list', { name: '插件内容' })).toBeVisible();
});

test('a bundled agent opens in Agents and its owner link returns to the plugin', async ({ page }) => {
  await setup(page);
  const details = await openFixture(page);
  const reviewer = details.getByRole('list', { name: '插件内容' }).getByRole('listitem').filter({ hasText: 'reviewer' });
  await reviewer.getByRole('button', { name: '在 Agents 中打开' }).click();
  await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true');
  const agent = page.getByRole('article', { name: 'reviewer' });
  await expect(agent).toBeVisible();
  await agent.getByRole('button', { name: '查看所属插件' }).click();
  await expect(page.getByRole('tab', { name: '插件', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('article', { name: '插件详情' }).getByRole('heading', { name: 'Fixture plugin', exact: true })).toBeVisible();
});

test('a failed contents read explains the problem and retries', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).pluginsHarness.failInspect = true; });
  await page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) }).getByRole('button').first().click();
  const details = page.getByRole('article', { name: '插件详情' });
  const alert = details.getByRole('alert').filter({ hasText: '暂时无法读取插件内容' });
  await expect(alert).toContainText('读取插件目录失败');
  await page.evaluate(() => { (window as any).pluginsHarness.failInspect = false; });
  await alert.getByRole('button', { name: '重试' }).click();
  await expect(details.getByRole('list', { name: '插件内容' }).getByRole('listitem')).toHaveCount(6);
});
