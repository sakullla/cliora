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

async function installRemoteRules(page: Page, options: { bound?: boolean; delay?: boolean; fail?: boolean; category?: string; versions?: boolean; recoveryRace?: boolean } = {}) {
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
    const state = { bound: options.bound ?? false, delay: options.delay ?? false, delaySave: false, delaySync: false, fail: options.fail ?? false, failAfterSync: false, saves: 0, fileVersion: 'old', attempts: [] as string[], reads: 0, delayReceipts: false, receiptLoads: 0, inspections: 0 };
    let receipt = { id: '7ae443eb-0ac1-4d44-b720-2e519f8f9665', targetId: host.id, targetRevision: host.updatedAt, identity: 'fixture', outcome: 'committing', items: [{ path: '$HOME/.cliora/library.json', state: 'applying', before: 'a'.repeat(64), after: 'b'.repeat(64), observed: null as string | null }] };
    if (options.recoveryRace) localStorage.setItem('cliora:remote-writes:v1', JSON.stringify([receipt]));
    const receiptReleases: Array<() => void> = [];
    const inspectionReleases: Array<() => void> = [];
    const snapshots = new Map<string, Record<string, string>>();
    const releases: Array<() => void> = [];
    const saveReleases: Array<() => void> = [];
    const syncReleases: Array<() => void> = [];
    const savedDrafts: Array<Record<string, unknown>> = [];
    const savedRule = { ...rule, category: options.category ?? rule.category };
    const placements = () => state.bound ? [{ ruleId: rule.id, toolId: 'codex', scope: 'global', projectPath: null, state: 'current', path: '/root/.codex/AGENTS.md' }] : [];
    Object.assign(window, {
      isTauri: true,
      __ruleCalls: calls,
      __ruleState: state,
      __ruleSavedDrafts: savedDrafts,
      __releaseReceiptList: () => receiptReleases.splice(0).forEach(release => release()),
      __releaseReceiptInspection: () => inspectionReleases.splice(0).forEach(release => release()),
      __releaseRulePlacements: () => { state.delay = false; releases.splice(0).forEach(release => release()); },
      __releaseRuleSave: () => { state.delaySave = false; saveReleases.splice(0).forEach(release => release()); },
      __releaseRuleSync: () => { state.delaySync = false; syncReleases.splice(0).forEach(release => release()); },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'sync_rule_clients' || command === 'sync_remote_rule_clients' || command === 'list_remote_rule_placements' || command === 'list_rule_placements') {
            calls.push({ command, targetId: args.targetId, ruleId: args.ruleId, selection: args.selection });
          }
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (options.recoveryRace && command === 'list_remote_write_receipts') {
            state.receiptLoads++;
            const snapshot = structuredClone(receipt);
            if (state.delayReceipts) await new Promise<void>(resolve => receiptReleases.push(resolve));
            return [snapshot];
          }
          if (options.recoveryRace && command === 'inspect_remote_write') {
            state.inspections++;
            await new Promise<void>(resolve => inspectionReleases.push(resolve));
            receipt = { ...receipt, outcome: 'committed', items: receipt.items.map(item => ({ ...item, state: 'committed', observed: 'after' })) };
            return structuredClone(receipt);
          }
          if (command === 'get_remote_write_snapshot') return snapshots.get(args.requestId) ?? {};
          if (command === 'list_remote_library_items') { state.reads++; if (options.versions) snapshots.set(args.operation.requestId, { '/root/.cliora/library.json': state.fileVersion }); return args.kind === 'rule' ? [{ ...savedRule }] : []; }
          if (command === 'list_remote_rule_placements') {
            const rows = placements();
            if (state.delay) await new Promise<void>(resolve => releases.push(resolve));
            if (state.fail) throw { message: 'fixture placement denied' };
            return rows;
          }
          if (command === 'save_remote_library_item') { if (options.versions) { const expected = args.operation.expectedFiles['/root/.cliora/library.json']; state.attempts.push(expected); if (expected !== state.fileVersion) throw { message: 'fixture version conflict; preserve draft' }; } state.saves++; savedDrafts.push({ ...args.draft }); if (state.delaySave) await new Promise<void>(resolve => saveReleases.push(resolve)); Object.assign(savedRule, args.draft, { version: savedRule.version + 1 }); return { ...savedRule }; }
          if (command === 'sync_remote_rule_clients') { if (state.delaySync) await new Promise<void>(resolve => syncReleases.push(resolve)); if (state.failAfterSync) state.fail = true; return [{ toolId: 'codex', path: '/root/.codex/AGENTS.md', status: 'written', detail: '已写入拼接后的规则', existing: '', proposed: '' }]; }
          if (command === 'list_library_items' || command === 'list_projects' || command === 'list_accounts' || command === 'list_mcp_definitions' || command === 'list_mcp_placements' || command === 'list_skill_packages' || command === 'list_remote_resource_stores') return [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          return [];
        },
      },
    });
  }, { host, rule, options });
}

test('inspection survives close/reopen and a delayed old receipt list, then permits a normal rule save', async ({ page }) => {
  await installRemoteRules(page, { recoveryRace: true }); await page.goto('/');
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  const recovery = page.getByRole('dialog', { name: '远程写入与恢复', exact: true });
  await expect.poll(() => page.evaluate(() => (window as any).__ruleState.receiptLoads)).toBe(1);
  await recovery.getByRole('button', { name: '核查实际结果', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__ruleState.inspections)).toBe(1);
  await recovery.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => { (window as any).__ruleState.delayReceipts = true; });
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__ruleState.receiptLoads)).toBe(2);
  await page.evaluate(() => (window as any).__releaseReceiptInspection());
  await expect(recovery.getByText('已确认提交', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__releaseReceiptList());
  await expect(recovery.getByRole('button', { name: '刷新回执', exact: true })).toBeEnabled();
  await expect(recovery.getByText('已确认提交', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cliora:remote-writes:v1')!)[0].outcome)).toBe('committed');
  await recovery.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('存在未确认的远程写入，请先核查回执，保留草稿并勿直接重试。')).toHaveCount(0);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('textbox', { name: '资料正文', exact: true }).fill('save after settled inspection');
  await editor.locator('[data-dialog-save]').click();
  await expect(editor).toBeHidden();
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(1);
});

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
  await expect(dialog.getByRole('textbox', { name: '资料正文', exact: true })).toHaveAttribute('aria-readonly', 'false');
  await expect(dialog.getByLabel('标题', { exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
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

for (const failedReadback of [false, true]) test(`rule draft controls and closing stay locked throughout saving (${failedReadback ? 'failed readback' : 'success'})`, async ({ page }) => {
  await installRemoteRules(page, { bound: true, category: 'suggested tag' });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await expect(page.getByRole('button', { name: 'Codex · 已生效', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByRole('textbox', { name: '资料正文', exact: true });
  await dialog.getByLabel('标题', { exact: true }).fill('title at submit');
  await dialog.getByLabel('添加标签').fill('submit tag');
  await dialog.getByLabel('添加标签').press('Enter');
  await dialog.getByRole('button', { name: 'suggested tag ×', exact: true }).click();
  await editor.fill('draft at submit');
  await page.evaluate((fail) => { Object.assign((window as any).__ruleState, { delay: true, delaySave: true, delaySync: true, failAfterSync: fail }); }, failedReadback);
  await dialog.locator('[data-dialog-save]').click();

  async function expectLocked(expectSuggestion = false) {
    await expect(dialog.getByLabel('标题', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '关联项目', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('添加标签')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'submit tag ×', exact: true })).toBeDisabled();
    if (expectSuggestion) await expect(dialog.getByRole('button', { name: 'suggested tag', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    await expect(dialog.locator('[data-dialog-save]')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
    await expect(editor).toHaveAttribute('aria-readonly', 'true');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('new edit during save');
    await expect(editor).toHaveText('draft at submit');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }

  await expectLocked(true); // Fresh placement preflight has not written the body.
  // Guard replacement callbacks too, including callers outside the modal's pointer boundary.
  await page.getByRole('button', { name: '新建规则', exact: true }).evaluate(button => button.click());
  await page.getByRole('button', { name: '远端规则', exact: true }).evaluate(button => button.click());
  await page.getByRole('tab', { name: /提示词/ }).evaluate(tab => tab.click());
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue('title at submit');
  await expect(page.getByRole('tab', { name: /长期规则/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(0);
  await page.evaluate(() => (window as any).__releaseRulePlacements());
  await expect.poll(() => page.evaluate(() => (window as any).__ruleState.saves)).toBe(1);
  await expectLocked(true); // Body persistence.
  await page.evaluate(() => (window as any).__releaseRuleSave());
  await expect.poll(() => page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'sync_remote_rule_clients').length)).toBe(1);
  await expectLocked(); // Actual CLI synchronization.
  await page.evaluate(() => { (window as any).__ruleState.delay = true; (window as any).__releaseRuleSync(); });
  await expect.poll(() => page.evaluate(() => (window as any).__ruleCalls.filter((call: any) => call.command === 'list_remote_rule_placements').length)).toBeGreaterThanOrEqual(3);
  await expectLocked(); // Post-write placement readback.
  await page.evaluate(() => (window as any).__releaseRulePlacements());
  expect(await page.evaluate(() => (window as any).__ruleSavedDrafts)).toMatchObject([{ title: 'title at submit', body: 'draft at submit', category: 'submit tag', projectId: null }]);
  if (!failedReadback) {
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'title at submit', exact: true }).click();
  } else {
    await expect(dialog.getByText('规则已写入，但写入状态读取失败。请重试读取后核查。')).toBeVisible();
  }
  await expect(editor).toHaveText('draft at submit');
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await expect(dialog.getByLabel('标题', { exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '关联项目', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('添加标签')).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'submit tag ×', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '删除', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(1);
});


test('a rule draft retains its original CAS baseline across search refresh and explicitly reopening accepts the new version', async ({ page }) => {
  await installRemoteRules(page, { versions: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByRole('textbox', { name: '资料正文', exact: true });
  await editor.fill('keep this user draft');
  const reads = await page.evaluate(() => { const state = (window as any).__ruleState; state.fileVersion = 'external'; return state.reads; });
  // Deliver a query update while the modal retains the same React draft.
  // Native modal focus trapping otherwise redirects synthetic keyboard input.
  await page.getByRole('textbox', { name: '搜索资料' }).evaluate(element => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '远端');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__ruleState.reads)).toBeGreaterThan(reads);
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog.getByText('fixture version conflict; preserve draft')).toBeVisible();
  await expect(editor).toHaveText('keep this user draft');
  expect(await page.evaluate(() => (window as any).__ruleState.attempts)).toEqual(['old']);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  await editor.fill('rebuilt from refreshed version');
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__ruleState.attempts)).toEqual(['old', 'external']);
});


test('a persisted unknown write blocks another rule save before native submission', async ({ page }) => {
  await installRemoteRules(page);
  await page.addInitScript(() => {
    localStorage.setItem('cliora:remote-writes:v1', JSON.stringify([{ id: '7ae443eb-0ac1-4d44-b720-2e519f8f9665', targetId: 'host-1', targetRevision: 1, identity: 'fixture', outcome: 'preparing', items: [] }]));
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await page.getByRole('button', { name: '远端规则', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '资料正文', exact: true }).fill('preserve blocked draft');
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog.getByText(/存在未确认的远程写入/)).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '资料正文', exact: true })).toHaveText('preserve blocked draft');
  expect(await page.evaluate(() => (window as any).__ruleState.saves)).toBe(0);
});
