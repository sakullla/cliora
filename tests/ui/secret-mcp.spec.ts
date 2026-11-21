import { expect, test, type Page } from '@playwright/test';
import { openCli } from './cli-switcher';

type Call = { command: string; args: any };
type Status = Record<string, any>;

/** A value that must never reach the panel, its fallback or any tool metadata. */
const CANARY = 'canary-synthetic-secret-mcp-ui-4f83a1';

const installationId = 'mcp-installation-77af';

function status(overrides: Status): Status {
  return {
    toolId: 'codex', scope: 'global', projectPath: null,
    capability: 'unverified', capabilityReason: '此 CLI 已声明支持 MCP，但秘密 MCP 条目尚未验收。',
    state: 'unverified', reason: '原生配置里还没有秘密 MCP 条目',
    installationId, installationLabel: '秘密 MCP · Codex',
    command: '/Applications/Cliora.app/Contents/MacOS/cliora',
    args: ['--cliora-internal-secret-mcp-v1', '--installation', installationId],
    placement: 'absent', health: 'unknown', healthDetail: '',
    available: false, cliFallback: true,
    ...overrides,
  };
}

/**
 * One managed CLI with the MCP tab open. Every secret MCP command returns the
 * state after the operation, so the panel can only show what the native side
 * actually reported: placement, protocol health and capability stay separate.
 */
async function install(page: Page, options: { initial: Status; enabled: Status; healthy: Status; revoked: Status }) {
  await page.addInitScript((settings: { initial: Status; enabled: Status; healthy: Status; revoked: Status; canary: string }) => {
    const state = { current: settings.initial, calls: [] as Call[], canary: settings.canary };
    const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
    Object.assign(window, { isTauri: true, __secretMcp: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any = {}) => {
      state.calls.push({ command, args: clone(args) });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'list_projects') return [];
      if (command === 'get_registered_tool_workspace') return {
        probe: { tool: 'codex', selectedPath: '/fixture/codex', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] },
        profiles: [], common: null, binding: null, effectiveContextId: 'ctx-1', nativeContextError: null, snapshots: [], recoveryNeeded: [], customPath: null,
      };
      if (command === 'list_mcp_definitions') return [];
      if (command === 'list_mcp_placements') return [];
      if (command === 'get_managed_mcp_enabled') return null;
      if (command === 'list_native_mcp') return { entries: [], issues: [] };
      if (command === 'secret_mcp_status') return clone(state.current);
      if (command === 'set_secret_mcp_enabled') { state.current = clone(settings.enabled); return clone(state.current); }
      if (command === 'check_secret_mcp_health') { state.current = clone(settings.healthy); return clone(state.current); }
      if (command === 'revoke_secret_mcp_installation') { state.current = clone(settings.revoked); return clone(state.current); }
      // Local metadata only: aliases, identifiers and grants. No value is ever returned.
      if (command === 'secret_cli_context') return { executable: '/Applications/Cliora.app/Contents/MacOS/cliora', entry: '--cliora-internal-secret-cli-v1' };
      if (command === 'list_prompt_secrets') return [{ id: 'sec-1', alias: 'deploy-token', version: 1 }, { id: 'sec-2', alias: 'unused-token', version: 1 }];
      if (command === 'list_secret_executors') return [{ id: 'ex-1', label: '本机命令', version: 1 }, { id: 'ex-2', label: '暂未授权', version: 1 }];
      if (command === 'list_secret_installations') return [{ id: settings.initial.installationId, label: '秘密 MCP · Codex', kind: 'mcp', targetId: 'codex', revoked: false, version: 1 }];
      if (command === 'list_secret_grants') return [{ installationId: settings.initial.installationId, secretId: 'sec-1', executorId: 'ex-1' }];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      throw new Error(`Unexpected IPC: ${command}`);
    } } });
  }, { ...options, canary: CANARY });
  await page.goto('/');
  await openCli(page, 'Codex');
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
}

const panel = (page: Page) => page.locator('[data-secret-mcp]');
const fallback = (page: Page) => page.locator('[data-secret-mcp-fallback-text]');
const calls = (page: Page) => page.evaluate(() => (window as any).__secretMcp.calls as Call[]);
const lastCall = async (page: Page, command: string) => (await calls(page)).filter(call => call.command === command).at(-1);

const unverified = status({});
const written = status({ state: 'enabled', placement: 'enabled', health: 'unknown', reason: '原生条目已写入，协议状态尚未检查；也可继续使用 CLI 回退' });
const healthy = status({
  state: 'enabled', placement: 'enabled', health: 'healthy', healthDetail: 'initialize 与 tools/list 已通过',
  available: true, reason: '原生条目已写入，协议握手与工具发现均已通过',
});
const revoked = status({ installationId: null, installationLabel: null, placement: 'absent', health: 'unknown', reason: '安装标识已撤销' });

test('the MCP tab keeps capability, placement and protocol health apart and still offers the CLI fallback', async ({ page }) => {
  await install(page, { initial: unverified, enabled: written, healthy, revoked });
  const section = panel(page);
  await expect(section).toHaveAttribute('data-secret-mcp-state', 'unverified');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await section.locator('[data-secret-mcp-toggle]').click();

  // Three separate facts, each from its own source.
  await expect(page.locator('[data-secret-mcp-capability]')).toHaveText('unverified');
  await expect(page.locator('[data-secret-mcp-placement]')).toHaveText('未写入');
  await expect(page.locator('[data-secret-mcp-health]')).toHaveText('未检查');
  await expect(page.locator('[data-secret-mcp-installation]')).toHaveText(installationId);
  await expect(page.locator('[data-secret-mcp-command]')).toHaveText(`/Applications/Cliora.app/Contents/MacOS/cliora --cliora-internal-secret-mcp-v1 --installation ${installationId}`);
  await expect(page.locator('[data-secret-mcp-reason]')).toHaveText('原生配置里还没有秘密 MCP 条目');

  // The fallback names this installation but runs the CLI helper, and holds granted identifiers only.
  const text = fallback(page);
  await expect(text).toContainText(installationId);
  await expect(text).toContainText('--cliora-internal-secret-cli-v1');
  await expect(text).toContainText('use --secret sec-1 --executor ex-1');
  await expect(text).toContainText('read --secret sec-1');
  await expect(text).toContainText('每次都要在栖点确认');
  await expect(text).not.toContainText('sec-2');
  await expect(text).not.toContainText('ex-2');
  await expect(page.locator('body')).not.toContainText(CANARY);

  // Writing the entry is a placement change only: it never becomes available on its own.
  await page.locator('[data-secret-mcp-enable]').click();
  const write = await lastCall(page, 'set_secret_mcp_enabled');
  expect(write.args.target).toMatchObject({ toolId: 'codex', scope: 'global', projectPath: null });
  expect(write.args.enabled).toBe(true);
  await expect(page.locator('[data-secret-mcp-notice]')).toHaveText('秘密 MCP 配置已写入；协议状态需要另外检查。');
  await expect(section).toHaveAttribute('data-secret-mcp-state', 'enabled');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await expect(page.locator('[data-secret-mcp-placement]')).toHaveText('已写入');
  await expect(page.locator('[data-secret-mcp-health]')).toHaveText('未检查');

  // A real probe is the only thing that can make it available.
  await page.locator('[data-secret-mcp-verify]').click();
  await expect((await lastCall(page, 'check_secret_mcp_health')).args.target).toMatchObject({ toolId: 'codex' });
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'true');
  await expect(page.locator('[data-secret-mcp-health]')).toHaveText('已通过initialize 与 tools/list 已通过');
  // The fallback is a documented path in every state, so a working entry does not remove it.
  await expect(fallback(page)).toContainText('--cliora-internal-secret-cli-v1');
  await expect(page.locator('body')).not.toContainText(CANARY);

  // Revoking drops the installation identity and the availability claim again.
  await page.locator('[data-secret-mcp-revoke]').click();
  await expect((await lastCall(page, 'revoke_secret_mcp_installation')).args.target).toMatchObject({ toolId: 'codex' });
  await expect(page.locator('[data-secret-mcp-installation]')).toHaveText('尚未创建');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await expect(page.locator('[data-secret-mcp-reason]')).toHaveText('安装标识已撤销');
});

test('an unsupported adapter reports its own reason without an enable action and keeps the fallback', async ({ page }) => {
  const unsupported = status({
    capability: 'unsupported', capabilityReason: '此 CLI 没有声明 MCP 配置能力。',
    state: 'unsupported', reason: '此 CLI 没有声明 MCP 配置能力；也可继续使用 CLI 回退',
  });
  await install(page, { initial: unsupported, enabled: unsupported, healthy: unsupported, revoked: unsupported });
  const section = panel(page);
  await expect(section).toHaveAttribute('data-secret-mcp-state', 'unsupported');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await section.locator('[data-secret-mcp-toggle]').click();
  await expect(page.locator('[data-secret-mcp-capability]')).toHaveText('unsupported');
  await expect(page.locator('[data-secret-mcp-unsupported]')).toHaveText('此 CLI 没有声明 MCP 配置能力。');
  await expect(page.locator('[data-secret-mcp-enable]')).toHaveCount(0);
  await expect(page.locator('[data-secret-mcp-verify]')).toHaveCount(0);
  await expect(fallback(page)).toContainText('--cliora-internal-secret-cli-v1');
  await expect(page.locator('body')).not.toContainText(CANARY);
});

test('a failed protocol probe stays failed and never claims the entry works', async ({ page }) => {
  const failed = status({
    state: 'enabled', placement: 'enabled', health: 'failed',
    healthDetail: 'initialize 失败：进程以非零状态退出',
    reason: '原生条目已写入，但协议握手失败；也可继续使用 CLI 回退',
  });
  await install(page, { initial: failed, enabled: failed, healthy: failed, revoked: failed });
  const section = panel(page);
  await expect(section).toHaveAttribute('data-secret-mcp-state', 'enabled');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await section.locator('[data-secret-mcp-toggle]').click();
  await expect(page.locator('[data-secret-mcp-placement]')).toHaveText('已写入');
  await expect(page.locator('[data-secret-mcp-health]')).toHaveText('未通过initialize 失败：进程以非零状态退出');
  await expect(fallback(page)).toContainText('use --secret sec-1 --executor ex-1');
  await expect(page.locator('body')).not.toContainText(CANARY);
});
