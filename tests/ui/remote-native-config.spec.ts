import { expect, test, type Page } from '@playwright/test';

const host = {
  id: 'host-native',
  name: '原生配置主机',
  host: '203.0.113.10',
  port: 22,
  user: 'root',
  authMethod: 'key',
  identityFile: '',
  sshConfig: null,
  defaultPath: '/src/project',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const settings = '{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://gateway.example.test"}}';

async function install(page: Page) {
  await page.addInitScript(({ host, settings }) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const calls: Array<Record<string, unknown>> = [];
    const profile = {
      id: 'remote-profile',
      tool: 'claude_code',
      name: '网关',
      version: 1,
      revision: 'rev',
      inheritCommon: false,
      files: { settings },
      suppressed: {},
      connection: { providerId: 'gateway', baseUrl: 'https://gateway.example.test', interfaceFormat: 'anthropic_messages', model: 'claude-sonnet', secretRef: null, authEnvVar: null },
      nativeCredentials: {},
    };
    Object.assign(window, {
      isTauri: true,
      __remoteConfigCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'save_remote_tool_store' || command === 'get_remote_tool_store' || command === 'begin_configuration_draft') {
            calls.push({ command, args });
          }
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'light', remote_ssh_enabled: true }, tools: [{ id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return {
            registered: [{
              id: 'claude_code',
              name: 'Claude Code',
              interfaceFormats: ['anthropic_messages'],
              yoloAvailable: true,
              resumeLatestAvailable: false,
              projectModelOverride: false,
              launchForm: 'terminal',
              nativeConfig: { state: 'available', reason: '' },
              launch: { state: 'available', reason: '' },
              resume: { state: 'available', reason: '' },
              resources: { state: 'available', reason: '' },
              history: { state: 'available', reason: '' },
              management: { accounts: true, mcp: true, skills: true, agents: true, plugins: true, projectPlugins: true, rules: { global: true, project: true } },
              remoteNativeFiles: [
                { role: 'settings', relative: '.claude/settings.json', format: 'json', scope: 'global' },
                { role: 'settings', relative: '.claude/settings.json', format: 'json', scope: 'project' },
                { role: 'local_settings', relative: '.claude/settings.local.json', format: 'json', scope: 'project' },
              ],
            }],
            managedIds: ['claude_code'],
            preservedUnknown: [],
          };
          if (command === 'list_remote_targets') return [host];
          if (command === 'probe_remote_cli') return { targetId: host.id, toolId: 'claude_code', executable: 'claude', installed: true, version: '2.1.314', detail: null };
          if (command === 'get_remote_tool_store') return { profiles: [profile], common: null, currentFiles: { settings } };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_remote_projects' || command === 'list_projects' || command === 'list_accounts') return [];
          return null;
        },
      },
    });
  }, { host, settings });
}

test('remote claude can open and apply the native file in use', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await expect(page.locator('.sidebar-host').getByRole('button', { name: '运行位置：原生配置主机' })).toBeVisible();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByRole('button', { name: '正在使用的文件' })).toBeVisible();
  const use = page.getByRole('button', { name: '使用', exact: true });
  await expect(use).toBeEnabled();
  await page.getByRole('button', { name: '正在使用的文件' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '修改正在使用的文件' })).toBeVisible();
  await expect(dialog.getByText('直接填写正在使用的原生配置')).toBeVisible();
  await expect(dialog.getByText('不会改掉正在用的那一份')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await use.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __remoteConfigCalls: Array<{ command: string; args: { scope?: string; store?: { currentFiles?: Record<string, string> } } }> }).__remoteConfigCalls.filter(call => call.command === 'save_remote_tool_store'))).toEqual([
    expect.objectContaining({
      command: 'save_remote_tool_store',
      args: expect.objectContaining({
        scope: 'global',
        store: expect.objectContaining({ currentFiles: { settings } }),
      }),
    }),
  ]);
});
