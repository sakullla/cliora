import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { RemoteCliProbe } from '../../src/types/remote';

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

// Rust commands::tests verifies this fixture comes from the real serialized
// dependency/127 failure decoder used by probe_remote_cli.
const missingProbe: RemoteCliProbe = JSON.parse(readFileSync('tests/fixtures/remote-probe-missing.json', 'utf8'));

const settings = '{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://gateway.example.test"}}';

async function install(page: Page, options: { probe?: RemoteCliProbe; probeFailure?: Record<string, unknown> } = {}) {
  await page.addInitScript(({ host, settings, options }) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const calls: Array<Record<string, unknown>> = [];
    const probeState = { probe: options.probe ?? null, failure: options.probeFailure ?? null, calls: 0 };
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
      __remoteProbeState: probeState,
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
          if (command === 'probe_remote_cli') {
            probeState.calls++;
            if (probeState.failure) throw probeState.failure;
            return probeState.probe ?? { targetId: host.id, toolId: 'claude_code', executable: 'claude', installed: true, version: '2.1.314', detail: null };
          }
          if (command === 'get_remote_tool_store') return { profiles: [profile], common: null, currentFiles: { settings } };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_remote_projects' || command === 'list_projects' || command === 'list_accounts') return [];
          return null;
        },
      },
    });
  }, { host, settings, options });
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


test('confirmed missing remote CLI retains installation and configuration after a refresh', async ({ page }) => {
  await install(page, { probe: missingProbe });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByRole('button', { name: '安装', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '网关', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '正在使用的文件' })).toBeVisible();
  await expect(page.getByText('配置读取失败', { exact: true })).toHaveCount(0);
  const before = await page.evaluate(() => (window as unknown as { __remoteProbeState: { calls: number } }).__remoteProbeState.calls);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __remoteProbeState: { calls: number } }).__remoteProbeState.calls)).toBeGreaterThan(before);
  await expect(page.getByRole('button', { name: '安装', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '网关', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '正在使用的文件' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '修改正在使用的文件' })).toBeVisible();
});

for (const reason of ['authentication', 'permission', 'connect'] as const) {
  test(`remote ${reason} failure stays an error with retry instead of claiming the CLI is missing`, async ({ page }) => {
    const failure = {
      code: 'remote_error', message: `fixture ${reason} failure`, action: '请按远程操作建议处理。',
      remote: {
        code: `remote_${reason}`, stage: reason, reason, message: `fixture ${reason} failure`,
        action: '检查远程连接后重试。', requestId: null, targetId: host.id, targetRevision: host.updatedAt,
        outcome: 'failed', retryable: reason === 'connect', exitCode: reason === 'permission' ? 1 : 255,
      },
    };
    await install(page, { probeFailure: failure });
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
    await expect(page.getByText(`fixture ${reason} failure`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试读取配置', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '安装', exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as unknown as { __remoteProbeState: { failure: unknown } }).__remoteProbeState.failure = null; });
    await page.getByRole('button', { name: '重试读取配置', exact: true }).click();
    await expect(page.getByRole('button', { name: '正在使用的文件' })).toBeVisible();
    await expect(page.getByRole('button', { name: '网关', exact: true })).toBeVisible();
    await expect(page.getByText(`fixture ${reason} failure`, { exact: true })).toHaveCount(0);
  });
}
