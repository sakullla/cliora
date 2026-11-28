import { type Page } from '@playwright/test';
import { expect, test } from './sharedPage';
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
    placement: 'absent', health: 'unknown', healthDetail: '', canCheck: false,
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
  const toolId = options.initial.toolId;
  const toolName = toolId === 'claude_code' ? 'Claude Code' : 'Codex';
  await page.addInitScript((settings: { initial: Status; enabled: Status; healthy: Status; revoked: Status; canary: string; toolId: string; toolName: string }) => {
    const state = { current: settings.initial, calls: [] as Call[], canary: settings.canary };
    const { toolId, toolName } = settings;
    const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
    Object.assign(window, { isTauri: true, __secretMcp: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any = {}) => {
      state.calls.push({ command, args: clone(args) });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [toolId], theme: 'light' }, tools: [{ id: toolId, name: toolName }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: toolId, name: toolName, interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: [toolId], preservedUnknown: [] };
      if (command === 'list_projects') return [];
      if (command === 'get_registered_tool_workspace') return {
        probe: { tool: toolId, selectedPath: `/fixture/${toolId}`, installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] },
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
      if (command === 'secret_access_options') return {
        cli: { executable: '/Applications/Cliora.app/Contents/MacOS/cliora', entry: '--cliora-internal-secret-cli-v1' },
        executors: [{ id: 'ex-1', label: '本机命令' }, { id: 'ex-2', label: '暂未授权' }],
        installations: [{ id: settings.initial.installationId, label: settings.initial.installationLabel, kind: 'mcp', targetId: toolId, revoked: false }],
        grants: [{ installationId: settings.initial.installationId, secretId: 'sec-1', alias: 'deploy-token', executorId: 'ex-1' }],
        availablePrograms: [],
      };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      throw new Error(`Unexpected IPC: ${command}`);
    } } });
  }, { ...options, canary: CANARY, toolId, toolName });
  await page.goto('/');
  await openCli(page, toolName);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
}

const panel = (page: Page) => page.locator('[data-secret-mcp]');
const fallback = (page: Page) => page.locator('[data-secret-mcp-fallback-text]');
const calls = (page: Page) => page.evaluate(() => (window as any).__secretMcp.calls as Call[]);
const lastCall = async (page: Page, command: string) => (await calls(page)).filter(call => call.command === command).at(-1);

const unverified = status({});
const written = status({ capability: 'supported', state: 'enabled', placement: 'enabled', canCheck: true, reason: '原生条目已写入，协议状态尚未检查；也可继续使用 CLI 回退' });
const healthy = status({
  ...written, health: 'healthy', healthDetail: 'initialize 与 tools/list 已通过',
  available: true, reason: '原生条目已写入，协议握手与工具发现均已通过',
});
const revoked = status({ installationId: null, installationLabel: null, placement: 'enabled', health: 'unknown', reason: '安装标识已撤销' });

test('the MCP tab keeps capability, placement and protocol health apart and still offers the CLI fallback', async ({ page }) => {
  const target = { toolId: 'claude_code', capability: 'unverified', state: 'unverified', installationLabel: '秘密 MCP · claude_code', available: false };
  await install(page, { initial: { ...unverified, ...target }, enabled: { ...written, ...target }, healthy: { ...healthy, ...target }, revoked: { ...target, ...revoked, toolId: target.toolId } });
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
  await expect(text).toContainText('允许本次会话');
  await expect(text).toContainText('外部终端每次请求都要确认');
  await expect(text).not.toContainText('sec-2');
  await expect(text).not.toContainText('ex-2');
  await expect(page.locator('body')).not.toContainText(CANARY);

  await page.locator('[data-secret-mcp-enable]').click();
  await expect(page.locator('[data-secret-mcp-notice]')).toHaveText('已用本机代理检查协议握手与工具发现。');
  const history = await calls(page);
  const write = history.findIndex(call => call.command === 'set_secret_mcp_enabled');
  expect(history[write].args).toMatchObject({ target: { toolId: 'claude_code', scope: 'global', projectPath: null }, enabled: true });
  expect(history.findIndex(call => call.command === 'check_secret_mcp_health')).toBeGreaterThan(write);
  expect(history.slice(write + 1).some(call => call.command === 'list_native_mcp')).toBe(true);
  await expect(section).toHaveAttribute('data-secret-mcp-state', 'unverified');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await expect(page.locator('[data-secret-mcp-placement]')).toHaveText('已写入');
  await expect(page.locator('[data-secret-mcp-health]')).toHaveText('已通过initialize 与 tools/list 已通过');
  await expect(section.getByText(/授权给 秘密 MCP · claude_code/)).toBeVisible();
  await expect(fallback(page)).toContainText('--cliora-internal-secret-cli-v1');
  await expect(page.locator('body')).not.toContainText(CANARY);

  // Revoking drops the installation identity and the availability claim again.
  await page.locator('[data-secret-mcp-revoke]').click();
  await expect((await lastCall(page, 'revoke_secret_mcp_installation')).args.target).toMatchObject({ toolId: 'claude_code' });
  await expect(page.locator('[data-secret-mcp-installation]')).toHaveText('尚未创建');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await expect(page.locator('[data-secret-mcp-reason]')).toHaveText('安装标识已撤销');
  await expect(page.locator('[data-secret-mcp-enable]')).toBeEnabled();
  await expect(page.locator('[data-secret-mcp-verify]')).toHaveCount(0);
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
    ...written, health: 'failed',
    healthDetail: 'initialize 失败：进程以非零状态退出',
    reason: '原生条目已写入，但协议握手失败；也可继续使用 CLI 回退',
  });
  await install(page, { initial: written, enabled: written, healthy: failed, revoked });
  const section = panel(page);
  await expect(section).toHaveAttribute('data-secret-mcp-state', 'enabled');
  await expect(section).toHaveAttribute('data-secret-mcp-available', 'false');
  await section.locator('[data-secret-mcp-toggle]').click();
  await expect(page.locator('[data-secret-mcp-placement]')).toHaveText('已写入');
  await page.locator('[data-secret-mcp-verify]').click();
  await expect(page.locator('[data-secret-mcp-health]')).toHaveText('未通过initialize 失败：进程以非零状态退出');
  await expect(page.locator('[data-secret-mcp-notice]')).toHaveCount(0);
  await expect(fallback(page)).toContainText('use --secret sec-1 --executor ex-1');
  await expect(page.locator('body')).not.toContainText(CANARY);
});
