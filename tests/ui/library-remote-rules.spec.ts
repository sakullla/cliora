import { expect, test, type Page } from '@playwright/test';

const host = {
  id: 'host-1',
  name: '测试远程主机',
  host: '212.60.153.19',
  port: 22,
  user: 'root',
  authMethod: 'key',
  identityFile: '',
  sshConfig: null,
  defaultPath: '/srv/project',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const rule = {
  id: 'remote-rule-1',
  kind: 'rule',
  title: '远端规则',
  body: 'stay remote',
  category: '',
  projectId: null,
  version: 1,
  updatedAt: 1,
};

async function installRemoteRules(page: Page, options: { bound?: boolean; delay?: boolean; fail?: boolean } = {}) {
  await page.addInitScript(({ host, rule, options }) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const registered = Object.entries(names).map(([id, name]) => ({
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
      management: { accounts: false, mcp: true, skills: true, agents: false, plugins: false, projectPlugins: false, rules: { global: true, project: false, catalog: false, globalReason: '', projectReason: '' } },
    }));
    const calls: Array<Record<string, unknown>> = [];
    const state = { bound: options.bound ?? false, delay: options.delay ?? false, fail: options.fail ?? false, failAfterSync: false, saves: 0 };
    const releases: Array<() => void> = [];
    const savedRule = { ...rule };
    const placements = () => state.bound ? [{ ruleId: rule.id, toolId: 'codex', scope: 'global', projectPath: null, state: 'current', path: '/root/.codex/AGENTS.md' }] : [];
    Object.assign(window, {
      isTauri: true,
      __ruleCalls: calls,
      __ruleState: state,
      __releaseRulePlacements: () => { state.delay = false; releases.splice(0).forEach(release => release()); },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'sync_rule_clients' || command === 'sync_remote_rule_clients' || command === 'list_remote_rule_placements' || command === 'list_rule_placements') {
            calls.push({ command, targetId: args.targetId, ruleId: args.ruleId, selection: args.selection });
          }
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_library_items') return args.kind === 'rule' ? [savedRule] : [];
          if (command === 'list_remote_rule_placements') {
            if (state.fail) throw { message: 'fixture placement denied' };
            const rows = placements();
            if (state.delay) await new Promise<void>(resolve => releases.push(resolve));
            return rows;
          }
          if (command === 'save_remote_library_item') { state.saves++; Object.assign(savedRule, args.draft, { version: savedRule.version + 1 }); return { ...savedRule }; }
          if (command === 'sync_remote_rule_clients') { if (state.failAfterSync) state.fail = true; return [{ toolId: 'codex', path: '/root/.codex/AGENTS.md', status: 'written', detail: '已写入拼接后的规则', existing: '', proposed: '' }]; }
          if (command === 'list_library_items' || command === 'list_projects' || command === 'list_accounts' || command === 'list_mcp_definitions' || command === 'list_mcp_placements' || command === 'list_skill_packages' || command === 'list_remote_resource_stores') return [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          return [];
        },
      },
    });
  }, { host, rule, options });
}

test('a remote rule icon writes that host, not this computer', async ({ page }) => {
  await installRemoteRules(page);
  await page.goto('/');
  await expect(page.locator('.sidebar-host').getByRole('button', { name: '运行位置：测试远程主机' })).toBeVisible();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await expect(page.getByRole('button', { name: '远端规则' })).toBeVisible();
  await page.getByRole('button', { name: 'Codex · 未写入' }).click();
  await expect(page.getByText('已写入 Codex。')).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __ruleCalls: Array<{ command: string; targetId?: string; ruleId?: string; selection?: { toolIds?: string[]; scope?: string } }> }).__ruleCalls);
  expect(calls.filter((call) => call.command === 'sync_rule_clients')).toEqual([]);
  expect(calls.filter((call) => call.command === 'list_rule_placements')).toEqual([]);
  const synced = calls.filter((call) => call.command === 'sync_remote_rule_clients');
  expect(synced).toHaveLength(1);
  expect(synced[0].targetId).toBe(host.id);
  expect(synced[0].ruleId).toBe(rule.id);
  expect(synced[0].selection?.toolIds).toEqual(['codex']);
  expect(synced[0].selection?.scope).toBe('global');
});


for (const order of ['before', 'after'] as const) test(`delayed nonempty rule placements resolve ${order} query changes and still synchronize saves`, async ({ page }) => {
  await installRemoteRules(page, { bound: true, delay: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'list_remote_rule_placements').length)).toBeGreaterThan(0);
  if (order === 'before') await page.evaluate(() => (window as any).__releaseRulePlacements());
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await page.getByRole('textbox', { name: '搜索资料' }).fill('远端');
  if (order === 'after') await page.evaluate(() => (window as any).__releaseRulePlacements());
  await expect(page.getByRole('button', { name: 'Codex · 已生效', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByRole('textbox', { name: '资料正文', exact: true });
  await editor.fill('new rule body');
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toBeHidden();
  const calls = await page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'sync_remote_rule_clients'));
  expect(calls).toHaveLength(1);
  expect(calls[0].selection.toolIds).toEqual(['codex']);
});


test('unknown placements block rule saves until the nonempty binding has loaded', async ({ page }) => {
  await installRemoteRules(page, { bound: true, delay: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await expect(page.getByRole('button', { name: 'Codex · 写入状态尚未确定', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '资料正文', exact: true }).fill('pending binding draft');
  await expect(dialog.locator('[data-dialog-save]')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(0);
  await page.evaluate(() => (window as any).__releaseRulePlacements());
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toBeHidden();
  const synced = await page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'sync_remote_rule_clients'));
  expect(synced).toHaveLength(1);
  expect(synced[0].selection.toolIds).toEqual(['codex']);
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(1);
});

for (const initialFailure of [false, true]) test(`binding failure (${initialFailure ? 'initial' : 'revalidation'}) keeps the rule draft and recovers with an actual sync`, async ({ page }) => {
  await installRemoteRules(page, { bound: true, fail: initialFailure });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  if (!initialFailure) await expect(page.getByRole('button', { name: 'Codex · 已生效', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '资料正文', exact: true }).fill('preserve failed binding draft');
  if (!initialFailure) {
    await page.evaluate(() => { (window as any).__ruleState.fail = true; });
    await dialog.locator('[data-dialog-save]').click();
    await expect(dialog.getByText(/规则写入状态刷新失败/)).toBeVisible();
  }
  await expect(dialog.locator('[data-dialog-save]')).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: '资料正文', exact: true })).toHaveText('preserve failed binding draft');
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(0);
  expect(await page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'sync_remote_rule_clients'))).toHaveLength(0);
  await page.evaluate(() => { (window as any).__ruleState.fail = false; });
  await dialog.getByRole('button', { name: '重试写入状态', exact: true }).click();
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  await expect(dialog.getByRole('textbox', { name: '资料正文', exact: true })).toHaveText('preserve failed binding draft');
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toBeHidden();
  const synced = await page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'sync_remote_rule_clients'));
  expect(synced).toHaveLength(1);
  expect(synced[0].selection.toolIds).toEqual(['codex']);
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(1);
});

test('a successful write followed by failed placement readback stays open with an explicit recovery message', async ({ page }) => {
  await installRemoteRules(page, { bound: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await expect(page.getByRole('button', { name: 'Codex · 已生效', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '资料正文', exact: true }).fill('body actually saved');
  await page.evaluate(() => { (window as any).__ruleState.failAfterSync = true; });
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog.getByText('规则已写入，但写入状态读取失败。请重试读取后核查。')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '资料正文', exact: true })).toHaveText('body actually saved');
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(1);
  expect(await page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'sync_remote_rule_clients'))).toHaveLength(1);
  await page.evaluate(() => { (window as any).__ruleState.fail = false; });
  await dialog.getByRole('button', { name: '重试写入状态', exact: true }).click();
  await expect(dialog.getByText(/规则写入状态刷新失败/)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(1);
  expect(await page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'sync_remote_rule_clients'))).toHaveLength(1);
});
