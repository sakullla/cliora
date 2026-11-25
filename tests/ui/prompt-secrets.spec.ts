import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPromptFixtureBridge, installRichPromptFixtures } from '../../scripts/capture-prompt-fixtures.mjs';

// The value is a synthetic canary: it may only enter the dedicated secret commands.
const CANARY = 'canary-ui-4c1d2e';
const referenceOf = (id: string) => `{{cliora-secret:${id}}}`;

async function install(page: Page, remote = false) {
  await page.addInitScript((remote: boolean) => {
    if (remote) localStorage.setItem('cliora:remote-target', 'remote-a');
    const handlers: Record<string, number> = {};
    const callbacks: Array<(value: unknown) => void> = [];
    const target = { id: 'remote-a', name: 'Fixture host', host: 'fixture.invalid', user: 'fixture', port: 22, enabled: true, authMethod: 'key', identityFile: null, sshConfig: null, defaultPath: '/srv', createdAt: 1, updatedAt: 1 };
    const calls: Array<{ command: string; args: unknown }> = [];
    const allCalls: Array<{ command: string; text: string }> = [];
    const secretCalls: string[] = [];
    const copied: string[] = [];
    const secrets: Array<{ id: string; alias: string; version: number; value: string }> = [];
    const grants: Array<{ secretId: string; installationId: string; alias: string; executorId: string; executorLabel: string }> = [];
    const state = { failCreate: false };
    const direct = new Set<string>();
    const reference = (id: string) => `{{cliora-secret:${id}}}`;
    const describe = (secret: { id: string; alias: string; version: number }) => ({ id: secret.id, alias: secret.alias, reference: reference(secret.id), version: secret.version, createdAt: 1, updatedAt: 1, status: 'available' });
    const stale = () => { throw { message: '秘密已更新，请重新读取后再修改' }; };
    const missing = () => { throw { message: '秘密已不存在，请重新选择引用' }; };
    const references = (body: string) => [...new Set([...body.matchAll(/\{\{cliora-secret:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/g)].map(match => match[1]))];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(String(text)); } } });
    Object.assign(window, {
      isTauri: true,
      __promptBaseCalls: calls,
      __allCalls: allCalls,
      __secretCalls: secretCalls,
      __secretFixture: state,
      __copied: copied,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => { callbacks.push(callback); return callbacks.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          calls.push({ command, args });
          allCalls.push({ command, text: JSON.stringify(args, (_key, value) => typeof value === 'function' ? undefined : value) });
          if (command.includes('secret')) secretCalls.push(command);
          if (command === 'secret_access_options') return {
            cli: { executable: 'C:\\Cliora\\cliora.exe', entry: '--cliora-internal-secret-cli-v1' },
            installations: [{ id: 'local-fixture', kind: 'cli', targetId: null, revoked: false },
              { id: 'ai-fixture', kind: 'cli', directReadOnly: true, targetId: 'cliora-direct', revoked: false }],
            directReads: secrets.filter(s => direct.has(s.id)).map(s => ({ installationId: 'ai-fixture', secretId: s.id, alias: s.alias })),
            grants, executors: [], availablePrograms: ['node'],
          };
          if (command === 'save_secret_executor') return { ...args.executor, id: 'fixture-action' };
          if (command === 'grant_secret_usage') {
            grants.push({ secretId: args.secretId, installationId: args.installationId, alias: secrets.find(s => s.id === args.secretId)!.alias, executorId: args.executorId, executorLabel: '测试传递' });
            return null;
          }
          if (command === 'list_secret_grants') return grants.filter(grant => grant.secretId === args.secretId);
          if (command === 'launch_cli') return { toolId: 'codex', terminal: 'workbench', status: 'session_started', sessionId: null };
          if (command === 'set_secret_direct_read') {
            if (args.enabled) direct.add(args.secretId); else direct.delete(args.secretId);
            return null;
          }
          if (command === 'list_prompt_secret_page') return { items: secrets.map(describe), total: secrets.length, matched: secrets.length, grantCounts: {}, directReadIds: [...direct], offset: 0 };
          if (command === 'list_prompt_secrets') return secrets.map(describe);
          if (command === 'create_prompt_secret') {
            if (state.failCreate) throw { message: 'fixture: 秘密原值写入失败' };
            if (secrets.some(item => item.alias === String(args.alias).trim())) throw { message: '已存在同名秘密，请换一个别名' };
            const created = { id: args.referenceId ?? crypto.randomUUID(), alias: String(args.alias).trim(), version: 1, value: String(args.value) };
            secrets.push(created);
            return describe(created);
          }
          if (command === 'rename_prompt_secret') {
            const secret = secrets.find(item => item.id === args.id) ?? missing();
            if (secret.version !== args.expectedVersion) stale();
            if (secrets.some(item => item.id !== secret.id && item.alias === String(args.alias).trim())) throw { message: '已存在同名秘密，请换一个别名' };
            secret.alias = String(args.alias).trim();
            secret.version += 1;
            return describe(secret);
          }
          if (command === 'update_prompt_secret_value') {
            const secret = secrets.find(item => item.id === args.id) ?? missing();
            if (secret.version !== args.expectedVersion) stale();
            secret.value = String(args.value);
            secret.version += 1;
            return describe(secret);
          }
          if (command === 'delete_prompt_secret') {
            const index = secrets.findIndex(item => item.id === args.id);
            if (index < 0) missing();
            if (secrets[index].version !== args.expectedVersion) stale();
            secrets.splice(index, 1);
            return null;
          }
          if (command === 'resolve_prompt_secret_references') return references(String(args.body ?? '')).map(id => {
            const secret = secrets.find(item => item.id === id);
            return { id, reference: reference(id), alias: secret?.alias ?? null, status: secret ? 'available' : 'unknown' };
          });
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: remote }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', launchForm: 'terminal', interfaceFormats: [], nativeConfig: { state: 'supported', reason: '' }, launch: { state: 'supported', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings' || command === 'set_preferred_terminal') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], worktreeLaunch: 'direct' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_remote_targets') return remote ? [target] : [];
          if (command === 'list_workbench_sessions') return [];
          if (command === 'plugin:event|listen') { handlers[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'get_registered_tool_workspace') return { profiles: [], snapshots: [], recoveryNeeded: [], common: null, customPath: null, probe: { selectedPath: '/fixture/codex', installations: [{ path: '/fixture/codex', version: '0.160.0', status: 'available' }], nativeFiles: [], interfaceFormats: [], providerPresets: [], dependencies: [], nativeWrites: { state: 'supported', reason: '' }, installUrl: '', upgradeHint: '' } };
          if (command.startsWith('list_')) return [];
          return null;
        },
      },
    });
  }, remote);
  await page.addInitScript(installPromptFixtureBridge);
  await page.addInitScript(installRichPromptFixtures);
  await page.goto('/');
}

async function library(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  return page.locator('[data-prompt-library]');
}
async function newPrompt(page: Page) {
  await page.getByRole('button', { name: '新建提示词', exact: true }).click();
  return page.getByRole('dialog', { name: '新建提示词' });
}
const secretPanel = (dialog: Locator) => dialog.locator('[data-prompt-secrets]');
async function createSecret(dialog: Locator, alias: string, value: string) {
  const panel = secretPanel(dialog);
  await panel.locator('[data-secret-create]').click();
  await panel.locator('[data-secret-alias]').fill(alias);
  await panel.locator('[data-secret-value]').fill(value);
  await panel.locator('[data-secret-submit]').click();
  return panel.locator('[data-secret-id]').filter({ hasText: alias });
}
const bodyOf = (dialog: Locator) => dialog.getByRole('textbox', { name: '资料正文', exact: true });
const titleOf = (dialog: Locator) => dialog.getByRole('textbox', { name: '标题', exact: true });

test('a created secret inserts only its reference and never reaches prompt content', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('部署步骤');
  // A first-time user sees what the panel does before anything is stored.
  await expect(secretPanel(dialog).locator('[data-secret-empty]')).toBeVisible();
  const row = await createSecret(dialog, '生产口令', CANARY);
  await expect(secretPanel(dialog).locator('[data-secret-empty]')).toHaveCount(0);
  const id = await row.getAttribute('data-secret-id');
  const reference = referenceOf(id!);
  await expect(row).toHaveAttribute('data-secret-status', 'available');
  await expect(bodyOf(dialog)).toHaveValue(reference);
  await expect(secretPanel(dialog).locator(`[data-secret-reference="${reference}"]`)).toHaveAttribute('data-secret-reference-status', 'available');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = await page.evaluate(() => (window as unknown as { __promptFixture: any }).__promptFixture.documents.local.find((item: any) => item.title === '部署步骤'));
  expect(saved.body).toBe(reference);
  // The value only ever entered the dedicated secret command.
  const surface = await page.evaluate(() => {
    const app = window as unknown as { __promptFixture: any; __allCalls: Array<{ command: string; text: string }> };
    return { documents: JSON.stringify(app.__promptFixture.documents), calls: JSON.stringify(app.__allCalls.filter(call => !['create_prompt_secret', 'update_prompt_secret_value'].includes(call.command))) };
  });
  expect(surface.documents).not.toContain(CANARY);
  expect(surface.calls).not.toContain(CANARY);
  expect(surface.documents).toContain(reference);
});

test('alias and value updates keep the same reference and never render the stored value', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('引用稳定');
  const panel = secretPanel(dialog);
  const row = await createSecret(dialog, '旧别名', CANARY);
  const id = await row.getAttribute('data-secret-id');
  const reference = referenceOf(id!);
  await expect(bodyOf(dialog)).toHaveValue(reference);

  await panel.locator('[data-secret-id] button[aria-haspopup="menu"]').click();
  await dialog.locator('[data-secret-rename]').click();
  await panel.locator('[data-secret-rename-value]').fill('新别名');
  await panel.locator('[data-secret-rename-save]').click();
  await expect(panel.locator('[data-secret-id]').filter({ hasText: '新别名' })).toHaveCount(1);
  await expect(panel.locator(`[data-secret-reference="${reference}"]`)).toContainText('新别名');
  await expect(bodyOf(dialog)).toHaveValue(reference);

  await panel.locator('[data-secret-id] button[aria-haspopup="menu"]').click();
  await dialog.locator('[data-secret-update]').click();
  await panel.locator('[data-secret-update-value]').fill('replacement-value-77');
  await panel.locator('[data-secret-update-save]').click();
  await expect(panel.locator('[data-secret-update-value]')).toHaveCount(0);
  await expect(panel.locator('[data-secret-value]')).toHaveCount(0);
  await expect(panel.locator('[data-secret-id]')).toHaveAttribute('data-secret-status', 'available');
  expect(await page.evaluate(() => document.body.innerText.includes('replacement-value-77'))).toBe(false);
  await expect(bodyOf(dialog)).toHaveValue(reference);
});

test('deleting a secret invalidates old references even after recreating the alias', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('失效引用');
  const panel = secretPanel(dialog);
  const row = await createSecret(dialog, '数据库口令', CANARY);
  const reference = referenceOf((await row.getAttribute('data-secret-id'))!);
  await expect(bodyOf(dialog)).toHaveValue(reference);

  await panel.locator('[data-secret-id] button[aria-haspopup="menu"]').click();
  await dialog.locator('[data-secret-remove]').click();
  const confirm = page.getByRole('dialog', { name: '删除秘密' });
  await confirm.getByRole('button', { name: '删除秘密', exact: true }).click();
  await expect(panel.locator('[data-secret-id]')).toHaveCount(0);
  await expect(panel.locator(`[data-secret-reference="${reference}"]`)).toHaveAttribute('data-secret-reference-status', 'unknown');
  // A broken reference turns the whole strip into a warning instead of a quiet chip.
  await expect(panel.locator('[data-secret-references]')).toHaveAttribute('data-problem', 'true');
  // The prompt body keeps the reference text so the draft stays editable.
  await expect(bodyOf(dialog)).toHaveValue(reference);

  const recreated = await createSecret(dialog, '数据库口令', 'replacement-value-88');
  const fresh = referenceOf((await recreated.getAttribute('data-secret-id'))!);
  expect(fresh).not.toBe(reference);
  await expect(panel.locator(`[data-secret-reference="${reference}"]`)).toHaveAttribute('data-secret-reference-status', 'unknown');
  await expect(panel.locator(`[data-secret-reference="${fresh}"]`)).toHaveAttribute('data-secret-reference-status', 'available');
});

test('a failed secret save keeps the draft and inserts no reference', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('保存失败');
  await bodyOf(dialog).fill('已有草稿');
  const panel = secretPanel(dialog);
  await page.evaluate(() => { (window as unknown as { __secretFixture: { failCreate: boolean } }).__secretFixture.failCreate = true; });
  await panel.locator('[data-secret-create]').click();
  await panel.locator('[data-secret-alias]').fill('失败别名');
  await panel.locator('[data-secret-value]').fill(CANARY);
  await panel.locator('[data-secret-submit]').click();
  await expect(panel.locator('[data-secret-error]')).toContainText('秘密原值写入失败');
  await expect(bodyOf(dialog)).toHaveValue('已有草稿');
  await expect(panel.locator('[data-secret-id]')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __secretFixture: { failCreate: boolean } }).__secretFixture.failCreate = false; });
  const row = await createSecret(dialog, '失败别名', CANARY);
  await expect(row).toHaveAttribute('data-secret-status', 'available');
  await expect(bodyOf(dialog)).toHaveValue(new RegExp(`^已有草稿 \\{\\{cliora-secret:[0-9a-f-]{36}\\}\\}$`));
});

test('a failed prompt save keeps the draft and its reference text', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('保存失败提示词');
  const row = await createSecret(dialog, '部署口令', CANARY);
  const reference = referenceOf((await row.getAttribute('data-secret-id'))!);
  await page.evaluate(() => { (window as unknown as { __promptFixture: { failTitle: string } }).__promptFixture.failTitle = '保存失败提示词'; });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(bodyOf(dialog)).toHaveValue(reference);
  await expect(titleOf(dialog)).toHaveValue('保存失败提示词');
  expect(await page.evaluate(() => (window as unknown as { __promptFixture: any }).__promptFixture.documents.local.some((item: any) => item.title === '保存失败提示词'))).toBe(false);
});

test('a remote library context never reads or creates a device secret', async ({ page }) => {
  await install(page, true);
  const panel = await library(page);
  await panel.getByRole('button', { name: '远端审查', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑提示词' });
  const secrets = secretPanel(dialog);
  await expect(secrets).toHaveAttribute('data-secret-local', 'false');
  await expect(secrets.locator('[data-secret-local-only]')).toBeVisible();
  await expect(secrets.locator('[data-secret-create]')).toHaveCount(0);
  await expect(secrets.locator('[data-secret-id]')).toHaveCount(0);
  const reference = referenceOf('11111111-2222-4333-8444-555555555555');
  await bodyOf(dialog).fill(`remote body\n${reference}`);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const remote = await page.evaluate(() => (window as unknown as { __promptFixture: any }).__promptFixture.documents['remote-a'].find((item: any) => item.id === 'remote-only').body);
  expect(remote).toBe(`remote body\n${reference}`);
  expect(await page.evaluate(() => (window as unknown as { __secretCalls: string[] }).__secretCalls)).toEqual([]);
});

test('copying and searching a prompt expose the reference text only', async ({ page }) => {
  await install(page);
  const list = await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('运维交接');
  const row = await createSecret(dialog, '运维口令', CANARY);
  const reference = referenceOf((await row.getAttribute('data-secret-id'))!);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();

  const search = list.getByRole('textbox', { name: '搜索资料' });
  await search.fill('运维交接');
  const card = list.locator('article').filter({ hasText: '运维交接' });
  await expect(card.locator('[data-prompt-preview]')).toHaveText(reference);
  await card.getByRole('button', { name: '复制全文', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([reference]);

  await search.fill(CANARY);
  await expect(list.getByText(/筛选结果为空/)).toBeVisible();
  await search.fill(reference.split(':')[1].replace('}}', ''));
  await expect(list.locator('article').filter({ hasText: '运维交接' })).toBeVisible();
});
test('a new session keeps the reference text and creates no secret', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('交接步骤');
  const row = await createSecret(dialog, '交接口令', CANARY);
  const reference = referenceOf((await row.getAttribute('data-secret-id'))!);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const session = page.getByRole('dialog', { name: '新建工作台会话' });
  const before = await page.evaluate(() => (window as unknown as { __secretCalls: string[] }).__secretCalls.length);
  await session.getByRole('button', { name: '查找提示词', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '查找提示词' });
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('交接步骤');
  await picker.getByRole('button', { name: '交接步骤', exact: true }).click();
  await expect(picker.locator('pre')).toHaveText(reference);
  await picker.getByRole('button', { name: '插入草稿', exact: true }).click();
  await expect(session.getByRole('textbox', { name: '初始提示词（可选）' })).toHaveValue(reference);
  expect(await page.evaluate(() => (window as unknown as { __secretCalls: string[] }).__secretCalls.length)).toBe(before);
});

test('a local AI can request a selected password for the task without configuring a script', async ({ page }) => {
  await install(page);
  const list = await library(page);
  const editor = await newPrompt(page);
  await titleOf(editor).fill('示例服务登录');
  const row = await createSecret(editor, 'DEMO_SERVICE_TOKEN', CANARY);
  const id = (await row.getAttribute('data-secret-id'))!;
  await bodyOf(editor).fill('查这次请求的日志');
  await row.getByRole('button', { name: '让 AI 使用', exact: true }).click();
  await expect(bodyOf(editor)).toHaveValue('查这次请求的日志 ' + referenceOf(id));
  await expect(row).toContainText('可申请使用');
  await row.locator('button[aria-haspopup="menu"]').click();
  await editor.getByRole('menuitem', { name: '关闭 AI 直接使用' }).click();
  await expect(row.getByRole('button', { name: '让 AI 使用', exact: true })).toBeVisible();
  await row.locator('[data-secret-direct]').click();
  await expect(row).toContainText('可申请使用');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await list.getByRole('textbox', { name: '搜索资料' }).fill('示例服务登录');
  await list.locator('article').filter({ hasText: '示例服务登录' }).getByRole('button', { name: '启动会话' }).click();
  await page.getByRole('dialog', { name: '用这条提示词启动' }).locator('[data-dialog-save]').click();
  const sent = () => page.evaluate(() => {
    const call = (window as unknown as { __allCalls: Array<{command: string; text: string}> }).__allCalls.find(item => item.command === 'launch_cli');
    return call ? JSON.parse(call.text).request.initialPrompt : '';
  });
  await expect.poll(sent).toContain('--installation ai-fixture read --secret ' + id);
  expect(await sent()).toContain('查这次请求的日志 DEMO_SERVICE_TOKEN');
  expect(await sent()).toContain('--format values');
  expect(await sent()).not.toMatch(/cliora-secret:|--executor|测试秘密传递|canary-ui/);
  expect(await page.evaluate(() => (window as unknown as { __secretCalls: string[] }).__secretCalls)).not.toContain('save_secret_executor');
});

test('launching a saved bare reference supplies the existing action without reading the secret', async ({ page }) => {
  await install(page);
  const list = await library(page);
  const editor = await newPrompt(page);
  await titleOf(editor).fill('引用启动');
  const row = await createSecret(editor, '测试口令', CANARY);
  const id = (await row.getAttribute('data-secret-id'))!;
  await expect(row.locator('[data-secret-grant-form]')).toHaveCount(0);
  await row.locator('button[aria-haspopup=menu]').click();
  await editor.getByRole('menuitem', { name: '脚本授权' }).click();
  await row.locator('[data-secret-preset="localCheck"]').click();
  await row.locator('[data-secret-grant-save]').click();
  await expect(row.locator('[data-secret-grant-row]')).toBeVisible();
  const body = '用这个令牌完成已授权的操作 ' + referenceOf(id);
  await bodyOf(editor).fill(body);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await list.getByRole('textbox', { name: '搜索资料' }).fill('引用启动');
  await list.locator('article').filter({ hasText: '引用启动' }).getByRole('button', { name: '启动会话' }).click();
  const launch = page.getByRole('dialog', { name: '用这条提示词启动' });
  await expect(launch.getByLabel('启动提示词')).toHaveValue(body);
  await launch.locator('[data-dialog-save]').click();
  const sent = () => page.evaluate(() => {
    const calls = (window as unknown as { __allCalls: Array<{command: string; text: string}> }).__allCalls;
    const call = calls.find(item => item.command === 'launch_cli');
    return call ? JSON.parse(call.text).request.initialPrompt : '';
  });
  await expect.poll(sent).toContain('use --secret ' + id + ' --executor fixture-action');
  const outgoing = await sent();
  expect(outgoing).toContain('用这个令牌完成已授权的操作 测试口令');
  expect(outgoing).toContain('read --secret ' + id);
  expect(outgoing).not.toContain(CANARY);
});

test('a synchronized reference can be configured and authorized without changing the prompt body', async ({ page }) => {
  await install(page);
  await library(page);
  const editor = await newPrompt(page);
  const id = '11111111-2222-4333-8444-555555555555';
  const body = '跨平台 ' + referenceOf(id);
  await bodyOf(editor).fill(body);
  await editor.locator('[data-secret-bind]').click();
  await editor.locator('[data-secret-alias]').fill('本机凭据');
  await editor.locator('[data-secret-value]').fill(CANARY);
  await editor.locator('[data-secret-submit]').click();
  await expect(editor.locator('[data-secret-reference-status="available"]')).toHaveCount(1);
  await expect(bodyOf(editor)).toHaveValue(body);
  await editor.locator('[data-secret-id] button[aria-haspopup=menu]').click();
  await editor.getByRole('menuitem', { name: '脚本授权' }).click();
  await editor.locator('[data-secret-preset="localCheck"]').click();
  await editor.locator('[data-secret-grant-save]').click();
  await expect(editor.locator('[data-secret-grant-row]')).toBeVisible();
  await expect(bodyOf(editor)).toHaveValue(body);
});

test('a stale reference can be removed from the body and a known one copied or located', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  await titleOf(dialog).fill('整理引用');
  const panel = secretPanel(dialog);
  const row = await createSecret(dialog, '部署口令', CANARY);
  const reference = referenceOf((await row.getAttribute('data-secret-id'))!);
  const stale = '11111111-2222-4333-8444-555555555555';
  await bodyOf(dialog).fill(`登录 ${referenceOf(stale)} 后部署 ${reference}`);
  const staleChip = panel.locator(`[data-secret-reference="${referenceOf(stale)}"]`);
  await expect(staleChip).toHaveAttribute('data-secret-reference-status', 'unknown');
  // Only the stale reference and one separating space go; the rest of the text is untouched.
  await staleChip.locator('[data-secret-reference-remove]').click();
  await expect(bodyOf(dialog)).toHaveValue(`登录 后部署 ${reference}`);
  await expect(staleChip).toHaveCount(0);
  await panel.locator(`[data-secret-reference="${reference}"]`).getByRole('button', { name: '部署口令', exact: true }).click();
  await expect(row).toHaveAttribute('data-flash', 'true');

  await row.locator('button[aria-haspopup="menu"]').click();
  await dialog.locator('[data-secret-copy-reference]').click();
  await expect(panel.locator('[data-secret-notice]')).toContainText('已复制');
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toEqual([reference]);
  expect(copied.join('')).not.toContain(CANARY);
});

test('the value field can show what is being typed without reading anything back', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  const panel = secretPanel(dialog);
  await panel.locator('[data-secret-create]').click();
  const value = panel.locator('[data-secret-value]');
  await expect(value).toHaveAttribute('type', 'password');
  await value.fill(CANARY);
  await panel.getByRole('button', { name: '显示输入的原值' }).click();
  await expect(value).toHaveAttribute('type', 'text');
  await panel.getByRole('button', { name: '隐藏输入的原值' }).click();
  await expect(value).toHaveAttribute('type', 'password');
  // Closing the form forgets both the value and the choice to show it.
  await value.press('Escape');
  await panel.locator('[data-secret-create]').click();
  await expect(panel.locator('[data-secret-value]')).toHaveValue('');
  await expect(panel.locator('[data-secret-value]')).toHaveAttribute('type', 'password');
});

test('the create form moves from name to value on Enter and blocks a name already in use', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  const panel = secretPanel(dialog);
  await createSecret(dialog, '生产口令', CANARY);
  await panel.locator('[data-secret-create]').click();
  await panel.locator('[data-secret-alias]').fill('生产口令');
  // Pressing the header action again returns to the open form and keeps what was typed.
  await panel.locator('[data-secret-value]').focus();
  await panel.locator('[data-secret-create]').click();
  await expect(panel.locator('[data-secret-alias]')).toBeFocused();
  await expect(panel.locator('[data-secret-alias]')).toHaveValue('生产口令');
  await expect(panel.locator('[data-secret-create]')).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('[data-secret-alias-taken]')).toBeVisible();
  await panel.locator('[data-secret-alias]').press('Enter');
  await expect(panel.locator('[data-secret-value]')).toBeFocused();
  await panel.locator('[data-secret-value]').fill('another-value');
  await expect(panel.locator('[data-secret-submit]')).toBeDisabled();
  await panel.locator('[data-secret-alias]').fill('预发口令');
  await expect(panel.locator('[data-secret-alias-taken]')).toHaveCount(0);
  await panel.locator('[data-secret-value]').press('Enter');
  await expect(panel.locator('[data-secret-id]')).toHaveCount(2);
  await expect(panel.locator('[data-secret-create]')).toHaveAttribute('aria-expanded', 'false');
});

test('a row shows its body and AI state as tags and keeps actions at the right edge', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  const row = await createSecret(dialog, '部署令牌', CANARY);
  await expect(row.locator('[data-secret-in-body]')).toBeVisible();
  await expect(row.locator('[data-secret-insert]')).toHaveCount(0);
  await row.locator('[data-secret-direct]').click();
  await expect(row.locator('[data-secret-direct-active]')).toBeVisible();
  await expect(row.locator('[data-secret-direct]')).toHaveCount(0);
  // Taking the reference out of the body brings the insert action back without losing AI use.
  await bodyOf(dialog).fill('');
  await expect(row.locator('[data-secret-in-body]')).toHaveCount(0);
  await expect(row.locator('[data-secret-insert]')).toBeVisible();
  await expect(row.locator('[data-secret-direct-active]')).toBeVisible();
});

test('binding a synchronized reference says it saves locally and leaves the body alone', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page);
  const id = '11111111-2222-4333-8444-555555555555';
  const body = '同步来的 ' + referenceOf(id);
  await bodyOf(dialog).fill(body);
  const panel = secretPanel(dialog);
  await panel.locator('[data-secret-bind]').click();
  await expect(panel.locator('[data-secret-submit]')).toHaveText(/保存到本机/);
  await panel.locator('[data-secret-alias]').fill('同步凭据');
  await panel.locator('[data-secret-value]').fill(CANARY);
  await panel.locator('[data-secret-submit]').click();
  await expect(panel.locator('[data-secret-notice]')).toContainText('已在本机配置');
  await expect(bodyOf(dialog)).toHaveValue(body);
});
