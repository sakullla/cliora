import { spawnSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPromptFixtureBridge, installRichPromptFixtures } from '../../scripts/capture-prompt-fixtures.mjs';

// A synthetic canary: it must never reach the window, the prompt body or a call.
const CANARY = 'canary-ui-approval-9a7f';
const SECRET_ID = '11111111-2222-4333-8444-555555555555';
const EXECUTOR_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const INSTALLATION_ID = '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234';
// A newer installation without any grant: it must not shadow the granted one.
const IDLE_INSTALLATION_ID = '5d3f9d0f-7c2b-4d55-8e6c-7a1b3c4d5678';

type Call = { command: string; args: Record<string, any> };

async function install(page: Page, options: { running?: boolean; idleInstallation?: boolean; empty?: boolean; count?: number; programs?: string[] } = {}) {
  await page.addInitScript((settings: { running: boolean; idle: boolean; empty: boolean; count: number; programs: string[] }) => {
    const callbacks: Array<(value: unknown) => void> = [];
    const handlers: Record<string, number> = {};
    const calls: Call[] = [];
    const idle = settings.idle
      ? [{ id: '5d3f9d0f-7c2b-4d55-8e6c-7a1b3c4d5678', label: 'idle-cli', kind: 'cli', targetId: null, revoked: false, createdAt: 3, revokedAt: null }]
      : [];
    const state = {
      running: settings.running,
      failGrant: false,
      installations: [...idle, { id: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234', label: 'codex-cli', kind: 'cli', targetId: null, revoked: false, createdAt: 1, revokedAt: null }],
      executors: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', label: '部署脚本', description: '', executable: '/usr/bin/env', args: [], cwd: null, channel: 'env', envName: 'DEPLOY_TOKEN', digest: 'a'.repeat(64), createdAt: 1, updatedAt: 1 }],
      grants: [{ installationId: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234', secretId: '11111111-2222-4333-8444-555555555555', alias: '生产口令', executorId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', executorLabel: '部署脚本', createdAt: 1 }],
      audit: [{ id: 2, at: 2, operation: 'read', decision: 'denied', code: 'declined', secretId: '11111111-2222-4333-8444-555555555555', installationId: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234', executorId: null }],
    };
    if (settings.empty) { state.installations = []; state.executors = []; state.grants = []; }
    const secret = { id: '11111111-2222-4333-8444-555555555555', alias: '生产口令', reference: '{{cliora-secret:11111111-2222-4333-8444-555555555555}}', version: 1, createdAt: 1, updatedAt: 1, status: 'available' };
    const inventory = Array.from({ length: settings.count }, (_, index) => index === 0 ? secret : {
      ...secret, id: crypto.randomUUID(), alias: 'fixture-' + String(index).padStart(4, '0'),
    }).map(item => ({ ...item, reference: '{{cliora-secret:' + item.id + '}}' }));
    const cli = { executable: '/Applications/Cliora.app/Contents/MacOS/cliora', entry: '--cliora-internal-secret-cli-v1' };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __secretBroker: {
        calls,
        state,
        emit: (event: string, payload: unknown) => {
          const handler = handlers[event];
          if (handler === undefined) throw new Error(`no listener for ${event}`);
          callbacks[handler]({ event, id: 0, payload });
        },
        hasListener: (event: string) => handlers[event] !== undefined,
      },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => { callbacks.push(callback); return callbacks.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          calls.push({ command, args });
          if (command === 'plugin:event|listen') { handlers[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'answer_prompt_secret_approval') {
            // The native side owns the pending entry: a repeated answer finds nothing.
            if (args.approvalId !== 'approval-1') throw { message: '确认请求已结束或已过期' };
            return null;
          }
          if (command === 'list_prompt_secrets') return inventory;
          if (command === 'list_prompt_secret_page') {
            const rows = inventory.filter(item => item.alias.includes(args.search) || item.id.includes(args.search))
              .sort((a, b) => Number(args.references.includes(b.reference)) - Number(args.references.includes(a.reference)) || a.alias.localeCompare(b.alias));
            const offset = Math.min(args.offset, Math.floor(Math.max(rows.length - 1, 0) / 30) * 30);
            return { items: rows.slice(offset, offset + 30), offset, total: inventory.length, matched: rows.length, grantCounts: { [secret.id]: state.grants.length } };
          }
          if (command === 'secret_access_options') return { cli, installations: state.installations, executors: state.executors,
            grants: state.grants.filter(item => !args.secretId || item.secretId === args.secretId), availablePrograms: settings.programs };

          if (command === 'list_secret_executors') return state.executors;
          if (command === 'list_secret_installations') return state.installations;
          if (command === 'list_secret_grants') return state.grants.filter(item => !args.secretId || item.secretId === args.secretId);
          if (command === 'list_secret_audit') return state.audit;
          if (command === 'secret_broker_status') return settings.running
            ? { running: true, transport: 'unix_socket', error: null }
            : { running: false, transport: 'unix_socket', error: '未找到正在运行的栖点秘密代理' };
          if (command === 'secret_cli_context') return { executable: '/Applications/Cliora.app/Contents/MacOS/cliora', entry: '--cliora-internal-secret-cli-v1' };
          if (command === 'create_secret_installation') {
            const created = { id: crypto.randomUUID(), label: String(args.label), kind: args.kind === 'mcp' ? 'mcp' : 'cli', targetId: null, revoked: false, createdAt: 2, revokedAt: null };
            state.installations = [created, ...state.installations];
            return created;
          }
          if (command === 'revoke_secret_installation') {
            const target = state.installations.find(item => item.id === args.id);
            if (!target) throw { message: '安装标识已不存在' };
            target.revoked = true;
            if (target.id === '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234') state.grants = [];
            return null;
          }
          if (command === 'restore_cli_installation') {
            const item = state.installations.find(item => item.id === args.id && item.revoked);
            if (!item) throw new Error('missing');
            item.revoked = false;
            return null;
          }
          if (command === 'delete_cli_installation') {
            state.installations = state.installations.filter(item => item.id !== args.id);
            return null;
          }
          if (command === 'save_secret_executor') {
            const created = { ...args.executor, id: crypto.randomUUID(), digest: 'abc', createdAt: 1, updatedAt: 1 };
            state.executors.push(created);
            return created;
          }
          if (command === 'grant_secret_usage') {
            if (state.failGrant) throw new Error('fixture grant failed');
            const entry = state.executors.find(item => item.id === args.executorId)!;
            state.grants.push({ installationId: args.installationId, secretId: args.secretId, executorId: entry.id, executorLabel: entry.label, alias: secret.alias, createdAt: 1 });
            return null;
          }
          if (command === 'revoke_secret_usage') {
            state.grants = state.grants.filter(item => item.installationId !== args.installationId || item.secretId !== args.secretId || item.executorId !== args.executorId);
            return null;
          }
          if (command === 'resolve_prompt_secret_references') return [];
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: false }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', launchForm: 'terminal', interfaceFormats: [], nativeConfig: { state: 'supported', reason: '' }, launch: { state: 'supported', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings' || command === 'set_preferred_terminal') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], worktreeLaunch: 'direct' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_remote_targets' || command === 'list_workbench_sessions') return [];
          if (command === 'get_registered_tool_workspace') return { profiles: [], snapshots: [], recoveryNeeded: [], common: null, customPath: null, probe: { selectedPath: '/fixture/codex', installations: [{ path: '/fixture/codex', version: '0.160.0', status: 'available' }], nativeFiles: [], interfaceFormats: [], providerPresets: [], dependencies: [], nativeWrites: { state: 'supported', reason: '' }, installUrl: '', upgradeHint: '' } };
          if (command.startsWith('list_')) return [];
          return null;
        },
      },
    });
  }, { running: options.running ?? true, idle: options.idleInstallation ?? false, empty: options.empty ?? false, count: options.count ?? 1, programs: options.programs ?? ['node', 'gh'] });
  await page.addInitScript(installPromptFixtureBridge);
  await page.addInitScript(installRichPromptFixtures);
  await page.goto('/');
}

async function library(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  return page.locator('[data-prompt-library]');
}
async function newPrompt(page: Page, title: string) {
  await page.getByRole('button', { name: '新建提示词', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建提示词' });
  await dialog.getByRole('textbox', { name: '标题', exact: true }).fill(title);
  return dialog;
}
const bodyOf = (dialog: Locator) => dialog.getByRole('textbox', { name: '资料正文', exact: true });
async function openBroker(dialog: Locator) {
  const panel = dialog.locator('[data-prompt-secrets]');
  await panel.locator('[data-secret-broker-toggle]').click();
  await expect(panel.locator('[data-secret-broker-toggle]')).toHaveAttribute('aria-selected', 'true');
  return panel.locator('[data-secret-broker]');
}
async function openSecrets(dialog: Locator) {
  const tab = dialog.locator('[data-prompt-secrets] [data-secret-tab="secrets"]');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
const approvalDialog = (page: Page) => page.locator('dialog[data-secret-approval]');
async function waitForListener(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __secretBroker: { hasListener: (event: string) => boolean } }).__secretBroker.hasListener('cliora:secret-approval-request'))).toBe(true);
}
async function emitApproval(page: Page, approvalId = 'approval-1', alias = '生产口令', source = 'CLI · codex-cli') {
  await waitForListener(page);
  await page.evaluate(({ approvalId, alias, source }) => {
    (window as unknown as { __secretBroker: { emit: (event: string, payload: unknown) => void } }).__secretBroker.emit('cliora:secret-approval-request', { approvalId, alias, source, expiresInSeconds: 120 });
  }, { approvalId, alias, source });
}

test('the broker panel lists metadata and inserts complete CLI instructions', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page, '受控使用');
  const broker = await openBroker(dialog);

  await expect(broker).toHaveAttribute('data-secret-broker-running', 'true');
  await expect(broker.locator(`[data-secret-installation="${INSTALLATION_ID}"]`)).toContainText('codex-cli');
  await expect(broker.locator(`[data-secret-executor="${EXECUTOR_ID}"]`)).toBeHidden();
  await broker.getByText('已保存的脚本', { exact: true }).click();
  await expect(broker.locator(`[data-secret-executor="${EXECUTOR_ID}"]`)).toContainText('部署脚本');
  await expect(broker.locator('[data-secret-audit-code]')).toHaveCount(0);
  await broker.locator('details').filter({ hasText: '最近访问记录' }).locator('summary').click();
  await expect(broker.getByText('最近 30 天，最多 100 次访问。')).toBeVisible();
  await expect(broker.locator('[data-secret-audit-code="declined"]')).toContainText('生产口令');
  await expect(broker.locator('[data-secret-audit-code="declined"]')).toContainText('已拒绝');
  await openSecrets(dialog);
  await expect(dialog.locator('[data-secret-id]')).toContainText('1 项授权');
  await dialog.locator('[data-secret-grant]').click();
  await expect(dialog.locator('[data-secret-grant-row]')).toBeVisible();

  await openBroker(dialog);
  await broker.locator('[data-secret-broker-instructions]').click();
  const body = await bodyOf(dialog).inputValue();
  expect(body).toContain('--cliora-internal-secret-cli-v1');
  expect(body).toContain(`--installation ${INSTALLATION_ID}`);
  expect(body).toContain(`use --secret ${SECRET_ID} --executor ${EXECUTOR_ID}`);
  expect(body).toContain(`read --secret ${SECRET_ID}`);
  expect(body).toContain('/Applications/Cliora.app/Contents/MacOS/cliora');
  expect(body).toContain('每次都要在栖点确认');
  expect(body).not.toContain(CANARY);
  // Creating an installation through the panel adds a row the instructions can use.
  await broker.locator('[data-secret-add-identity]').click();
  await broker.locator('[data-secret-installation-label]').fill('review-cli');
  await broker.locator('[data-secret-installation-create]').click();
  await expect(broker.locator('[data-secret-installation]')).toHaveCount(2);
  expect(await bodyOf(dialog).inputValue()).not.toContain(CANARY);
});

test('inserted instructions pick the installation that carries a grant', async ({ page }) => {
  await install(page, { idleInstallation: true });
  await library(page);
  const dialog = await newPrompt(page, '多个安装标识');
  const broker = await openBroker(dialog);
  await expect(broker.locator('[data-secret-installation]')).toHaveCount(2);
  // The newer installation has no grant, so it cannot describe a usable command.
  await broker.locator('[data-secret-broker-instructions]').click();
  const body = await bodyOf(dialog).inputValue();
  expect(body).toContain(`--installation ${INSTALLATION_ID}`);
  expect(body).not.toContain(IDLE_INSTALLATION_ID);
  expect(body).toContain(`use --secret ${SECRET_ID} --executor ${EXECUTOR_ID}`);
  expect(body).toContain(`read --secret ${SECRET_ID}`);
  expect(body).not.toContain('还没有任何已授权的秘密与执行入口');
  expect(body).not.toContain(CANARY);
});

test('a read approval shows only the alias and the source and answers by id', async ({ page }) => {
  await install(page);
  await emitApproval(page);
  const dialog = approvalDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-secret-approval', 'approval-1');
  await expect(dialog).toContainText('生产口令');
  await expect(dialog).toContainText('CLI · codex-cli');
  await expect(dialog.locator('[data-secret-approval-risk]')).toContainText('模型上下文');
  await expect(dialog.locator('[data-secret-approval-timeout]')).toContainText('120');
  // The window never receives a value, not even as an empty field.
  expect(await page.content()).not.toContain(CANARY);

  await dialog.locator('[data-secret-approval-accept]').click();
  await expect(dialog).toHaveCount(0);
  const answers = await page.evaluate(() => (window as unknown as { __secretBroker: { calls: Call[] } }).__secretBroker.calls.filter(call => call.command === 'answer_prompt_secret_approval'));
  expect(answers).toEqual([{ command: 'answer_prompt_secret_approval', args: { approvalId: 'approval-1', accepted: true } }]);
  expect(JSON.stringify(answers)).not.toContain(CANARY);
});

test('a declined or repeated answer returns nothing and keeps the window usable', async ({ page }) => {
  await install(page);
  await emitApproval(page, 'approval-2', '拒绝口令', 'CLI · codex-cli');
  const dialog = approvalDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-secret-approval-decline]').click();
  await expect(dialog).toHaveCount(0);

  // The same approval id cannot be answered twice: the native side refuses and the
  // window reports nothing.
  await emitApproval(page, 'approval-2', '拒绝口令', 'CLI · codex-cli');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-secret-approval-accept]').click();
  await expect(dialog).toHaveCount(0);
  expect(await page.content()).not.toContain(CANARY);
});

test('an offline broker is reported before any secret is used', async ({ page }) => {
  await install(page, { running: false });
  await library(page);
  const dialog = await newPrompt(page, '代理离线');
  const broker = await openBroker(dialog);
  await expect(broker).toHaveAttribute('data-secret-broker-running', 'false');
  await expect(broker).toContainText('代理未运行');
  await expect(broker.locator('[data-secret-broker-status]')).toContainText('未找到正在运行的栖点秘密代理');
  // The instructions are still exact: they come from metadata, not from the broker.
  await broker.locator('[data-secret-broker-instructions]').click();
  expect(await bodyOf(dialog).inputValue()).toContain(`--installation ${INSTALLATION_ID}`);
});

test('the first script permission needs only a preset and explicit approval', async ({ page }) => {
  await install(page, { empty: true });
  await library(page);
  const dialog = await newPrompt(page, '预设授权');
  await dialog.locator('[data-secret-grant]').click();
  const form = dialog.locator('[data-secret-grant-form]');
  await expect(form).toContainText('只在本机检查');
  await form.locator('[data-secret-preset="github"]').click();
  await expect(form).toContainText('github.com');
  await expect(form.locator('input')).toHaveCount(0);
  await expect(form.locator('[data-secret-grant-installation]')).toHaveCount(0);
  const calls = () => page.evaluate(() => (window as unknown as { __secretBroker: { calls: Call[] } }).__secretBroker.calls.filter(call => ['save_secret_executor', 'grant_secret_usage', 'create_secret_installation'].includes(call.command)));
  expect(await calls()).toEqual([]);
  await form.locator('[data-secret-grant-save]').click();
  await expect(form.locator('[data-secret-grant-row]')).toContainText('查看 GitHub 用户名');
  const writes = await calls();
  expect(writes.map(call => call.command)).toEqual(['create_secret_installation', 'save_secret_executor', 'grant_secret_usage']);
  expect(writes[1].args.executor).toMatchObject({ executable: 'gh', args: ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], channel: 'env', envName: 'GH_TOKEN' });
  expect(writes[2].args.secretId).toEqual(SECRET_ID);
  const grantCalls: string[] = await page.evaluate(() => (window as any).__secretBroker.calls.map((c: Call) => c.command).filter((name: string) => /secret/.test(name) && name !== 'list_prompt_secret_page'));
  expect(grantCalls).toEqual(['secret_access_options', 'create_secret_installation', 'save_secret_executor', 'grant_secret_usage', 'list_secret_grants']);
  await form.locator('[data-secret-grant-insert]').click();
  await expect(bodyOf(dialog)).toHaveValue(new RegExp(writes[2].args.executorId));
  await expect(bodyOf(dialog)).not.toHaveValue(/read --secret/);
  await form.locator('[data-secret-grant-revoke]').click();
  await expect(form.locator('[data-secret-grant-row]')).toHaveCount(0);
});

test('a revoked local CLI can be restored and permanently deleted', async ({ page }) => {
  await install(page);
  await library(page);
  const dialog = await newPrompt(page, '本地连接');
  const broker = await openBroker(dialog);
  const row = broker.locator(`[data-secret-installation="${INSTALLATION_ID}"]`);
  async function confirm(action: string) {
    await page.getByRole('dialog', { name: action, exact: true }).getByRole('button', { name: action, exact: true }).click();
  }
  await row.locator('[data-secret-installation-revoke]').click();
  await confirm('撤销');
  await expect(row).toHaveAttribute('data-secret-installation-revoked', 'true');
  await broker.locator('[data-secret-broker-instructions]').click();
  await expect(dialog.locator('[data-secret-error]')).toContainText('恢复已撤销');
  await row.locator('[data-secret-installation-restore]').click();
  await confirm('恢复连接');
  await expect(row).toHaveAttribute('data-secret-installation-revoked', 'false');
  await row.locator('[data-secret-installation-revoke]').click();
  await confirm('撤销');
  await row.locator('[data-secret-installation-delete]').click();
  await confirm('删除连接');
  await expect(row).toHaveCount(0);
  await openSecrets(dialog);
  await expect(dialog.locator('[data-secret-id]')).toBeVisible();
});

test('a failed grant retries the saved custom script without creating another connection', async ({ page }) => {
  await install(page, { empty: true });
  await library(page);
  const dialog = await newPrompt(page, '自定义脚本');
  await dialog.locator('[data-secret-grant]').click();
  const form = dialog.locator('[data-secret-grant-form]');
  await form.locator('[data-secret-preset="custom"]').click();
  await form.locator('[data-secret-executor-executable]').fill('/fixture/my script');
  await expect(form.locator('textarea')).toBeHidden();
  await page.evaluate(() => { (window as any).__secretBroker.state.failGrant = true; });
  await form.locator('[data-secret-grant-save]').click();
  await expect(dialog.locator('[data-secret-error]')).toContainText('fixture grant failed');
  await expect(form.locator('[data-secret-grant-row]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__secretBroker.state.failGrant = false; });
  await form.locator('[data-secret-grant-save]').click();
  await expect(form.locator('[data-secret-grant-row]')).toContainText('my script');
  const calls: Call[] = await page.evaluate(() => (window as any).__secretBroker.calls);
  expect(calls.filter(call => call.command === 'create_secret_installation')).toHaveLength(1);
  const saved = calls.filter(call => call.command === 'save_secret_executor');
  expect(saved).toHaveLength(1);
  expect(saved[0].args.executor).toMatchObject({ channel: 'stdin', envName: null, executable: '/fixture/my script', args: [] });
});

test('the local check preset receives a synthetic value and returns only OK', async ({ page }) => {
  await install(page, { empty: true });
  await library(page);
  const dialog = await newPrompt(page, '本地检查');
  await dialog.locator('[data-secret-grant]').click();
  await dialog.locator('[data-secret-grant-save]').click();
  await expect(dialog.locator('[data-secret-grant-row]')).toContainText('测试秘密传递');
  const executor = await page.evaluate(() => (window as any).__secretBroker.state.executors[0]);
  expect(executor).toMatchObject({ executable: 'node', channel: 'stdin', envName: null });
  const result = spawnSync(process.execPath, executor.args, { input: CANARY, encoding: 'utf8', timeout: 30000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('OK');
  expect(result.stderr).toBe('');
});

test('a large vault searches across pages without loading the broker', async ({ page }) => {
  await install(page, { count: 75, empty: true });
  await library(page);
  const dialog = await newPrompt(page, '大资料库');
  const rows = dialog.locator('[data-secret-id]');
  await expect(rows).toHaveCount(30);
  await dialog.locator('[data-secret-pagination]').getByRole('button', { name: '下一页' }).click();
  await expect(dialog.locator('[data-secret-pagination]')).toContainText('31–60');
  await dialog.locator('[data-secret-search]').fill('fixture-0074');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('fixture-0074');
  await dialog.locator('[data-secret-search]').fill('不存在');
  await expect(rows).toHaveCount(0);
  const calls: Call[] = await page.evaluate(() => (window as any).__secretBroker.calls);
  expect(calls.filter(x => ['secret_access_options', 'list_secret_audit', 'list_prompt_secrets'].includes(x.command))).toHaveLength(0);
});

test('a missing preset program leaves custom scripts available', async ({page}) => {
  await install(page, { empty: true, programs: ['node'] });
  await library(page);
  const dialog = await newPrompt(page, '缺少预设程序');
  await dialog.locator('[data-secret-grant]').click();
  await dialog.locator('[data-secret-preset="github"]').click();
  await expect(dialog.locator('[data-secret-grant-form]')).toContainText('找不到 gh');
  await expect(dialog.locator('[data-secret-grant-save]')).toBeDisabled();
  await dialog.locator('[data-secret-preset="custom"]').click();
  await dialog.locator('[data-secret-executor-executable]').fill('/fixture/script');
  await expect(dialog.locator('[data-secret-grant-save]')).toBeEnabled();
});
