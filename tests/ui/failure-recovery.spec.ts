import { expect, test, type Locator, type Page } from '@playwright/test';
import { openCli } from './cli-switcher';

// R3: when a capability read fails, the error and its recovery control stay on the page instead of
// being folded into a row menu (02 ADR-2/ADR-7).

async function install(page: Page) {
  await page.addInitScript(() => {
    const state = { fail: true, calls: 0 };
    const workspace = (toolId: string) => ({
      probe: { tool: toolId, selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] },
      profiles: [{ id: 'daily', tool: toolId, name: '日常', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: null }],
      binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    Object.assign(window, { isTauri: true, __probe: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false } }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'get_registered_tool_workspace') {
        state.calls += 1;
        if (state.fail) throw { message: '找不到 Codex 可执行文件' };
        return workspace(args.toolId);
      }
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_') || command === 'usage_presets') return [];
      return null;
    } } });
  });
}

const heal = (page: Page) => page.evaluate(() => { (window as unknown as { __probe: { fail: boolean } }).__probe.fail = false; });

/** Visible, enabled, and not inside any menu. */
async function expectDirect(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  expect(await control.evaluate((el) => !!el.closest('[role="menu"]'))).toBe(false);
}

test('a failed home probe keeps the error, 重新检测 and 编辑配置 on the row', async ({ page }) => {
  await install(page);
  await page.goto('/');
  const tools = page.getByLabel('受管理工具', { exact: true });
  const row = tools.locator('[data-tool-row]').filter({ hasText: 'Codex' });
  const alert = tools.getByRole('alert');
  await expect(alert).toContainText('Codex 检测失败');
  await expect(alert).toContainText('找不到 Codex 可执行文件');
  await expectDirect(row.getByRole('button', { name: '重新检测', exact: true }));
  await expectDirect(row.getByRole('button', { name: '编辑配置 →', exact: true }));

  await heal(page);
  await row.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(row.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  // Once healthy, the edit entry moves back into the row menu.
  await expect(row.getByRole('button', { name: '编辑配置 →', exact: true })).toHaveCount(0);
});

test('a failed tool workspace read shows the error and a direct retry on the tools page', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await openCli(page, 'Codex');
  const region = page.getByRole('region', { name: '工具' });
  await expect(region.getByText('配置读取失败', { exact: true })).toBeVisible();
  // The read failure uses the same empty surface as the MCP / Skill / Agent / Plugin tabs.
  await expect(region.locator('.empty-state')).toHaveCount(1);
  await expect(page.getByText('找不到 Codex 可执行文件').first()).toBeVisible();
  const retry = region.getByRole('button', { name: '重试读取配置', exact: true });
  await expectDirect(retry);
  await expect(page.getByRole('menu')).toHaveCount(0);

  await heal(page);
  await retry.click();
  await expect(region.getByLabel('配置列表')).toBeVisible();
  await expect(region.getByRole('button', { name: '日常', exact: true })).toBeVisible();
  await expect(region.getByText('配置读取失败', { exact: true })).toHaveCount(0);
});

// Home remote reads and directory actions: a failure is never shown as an empty host or hidden in a
// closed editor, and the recovery control sits next to the message.
async function installHomeRemote(page: Page) {
  await page.addInitScript(() => {
    const hosts = [
      { id: 'host-a', name: '主机 A', host: '10.0.0.2', port: 22, user: 'dev', authMethod: 'key', enabled: true, createdAt: 1, updatedAt: 1 },
      { id: 'host-b', name: '主机 B', host: '10.0.0.3', port: 2222, user: 'ops', authMethod: 'key', enabled: true, createdAt: 1, updatedAt: 1 },
    ];
    localStorage.setItem('cliora:remote-target', 'host-a');
    const state = { failRemote: true, remoteReads: 0, failOpen: true, opens: 0, launches: 0, remote: [
      { id: 'ra', targetId: 'host-a', name: '远程仓库', path: '/srv/repo', preferredTool: 'codex', updatedAt: 1 },
      { id: 'rb', targetId: 'host-b', name: '运维脚本', path: '/opt/ops/scripts', preferredTool: 'codex', updatedAt: 1 },
    ] };
    Object.assign(window, { isTauri: true, __home: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: true }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal' }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'list_remote_targets') return hosts;
      if (command === 'list_remote_projects') {
        state.remoteReads += 1;
        if (state.failRemote) throw { message: 'ssh: connect to host 10.0.0.2 port 22: Connection timed out' };
        return state.remote;
      }
      if (command === 'list_projects') return [{ id: 'demo', name: 'Demo', path: 'C:/demo', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
      if (command === 'open_project_directory') { state.opens += 1; if (state.failOpen) throw { message: '系统找不到指定的路径' }; return null; }
      if (command === 'launch_cli') { state.launches += 1; return { mode: 'normal', status: 'terminal_requested' }; }
      if (command === 'probe_remote_clis') return (args.toolIds as string[]).map((toolId) => ({ targetId: args.targetId, toolId, executable: toolId, installed: true, version: '1.0.0', detail: null }));
      if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [], cliMode: 'normal', projectMode: 'normal' };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_')) return [];
      return null;
    } } });
  });
}

type HomeState = { failRemote: boolean; remoteReads: number; failOpen: boolean; opens: number; launches: number };
const homeState = (page: Page) => page.evaluate(() => (window as unknown as { __home: HomeState }).__home);
const setHome = (page: Page, patch: Partial<HomeState>) => page.evaluate((value) => Object.assign((window as unknown as { __home: HomeState }).__home, value), patch);

test('a failed remote project read is not an empty host, and retry reads the host again', async ({ page }) => {
  await installHomeRemote(page);
  await page.goto('/');
  const projects = page.getByRole('region', { name: '项目与启动' });
  const alert = projects.locator('[data-remote-read]');
  await expect(alert).toHaveAttribute('data-remote-read', 'failed');
  await expect(alert).toContainText('无法读取「主机 A」的远程项目');
  await expect(alert).toContainText('Connection timed out');
  await expect(projects).not.toContainText('还没有项目');
  const retry = alert.getByRole('button', { name: '重新读取远程项目', exact: true });
  await expectDirect(retry);

  // A retry that fails again says so instead of looking unchanged.
  const before = (await homeState(page)).remoteReads;
  await retry.click();
  await expect(alert).toContainText('再次读取仍然失败');
  expect((await homeState(page)).remoteReads).toBe(before + 1);

  await setHome(page, { failRemote: false });
  await retry.click();
  await expect(projects.locator('[data-project-id="remote:ra"]')).toBeVisible();
  await expect(projects.locator('[data-remote-read]')).toHaveCount(0);
  // Only this host's projects are listed.
  await expect(projects.locator('[data-project-id="remote:rb"]')).toHaveCount(0);
  expect((await homeState(page)).launches).toBe(0);
});

test('a failed remote refresh keeps the last good list and marks it stale', async ({ page }) => {
  await installHomeRemote(page);
  await page.addInitScript(() => { (window as unknown as { __home: { failRemote: boolean } }).__home.failRemote = false; });
  await page.goto('/');
  const projects = page.getByRole('region', { name: '项目与启动' });
  await expect(projects.locator('[data-project-id="remote:ra"]')).toBeVisible();
  await setHome(page, { failRemote: true });
  // Entering the other host re-reads remote projects; the failure keeps the earlier list.
  await page.locator('.sidebar-host button').first().click();
  await page.getByRole('menuitemradio', { name: /主机 B/ }).click();
  const alert = projects.locator('[data-remote-read]');
  await expect(alert).toHaveAttribute('data-remote-read', 'stale');
  await expect(alert).toContainText('「主机 B」的远程项目刷新失败');
  await expect(projects.locator('[data-project-id="remote:rb"]')).toBeVisible();
  await expect(projects.locator('[data-project-id="remote:rb"] [class*="contextHost"]')).toHaveText('ops@10.0.0.3:2222');
  await setHome(page, { failRemote: false });
  await alert.getByRole('button', { name: '重新读取远程项目', exact: true }).click();
  await expect(projects.locator('[data-remote-read]')).toHaveCount(0);
  await expect(projects.locator('[data-project-id="remote:rb"]')).toBeVisible();
});

test('opening a directory from the card or the editor shows its failure where it was triggered', async ({ page }) => {
  await installHomeRemote(page);
  await page.addInitScript(() => localStorage.setItem('cliora:remote-target', 'local'));
  await page.goto('/');
  const card = page.getByRole('region', { name: '项目与启动' }).locator('[data-project-id="demo"]');
  await card.getByRole('button', { name: 'Demo 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '打开Demo的目录', exact: true }).click();
  const cardAlert = card.getByRole('alert');
  await expect(cardAlert).toContainText('系统找不到指定的路径');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await cardAlert.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  await expect(cardAlert).toHaveCount(0);

  // The editor keeps its own copy of the action and its error stays inside the open dialog.
  await card.getByRole('button', { name: 'Demo 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '修改', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改Demo' });
  await editor.getByRole('button', { name: '打开目录', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('系统找不到指定的路径');
  await expect(card.locator('[class*="cardError"]')).toHaveCount(0);
  await setHome(page, { failOpen: false });
  await editor.getByRole('button', { name: '打开目录', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveCount(0);
  expect((await homeState(page)).opens).toBe(3);
  expect((await homeState(page)).launches).toBe(0);
});
