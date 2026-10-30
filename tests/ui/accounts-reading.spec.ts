import { expect, test, type Locator, type Page } from '@playwright/test';

const addCopy = '独立账号使用各自的 Codex 登录与配置目录，凭据由原生 CLI 维护。';
const hintCopy = '删除已停用：登录进行中，请先取消当前操作。';

async function setup(page: Page) {
  await page.addInitScript(() => {
    const account = {
      id: 'a',
      label: '工作账号',
      toolId: 'codex',
      provider: 'openai',
      version: 1,
      state: 'pending',
      identity: null,
      context: null,
      retiredContexts: [],
      pendingLogin: { id: 'attempt-1', expiresAt: 1999999999, operation: 'login' },
      detail: null,
      checkedAt: null,
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'], login: { hint: '原生登录' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'get_registered_tool_workspace') return {
          probe: { tool: 'codex', selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '0.160.0', status: 'available', source: 'npm_shim', detail: null }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null },
          profiles: [], effectiveContextId: null, binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [],
        };
        if (command === 'list_accounts') return [account];
        if (command === 'account_capabilities') return [{ toolId: 'codex', provider: 'openai', version: '0.160.0', managedLogin: true, importNative: true, methods: ['browser', 'device'], reason: '使用原生登录，在独立目录完成身份核验。', identitySource: 'mock', refreshOwner: 'native_cli', acceptance: 'mock only' }];
        if (command === 'discover_native_logins') return { toolId: args.toolId, checkedAt: 0, logins: [] };
        if (command === 'account_impact') return { accountId: args.id, accountVersion: account.version, toolId: 'codex', currentContextId: null, contexts: [], profiles: [], scopes: [], usageReferences: [] };
        if (['list_projects', 'list_usage_queries', 'list_usage_cache', 'usage_presets', 'list_mcp_definitions', 'list_skill_packages', 'list_skill_recovery_issues', 'scan_native_skills', 'list_native_mcp'].includes(command)) return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('plugin:event|')) return 1;
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '账号', exact: true }).click();
}

async function reading(locator: Locator) {
  return locator.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--text)';
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { color: getComputedStyle(element).color, token };
  });
}

test('account polling waits for a slow response before scheduling another read', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('工作账号', { exact: true }).first()).toBeVisible();
  await page.clock.install();
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.accountPoll = { calls: 0, hold: true, release: () => {} };
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
      if (command === 'list_accounts') {
        w.accountPoll.calls++;
        if (w.accountPoll.hold) await new Promise<void>(resolve => { w.accountPoll.release = resolve; });
      }
      return invoke(command, args);
    };
  });
  await page.clock.fastForward(3000);
  await expect.poll(() => page.evaluate(() => (window as any).accountPoll.calls)).toBe(1);
  await page.clock.fastForward(12000);
  expect(await page.evaluate(() => (window as any).accountPoll.calls)).toBe(1);
  await page.evaluate(() => { (window as any).accountPoll.hold = false; (window as any).accountPoll.release(); });
  await page.waitForTimeout(50);
  await page.clock.fastForward(3000);
  await expect.poll(() => page.evaluate(() => (window as any).accountPoll.calls)).toBe(2);
});

test('account action hint uses the body text color', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.getByText(addCopy, { exact: true })).toBeVisible();

  const account = page.getByRole('listitem').filter({ hasText: '工作账号' });
  await account.getByText('管理与关联', { exact: true }).click();
  const hint = account.getByText(hintCopy, { exact: true });
  await expect(hint).toBeVisible();
  const hintStyle = await reading(hint);
  expect(hintStyle.color).toBe(hintStyle.token);
});
