import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => {
    const account = (id: string, label: string) => ({ id, label, toolId: 'codex', provider: 'openai', version: 1, state: 'signed_in', identity: { subject: id, email: `${id}@example.test`, plan: 'Plus', source: 'mock' }, context: { id: `ctx-${id}` }, retiredContexts: [], pendingLogin: null, detail: null, checkedAt: null });
    const harness = { accounts: [account('a', '工作账号'), account('b', '个人账号')], profiles: [] as any[], binding: null as any, calls: [] as { command: string; args: any }[] };
    Object.assign(window, { isTauri: true, oauthHarness: harness, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      harness.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'], login: { hint: '原生登录' } }], managedIds: ['codex'], preservedUnknown: [] };
      if (['list_projects', 'list_usage_queries', 'list_usage_cache', 'list_mcp_definitions', 'list_skill_packages'].includes(command)) return [];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'list_accounts') return harness.accounts;
      if (command === 'account_capabilities') return [{ toolId: 'codex', provider: 'openai', version: '0.160.0', managedLogin: true, importNative: true, methods: ['browser', 'device'], reason: '使用原生登录，在独立目录完成身份核验。', identitySource: 'mock', refreshOwner: 'native_cli', acceptance: 'mock only' }];
      if (command === 'create_account') { const value = { ...account('new', args.label), state: 'signed_out', identity: null, context: null }; harness.accounts.push(value as any); return value; }
      if (command === 'adopt_native_codex_account') { const value = account('adopted', args.label); harness.accounts.push(value); return value; }
      if (['start_account_login', 'cancel_account_login', 'logout_account', 'check_account', 'rename_account'].includes(command)) {
        const value: any = harness.accounts.find(item => item.id === args.id); value.version++;
        if (command === 'start_account_login') { value.state = 'pending'; value.pendingLogin = { id: 'attempt-1', expiresAt: 1999999999, operation: 'login' }; }
        if (command === 'cancel_account_login') { value.state = 'signed_out'; value.pendingLogin = null; }
        if (command === 'logout_account') { value.state = 'signed_out'; value.pendingLogin = null; }
        if (command === 'rename_account') value.label = args.label;
        return value;
      }
      if (command === 'get_registered_tool_workspace') return { probe: { tool: 'codex', selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '0.160.0', status: 'available', source: 'npm_shim', detail: null }], nativeFiles: [{ role: 'settings', path: 'C:/fixture/config.toml', format: 'toml', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: 'https://developers.openai.com/codex/cli', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null }, profiles: harness.profiles, binding: harness.binding, snapshots: [{ role: 'settings', text: '', fingerprint: '', error: null }], common: null, customPath: null, recoveryNeeded: [] };
      if (command === 'prepare_registered_native_import') return { files: args.files, nativeCredentials: {}, migratedSecret: false, inspection: { connection: null, providerId: null, model: null, baseUrl: null, reasoningEffort: null } };
      if (command === 'inspect_registered_native_draft') return { connection: null, providerId: null, model: null, reasoningEffort: null };
      if (command === 'preview_registered_native_profile') return { documents: {}, rendered: {}, sources: {} };
      if (command === 'save_registered_native_profile') { const value = { ...args.profile, id: args.profile.id || 'profile-1', version: args.profile.version + 1 }; harness.profiles = [value]; return value; }
      if (command === 'apply_registered_native_profile') { const profile = harness.profiles.find(item => item.id === args.profileId); harness.binding = { scopeKey: 'global', tool: 'codex', profileId: profile.id, profileVersion: profile.version, contextId: `ctx-${profile.authentication.accountId}`, managed: {} }; return { transactionId: 'mock', changedFiles: [], status: 'written_for_next_session' }; }
      return null;
    } } });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
}

test('account panel distinguishes pending, cancel, reauthentication, logout and native adoption', async ({ page }) => {
  await setup(page); await page.getByRole('tab', { name: '账号', exact: true }).click();
  await expect(page.getByText('a@example.test · Plus')).toBeVisible();
  await page.getByLabel('账号名称').fill('新账号'); await page.getByRole('button', { name: '添加并登录' }).click();
  await expect(page.getByText('等待原生登录完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消登录' }).click();
  await expect(page.getByText(/外部登录终端需自行关闭/)).toBeVisible();
  const work = page.getByRole('listitem').filter({ hasText: '工作账号' });
  await work.getByRole('button', { name: '重新认证' }).click(); await expect(work.getByText('等待原生登录完成')).toBeVisible();
  await work.getByRole('button', { name: '取消登录' }).click();
  const personal = page.getByRole('listitem').filter({ hasText: '个人账号' }); await expect(personal.getByText('已登录', { exact: true })).toBeVisible();
  await personal.getByRole('button', { name: '退出此账号' }).click(); await expect(personal.getByText('已退出')).toBeVisible();
  await page.getByLabel('账号名称').fill('既有账号'); await page.getByRole('button', { name: '纳入现有原生账号' }).click();
  await expect(page.getByText('已将现有原生账号纳入管理；继续使用原目录，未复制令牌。')).toBeVisible();
  await page.screenshot({ path: 'test-results/oauth-accounts.png', fullPage: true });
});

test('OAuth profile saves and applies the selected account without an API connection', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('认证方式').selectOption('oauth');
  await dialog.getByLabel('绑定账号').selectOption('b'); await dialog.getByLabel('配置名称').fill('个人订阅');
  await page.screenshot({ path: 'test-results/oauth-binding.png', fullPage: true });
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '启用', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).oauthHarness.binding?.contextId)).toBe('ctx-b');
  const result = await page.evaluate(() => (window as any).oauthHarness);
  expect(result.profiles[0].authentication).toEqual({ kind: 'oauth', accountId: 'b' });
  expect(result.profiles[0].connection).toBeNull(); expect(result.profiles[0].nativeCredentials).toEqual({});
  expect(result.binding.contextId).toBe('ctx-b');
});
