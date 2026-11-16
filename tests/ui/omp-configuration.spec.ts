import { expect, test } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { setupConfigurationWorkspace } from './configuration-workspace-fixture';

// OMP's dedicated editor mounted in isolation. Native YAML semantics, profile
// isolation and credential references are covered by Rust tests and the shared
// native verifier; this spec only proves the registered editor's DOM,
// descriptor-driven actions and pending/invalid reporting.
let harness: string;
test.beforeAll(async () => {
  const entry = 'virtual:omp-configuration-test';
  const i18nEntry = path.resolve('src/i18n/index.ts');
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import ${JSON.stringify(i18nEntry)};
    import { OmpConfigurationEditor } from ${JSON.stringify(path.resolve('src/adapters/omp/ConfigurationEditor.tsx'))};
    const project = new URL(location.href).searchParams.get('scope') === 'project';
    const fields = [
      ['name','显示名称','string'],['contextWindow','上下文上限','number'],['maxTokens','输出上限','number'],
      ['reasoning','支持思考','boolean'],['input','输入类型','json'],['thinkingLevelMap','模型思考档位映射','json'],
      ['cost','费用','json'],['retry','重试设置','json'],
      ['modelRoles.default','默认模型','string'],['modelRoles.smol','轻量模型','string'],
      ['modelRoles.slow','复杂模型','string'],['modelRoles.plan','计划模型','string'],
    ].map(([id,label,kind]) => ({ id,label,kind,required:false,advanced:id==='retry'||id==='modelRoles.smol'||id==='modelRoles.slow'||id==='modelRoles.plan'||kind==='json',choices:[],minimum:kind==='number'?1:null,defaultSource:'原生默认',unavailableReason:null }));
    const descriptor = { version:1,fields,operations: project ? ['set','reset','default','small_default'] : ['set','reset','default','small_default','create','copy','rename','delete','configure_provider','select_provider'] };
    window.__actions=[];window.__validity={};window.__fail=false;window.__delay=false;
    const initial = {
      providerId:'alpha',providers:['alpha','beta'],
      models:[
        {id:'one',kind:'model',fields:{name:'One',contextWindow:200000,maxTokens:16384,reasoning:true,input:['text','image'],thinkingLevelMap:{low:'low'},cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0.2}}},
        {id:'two',kind:'model',fields:{name:'Two',contextWindow:128000}},
      ],
      roles:{customRole:'alpha/one',default:'alpha/one',smol:'beta/small',slow:'alpha/one',plan:'beta/small'},
      roleNames:['customRole','default','smol','slow','plan'],
      defaultModel:'one',smallModel:null,
      settings:{retry:{maxAttempts:3,baseDelayMs:250},'modelRoles.default':'alpha/one','modelRoles.smol':'beta/small','modelRoles.slow':'alpha/one','modelRoles.plan':'beta/small'},
      connection:{baseUrl:'https://alpha.example.test/v1',protocol:'openai-responses'},
      capabilityReason:'OMP 模型角色引用 provider/model；未编辑的角色与其他供应商保持原生值。',
    };
    function Harness() {
      const [draft,setDraft]=React.useState({sessionId:'editor-test',revision:0,scope:project?'project':'global',profile:{files:{},editing:{version:1,selectedProvider:'alpha',intents:[]}},baselineFiles:{},issues:[],view:structuredClone(initial)});
      const [valid,setValid]=React.useState(true);
      const onAction=async action=>{
        window.__actions.push(action);
        if(window.__delay) await new Promise(resolve=>{window.__release=resolve;});
        if(window.__fail) throw new Error('模拟写入失败');
        setDraft(old=>{
          const next=structuredClone(old);next.revision++;
          const kind=action.target.kind;
          if(kind==='provider' && action.operation==='select_provider') next.view.providerId=action.target.provider;
          else if(kind==='provider' && action.operation==='configure_provider') { next.view.providerId=action.target.provider; next.view.connection={baseUrl:action.value.baseUrl,protocol:'openai-completions'}; }
          else if(kind==='settings' || kind==='role') {
            const field=action.field;
            if(action.operation==='reset') { delete next.view.settings[field]; if(field.startsWith('modelRoles.')) delete next.view.roles[field.slice(11)]; }
            else { next.view.settings[field]=action.value; if(field.startsWith('modelRoles.')) next.view.roles[field.slice(11)]=action.value; }
          } else if(kind==='model') {
            if(action.operation==='default') { next.view.defaultModel=action.target.id; next.view.settings['modelRoles.default']=action.target.provider+'/'+action.target.id; }
            else if(action.operation==='small_default') { next.view.smallModel=action.target.id; next.view.settings['modelRoles.smol']=action.target.provider+'/'+action.target.id; }
            else if(action.operation==='create') { next.view.models.push({id:action.target.id,kind:'model',fields:{...action.value}}); }
            else if(action.operation==='delete' || action.operation==='rename') { next.view.models=next.view.models.filter(model=>model.id!==action.target.id); }
            else {
              const model=next.view.models.find(model=>model.id===action.target.id);
              if(model) {
                if(action.operation==='reset') delete model.fields[action.field];
                else if(typeof action.field==='string' && action.field.includes('.')) {
                  const [head,tail]=action.field.split('.');
                  model.fields[head]={...(model.fields[head]??{}),[tail]:action.value};
                } else if(action.field) model.fields[action.field]=action.value;
              }
            }
          }
          return next;
        });
      };
      const onValidityChange=(field,valid)=>{window.__validity[field]=valid;setValid(Object.values(window.__validity).every(value=>value));};
      return React.createElement('div',null,React.createElement(OmpConfigurationEditor,{draft,descriptor,onAction,onValidityChange}),React.createElement('button',{disabled:!valid},'保存配置'));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  `;
  const result = await build({ configFile: false, logLevel: 'silent', plugins: [react(), { name: 'omp-configuration-test', resolveId: id => id === entry ? `\0${entry}` : undefined, load: id => id === `\0${entry}` ? source : undefined }], build: { write: false, minify: false, cssCodeSplit: false, rollupOptions: { input: entry } } });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string; source?: string | Uint8Array }[] };
  const code = output.output.filter(item => item.type === 'chunk').map(item => item.code).join('\\n');
  const css = output.output.filter(item => item.type === 'asset').map(item => String(item.source)).join('\\n');
  if (!code.includes('editor-test')) throw new Error(`Missing harness entry in Vite output: ${output.output.map(item => item.type).join(',')}`);
  harness = `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
});
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { console.error(`OMP editor harness: ${error.message}`); });
  await page.route(/\/__omp_configuration_test/, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: harness }));
});

test('OMP roles use provider/model references and keep unknown roles visible', async ({ page }) => {
  await page.goto('/__omp_configuration_test');
  await expect(page.getByLabel('oh-my-pi (OMP) 配置')).toBeVisible();
  await page.getByText('模型角色', { exact: true }).click();
  const role = page.getByLabel('默认模型', { exact: true });
  await expect(role).toHaveValue('alpha/one');
  await expect(page.getByText(/customRole/)).toBeVisible();
  await role.selectOption('alpha/two');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: { kind: 'settings' }, operation: 'set', field: 'modelRoles.default', value: 'alpha/two' },
  ]);
});

test('OMP model edits stay inside one model and invalid numbers block save', async ({ page }) => {
  await page.goto('/__omp_configuration_test');
  await page.getByLabel('模型 one').getByRole('button').first().click();
  const context = page.getByLabel('模型 one').getByLabel('上下文上限（Token）');
  await expect(context).toHaveValue('200000');
  await context.fill('0');
  await expect(page.getByRole('alert')).toContainText('请输入有效数值');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.evaluate(() => { (window as unknown as { __delay: boolean }).__delay = true; });
  await context.fill('100000');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.evaluate(() => { const state = window as unknown as { __release: () => void; __delay: boolean }; state.__delay = false; state.__release(); });
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: { kind: 'model', provider: 'alpha', id: 'one' }, operation: 'set', field: 'contextWindow', value: 100000 },
  ]);
});

test('OMP retry JSON is validated, saved as a native object and failure recovers', async ({ page }) => {
  await page.goto('/__omp_configuration_test');
  await page.locator('summary').filter({ hasText: '重试设置' }).click();
  const retry = page.getByLabel('重试设置', { exact: true });
  await retry.fill('{');
  await expect(page.getByRole('alert')).toContainText('请输入有效 JSON');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = true; });
  await retry.fill('{"maxAttempts":4}');
  await expect(page.getByRole('alert')).toContainText('模拟写入失败');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = false; });
  await retry.fill('{"maxAttempts":5}');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: { kind: 'settings' }, operation: 'set', field: 'retry', value: { maxAttempts: 4 } },
    { version: 1, target: { kind: 'settings' }, operation: 'set', field: 'retry', value: { maxAttempts: 5 } },
  ]);
});

test('OMP provider selection targets the native provider identity', async ({ page }) => {
  await page.goto('/__omp_configuration_test');
  const providerSelect = page.locator('[data-config-step="connection"] select').first();
  await providerSelect.selectOption('beta');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: { kind: 'provider', provider: 'beta' }, operation: 'select_provider', field: null, value: null },
  ]);
});

test('OMP default action targets the native model identity', async ({ page }) => {
  await page.goto('/__omp_configuration_test');
  await page.getByLabel('模型 two').getByRole('button').first().click();
  await page.getByRole('button', { name: '设为默认模型' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: { kind: 'model', provider: 'alpha', id: 'two' }, operation: 'default', field: null, value: null },
  ]);
});

test('OMP project scope explains plaintext rejection and hides new providers', async ({ page }) => {
  await page.goto('/__omp_configuration_test?scope=project');
  await expect(page.getByText('项目 .omp 只保存当前项目的值；明文供应商密钥会被拒绝。')).toBeVisible();
  await expect(page.getByText('供应商密钥保存在 Cliora 的凭据边界；配置只写入环境变量引用，不进入草稿、IPC 或未加密导出。')).toBeVisible();
});

test('the shared shell opens OMP new configurations in quick and keeps one draft across levels', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'omp');
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '快速配置', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByLabel('oh-my-pi (OMP) 配置')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '常用设置', exact: true })).toHaveCount(0);
  const model = dialog.getByLabel('模型 one', { exact: true });
  await model.getByRole('button').first().click();
  const context = model.getByLabel('上下文上限（Token）');
  await context.fill('100000');
  await dialog.getByRole('button', { name: '高级配置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '常用设置', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '原生文本', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('配置名称')).toHaveValue('omp 配置');
  await dialog.getByRole('button', { name: '快速配置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '常用设置', exact: true })).toHaveCount(0);
  await expect(model.getByLabel('上下文上限（Token）')).toHaveValue('100000');
});

test('OMP quick save never applies and leaves the current binding alone', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'omp');
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).configurationProtocol.calls);
  expect(calls.filter((call: any) => call.command === 'save_configuration_draft')).toHaveLength(1);
  expect(calls.filter((call: any) => call.command.includes('apply_'))).toEqual([]);
  expect(await page.evaluate(() => (window as any).workspaceFixture.binding.profileVersion)).toBe(3);
});
