import { expect, test, type Page } from '@playwright/test';
import { installConfigurationProtocol, setupConfigurationWorkspace } from './configuration-workspace-fixture';

/** Synthetic IPC only: covers the connection workspace interaction affordances. */
async function mockWorkspace(page: Page, count = 20) {
  await page.addInitScript((count) => {
    const applied = { id: 'p0' };
    const profiles = Array.from({ length: count }, (_, index) => ({ id: `p${index}`, tool: 'claude_code', name: index === 0 ? 'Kimi For Coding' : `配置 ${index}`, version: 1, revision: String(index), inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: index === 3 ? { providerId: 'glm', interfaceFormat: 'anthropic_messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3', secretRef: null, authEnvVar: null } : null }));
    const workspace = () => ({
      probe: { selectedPath: 'C:/claude.cmd', installations: [{ path: 'C:/claude.cmd', version: '2.1.284', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
      profiles, binding: { scopeKey: 'global', tool: 'claude_code', profileId: applied.id, profileVersion: 1, appliedProfileAvailable: true, appliedSummary: { profileVersion: 1, profileRevision: profiles.find(profile => profile.id === applied.id)!.revision, authentication: { kind: 'native' }, contextId: null, providerId: null, baseUrl: null, model: null }, commonVersion: null, commonRevision: null, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { profileId?: string }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'], management: { accounts: false, mcp: true, skills: true, agents: false, plugins: false } }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return workspace();
        if (command === 'apply_registered_native_profile') { applied.id = args?.profileId ?? applied.id; return { transactionId: '1', changedFiles: [], status: 'written_for_next_session' }; }
        if (command === 'inspect_registered_native_draft') return { connection: null, reasoningEffort: null };
        return null;
      } },
    });
  }, count);
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

test('row menu supports keyboard navigation and returns focus to its trigger', async ({ page }) => {
  await mockWorkspace(page, 3);
  const trigger = page.getByRole('button', { name: '配置 1 更多操作' });
  await trigger.click();
  const menu = page.getByRole('menu', { name: '配置 1 更多操作' });
  await expect(menu.getByRole('menuitem', { name: '修改配置' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '复制配置' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: '删除配置' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '修改配置' })).toBeFocused();
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

test('MCP and Skill tabs share one heading and a single add action', async ({ page }) => {
  await mockWorkspace(page, 1);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP 服务器' })).toBeVisible();
  await expect(page.getByText('这个 CLI 还没有生效的 MCP')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加 MCP', exact: true })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Skill', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加 Skill', exact: true })).toHaveCount(1);
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
