/** Capture the current configuration/account UI with the shared sanitized IPC fixture. */
import fs from 'node:fs';
import ts from 'typescript';
import { expect } from '@playwright/test';

const toolNames = { pi: 'Pi', open_code: 'OpenCode', kimi_code: 'Kimi Code', codex: 'Codex', claude_code: 'Claude Code' };
const toolSlugs = { pi: 'pi', open_code: 'opencode', kimi_code: 'kimi', codex: 'codex', claude_code: 'claude' };
const variants = Object.keys(toolNames).flatMap(tool => [
  { name: `${toolSlugs[tool]}-default`, tool, title: `${toolNames[tool]} · 简洁编辑首屏`, state: '连接摘要、按需展开的模型与单独保存' },
  { name: `${toolSlugs[tool]}-parameters`, tool, title: `${toolNames[tool]} · 原生模型参数`, state: '上下文、输出、推理与输入能力', details: true },
]);
const extra = [
  ['pi-input-capabilities', 'pi', 'Pi · 文本、图片与推理', '原生 input 与 reasoning 字段', 'capabilities'],
  ['opencode-modalities', 'open_code', 'OpenCode · 输入输出模态', '文本、图片等输入输出能力', 'capabilities'],
  ['kimi-capabilities', 'kimi_code', 'Kimi · 图片、思考与工具调用', '原生模型能力标记', 'capabilities'],
  ['model-management', 'pi', '模型管理 · 复制、改名与删除', '逐模型管理与明确默认模型', 'model-actions'],
  ['configuration-overview', 'codex', '配置列表 · 已保存与上次使用', '保存的新内容与上次使用的快照分开', 'overview'],
  ['configuration-new', 'kimi_code', '新建配置', '从简洁首屏开始填写', 'new'],
  ['kimi-new-model', 'kimi_code', 'Kimi · 添加模型与必填上下文', '模型 alias、请求 ID 与上下文上限', 'new-model'],
  ['model-directory', 'kimi_code', '模型目录 · 多选', '勾选多个模型后明确添加', 'directory'],
  ['model-directory-required', 'kimi_code', '模型目录 · 补充上下文', '目录没有上下文数据时保留必填提示', 'directory-required'],
  ['connection-check', 'codex', '连接检查', '非推理检查与可能计费的模型请求分开', 'check'],
  ['configuration-source', 'codex', '凭据来源', '原生登录、独立账号与 API 密钥', 'source'],
  ['configuration-account-picker', 'codex', '从配置选择账号', '明确选择并返回原草稿', 'picker'],
  ['configuration-login-pending', 'codex', '配置内登录新账号', '登录期间保留草稿并提供返回', 'login'],
  ['configuration-login-return', 'codex', '登录后返回配置', '明确选择登录账号，保留原配置名称', 'login-return'],
  ['configuration-raw', 'codex', '配置原文', '原文与表单共用同一草稿', 'raw'],
  ['current-file-comparison', 'codex', '当前文件 · 外部修改比较', '比较已有内容与本次修改', 'comparison'],
  ['common-parameters', 'codex', '通用参数', '查看参数与真实影响范围', 'common'],
  ['common-apply-results', 'codex', '通用参数 · 部分应用失败', '按范围保留结果与恢复操作', 'common-results'],
  ['accounts-overview', 'codex', '账号与本机登录', '只读本机观察和独立账号分开', 'accounts'],
  ['account-impact', 'codex', '账号关联', '关联配置、使用范围和额度引用', 'impact'],
  ['account-create', 'codex', '添加独立账号', '账号名称与登录方式', 'account-create'],
].map(([name, tool, title, state, action]) => ({ name, tool, title, state, action }));
export const configurationScenarios = [...variants, ...extra];

async function fixtureInstaller() {
  const text = fs.readFileSync(new URL('../tests/ui/configuration-workspace-fixture.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

export async function installCaptureConfigurationProtocol(page) {
  const { installConfigurationProtocol } = await fixtureInstaller();
  await installConfigurationProtocol(page);
}

async function installPresentation(page, theme, names, rawTemplate) {
  await page.addInitScript(({ theme, names, rawTemplate }) => {
    const previous = window.__TAURI_INTERNALS__.invoke;
    const context = id => ({ id: `ctx-${id}`, toolId: 'codex', root: `/fixtures/accounts/${id}`, configRoot: `/fixtures/accounts/${id}`, resourceRoot: `/fixtures/accounts/${id}`, authFiles: [], historyRoots: [], environment: {}, removeEnvironment: [], cliArgs: [] });
    const account = value => ({ provider: 'fixture', checkedAt: null, ...value, identity: value.identity ? { plan: null, ...value.identity } : null, context: value.context ? { ...context(value.id), ...value.context } : null, pendingLogin: value.pendingLogin ? { expiresAt: Math.floor(Date.now() / 1000) + 600, previousState: 'signed_out', externalTerminal: false, context: context(value.id), ...value.pendingLogin } : null });
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'account_impact') {
        const value = window.workspaceFixture.accounts.find(item => item.id === args.id);
        return { accountId: value.id, accountVersion: value.version, toolId: value.toolId, currentContextId: value.context?.id ?? null, contexts: [{ id: value.context?.id, kind: 'current' }], profiles: [{ id: 'existing', name: '工作配置', toolId: value.toolId, version: 3, revision: 'revision-3' }], scopes: [{ bindingId: 'global', toolId: value.toolId, profileId: 'existing', profileName: '工作配置', profileVersion: 3, scope: 'global', projectPath: null, projectName: null, contextId: value.context?.id ?? null, contextKind: 'current', active: true, needsReapply: false, canReapply: false, reason: null, reapplyRequest: null }], usageReferences: [{ id: 'usage-demo', label: '官方额度查询', version: 1, enabled: true, accountId: value.id, contextId: value.context?.id ?? null, profileId: 'existing', contextKind: 'current', needsRebind: false }] };
      }
      const value = await previous(command, args);
      if (command === 'get_bootstrap') return { ...value, preferences: { ...value.preferences, theme }, tools: value.tools.map(tool => ({ ...tool, name: names[tool.id] ?? tool.name })) };
      if (command === 'list_cli_adapters') return { ...value, registered: value.registered.map(tool => ({ ...tool, name: names[tool.id] ?? tool.name })) };
      if (command === 'list_accounts') return value.map(account);
      if (command === 'account_capabilities') return value.map(cap => ({ provider: 'fixture', version: '合成预览', browserLink: false, importNative: false, identitySource: 'synthetic', refreshOwner: 'native_cli', acceptance: 'UI fixture only', ...cap }));
      if (command === 'get_registered_tool_workspace' && rawTemplate) value.probe.nativeFiles = value.probe.nativeFiles.map(file => ({ ...file, format: 'toml', path: '/fixtures/codex/config.toml' }));
      if (['create_account', 'start_account_login', 'check_account', 'cancel_account_login'].includes(command)) return account(value);
      if (command === 'begin_configuration_draft') {
        if (rawTemplate) value.profile.files = { settings: rawTemplate };
        if (value.subject === 'profile' && !value.profile.id && value.view.models) { value.view.models = []; value.view.defaultModel = null; value.profile.files.settings = JSON.stringify(value.view); }
        if (value.profile.tool === 'kimi_code') value.sourceCapabilities = value.sourceCapabilities.map(cap => cap.source === 'account' ? { ...cap, available: false, reason: 'Kimi 使用原生配置或 API 密钥' } : cap);
        if (value.profile.tool === 'open_code' && value.descriptor) {
          value.descriptor.operations.push('small_default'); value.view.smallModel = 'two';
          for (const id of ['modalities.input', 'modalities.output']) value.descriptor.fields.push({ id, label: id.endsWith('input') ? '输入模态' : '输出模态', kind: 'json', required: false, advanced: true, choices: [], minimum: null, defaultSource: '原生默认', unavailableReason: null });
          for (const model of value.view.models ?? []) model.fields.modalities = { input: ['text', 'image'], output: ['text'] };
        }
        if (value.profile.tool === 'pi') for (const model of value.view.models ?? []) { model.fields.input = ['text', 'image']; model.fields.reasoning = true; }
        if (value.profile.tool === 'kimi_code') for (const model of value.view.models ?? []) model.fields.capabilities = ['image_in', 'thinking', 'tool_use'];
        if (value.subject === 'common' && value.profile.tool === 'codex') {
          value.descriptor.fields = [{ id: 'model_reasoning_effort', label: '默认推理强度', kind: 'enum', required: false, advanced: false, choices: ['low', 'medium', 'high', 'xhigh'], minimum: null, defaultSource: 'Codex 原生默认', unavailableReason: null }];
          value.view.commonFields = [{ id: 'model_reasoning_effort', value: 'high', target: 'configuration' }];
        }
      }
      return value;
    };
  }, { theme, names, rawTemplate });
}

export async function captureConfiguration({ browser, themes, widths, selected, url, capture, failures }) {
  const { installConfigurationWorkspace } = await fixtureInstaller();
  for (const width of widths) for (const theme of themes) for (const scene of configurationScenarios.filter(item => selected.includes(item.name))) {
    const page = await browser.newPage({ baseURL: url, viewport: { width, height: 1100 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => failures.push({ name: scene.name, theme, width, type: 'pageerror', message: error.message }));
    try {
      await installConfigurationWorkspace(page, scene.tool, true, scene.action === 'overview');
      await installPresentation(page, theme, toolNames, scene.action === 'raw' ? fs.readFileSync(new URL('../tests/fixtures/native/codex-model-editor.toml', import.meta.url), 'utf8') : null);
      await page.goto('/');
      await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
      const action = scene.action;
      const dialog = page.locator('dialog.guide-dialog');
      if (['accounts', 'impact', 'account-create'].includes(action)) {
        await page.getByRole('tab', { name: '账号', exact: true }).click();
        await expect(page.getByRole('heading', { name: '账号与登录' })).toBeVisible();
        await expect(page.getByText('CLI 已登录', { exact: true })).toBeVisible();
        if (action === 'impact') { await page.getByText('管理与关联', { exact: true }).first().click(); await expect(page.getByText('官方额度查询', { exact: true })).toBeVisible(); }
        if (action === 'account-create') { await page.getByRole('button', { name: '添加账号', exact: true }).click(); await page.getByLabel('账号名称').fill('工作账号'); }
      } else if (action !== 'overview') {
        if (['common', 'common-results'].includes(action)) await page.getByRole('button', { name: '通用配置', exact: true }).click();
        else if (action === 'new') await page.getByRole('button', { name: '新建配置', exact: true }).click();
        else if (action === 'comparison') await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
        else await page.locator('[data-profile-id="existing"]').getByRole('button', { name: '修改', exact: true }).click();
        await expect(dialog).toBeVisible();
        if (scene.details) {
          if (['pi', 'open_code', 'kimi_code'].includes(scene.tool)) { await dialog.getByRole('button', { name: /^one(?: ·|$)/ }).click(); await expect(dialog.getByLabel('模型 one', { exact: true })).toBeVisible(); }
          else await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
        }
        if (['capabilities', 'model-actions'].includes(action)) {
          await dialog.getByRole('button', { name: /^one(?: ·|$)/ }).click();
          const model = dialog.getByLabel('模型 one', { exact: true });
          if (action === 'model-actions') { await model.getByText('复制或修改模型标识', { exact: true }).click(); await model.getByLabel('新模型 ID').fill('one-copy'); await model.getByLabel('新模型 ID').scrollIntoViewIfNeeded(); }
          else await model.getByText(scene.tool === 'pi' ? '输入能力' : scene.tool === 'open_code' ? '输入模态' : '模型能力', { exact: true }).scrollIntoViewIfNeeded();
        }
        if (action === 'new-model') { await dialog.getByRole('button', { name: '新增模型', exact: true }).click(); await dialog.getByLabel('模型 alias', { exact: true }).fill('work-model'); await dialog.getByLabel('模型 alias', { exact: true }).scrollIntoViewIfNeeded(); }
        if (['directory', 'directory-required', 'check'].includes(action)) {
          await dialog.getByText('模型目录与连接检查', { exact: true }).click();
          if (action === 'check') { await dialog.getByRole('button', { name: '检查连接', exact: true }).click(); await expect(dialog.getByText('未发送推理', { exact: true })).toBeVisible(); }
          else {
            await dialog.getByRole('button', { name: '获取模型目录', exact: true }).click();
            const directory = dialog.getByLabel('模型目录', { exact: true });
            await directory.getByLabel('new-1', { exact: true }).check(); await directory.getByLabel('new-2', { exact: true }).check();
            if (action === 'directory-required') { await directory.getByRole('button', { name: '添加所选模型', exact: true }).click(); await expect(dialog.getByRole('alert').filter({ hasText: 'new-1 缺少必填上下文' })).toBeVisible(); }
          }
        }
        if (action === 'source') await dialog.getByRole('combobox', { name: '凭据来源', exact: true }).selectOption('native');
        if (['picker', 'login', 'login-return'].includes(action)) {
          await dialog.getByLabel('配置名称').fill('保留草稿 · 工作配置');
          await dialog.getByRole('combobox', { name: '凭据来源', exact: true }).selectOption('account');
          await expect(page.getByRole('button', { name: '返回配置', exact: true })).toBeVisible();
          if (action !== 'picker') {
            await page.getByRole('button', { name: '登录新账号', exact: true }).click(); await page.getByLabel('账号名称').fill('新的工作账号'); await page.getByRole('button', { name: '添加并登录', exact: true }).click();
            const added = dialog.getByRole('listitem', { name: '新的工作账号' });
            await expect(added.getByRole('button', { name: '选择并返回' })).toBeDisabled();
            if (action === 'login-return') {
              await page.evaluate(() => { const value = window.workspaceFixture.accounts.find(account => account.id === 'new'); Object.assign(value, { state: 'signed_in', version: 3, pendingLogin: null, identity: { subject: 'new', email: 'new@example.test', source: 'synthetic' }, context: { id: 'ctx-new' } }); });
              await added.getByRole('button', { name: '选择并返回' }).click();
              await expect(dialog.getByLabel('配置名称')).toHaveValue('保留草稿 · 工作配置');
            }
          }
        }
        if (action === 'raw') { await dialog.getByRole('button', { name: '原生文本', exact: true }).click(); await expect(dialog.getByRole('textbox', { name: 'settings 配置草稿' })).toBeVisible(); }
        if (action === 'comparison') {
          await dialog.getByLabel('当前模型', { exact: true }).fill('my-edited-model');
          await page.evaluate(() => { const state = window.configurationProtocol; const file = JSON.parse(state.disk.settings); file.values.model = 'external-model'; state.disk.settings = JSON.stringify(file); });
          await dialog.getByRole('button', { name: '保存到当前文件', exact: true }).click();
          await expect(dialog.getByRole('button', { name: '使用本次修改', exact: true })).toBeVisible();
        }
        if (action === 'common-results') { await dialog.getByLabel('默认推理强度').selectOption('medium'); await dialog.getByText('更多保存操作', { exact: true }).click(); await dialog.getByRole('button', { name: '保存并应用到继承范围', exact: true }).click(); await expect(dialog.getByText('通用配置已保存；部分范围应用失败，可逐项重试。')).toBeVisible(); }
      }
      await capture(page, scene.name, theme, width, { category: 'configuration', title: scene.title, state: scene.state });
    } catch (error) { failures.push({ name: scene.name, theme, width, type: 'capture', message: error.message }); }
    finally { await page.close(); }
  }
}
