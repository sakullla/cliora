import { expect, test, type Locator, type Page } from '@playwright/test';

const addCopy = '独立账号使用各自的 Codex 登录与配置目录，凭据由原生 CLI 维护。';
const hintCopy = '删除已停用：登录进行中，请先取消当前操作。';

type Fixture = {
  label: string;
  identityEmail: string | null;
  state: string;
  pending: boolean;
  nativeEmail: string | null;
  impact: Record<string, unknown> | null;
};

/** The default fixture is one pending account and no native sign-in. */
async function setup(page: Page, overrides: Partial<Fixture> = {}) {
  const fixture: Fixture = { label: '工作账号', identityEmail: null, state: 'pending', pending: true, nativeEmail: null, impact: null, ...overrides };
  await page.addInitScript((fixture) => {
    const account = {
      id: 'a',
      label: fixture.label,
      toolId: 'codex',
      provider: 'openai',
      version: 1,
      state: fixture.state,
      identity: fixture.identityEmail ? { subject: 'a', email: fixture.identityEmail, plan: 'Plus', source: 'mock' } : null,
      context: fixture.identityEmail ? { id: 'ctx-a' } : null,
      retiredContexts: [],
      pendingLogin: fixture.pending ? { id: 'attempt-1', expiresAt: 1999999999, operation: 'login' } : null,
      detail: null,
      checkedAt: null,
    };
    Object.assign(window, {
      isTauri: true,
      accountCommands: [] as string[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        (window as unknown as { accountCommands: string[] }).accountCommands.push(command);
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'], login: { hint: '原生登录' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'get_registered_tool_workspace') return {
          probe: { tool: 'codex', selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '0.160.0', status: 'available', source: 'npm_shim', detail: null }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null },
          profiles: [], effectiveContextId: null, binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [],
        };
        if (command === 'list_accounts') return [account];
        if (command === 'account_capabilities') return [{ toolId: 'codex', provider: 'openai', version: '0.160.0', managedLogin: true, importNative: true, methods: ['browser', 'device'], reason: '使用原生登录，在独立目录完成身份核验。', identitySource: 'mock', refreshOwner: 'native_cli', acceptance: 'mock only' }];
        if (command === 'discover_native_logins') return { toolId: args.toolId, checkedAt: 0, logins: fixture.nativeEmail ? [{ provider: 'chatgpt', authKind: 'oauth', state: 'signed_in', identity: { subject: 'native', email: fixture.nativeEmail, plan: 'plus', source: 'native' }, detail: '原生本地登录，未在线核验。', managedAccountId: null }] : [] };
        if (command === 'account_impact') return fixture.impact ?? { accountId: args.id, accountVersion: account.version, toolId: 'codex', currentContextId: null, contexts: [], profiles: [], scopes: [], usageReferences: [] };
        if (command === 'check_account' || command === 'rename_account') return account;
        if (['list_projects', 'list_usage_queries', 'list_usage_cache', 'usage_presets', 'list_mcp_definitions', 'list_skill_packages', 'list_skill_recovery_issues', 'scan_native_skills', 'list_native_mcp'].includes(command)) return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('plugin:event|')) return 1;
        return null;
      } },
    });
  }, fixture);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具' }).click();
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

test('managed row leads with identity and state, keeps its current action visible and stays inside 640', async ({ page }) => {
  const profileName = '超长的关联配置名称'.repeat(3);
  const longEmail = 'very.long.account.identity.for.layout@example.subdomain.test';
  await setup(page, {
    label: '超长的工作账号名称'.repeat(3),
    identityEmail: longEmail,
    state: 'signed_in',
    pending: false,
    nativeEmail: 'native.very.long.identity@example.subdomain.test',
    impact: {
      accountId: 'a', accountVersion: 1, toolId: 'codex', currentContextId: 'ctx-a',
      contexts: [{ id: 'ctx-a', kind: 'current' }, { id: 'ctx-old', kind: 'retained' }],
      profiles: [{ id: 'p', name: profileName, toolId: 'codex', version: 1, revision: 'r' }],
      scopes: [{ bindingId: 'b', toolId: 'codex', profileId: 'p', profileName, profileVersion: 1, scope: 'project', projectPath: '/very/long/path/to/a/workspace/that/keeps/going/project', projectName: '一个很长很长的项目名称'.repeat(2), contextId: 'ctx-a', contextKind: 'current', active: true, needsReapply: false, canReapply: false, reason: null, reapplyRequest: null }],
      usageReferences: [{ id: 'q', label: '超长的额度查询名称'.repeat(3), version: 1, enabled: true, accountId: 'a', contextId: 'ctx-a', profileId: 'p', contextKind: 'current', needsRebind: false }],
    },
  });
  const work = page.getByRole('listitem').filter({ has: page.getByText('超长的工作账号名称'.repeat(3), { exact: true }) });
  await expect(work).toHaveCount(1);
  // Identity and state come before the actions; the actions are visible without opening management.
  expect(await work.evaluate((node) => {
    const label = node.querySelector('[class*="accountIdentity"] strong') as HTMLElement;
    const badge = node.querySelector('[data-account-state] [data-state]') as HTMLElement;
    const action = [...node.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === '重新认证') as HTMLElement;
    return {
      labelBeforeBadge: !!(label.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING),
      badgeBeforeAction: !!(badge.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  })).toEqual({ labelBeforeBadge: true, badgeBeforeAction: true });
  await expect(work.getByText(longEmail + ' · Plus', { exact: true })).toBeVisible();
  await expect(work.locator('[data-state="signed_in"]')).toHaveText('已登录');
  await expect(work.getByRole('button', { name: '管理与关联', exact: true })).toHaveAttribute('aria-expanded', 'false');
  // The native snapshot sits in its own read-only section, so the two sources never merge.
  const native = page.getByLabel('CLI 原生登录');
  await expect(native.locator('[data-native-login]')).toHaveCount(1);
  await expect(native.getByText('只读快照', { exact: true })).toBeVisible();
  await expect(native.locator('[data-native-login]').getByRole('button')).toHaveCount(0);
  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(work.getByRole('button', { name: '重新认证', exact: true })).toBeVisible();
    await expect(work.getByRole('button', { name: '检查状态', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), String(width)).toBeLessThanOrEqual(0);
    expect(await work.evaluate((node) => node.scrollWidth - node.clientWidth), String(width)).toBeLessThanOrEqual(1);
  }
  // The opened management region keeps the same widths: links, scopes, quota and danger actions.
  await work.getByRole('button', { name: '管理与关联', exact: true }).click();
  await expect(work.getByRole('region', { name: /的管理与关联$/ })).toBeVisible();
  await expect(work.getByRole('region', { name: '危险操作' })).toBeVisible();
  for (const width of [900, 640]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), String(width)).toBeLessThanOrEqual(0);
    expect(await work.evaluate((node) => node.scrollWidth - node.clientWidth), String(width)).toBeLessThanOrEqual(1);
  }
});

test('managed account actions and the confirmation stay keyboard operable with a visible focus return', async ({ page }) => {
  await setup(page, { state: 'signed_in', pending: false, identityEmail: 'a@example.test' });
  const work = page.getByRole('listitem').filter({ has: page.getByText('工作账号', { exact: true }) });
  const rename = work.getByRole('button', { name: '重命名', exact: true });
  await rename.focus();
  await page.keyboard.press('Enter');
  const field = work.getByLabel('新名称');
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(rename).toBeFocused();

  const manage = work.getByRole('button', { name: '管理与关联', exact: true });
  // The row keeps one predictable order: the focused control's neighbour comes next.
  await page.keyboard.press('Tab');
  await expect(manage).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(manage).toHaveAttribute('aria-expanded', 'true');
  const logout = work.getByRole('button', { name: '退出此账号', exact: true });
  await logout.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(logout).toBeFocused();
  await expect(work.locator('[data-state="signed_in"]')).toHaveText('已登录');
  expect(await page.evaluate(() => (window as any).accountCommands.filter((command: string) => command === 'logout_account'))).toEqual([]);
});

test('OMP accounts stay read-only with visible reasons and no managed actions', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['omp'], theme: 'system' }, tools: [{ id: 'omp', name: 'oh-my-pi (OMP)' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'omp', name: 'oh-my-pi (OMP)', interfaceFormats: [], management: { accounts: true, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false } }], managedIds: ['omp'], preservedUnknown: [] };
        if (command === 'get_registered_tool_workspace') return {
          probe: { tool: 'omp', selectedPath: 'C:/omp.exe', installations: [{ path: 'C:/omp.exe', version: '18.20.2', status: 'available', source: 'native', detail: null }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null },
          profiles: [], effectiveContextId: null, binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [],
        };
        if (command === 'list_accounts') return [];
        if (command === 'account_capabilities') return [{ toolId: 'omp', provider: 'omp-native', version: '1.0.0', managedLogin: false, importNative: false, methods: [], reason: 'OMP 账号仅只读发现：agent.db 混存认证与其他状态，且没有 provider 完成真实身份、隔离、登录、取消、refresh 与退出验证。', identitySource: 'agent.db 脱敏元数据', identityRequired: true, refreshOwner: 'native_cli', acceptance: '仅合成 fixture' }];
        if (command === 'discover_native_logins') return { toolId: args.toolId, checkedAt: 0, logins: [
          { provider: 'openai-codex', authKind: 'oauth', state: 'signed_in', identity: { subject: 'acct_codex_1', email: 'ops@example.test', plan: 'plus', source: 'native_agent_db' }, detail: '只读发现 agent.db 原生 OAuth；未在线核验。另有 1 行损坏、字段不完整或二进制材料已跳过。', managedAccountId: null },
          { provider: 'openai-codex', authKind: 'oauth', state: 'signed_in', identity: { subject: 'acct_codex_2', email: 'second@example.test', plan: 'plus', source: 'native_agent_db' }, detail: '同一 provider 的第二个账号；仍为只读发现。', managedAccountId: null },
          { provider: 'anthropic', authKind: 'oauth', state: 'expired', identity: null, detail: '本地有效期已过；由 OMP 原生 CLI 刷新或重新登录。', managedAccountId: null },
        ] };
        if (['list_projects', 'list_usage_queries', 'list_usage_cache', 'usage_presets', 'list_mcp_definitions', 'list_skill_packages', 'list_skill_recovery_issues', 'scan_native_skills', 'list_native_mcp'].includes(command)) return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('plugin:event|')) return 1;
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具' }).click();
  await page.getByRole('tab', { name: '账号', exact: true }).click();
  const native = page.getByLabel('CLI 原生登录');
  await expect(native.getByText('只读快照', { exact: true })).toBeVisible();
  const codex = native.locator('[data-native-login="openai-codex"]');
  await expect(codex).toHaveCount(2);
  await expect(codex.filter({ hasText: 'ops@example.test' })).toContainText('CLI 已登录');
  await expect(codex.filter({ hasText: 'second@example.test' })).toContainText('CLI 已登录');
  await expect(native.locator('[data-native-login="anthropic"]')).toContainText('认证失效');
  await expect(page.getByText(/OMP 账号仅只读发现/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '退出此账号', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新认证', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '检查状态', exact: true })).toHaveCount(0);
});
