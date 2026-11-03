import { expect, test, type Page } from '@playwright/test';
import { installConfigurationProtocol, setupConfigurationWorkspace } from './configuration-workspace-fixture';

/** Synthetic IPC only: covers the connection workspace interaction affordances. */
async function mockWorkspace(page: Page, count = 20, options: { stale?: boolean; projects?: unknown[] } = {}) {
  await page.addInitScript(({ count, stale, projects }) => {
    const applied = { id: 'p0' };
    const profiles = Array.from({ length: count }, (_, index) => ({ id: `p${index}`, tool: 'claude_code', name: index === 0 ? 'Plan A' : `配置 ${index}`, version: 1, revision: String(index), inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: index === 3 ? { providerId: 'glm', interfaceFormat: 'anthropic_messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3', secretRef: null, authEnvVar: null } : null }));
    const appliedBinding = () => {
      const version = stale ? 0 : 1;
      return { scopeKey: 'global', tool: 'claude_code', profileId: applied.id, profileVersion: version, appliedProfileAvailable: true, appliedSummary: { profileVersion: version, profileRevision: profiles.find(profile => profile.id === applied.id)!.revision, authentication: { kind: 'native' }, contextId: null, providerId: null, baseUrl: null, model: null }, commonVersion: null, commonRevision: null, managed: {} };
    };
    // A project scope with its own path has no independent binding in this fixture.
    const workspace = (scope: string, projectPath: string | null) => ({
      probe: { selectedPath: 'C:/claude.cmd', installations: [{ path: 'C:/claude.cmd', version: '2.1.284', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
      profiles, binding: scope === 'project' && projectPath ? null : appliedBinding(), snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { profileId?: string; scope?: string; projectPath?: string | null }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'], management: { accounts: false, mcp: true, skills: true, agents: false, plugins: false } }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects') return projects;
        if (command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return workspace(args?.scope ?? 'global', args?.projectPath ?? null);
        if (command === 'apply_registered_native_profile') { applied.id = args?.profileId ?? applied.id; ((window as unknown as { __applyCalls?: string[] }).__applyCalls ??= []).push(applied.id); return { transactionId: '1', changedFiles: [], status: 'written_for_next_session' }; }
        if (command === 'inspect_registered_native_draft') return { connection: null, reasoningEffort: null };
        return null;
      } },
    });
  }, { count, stale: !!options.stale, projects: options.projects ?? [] });
  await installConfigurationProtocol(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
}

test('configuration search matches models, explains an empty result and clears with Escape', async ({ page }) => {
  await mockWorkspace(page);
  const items = page.getByRole('list', { name: '配置项' });
  const search = page.getByLabel('搜索配置');
  await search.fill('glm-5.3');
  await expect(items.getByRole('listitem')).toHaveCount(1);
  await expect(items.getByRole('listitem')).toContainText('配置 3');
  await search.fill('不存在的配置');
  await expect(items.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('没有匹配“不存在的配置”的配置。')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(items.getByRole('listitem')).toHaveCount(20);
  await search.fill('配置 12');
  await expect(items.getByRole('listitem')).toHaveCount(1);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(items.getByRole('listitem')).toHaveCount(20);
});

test('the configuration board states the applied profile of the current scope', async ({ page }) => {
  await mockWorkspace(page, 3);
  const region = page.getByRole('region', { name: '工具与连接' });
  const live = region.locator('[data-tools-live]');
  await expect(live).toContainText('当前生效');
  await expect(live).toContainText('Plan A');
  await expect(live).toHaveAttribute('data-live-profile', 'p0');
  await expect(live).toHaveAttribute('data-live-state', 'applied');
  await expect(live).toHaveAttribute('data-live-tone', 'success');
  await expect(page.locator('[data-profile-id="p0"]')).toHaveAttribute('data-active', 'true');
  const liveStyle = await live.evaluate((node) => {
    const style = getComputedStyle(node);
    const dot = getComputedStyle(node.querySelector('span')!);
    return { display: style.display, background: style.backgroundColor, dot: dot.backgroundColor };
  });
  expect(liveStyle.display).toBe('flex');
  expect(liveStyle.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(liveStyle.dot).not.toBe('rgba(0, 0, 0, 0)');
  // Applying a row moves that statement with the binding instead of leaving a stale name.
  await page.locator('[data-profile-id="p1"]').getByRole('button', { name: '使用', exact: true }).click();
  await expect(live).toHaveAttribute('data-live-profile', 'p1');
  await expect(live).toContainText('配置 1');
  // The statement follows the binding instead of staying a stale success.
  await expect(live).toHaveAttribute('data-live-state', 'applied');
  await expect(live).toHaveAttribute('data-live-tone', 'success');
  await expect(live).not.toContainText('Plan A');
});

test('a stale binding is reported as no longer in effect, never as in effect', async ({ page }) => {
  await mockWorkspace(page, 3, { stale: true });
  const live = page.getByRole('region', { name: '工具与连接' }).locator('[data-tools-live]');
  await expect(live).toHaveAttribute('data-live-tone', 'warning');
  await expect(live).toHaveAttribute('data-live-state', 'invalid');
  await expect(live).toContainText('已失效');
  await expect(live).toContainText('Plan A');
  await expect(live).not.toContainText('当前生效');
  await expect(live).toHaveAttribute('title', '应用的记录与当前配置不一致（版本、公共配置或绑定已失效），需要重新应用。');
  // The row judgement is the same fact: no active row and no green dot.
  const row = page.locator('[data-profile-id="p0"]');
  await expect(row).not.toHaveAttribute('data-active', 'true');
  await expect(row).toContainText('已保存，待使用');
  const dot = await live.evaluate((node) => getComputedStyle(node.querySelector('span')!).backgroundColor);
  expect(dot).toBe(await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--warning)';
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }));
});

test('a stale binding offers to apply the same configuration again from the live strip', async ({ page }) => {
  await mockWorkspace(page, 3, { stale: true });
  const live = page.getByRole('region', { name: '工具与连接' }).locator('[data-tools-live]');
  await expect(live).toHaveAttribute('data-live-state', 'invalid');
  await live.getByRole('button', { name: '重新应用', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __applyCalls?: string[] }).__applyCalls ?? [])).toEqual(['p0']);
});

test('a project scope without its own binding says so and never claims a configuration', async ({ page }) => {
  await mockWorkspace(page, 3, { projects: [{ id: 'project-1', name: '测试项目', path: '/tmp/project', available: true, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }] });
  const live = page.getByRole('region', { name: '工具与连接' }).locator('[data-tools-live]');
  await expect(live).toHaveAttribute('data-live-tone', 'success');
  const appliedDot = await live.evaluate((node) => getComputedStyle(node.querySelector('span')!).backgroundColor);
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  await expect(live).toHaveAttribute('data-live-state', 'project_unbound');
  await expect(live).toHaveAttribute('data-live-tone', 'neutral');
  await expect(live).toContainText('未设置项目绑定');
  await expect(live).toHaveAttribute('data-live-profile', '');
  await expect(live).not.toContainText('当前生效');
  await expect(live).not.toContainText('Plan A');
  // The tone is a real paint, not only an attribute.
  expect(await live.evaluate((node) => getComputedStyle(node.querySelector('span')!).backgroundColor)).not.toBe(appliedDot);
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '全局配置' }).click();
  await expect(live).toHaveAttribute('data-live-state', 'applied');
  await expect(live).toHaveAttribute('data-live-tone', 'success');
  await expect(live).toContainText('Plan A');
});

test('the configuration board stays inside a 640px window and keeps row actions reachable', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await mockWorkspace(page, 8);
  const region = page.getByRole('region', { name: '工具与连接' });
  await expect(region.getByLabel('配置列表')).toBeVisible();
  const row = page.locator('[data-profile-id="p0"]');
  await expect(row.locator('[data-tools-row-actions]')).toBeVisible();
  const actions = await row.locator('[data-tools-row-actions]').boundingBox();
  const viewport = page.viewportSize()!;
  expect(actions!.x + actions!.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('row menu supports keyboard navigation and returns focus to its trigger', async ({ page }) => {
  await mockWorkspace(page, 3);
  const trigger = page.getByRole('button', { name: '配置 1 更多操作' });
  await trigger.click();
  const menu = page.getByRole('menu', { name: '配置 1 更多操作' });
  await expect(menu.getByRole('menuitem', { name: '复制配置' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '添加额度查询' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: '删除配置' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '复制配置' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a success notice can be dismissed', async ({ page }) => {
  await mockWorkspace(page, 3);
  await page.locator('[data-profile-id="p1"]').getByRole('button', { name: '使用', exact: true }).click();
  const notice = page.getByRole('status').filter({ hasText: '已使用保存的配置' });
  await expect(notice).toBeVisible();
  await page.getByRole('button', { name: '关闭提示' }).click();
  await expect(notice).toHaveCount(0);
});

test('MCP and Skill tabs share one heading and one add action in the head and empty state', async ({ page }) => {
  await mockWorkspace(page, 1);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('region', { name: 'MCP 服务器' })).toBeVisible();
  await expect(page.getByText('MCP 服务器', { exact: true })).toBeVisible();
  await expect(page.getByText('这个 CLI 还没有生效的 MCP')).toBeVisible();
  // The empty state embeds an entry with the same action as the head button.
  await expect(page.getByRole('button', { name: '添加 MCP', exact: true })).toHaveCount(2);
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Skill', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Skill', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加 Skill', exact: true })).toHaveCount(2);
});

test('configuration dialog names the profile, marks the preview tab and reports draft state', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.getByRole('button', { name: '修改', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: /^修改配置 · / });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('没有未保存的修改', { exact: true })).toBeVisible();
  await dialog.getByLabel('配置名称').fill('改名后的配置');
  await expect(dialog.getByText('有未保存的修改', { exact: true })).toBeVisible();
  await dialog.getByLabel('配置名称').fill('');
  await expect(dialog.getByLabel('配置名称')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('配置名称').fill('改名后的配置');
  await dialog.getByRole('button', { name: '合并与来源', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '合并与来源', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '连接与模型', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog.getByRole('textbox', { name: '合并配置预览' })).toBeVisible();
});

test('blocking draft issues are summarized in the footer and lead to the problem list', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'claude_code');
  await page.evaluate(() => { (window as any).configurationProtocol.commonFiles = { settings: '{"effortLevel":"high"}', local_settings: '{}' }; });
  await page.getByRole('button', { name: '通用配置', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '原生文本', exact: true }).click();
  await dialog.getByRole('button', { name: 'local_settings', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'local_settings 配置草稿' }).fill('{"model":"sonnet"}');
  const summary = dialog.getByRole('button', { name: /项待完成 · 查看$/ });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(dialog.getByRole('alert').filter({ hasText: '通用配置不允许模型引用' })).toBeInViewport();
});

/** Synthetic IPC only: a remote target keeps its own tool store and exposes no binding record. */
async function mockRemoteWorkspace(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('cliora:remote-target', 'host-live');
    const host = { id: 'host-live', name: '远程主机', host: '203.0.113.10', port: 22, user: 'root', authMethod: 'key', identityFile: '', sshConfig: null, defaultPath: '/src/project', enabled: true, createdAt: 1, updatedAt: 1 };
    const profile = { id: 'remote-profile', tool: 'claude_code', name: '网关', version: 1, revision: 'rev', inheritCommon: false, files: { settings: '{}' }, suppressed: {}, connection: null, nativeCredentials: {} };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system', remote_ssh_enabled: true }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' }, management: { accounts: true, mcp: true, skills: true, agents: true, plugins: true, projectPlugins: true }, remoteNativeFiles: [{ role: 'settings', relative: '.claude/settings.json', format: 'json', scope: 'global' }] }], managedIds: ['claude_code'], preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'probe_remote_cli') return { targetId: host.id, toolId: 'claude_code', executable: 'claude', installed: true, version: '2.1.314', detail: null };
          if (command === 'get_remote_tool_store') return { profiles: [profile], common: null, currentFiles: { settings: '{}' } };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          if (['list_remote_projects', 'list_projects', 'list_accounts', 'list_mcp_definitions', 'list_skill_packages', 'list_skill_recovery_issues', 'scan_native_skills', 'list_native_mcp'].includes(command)) return [];
          return null;
        },
      },
    });
  });
  await installConfigurationProtocol(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
}

test('a remote target is unconfirmed instead of empty or in effect', async ({ page }) => {
  await mockRemoteWorkspace(page);
  const live = page.getByRole('region', { name: '工具与连接' }).locator('[data-tools-live]');
  await expect(live).toHaveAttribute('data-live-state', 'unconfirmed');
  await expect(live).toHaveAttribute('data-live-tone', 'unknown');
  await expect(live).toContainText('无法确认');
  await expect(live).toContainText('远程目标没有绑定记录');
  await expect(live).toHaveAttribute('data-live-profile', '');
  await expect(live).not.toContainText('当前作用域还没有应用配置');
  await expect(live).not.toContainText('当前生效');
  // No green dot: the unknown tone paints an outline instead of the success fill.
  const dot = await live.evaluate((node) => {
    const style = getComputedStyle(node.querySelector('span')!);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  expect(dot.background).toBe('rgba(0, 0, 0, 0)');
  expect(dot.shadow).toContain('inset');
});
