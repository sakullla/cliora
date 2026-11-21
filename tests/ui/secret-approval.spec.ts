import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPromptFixtureBridge, installRichPromptFixtures } from '../../scripts/capture-prompt-fixtures.mjs';

// A synthetic canary: it must never reach the window, the prompt body or a call.
const CANARY = 'canary-ui-approval-9a7f';
const SECRET_ID = '11111111-2222-4333-8444-555555555555';
const EXECUTOR_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const INSTALLATION_ID = '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234';

type Call = { command: string; args: Record<string, any> };

async function install(page: Page, options: { running?: boolean } = {}) {
  await page.addInitScript((settings: { running: boolean }) => {
    const callbacks: Array<(value: unknown) => void> = [];
    const handlers: Record<string, number> = {};
    const calls: Call[] = [];
    const state = {
      running: settings.running,
      installations: [{ id: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234', label: 'codex-cli', kind: 'cli', targetId: null, revoked: false, createdAt: 1, revokedAt: null }],
      executors: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', label: '部署脚本', description: '', executable: '/usr/bin/env', args: [], cwd: null, channel: 'env', envName: 'DEPLOY_TOKEN', digest: 'a'.repeat(64), createdAt: 1, updatedAt: 1 }],
      grants: [{ installationId: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234', secretId: '11111111-2222-4333-8444-555555555555', alias: '生产口令', executorId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', executorLabel: '部署脚本', createdAt: 1 }],
      audit: [{ id: 2, at: 2, operation: 'read', decision: 'denied', code: 'declined', secretId: '11111111-2222-4333-8444-555555555555', installationId: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234', executorId: null }],
    };
    const secret = { id: '11111111-2222-4333-8444-555555555555', alias: '生产口令', reference: '{{cliora-secret:11111111-2222-4333-8444-555555555555}}', version: 1, createdAt: 1, updatedAt: 1, status: 'available' };
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
          if (command === 'list_prompt_secrets') return [secret];
          if (command === 'list_secret_executors') return state.executors;
          if (command === 'list_secret_installations') return state.installations;
          if (command === 'list_secret_grants') return state.grants;
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
  }, { running: options.running ?? true });
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
  return panel.locator('[data-secret-broker]');
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
  await expect(broker.locator(`[data-secret-executor="${EXECUTOR_ID}"]`)).toContainText('部署脚本');
  await expect(broker.locator('[data-secret-grant-row]')).toHaveCount(1);
  // The audit trail is shown without any value or script text.
  await expect(broker.locator('[data-secret-audit-code="declined"]')).toHaveCount(1);

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
  await broker.locator('[data-secret-installation-label]').fill('review-cli');
  await broker.locator('[data-secret-installation-create]').click();
  await expect(broker.locator('[data-secret-installation]')).toHaveCount(2);
  expect(await bodyOf(dialog).inputValue()).not.toContain(CANARY);
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
