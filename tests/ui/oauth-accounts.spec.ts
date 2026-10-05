import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

async function setup(page: Page, inherited = false) {
  await page.addInitScript((inherited) => {
    const account = (id: string, label: string) => ({ id, label, toolId: 'codex', provider: 'openai', version: 1, state: 'signed_in', identity: { subject: id, email: `${id}@example.test`, plan: 'Plus', source: 'mock' }, context: { id: `ctx-${id}` }, retiredContexts: [], pendingLogin: null, detail: null, checkedAt: null });
    const harness = { nativeFailure: '', nativeSnapshot: { toolId: 'codex', checkedAt: 1790992800, logins: [{ provider: 'chatgpt', authKind: 'oauth', state: 'signed_in', identity: { subject: 'native', email: 'native@example.test', plan: 'plus', source: 'native' }, detail: '原生本地登录，未在线核验。', managedAccountId: null }] }, skillEnabled: true, accounts: [account('a', '工作账号'), account('b', '个人账号')], profiles: [] as any[], queries: [] as any[], binding: null as any, impacts: {} as Record<string, any>, impactFailure: '', applyFailure: '', calls: [] as { command: string; args: any }[] };
    Object.assign(window, { isTauri: true, oauthHarness: harness, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      harness.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'], login: { hint: '原生登录' } }], managedIds: ['codex'], preservedUnknown: [] };
      if (inherited && command === 'list_projects') return [{ id: 'project', name: '继承项目', path: '/tmp/project', available: true, selectedProfiles: {}, appliedProfiles: {} }];
      if (inherited && command === 'read_registered_native_file_for_edit') return 'model = \"before\"';
      if (inherited && command === 'save_registered_native_file') {
        if (args.expectedContextId !== 'ctx-a') throw { message: '账号上下文错误' };
        return { status: 'written_for_next_session', changedFiles: [] };
      }
      if (inherited && command === 'list_native_mcp') {
        if (args.target.contextId !== 'ctx-a') throw { message: 'MCP 上下文错误' };
        return [{ name: 'project-server', command: 'node', args: [], env: {}, headers: {}, transport: 'stdio', enabled: true }];
      }
      if (inherited && command === 'list_skill_packages') return [{ id: 'skill', name: 'project-skill', description: 'fixture', fileCount: 1, source: '/tmp/fixtures/project-skill', digest: 'fixture-digest', compatibility: null, inLibrary: true, updatedAt: 1 }];
      if (inherited && command === 'scan_native_skills') return [{ name: 'project-skill', packageId: 'skill', state: 'managed', path: '/tmp/project/.agents/skills/project-skill', description: 'fixture' }];
      if (inherited && command === 'list_skill_installations') return [{ packageId: 'skill', toolId: 'codex', scope: 'project', projectPath: '/tmp/project', contextId: null, state: 'current', targetPath: '/tmp/project/.agents/skills/project-skill' }];
      if (command === 'list_skill_recovery_issues') return [];
      if (inherited && command === 'get_skill_enabled') return harness.skillEnabled;
      if (inherited && command === 'set_skill_enabled') { if (args.expectedContextId !== 'ctx-a') throw { message: 'Skill 上下文错误' }; harness.skillEnabled = args.enabled; return null; }
      if (command === 'list_usage_queries') return structuredClone(harness.queries);
      if (['list_projects', 'list_usage_cache', 'list_mcp_definitions', 'list_skill_packages'].includes(command)) return [];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'list_accounts') return structuredClone(harness.accounts);
      if (command === 'account_impact') {
        if (harness.impactFailure) throw { message: harness.impactFailure };
        const account = harness.accounts.find(item => item.id === args.id)!;
        return structuredClone(harness.impacts[args.id] ?? { accountId: account.id, accountVersion: account.version, toolId: 'codex', currentContextId: account.context?.id ?? null, profiles: [], scopes: [], usageReferences: [], contexts: [] });
      }
      if (command === 'discover_native_logins') { if (harness.nativeFailure) throw { message: harness.nativeFailure }; return structuredClone(harness.nativeSnapshot); }
      if (command === 'account_capabilities') return [{ toolId: 'codex', provider: 'openai', version: '0.160.0', browserLink: (harness as any).browserLink ?? false, managedLogin: true, importNative: true, methods: ['browser', 'device'], reason: '使用原生登录，在独立目录完成身份核验。', identitySource: 'mock', refreshOwner: 'native_cli', acceptance: 'mock only' }];
      if (command === 'create_account') { const value = { ...account('new', args.label), state: 'signed_out', identity: null, context: null }; harness.accounts.push(value as any); return value; }
      if (command === 'reapply_account_profile') {
        if (harness.applyFailure) throw { message: harness.applyFailure };
        const value = harness.impacts[args.request.accountId];
        const target = value.scopes.find((scope: any) => scope.reapplyRequest?.expectedBindingFingerprint === args.request.expectedBindingFingerprint);
        if (!target) throw { message: '账号或范围关联已变化，请刷新后重试' };
        const refreshedAccount = harness.accounts.find(item => item.id === args.request.accountId)!; refreshedAccount.version++; value.accountVersion = refreshedAccount.version;
        target.contextKind = 'current'; target.contextId = value.currentContextId; target.needsReapply = false; target.canReapply = false; target.reapplyRequest = null;
        return { transactionId: 'guarded-mock', changedFiles: [], status: 'written_for_next_session' };
      }
      if (command === 'delete_account') {
        const references = harness.impacts[args.id];
        if (references && (references.profiles.length || references.scopes.length || references.usageReferences.length)) throw { message: '账号仍被配置、范围或额度引用，请先解除关联' };
        const value = harness.accounts.find(item => item.id === args.id); if (value?.version !== args.expectedVersion) throw { message: '账号已发生变化，请重新读取' }; harness.accounts = harness.accounts.filter(item => item.id !== args.id); return null; }
      if (command === 'adopt_native_account') { if (args.toolId !== 'codex') throw { message: '原生账号工具错误' }; const value = account('adopted', args.label); harness.accounts.push(value); return value; }
      if (['start_account_login', 'cancel_account_login', 'logout_account', 'check_account', 'rename_account'].includes(command)) {
        const value: any = harness.accounts.find(item => item.id === args.id); value.version++;
        if (command === 'start_account_login') { value.state = 'pending'; value.pendingLogin = { id: 'attempt-1', expiresAt: 1999999999, operation: 'login' }; }
        if (command === 'cancel_account_login') { value.state = 'signed_out'; value.pendingLogin = null; }
        if (command === 'logout_account') { value.state = 'signed_out'; value.pendingLogin = null; }
        if (command === 'rename_account') value.label = args.label;
        return value;
      }
      if (command === 'get_registered_tool_workspace') return { probe: { tool: 'codex', selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '0.160.0', status: 'available', source: 'npm_shim', detail: null }], nativeFiles: [{ role: 'settings', path: 'C:/fixture/config.toml', format: 'toml', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: 'https://developers.openai.com/codex/cli', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null }, profiles: harness.profiles, effectiveContextId: inherited ? 'ctx-a' : harness.binding?.contextId ?? null, binding: harness.binding, snapshots: [{ role: 'settings', text: '', fingerprint: inherited ? 'present' : '', error: null }], common: null, customPath: null, recoveryNeeded: [] };
      if (command === 'prepare_registered_native_import') return { files: args.files, nativeCredentials: {}, migratedSecret: false, inspection: { connection: null, providerId: null, model: null, baseUrl: null, reasoningEffort: null } };
      if (command === 'inspect_registered_native_draft') return { connection: null, providerId: null, model: null, reasoningEffort: null };
      if (command === 'preview_registered_native_profile') return { documents: {}, rendered: {}, sources: {} };
      if (command === 'save_registered_native_profile') { const value = { ...args.profile, id: args.profile.id || 'profile-1', version: args.profile.version + 1 }; harness.profiles = [value]; return value; }
      if (command === 'apply_registered_native_profile') { const profile = harness.profiles.find(item => item.id === args.profileId); harness.binding = { scopeKey: 'global', tool: 'codex', profileId: profile.id, profileVersion: profile.version, contextId: `ctx-${profile.authentication.accountId}`, managed: {} }; return { transactionId: 'mock', changedFiles: [], status: 'written_for_next_session' }; }
      return null;
    } } });
  }, inherited);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
}

test('account panel distinguishes pending, cancel, reauthentication, logout and native adoption', async ({ page }) => {
  await setup(page); await page.getByRole('tab', { name: '账号', exact: true }).click();
  await expect(page.getByText('a@example.test · Plus')).toBeVisible();
  await expect(page.getByText('native@example.test', { exact: true })).toBeVisible();
  await expect(page.getByText('CLI 已登录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await page.getByLabel('账号名称').fill('新账号'); await page.getByRole('button', { name: '添加并登录' }).click();
  await expect(page.getByText('等待原生登录完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消登录' }).click();
  await expect(page.getByText(/外部登录终端需自行关闭/)).toBeVisible();
  const work = page.getByRole('listitem').filter({ has: page.getByText('工作账号', { exact: true }) });
  await work.getByText('管理与关联', { exact: true }).click();
  await work.getByRole('button', { name: '重新认证' }).click(); await expect(work.getByText('等待原生登录完成')).toBeVisible();
  await work.getByRole('button', { name: '取消登录' }).click();
  const personal = page.getByRole('listitem').filter({ has: page.getByText('个人账号', { exact: true }) }); await personal.getByText('管理与关联', { exact: true }).click(); await expect(personal.getByText('已登录', { exact: true })).toBeVisible();
  await personal.getByRole('button', { name: '退出此账号' }).click(); await page.getByRole('dialog').getByRole('button', { name: '退出此账号' }).click(); await expect(personal.getByText('已退出')).toBeVisible();
  await page.getByLabel('账号名称').fill('既有账号'); await page.getByRole('button', { name: '纳入现有原生账号' }).click();
  await expect(page.getByText('已将现有原生账号纳入管理；继续使用原目录，未复制令牌。')).toBeVisible();
  const adoption = await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'adopt_native_account'));
  expect(adoption).toEqual([{ command: 'adopt_native_account', args: { toolId: 'codex', label: '既有账号' } }]);
  await page.screenshot({ path: 'test-results/oauth-accounts.png', fullPage: true });
});

test('account deletion confirms its scope, cancel makes no call and pending login cannot delete', async ({ page }) => {
  await setup(page); await page.getByRole('tab', { name: '账号', exact: true }).click();
  const work = page.getByRole('listitem').filter({ has: page.getByText('工作账号', { exact: true }) });
  await work.getByText('管理与关联', { exact: true }).click();
  await work.getByRole('button', { name: '删除账号', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('原生登录文件、插件和历史记录会保留');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'delete_account').length)).toBe(0);
  await work.getByRole('button', { name: '重新认证' }).click();
  await expect(work.getByRole('button', { name: '删除账号', exact: true })).toBeDisabled();
  await work.getByRole('button', { name: '取消登录' }).click();
  await work.getByRole('button', { name: '删除账号', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除账号', exact: true }).click();
  await expect(work).toHaveCount(0);
  await expect(page.getByText('个人账号', { exact: true })).toBeVisible();
  await expect(page.getByText('native@example.test', { exact: true })).toBeVisible();
});

test('browser retry follows adapter capability and uses only the current attempt', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).oauthHarness.browserLink = true; });
  await page.getByRole('tab', { name: '账号', exact: true }).click();
  const work = page.getByRole('listitem').filter({ has: page.getByText('工作账号', { exact: true }) });
  await work.getByText('管理与关联', { exact: true }).click();
  await expect(work.getByRole('button', { name: '打开授权页面' })).toHaveCount(0);
  await work.getByRole('button', { name: '重新认证' }).click();
  await work.getByRole('button', { name: '打开授权页面' }).click();
  expect(await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'open_account_login_link'))).toEqual([{ command: 'open_account_login_link', args: { id: 'a', attemptId: 'attempt-1' } }]);
  await work.getByRole('button', { name: '取消登录' }).click();
  await expect(work.getByRole('button', { name: '打开授权页面' })).toHaveCount(0);
});

test('existing CLI login is visible without managed accounts and discovery never adopts it', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).oauthHarness.accounts = []; });
  expect(await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'discover_native_logins').length)).toBe(0);
  await page.getByRole('tab', { name: '账号', exact: true }).click();
  const native = page.getByLabel('CLI 原生登录');
  await expect(native.getByText('CLI 已登录', { exact: true })).toBeVisible();
  await expect(native.getByText('native@example.test', { exact: true })).toBeVisible();
  await expect(page.getByText(/还没有独立账号/)).toBeVisible();
  await expect(native.getByRole('button', { name: /^(退出|重新认证|登录)$/ })).toHaveCount(0);
  await page.evaluate(() => { (window as any).oauthHarness.nativeSnapshot.logins[0].state = 'expired'; });
  await native.getByRole('button', { name: '检查原生登录' }).click();
  await expect(native.getByText('认证失效', { exact: true })).toBeVisible();
  const commands = await page.evaluate(() => (window as any).oauthHarness.calls.map((call: any) => call.command));
  expect(commands.filter((command: string) => command === 'discover_native_logins')).toHaveLength(2);
  expect(commands.filter((command: string) => ['create_account', 'adopt_native_account', 'start_account_login', 'logout_account'].includes(command))).toEqual([]);
});

test('native discovery failure keeps managed accounts and offers a retry', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).oauthHarness.nativeFailure = '无法读取原生认证文件'; });
  await page.getByRole('tab', { name: '账号', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('无法读取原生认证文件');
  await expect(page.getByText('a@example.test · Plus')).toBeVisible();
  await page.evaluate(() => { (window as any).oauthHarness.nativeFailure = ''; });
  await page.getByRole('button', { name: '检查原生登录' }).click();
  await expect(page.getByText('CLI 已登录', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('OAuth profile saves and applies the selected account without an API connection', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('认证方式').selectOption('oauth');
  await expect(dialog.getByLabel('绑定账号')).toHaveValue(''); await dialog.getByLabel('绑定账号').selectOption('b'); await dialog.getByLabel('配置名称').fill('个人订阅');
  await page.screenshot({ path: 'test-results/oauth-binding.png', fullPage: true });
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '启用', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).oauthHarness.binding?.contextId)).toBe('ctx-b');
  const result = await page.evaluate(() => (window as any).oauthHarness);
  expect(result.profiles[0].authentication).toEqual({ kind: 'oauth', accountId: 'b' });
  expect(result.profiles[0].connection).toBeNull(); expect(result.profiles[0].nativeCredentials).toEqual({});
  expect(result.binding.contextId).toBe('ctx-b');
});


test('project without explicit binding edits and queries using its inherited effective account', async ({ page }) => {
  await setup(page, true);
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '继承项目' }).click();
  await page.getByRole('button', { name: '修改正在使用的文件', exact: true }).click();
  await page.getByRole('textbox', { name: 'settings 配置草稿' }).fill('model = "after"');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('button', { name: /project-server/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'project-skill' }).click();
  await expect(page.getByRole('checkbox', { name: '启用 Skill' })).toBeChecked();
  await page.getByRole('checkbox', { name: '启用 Skill' }).uncheck();
  const calls = await page.evaluate(() => (window as any).oauthHarness.calls);
  expect(calls.find((call: any) => call.command === 'save_registered_native_file').args).toMatchObject({ scope: 'project', expectedContextId: 'ctx-a' });
  expect(calls.find((call: any) => call.command === 'set_skill_enabled').args).toMatchObject({ scope: 'project', expectedContextId: 'ctx-a' });
  expect(await page.evaluate(() => (window as any).oauthHarness.binding)).toBeNull();
});

let pickerHarness: string;
test.beforeAll(async () => {
  const entry = 'virtual:account-picker-test';
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AccountPicker } from ${JSON.stringify(path.resolve('src/features/tools/AccountPicker.tsx'))};
    function Fixture() {
      const [picking,setPicking] = React.useState(false);
      const [draft,setDraft] = React.useState({name:'填写了一半',model:'draft-model',parameters:{temperature:0.25},connection:{baseUrl:'https://draft.example.test'},accountId:''});
      return React.createElement('main',null,
        React.createElement('div',{hidden:picking},React.createElement('label',null,'配置名称',React.createElement('input',{value:draft.name,onChange:event=>setDraft({...draft,name:event.target.value})})),
          React.createElement('button',{onClick:()=>setPicking(true)},'选择账号'),React.createElement('pre',{'aria-label':'原配置草稿'},JSON.stringify(draft))),
        picking && React.createElement(AccountPicker,{toolId:window.pickerFixture.toolId,selectedAccountId:draft.accountId,
          onSelect:account=>{window.pickerFixture.selections.push(account.id);setDraft(old=>({...old,accountId:account.id}));setPicking(false);},
          onBack:()=>{window.pickerFixture.backs++;setPicking(false);}}));
    }
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Fixture)));
  `;
  const result = await build({ configFile: false, logLevel: 'silent', plugins: [react(), { name: 'account-picker-test', resolveId: id => id === entry ? `\0${entry}` : undefined, load: id => id === `\0${entry}` ? source : undefined }], build: { write: false, minify: false, cssCodeSplit: false, rollupOptions: { input: entry, output: { inlineDynamicImports: true } } } });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string; source?: string | Uint8Array }[] };
  const code = output.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  const css = output.output.filter(item => item.type === 'asset' && typeof item.source === 'string').map(item => item.source).join('\n');
  pickerHarness = `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
});

async function mountPicker(page: Page, toolId = 'codex', managedLogin = true) {
  await page.addInitScript(({ toolId, managedLogin }) => {
    const account = (id: string, label: string) => ({ id, label, toolId, provider: 'fixture-provider', version: 1, state: 'signed_in', identity: { subject: id, email: `${id}@example.test`, plan: null, source: 'fixture' }, context: { id: `ctx-${id}` }, retiredContexts: [], pendingLogin: null, detail: null, checkedAt: null });
    const fixture = {
      toolId, accounts: [account('first', '第一个账号'), account('second', '第二个账号')] as any[], selections: [] as string[], backs: 0,
      calls: [] as {command: string; args: any}[], managedLogin, failCheck: false, failLogin: false, delayStart: false, delayCheck: false, cancelFailure: '',
      releaseStart: null as (() => void) | null, releaseCheck: null as (() => void) | null,
    };
    Object.assign(window, { isTauri: true, pickerFixture: fixture, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      fixture.calls.push({ command, args });
      if (command === 'list_accounts') return structuredClone(fixture.accounts);
      if (command === 'account_capabilities') return [{ toolId, managedLogin: fixture.managedLogin, importNative: false, methods: fixture.managedLogin ? ['browser', 'device'] : [], browserLink: true, reason: fixture.managedLogin ? '注册适配器提供原生登录' : '当前平台不支持受管登录' }];
      if (command === 'create_account') { const value = { ...account('new', args.label), state: 'signed_out', context: null, identity: null }; fixture.accounts.push(value); return structuredClone(value); }
      const value = fixture.accounts.find(item => item.id === args.id);
      if (command === 'start_account_login') {
        if (fixture.failLogin) throw { message: '原生登录启动失败' };
        value.version++; value.state = 'pending'; value.pendingLogin = { id: `attempt-${value.version}`, operation: 'login' };
        const response = structuredClone(value);
        if (fixture.delayStart) await new Promise<void>(resolve => { fixture.releaseStart = resolve; });
        return response;
      }
      if (command === 'cancel_account_login') { if (fixture.cancelFailure) throw { message: fixture.cancelFailure }; if (value.pendingLogin?.id === args.attemptId) { value.version++; value.state = 'signed_out'; value.pendingLogin = null; } return structuredClone(value); }
      if (command === 'check_account') {
        const response = fixture.failCheck ? { ...structuredClone(value), state: 'unknown', identity: null } : structuredClone(value);
        if (fixture.delayCheck) await new Promise<void>(resolve => { fixture.releaseCheck = resolve; });
        return response;
      }
      return null;
    } } });
  }, { toolId, managedLogin });
  await page.route('**/__account_picker_test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pickerHarness }));
  await page.goto('/__account_picker_test');
  await page.getByLabel('配置名称').fill('保留的配置草稿');
  await page.getByRole('button', { name: '选择账号', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择并返回' }).first()).toBeEnabled();
}

test('picker requires an explicit verified selection and keeps the calling draft', async ({ page }) => {
  await mountPicker(page);
  expect(await page.evaluate(() => (window as any).pickerFixture.selections)).toEqual([]);
  const second = page.getByRole('listitem', { name: '第二个账号' });
  await second.getByRole('button', { name: '选择并返回' }).click();
  await expect(page.getByLabel('配置名称')).toHaveValue('保留的配置草稿');
  const draft = JSON.parse(await page.getByLabel('原配置草稿').innerText());
  expect(draft).toEqual({ name: '保留的配置草稿', model: 'draft-model', parameters: { temperature: 0.25 }, connection: { baseUrl: 'https://draft.example.test' }, accountId: 'second' });
  const fixture = await page.evaluate(() => (window as any).pickerFixture);
  expect(fixture.selections).toEqual(['second']);
  expect(fixture.calls.filter((call: any) => call.command.includes('apply') || call.command.includes('save'))).toEqual([]);
  expect(fixture.calls.filter((call: any) => call.command === 'check_account')).toEqual([{ command: 'check_account', args: { id: 'second' } }]);
});

test('picker keeps failed verification in place and ignores a late selection after back', async ({ page }) => {
  await mountPicker(page);
  await page.evaluate(() => { (window as any).pickerFixture.failCheck = true; });
  await page.getByRole('listitem', { name: '第二个账号' }).getByRole('button', { name: '选择并返回' }).click();
  await expect(page.getByRole('alert')).toContainText('尚未核验为可用身份');
  expect(await page.evaluate(() => (window as any).pickerFixture.selections)).toEqual([]);
  await page.evaluate(() => { Object.assign((window as any).pickerFixture, { failCheck: false, delayCheck: true }); });
  await page.getByRole('listitem', { name: '第二个账号' }).getByRole('button', { name: '选择并返回' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).pickerFixture.releaseCheck)).toBe(true);
  await page.getByRole('button', { name: '返回配置' }).click();
  await page.evaluate(() => { (window as any).pickerFixture.releaseCheck(); });
  await expect(page.getByLabel('配置名称')).toHaveValue('保留的配置草稿');
  expect(await page.evaluate(() => (window as any).pickerFixture.selections)).toEqual([]);
  expect(JSON.parse(await page.getByLabel('原配置草稿').innerText()).accountId).toBe('');
});

test('picker login supports retry, cancellation and late identity suppression without automatic selection', async ({ page }) => {
  await mountPicker(page);
  await page.getByRole('button', { name: '登录新账号' }).click();
  await page.getByLabel('账号名称').fill('新登录');
  await page.evaluate(() => { (window as any).pickerFixture.failLogin = true; });
  await page.getByRole('button', { name: '添加并登录' }).click();
  await expect(page.getByRole('alert')).toHaveText('原生登录启动失败');
  await page.evaluate(() => { (window as any).pickerFixture.failLogin = false; });
  const added = page.getByRole('listitem', { name: '新登录' });
  await added.getByRole('button', { name: '重试登录' }).click();
  await expect(added.getByRole('status')).toContainText('等待原生身份核验');
  await expect(added.getByRole('button', { name: '选择并返回' })).toBeDisabled();
  await added.getByRole('button', { name: '打开授权页面' }).click();
  await added.getByRole('button', { name: '取消登录' }).click();
  await expect(page.getByText(/外部终端由你关闭/)).toBeVisible();
  await page.evaluate(() => {
    const value = (window as any).pickerFixture.accounts.find((account: any) => account.id === 'new');
    value.state = 'signed_in'; value.version++; value.identity = { subject: 'late', email: 'late@example.test' }; value.context = { id: 'ctx-late' };
  });
  await expect(added.getByText('late@example.test')).toBeVisible();
  await expect(added.getByRole('button', { name: '选择并返回' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).pickerFixture.selections)).toEqual([]);
  await added.getByRole('button', { name: '重试登录' }).click();
  await page.evaluate(() => {
    const value = (window as any).pickerFixture.accounts.find((account: any) => account.id === 'new');
    value.state = 'signed_in'; value.version++; value.pendingLogin = null; value.identity = { subject: 'verified', email: 'verified@example.test' }; value.context = { id: 'ctx-verified' };
  });
  await expect(added.getByText('verified@example.test')).toBeVisible();
  expect(await page.evaluate(() => (window as any).pickerFixture.selections)).toEqual([]);
  await added.getByRole('button', { name: '选择并返回' }).click();
  expect(JSON.parse(await page.getByLabel('原配置草稿').innerText()).accountId).toBe('new');
  const calls = await page.evaluate(() => (window as any).pickerFixture.calls);
  expect(calls.filter((call: any) => call.command === 'open_account_login_link')).toEqual([{ command: 'open_account_login_link', args: { id: 'new', attemptId: 'attempt-2' } }]);
  expect(calls.filter((call: any) => call.command.includes('apply'))).toEqual([]);
});

test('picker back while login is starting cancels the returned attempt and retains draft', async ({ page }) => {
  await mountPicker(page);
  await page.evaluate(() => { (window as any).pickerFixture.delayStart = true; });
  await page.getByRole('button', { name: '登录新账号' }).click();
  await page.getByRole('button', { name: '添加并登录' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).pickerFixture.releaseStart)).toBe(true);
  await page.getByRole('button', { name: '返回配置' }).click();
  await page.evaluate(() => { (window as any).pickerFixture.releaseStart(); });
  await expect.poll(() => page.evaluate(() => (window as any).pickerFixture.calls.filter((call: any) => call.command === 'cancel_account_login').length)).toBe(1);
  await expect(page.getByLabel('配置名称')).toHaveValue('保留的配置草稿');
  expect(await page.evaluate(() => (window as any).pickerFixture.selections)).toEqual([]);
});

test('registered capability supports a new tool and platform limitations hide managed login', async ({ page }) => {
  await mountPicker(page, 'registered-fixture', false);
  await expect(page.getByRole('button', { name: '登录新账号' })).toHaveCount(0);
  await page.getByText('登录支持范围', { exact: true }).click();
  await expect(page.getByText('当前平台不支持受管登录')).toBeVisible();
  await page.getByRole('listitem', { name: '第二个账号' }).getByRole('button', { name: '选择并返回' }).click();
  expect(JSON.parse(await page.getByLabel('原配置草稿').innerText()).accountId).toBe('second');
  expect(await page.evaluate(() => (window as any).pickerFixture.calls.filter((call: any) => call.command === 'create_account'))).toEqual([]);
});

async function addImpactFixture(page: Page, official = false) {
  await page.evaluate(official => {
    const fixture = (window as any).oauthHarness;
    fixture.profiles = [{ id: 'work-profile', tool: 'codex', name: '关联工作配置', version: 3, revision: 'profile-revision', authentication: { kind: 'oauth', accountId: 'a' }, inheritCommon: false, files: { settings: '' }, suppressed: {}, connection: null, nativeCredentials: {} }];
    fixture.queries = [{ id: 'work-quota', version: 2, generation: 1, config: { schemaVersion: 1, label: '关联工作额度', site: 'https://quota.example.test', identity: { accountId: 'a', contextId: 'ctx-old', profileId: 'work-profile', subject: 'account', subjectId: null }, program: official ? { kind: 'official', tool: 'codex', adapterVersion: 1 } : { kind: 'javascript', source: 'async function query() {}' }, parameters: {}, targets: [], enabled: true, refreshIntervalSeconds: 0 }, credentials: [] }];
    fixture.impacts.a = {
      accountId: 'a', accountVersion: 1, toolId: 'codex', currentContextId: 'ctx-a',
      contexts: [{ id: 'ctx-a', kind: 'current' }, { id: 'ctx-old', kind: 'retained' }],
      profiles: [{ id: 'work-profile', name: '关联工作配置', toolId: 'codex', version: 3, revision: 'profile-revision' }],
      scopes: [
        { bindingId: 'global-current', toolId: 'codex', profileId: 'work-profile', profileName: '关联工作配置', profileVersion: 3, scope: 'global', projectPath: null, projectName: null, contextId: 'ctx-old', contextKind: 'retained', active: true, needsReapply: true, canReapply: true, reason: '重新认证已完成，请应用新上下文', reapplyRequest: { accountId: 'a', expectedAccountVersion: 1, expectedContextId: 'ctx-a', toolId: 'codex', profileId: 'work-profile', expectedProfileVersion: 3, expectedProfileRevision: 'profile-revision', scope: 'global', projectPath: null, expectedBindingFingerprint: 'global-fingerprint' } },
        { bindingId: 'historical-project', toolId: 'codex', profileId: 'work-profile', profileName: '关联工作配置', profileVersion: 2, scope: 'project', projectPath: '/tmp/previous-project', projectName: '历史项目', contextId: 'ctx-old', contextKind: 'retained', active: false, needsReapply: true, canReapply: false, reason: '该范围已使用其他账号，不提供重新应用', reapplyRequest: null },
      ],
      usageReferences: [{ id: 'work-quota', label: '关联工作额度', version: 2, accountId: 'a', contextId: 'ctx-old', profileId: 'work-profile', contextKind: 'retained', enabled: true, needsRebind: true }],
    };
  }, official);
  await page.getByRole('tab', { name: '账号', exact: true }).click();
  const work = page.getByRole('listitem').filter({ has: page.getByText('工作账号', { exact: true }) });
  await expect(work.getByText('a@example.test · Plus')).toBeVisible();
  return work;
}

test('account impacts are loaded on demand with real configuration, scope and quota recovery links', async ({ page }) => {
  await setup(page); const work = await addImpactFixture(page);
  await expect(work.getByRole('button', { name: '重新认证' })).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'account_impact'))).toEqual([]);
  await work.getByText('管理与关联', { exact: true }).click();
  const impacts = work.getByLabel('工作账号的关联');
  await expect(impacts.getByText('关联工作配置 · 全局', { exact: true })).toBeVisible();
  await expect(impacts.getByText('关联工作配置 · 历史项目', { exact: true })).toBeVisible();
  await expect(impacts.getByText('关联工作额度 · 需重新绑定', { exact: true })).toBeVisible();
  await expect(impacts.getByRole('button', { name: '重新应用此范围' })).toHaveCount(1);
  await impacts.getByRole('button', { name: '打开额度设置' }).click();
  await expect(page.getByRole('dialog').getByLabel('查询名称')).toHaveValue('关联工作额度');
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  await impacts.getByRole('button', { name: '打开此范围配置' }).first().click();
  await expect(page.getByRole('tab', { name: '配置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('关联工作配置');
  expect(await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command.includes('apply')))).toEqual([]);
});

test('account reapply rejects changed intent and recovers from guarded backend failure', async ({ page }) => {
  await setup(page); const work = await addImpactFixture(page);
  await work.getByText('管理与关联', { exact: true }).click();
  const impacts = work.getByLabel('工作账号的关联');
  await expect(impacts.getByRole('button', { name: '重新应用此范围' })).toBeVisible();
  await page.evaluate(() => { (window as any).oauthHarness.impacts.a.scopes[0].reapplyRequest.expectedBindingFingerprint = 'changed-fingerprint'; });
  await impacts.getByRole('button', { name: '重新应用此范围' }).click();
  await expect(impacts.getByRole('alert')).toHaveText('账号或范围关联已变化，请刷新后再重新应用。');
  expect(await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'reapply_account_profile'))).toEqual([]);
  await impacts.getByRole('button', { name: '刷新关联' }).click();
  await page.evaluate(() => { (window as any).oauthHarness.applyFailure = '账号或范围已变化，请刷新后重新选择'; });
  await impacts.getByRole('button', { name: '重新应用此范围' }).click();
  await expect(impacts.getByRole('alert')).toContainText('刷新后重新选择');
  await page.evaluate(() => { (window as any).oauthHarness.applyFailure = ''; });
  await impacts.getByRole('button', { name: '刷新关联' }).click();
  await impacts.getByRole('button', { name: '重新应用此范围' }).click();
  await expect(impacts.getByRole('status')).toContainText('下次启动使用新的账号上下文');
  await expect(impacts.getByRole('button', { name: '重新应用此范围' })).toHaveCount(0);
  await expect(impacts.getByRole('alert')).toHaveCount(0);
  await expect(impacts.getByRole('button', { name: '刷新关联' })).toBeEnabled();
  await expect(impacts.getByText('正在使用 · 当前登录上下文', { exact: true })).toBeVisible();
  await expect(impacts.getByRole('status')).toContainText('下次启动使用新的账号上下文');
  expect(await page.evaluate(() => (window as any).oauthHarness.accounts.find((account: any) => account.id === 'a').version)).toBe(2);
  const calls = await page.evaluate(() => (window as any).oauthHarness.calls);
  expect(calls.filter((call: any) => call.command === 'apply_registered_native_profile')).toEqual([]);
  expect(calls.filter((call: any) => call.command === 'reapply_account_profile').at(-1).args.request).toEqual({ accountId: 'a', expectedAccountVersion: 1, expectedContextId: 'ctx-a', toolId: 'codex', profileId: 'work-profile', expectedProfileVersion: 3, expectedProfileRevision: 'profile-revision', scope: 'global', projectPath: null, expectedBindingFingerprint: 'changed-fingerprint' });
});

test('account impact failure has retry and destructive operations explain references while preserving protections', async ({ page }) => {
  await setup(page); const work = await addImpactFixture(page);
  await page.evaluate(() => { (window as any).oauthHarness.impactFailure = '引用数据库暂时不可用'; });
  await work.getByText('管理与关联', { exact: true }).click();
  const impacts = work.getByLabel('工作账号的关联');
  await expect(impacts.getByRole('alert')).toHaveText('引用数据库暂时不可用');
  await page.evaluate(() => { (window as any).oauthHarness.impactFailure = ''; });
  await impacts.getByRole('button', { name: '刷新关联' }).click();
  await expect(impacts.getByText('关联工作配置 · 全局', { exact: true })).toBeVisible();
  await work.getByRole('button', { name: '退出此账号' }).click();
  await expect(page.getByRole('dialog')).toContainText('关联工作配置');
  await expect(page.getByRole('dialog')).toContainText('关联工作额度');
  await expect(page.getByRole('dialog')).toContainText('管理记录仍保留');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText('已请求原生退出。该账号绑定的配置不能再启动；其他账号不受影响。')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'logout_account'))).toEqual([]);
  await work.getByRole('button', { name: '删除账号', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('不会退出或撤销授权');
  await page.getByRole('dialog').getByRole('button', { name: '删除账号', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '账号仍被配置、范围或额度引用' })).toBeVisible();
  await expect(work.getByRole('button', { name: '修改关联配置' })).toBeVisible();
  await expect(work.getByText('a@example.test · Plus')).toBeVisible();
});

test('picker cancellation failure stays recoverable before returning the preserved draft', async ({ page }) => {
  await mountPicker(page);
  await page.getByRole('button', { name: '登录新账号' }).click();
  await page.getByRole('button', { name: '添加并登录' }).click();
  const added = page.getByRole('listitem', { name: 'ChatGPT 账号' });
  await expect(added.getByRole('button', { name: '取消登录' })).toBeEnabled();
  await page.evaluate(() => { (window as any).pickerFixture.cancelFailure = '取消请求暂时失败'; });
  await page.getByRole('button', { name: '返回配置' }).click();
  await expect(page.getByRole('alert')).toHaveText('取消请求暂时失败');
  await expect(added.getByRole('button', { name: '选择并返回' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).pickerFixture.backs)).toBe(0);
  await page.evaluate(() => { (window as any).pickerFixture.cancelFailure = ''; });
  await page.getByRole('button', { name: '返回配置' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('配置名称')).toHaveValue('保留的配置草稿');
  expect(await page.evaluate(() => (window as any).pickerFixture.backs)).toBe(1);
  expect(await page.evaluate(() => (window as any).pickerFixture.selections)).toEqual([]);
});

test('account quota recovery opens the existing editor and requires explicit current-context selection', async ({ page }) => {
  await setup(page); const work = await addImpactFixture(page, true);
  await work.getByText('管理与关联', { exact: true }).click();
  await work.getByRole('button', { name: '打开额度设置' }).click();
  const dialog = page.getByRole('dialog');
  const selector = dialog.getByLabel('官方查询账号');
  await expect(selector).toHaveValue('a:ctx-old');
  await expect(selector.getByRole('option', { name: '原绑定已不可用，请重新选择' })).toHaveAttribute('disabled', '');
  await expect(selector.getByRole('option', { name: /个人账号/ })).toHaveCount(0);
  await selector.selectOption('a:ctx-a');
  await dialog.getByRole('button', { name: '保存查询', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).oauthHarness.calls);
  const saved = calls.find((call: any) => call.command === 'save_usage_query');
  expect(saved.args.draft.expectedVersion).toBe(2);
  expect(saved.args.draft.config.identity).toMatchObject({ accountId: 'a', contextId: 'ctx-a', profileId: 'work-profile' });
  expect(calls.filter((call: any) => call.command.includes('apply') || call.command === 'refresh_usage_query')).toEqual([]);
});

test('account scope link opens the explicitly selected project without applying or changing its binding', async ({ page }) => {
  await setup(page); const work = await addImpactFixture(page);
  await work.getByText('管理与关联', { exact: true }).click();
  const historical = work.getByRole('listitem').filter({ hasText: '关联工作配置 · 历史项目' });
  await expect(historical.getByRole('button', { name: '重新应用此范围' })).toHaveCount(0);
  await historical.getByRole('button', { name: '打开此范围配置' }).click();
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('关联工作配置');
  await expect.poll(() => page.evaluate(() => (window as any).oauthHarness.calls.filter((call: any) => call.command === 'get_registered_tool_workspace' && call.args.scope === 'project').length)).toBeGreaterThan(0);
  const fixture = await page.evaluate(() => (window as any).oauthHarness);
  expect(fixture.calls.filter((call: any) => call.command === 'get_registered_tool_workspace' && call.args.scope === 'project').at(-1).args.projectPath).toBe('/tmp/previous-project');
  expect(fixture.calls.filter((call: any) => call.command.includes('apply'))).toEqual([]);
  expect(fixture.binding).toBeNull();
});
