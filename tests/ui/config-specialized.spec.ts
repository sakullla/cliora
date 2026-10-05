import { expect, test } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Exercise the registered editors independently of workspace routing. Native
// semantics are tested in each Rust adapter; this harness checks DOM behavior
// and pending/invalid input reporting to the shared session owner.
let harness: string;
test.beforeAll(async () => {
  const entry = 'virtual:configuration-editor-test';
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { CodexConfigurationEditor } from ${JSON.stringify(path.resolve('src/adapters/codex/ConfigurationEditor.tsx'))};
    import { ClaudeConfigurationEditor } from ${JSON.stringify(path.resolve('src/adapters/claude/ConfigurationEditor.tsx'))};
    const tool = new URL(location.href).searchParams.get('tool');
    const codex = tool === 'codex';
    const fields = (codex ? [
      ['model','当前模型','string'],['model_provider','供应商 ID','string'],['base_url','Responses 地址','string'],
      ['model_reasoning_effort','推理强度（Codex 原生）','string'],['model_context_window','上下文窗口（Token）','integer'],
      ['model_reasoning_summary','推理摘要','string',['auto','concise','detailed','none']],['model_verbosity','回答详细程度','string',['low','medium','high']],
    ] : [
      ['default.model','默认模型','string'],['default.longContext','default 长上下文 [1m]','boolean'],['base_url','Anthropic 地址','string'],
      ['effortLevel','默认推理 effort','string',['low','medium','high','xhigh']],['modelEffortLevel','此模型推理 effort','string',['low','medium','high','xhigh']],
      ...['sonnet','opus','fable','haiku','subagent'].flatMap(role => [[role+'.model',role+' 模型','string'],[role+'.longContext',role+' 长上下文 [1m]','boolean'],...(role === 'subagent' ? [] : [[role+'.name',role+' 显示名称','string']])]),
    ]).map(([id,label,kind,choices]) => ({ id,label,kind,choices:choices ?? [],required:false,advanced:false,minimum:kind==='integer'?1:null,defaultSource:'原生默认',unavailableReason:null }));
    const descriptor = { version:1,fields,operations:['set','reset','unify'] };
    window.__actions=[];window.__validity={};window.__fail=false;window.__delay=false;
    function Harness() {
      const [draft,setDraft]=React.useState({sessionId:'editor-test',revision:0,scope:'global',profile:{connection:{baseUrl:'https://api.openai.com/v1'}},baselineFiles:{},issues:[],view:{
        values:codex?{model:'gpt-6.1-sol',model_provider:'gateway',model_reasoning_effort:'ultra',model_context_window:262144}:{'default.model':'claude-opus-4-8','sonnet.model':'gateway-sonnet',effortLevel:'xhigh'},
        effortChoices:codex?['low','medium','high','xhigh','max','ultra']:['low','medium','high','xhigh'],
        currentEffortModel:'claude-opus-4-8',modelEfforts:{'claude-opus-4-8':'high'},modelEffortChoices:{'claude-opus-4-8':['low','medium','high','xhigh']},capabilitySource:'Native capability evidence',
      }});
      const [valid,setValid]=React.useState(true);
      const onAction=async action=>{
        window.__actions.push(action);
        if(window.__delay) await new Promise(resolve=>{window.__release=resolve;});
        if(window.__fail) throw new Error('模拟写入失败');
        setDraft(old=>{
          const next=structuredClone(old);next.revision++;
          if(action.field==='modelEffortLevel') {const model=action.target.slice(6);if(action.operation==='reset')delete next.view.modelEfforts[model];else next.view.modelEfforts[model]=action.value;}
          else if(action.operation==='reset')delete next.view.values[action.field];
          else if(action.operation==='unify')for(const role of ['default','sonnet','opus','fable','haiku','subagent'])next.view.values[role+'.model']=action.value;
          else next.view.values[action.field]=action.value;
          return next;
        });
      };
      const onValidityChange=(field,valid)=>{window.__validity[field]=valid;setValid(Object.values(window.__validity).every(value=>value));};
      return React.createElement('div',null,React.createElement(codex?CodexConfigurationEditor:ClaudeConfigurationEditor,{draft,descriptor,onAction,onValidityChange}),React.createElement('button',{disabled:!valid},'保存配置'));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  `;
  const result = await build({ configFile: false, logLevel: 'silent', plugins: [react(), { name: 'specialized-editor-test', resolveId: id => id === entry ? `\0${entry}` : undefined, load: id => id === `\0${entry}` ? source : undefined }], build: { write: false, minify: false, cssCodeSplit: false, rollupOptions: { input: entry } } });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string; source?: string | Uint8Array }[] };
  const code = output.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  const css = output.output.filter(item => item.type === 'asset').map(item => String(item.source)).join('\n');
  if (!code.includes('editor-test')) throw new Error(`Missing harness entry in Vite output: ${output.output.map(item => item.type).join(',')}`);
  harness = `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
});
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { console.error(`Specialized editor harness: ${error.message}`); });
  await page.route(/\/__configuration_editor_test\?/, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: harness }));
});

test('Codex keeps parameters collapsed and uses model efforts including ultra', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=codex');
  await expect(page.getByLabel('当前模型')).toBeVisible();
  await expect(page.getByLabel('推理强度（Codex 原生）')).not.toBeVisible();
  await page.getByText('模型参数', { exact: true }).click();
  const effort = page.getByLabel('推理强度（Codex 原生）');
  await expect(effort).toHaveValue('ultra');
  await expect(effort.locator('option')).toContainText(['原生默认', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  await effort.selectOption('');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([{ version: 1, target: 'configuration', operation: 'reset', field: 'model_reasoning_effort', value: null }]);
});

test('Codex invalid and pending integer input blocks save and failure can recover', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=codex');
  await page.getByText('模型参数', { exact: true }).click();
  const context = page.getByLabel('上下文窗口（Token）');
  await context.fill('0');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('请输入有效数值');
  await page.evaluate(() => { (window as unknown as { __delay: boolean }).__delay = true; });
  await context.fill('524288');
  await expect(context).toHaveValue('524288');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.evaluate(() => { const state = window as unknown as { __release: () => void; __delay: boolean }; state.__delay = false; state.__release(); });
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = true; });
  await context.fill('65536');
  await expect(page.getByRole('alert')).toContainText('模拟写入失败');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = false; });
  await context.fill('131072');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
});

test('Codex omitted address stays empty and reset removes the override', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=codex');
  await page.getByText('供应商连接', { exact: true }).click();
  const address = page.getByLabel('Responses 地址');
  await expect(address).toHaveValue('');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await address.fill('https://api.openai.com/v1');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await address.locator('..').getByRole('button', { name: '恢复默认' }).click();
  await expect(address).toHaveValue('');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: 'gateway', operation: 'set', field: 'base_url', value: 'https://api.openai.com/v1' },
    { version: 1, target: 'gateway', operation: 'reset', field: 'base_url', value: null },
  ]);
});

test('Claude default model edits leave roles independent until explicit unify', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await expect(page.getByLabel('默认模型', { exact: true })).toBeVisible();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).not.toBeVisible();
  await page.getByLabel('默认模型', { exact: true }).fill('gateway-default');
  await page.getByText('角色、子代理与长上下文', { exact: true }).click();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-sonnet');
  await page.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-default');
  await expect(page.getByLabel('subagent 模型', { exact: true })).toHaveValue('gateway-default');
});

test('Claude model effort edit and reset target the native model override', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.getByText('推理参数', { exact: true }).click();
  await expect(page.getByLabel('模型 effort 的 canonical ID')).toHaveValue('claude-opus-4-8');
  await page.getByLabel('此模型推理 effort', { exact: true }).selectOption('low');
  await expect(page.getByLabel('默认推理 effort', { exact: true })).toHaveValue('xhigh');
  await page.getByLabel('此模型推理 effort', { exact: true }).selectOption('');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: 'model:claude-opus-4-8', operation: 'set', field: 'modelEffortLevel', value: 'low' },
    { version: 1, target: 'model:claude-opus-4-8', operation: 'reset', field: 'modelEffortLevel', value: null },
  ]);
});

test('Claude explicit unify failure blocks save until retry succeeds', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.getByText('角色、子代理与长上下文', { exact: true }).click();
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = true; });
  await page.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await expect(page.getByRole('alert')).toContainText('模拟写入失败');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-sonnet');
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = false; });
  await page.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('claude-opus-4-8');
});
