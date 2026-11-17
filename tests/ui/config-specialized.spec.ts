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
  const i18nEntry = path.resolve('src/i18n/index.ts');
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import ${JSON.stringify(i18nEntry)};
    import ${JSON.stringify(path.resolve('src/styles/tokens.css'))};
    import ${JSON.stringify(path.resolve('src/styles/base.css'))};
    import ${JSON.stringify(path.resolve('src/styles/components.css'))};
    import shellStyles from ${JSON.stringify(path.resolve('src/features/tools/configuration/ConfigurationWorkspaceEditor.module.css'))};
    import { ConfirmationHost } from ${JSON.stringify(path.resolve('src/components/ConfirmationHost.tsx'))};
    import { CodexConfigurationEditor } from ${JSON.stringify(path.resolve('src/adapters/codex/ConfigurationEditor.tsx'))};
    import { ClaudeConfigurationEditor } from ${JSON.stringify(path.resolve('src/adapters/claude/ConfigurationEditor.tsx'))};
    const search = new URL(location.href).searchParams;
    const tool = search.get('tool');
    const codex = tool === 'codex';
    const initialLevel = search.get('level') === 'quick' ? 'quick' : 'advanced';
    const initialSection = search.get('section') ?? (initialLevel === 'quick' ? 'models' : undefined);
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
    const roleNames = ['sonnet','opus','fable','haiku','subagent'];
    function Harness() {
      const [draft,setDraft]=React.useState({sessionId:'editor-test',revision:0,scope:'global',profile:{connection:{baseUrl:'https://api.openai.com/v1'}},baselineFiles:{},issues:[],view:{
        values:codex?{model:'gpt-6.1-sol',model_provider:'gateway',model_reasoning_effort:'ultra',model_context_window:262144}:{'default.model':'claude-opus-4-8','sonnet.model':'gateway-sonnet',effortLevel:'xhigh'},
        customConnection:codex?true:undefined,roleFollowing:codex?undefined:{sonnet:false,opus:true,fable:true,haiku:true,subagent:true},
        effortChoices:codex?['low','medium','high','xhigh','max','ultra']:['low','medium','high','xhigh'],
        currentEffortModel:'claude-opus-4-8',modelEfforts:{'claude-opus-4-8':'high'},modelEffortChoices:{'claude-opus-4-8':['low','medium','high','xhigh']},capabilitySource:'Native capability evidence',
      }});
      const [valid,setValid]=React.useState(true);
      const [level,setLevel]=React.useState(initialLevel);
      const [section,setSection]=React.useState(initialSection);
      window.__setLevel=setLevel;window.__setSection=setSection;
      window.__replaceView=fn=>setDraft(old=>({...old,revision:old.revision+1,view:fn(structuredClone(old.view))}));
      const onAction=async action=>{
        window.__actions.push(action);
        if(window.__delay) await new Promise(resolve=>{window.__release=resolve;});
        if(window.__fail) throw new Error('模拟写入失败');
        setDraft(old=>{
          const next=structuredClone(old);next.revision++;
          const role = typeof action.field === 'string' ? action.field.split('.')[0] : '';
          if(action.field==='modelEffortLevel') {const model=action.target.slice(6);if(action.operation==='reset')delete next.view.modelEfforts[model];else next.view.modelEfforts[model]=action.value;}
          else if(action.operation==='reset'){delete next.view.values[action.field];if(roleNames.includes(role)&&action.field.endsWith('.model'))next.view.roleFollowing[role]=true;}
          else if(action.operation==='unify'){const value=String(action.value??'');next.view.values['default.model']=value.replace(/\[1m\]$/i,'');next.view.values['default.longContext']=/\[1m\]$/i.test(value);for(const item of roleNames){delete next.view.values[item+'.model'];delete next.view.values[item+'.longContext'];next.view.roleFollowing[item]=true;}}
          else {next.view.values[action.field]=action.value;if(roleNames.includes(role)&&action.field.endsWith('.model'))next.view.roleFollowing[role]=false;}
          return next;
        });
      };
      const onValidityChange=(field,valid)=>{window.__validity[field]=valid;setValid(Object.values(window.__validity).every(value=>value));};
      const editor = React.createElement(codex?CodexConfigurationEditor:ClaudeConfigurationEditor,{draft,descriptor,section:level==='quick'?'models':section,onAction,onValidityChange});
      return React.createElement('div',null,
        React.createElement('div',{className:level==='quick'?shellStyles.quickEditor:undefined},editor),
        React.createElement('button',{disabled:!valid},'保存配置'),
        React.createElement(ConfirmationHost));
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
  await expect(page.getByLabel('模型', { exact: true })).toBeVisible();
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
  const address = page.getByLabel('请求地址', { exact: true });
  const model = page.getByLabel('模型', { exact: true });
  await expect(address).toBeVisible();
  expect((await address.boundingBox())!.y).toBeLessThan((await model.boundingBox())!.y);
  await page.getByText('供应商连接', { exact: true }).click();
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
  await page.getByText('供应商连接', { exact: true }).click();
  await page.getByText('角色、子代理与长上下文', { exact: true }).click();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-sonnet');
  await page.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Sonnet');
  await expect(dialog).not.toContainText('Opus');
  await dialog.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveAttribute('placeholder', '跟随默认模型 · gateway-default');
  await expect(page.getByLabel('subagent 模型', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('subagent 模型', { exact: true })).toHaveAttribute('placeholder', '跟随默认模型 · gateway-default');
});

test('Claude all-following roles disable unify and show the no-change note', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    delete view.values['sonnet.model'];
    view.roleFollowing = { sonnet: true, opus: true, fable: true, haiku: true, subagent: true };
    return view;
  }));
  await page.evaluate(() => (window as unknown as { __setSection: (value: string) => void }).__setSection('settings'));
  const unify = page.getByRole('button', { name: '将默认模型用于全部角色' });
  await expect(unify).toBeDisabled();
  await expect(page.getByText('所有角色都已跟随默认模型，无需统一。', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveAttribute('placeholder', '跟随默认模型 · claude-opus-4-8');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([]);
});

test('Claude local settings block unify when global role overrides remain', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    view.editTarget = 'local_configuration';
    view.inheritedRoleModels = ['sonnet'];
    return view;
  }));
  await page.evaluate(() => (window as unknown as { __setSection: (value: string) => void }).__setSection('settings'));
  const unify = page.getByRole('button', { name: '将默认模型用于全部角色' });
  await expect(unify).toBeDisabled();
  await expect(page.getByText(/Sonnet 的模型覆盖来自全局 settings/)).toBeVisible();
  await expect(page.getByText('全局覆盖', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([]);
});

test('Claude explicit-equal and long-context-only roles are listed and unified', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    view.values['haiku.model'] = 'claude-opus-4-8';
    view.values['haiku.longContext'] = true;
    view.roleFollowing.haiku = false;
    return view;
  }));
  await page.evaluate(() => (window as unknown as { __setSection: (value: string) => void }).__setSection('settings'));
  await page.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Haiku');
  await expect(dialog).toContainText('Sonnet');
  await dialog.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await expect(page.getByLabel('haiku 模型', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('haiku 长上下文 [1m]', { exact: true })).not.toBeChecked();
});

test('Claude following roles show an inherited long-context checkbox without failing writes', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    delete view.values['sonnet.model'];
    view.roleFollowing.sonnet = true;
    view.values['default.longContext'] = true;
    return view;
  }));
  await page.evaluate(() => (window as unknown as { __setSection: (value: string) => void }).__setSection('settings'));
  const longContext = page.getByLabel('sonnet 长上下文 [1m]', { exact: true });
  await expect(longContext).toBeChecked();
  await expect(longContext).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([]);
});

test('Claude following roles keep the default model and unify cancellation sends nothing', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.getByLabel('默认模型', { exact: true }).fill('claude-sonnet-4-6');
  await page.evaluate(() => (window as unknown as { __setSection: (value: string) => void }).__setSection('settings'));
  const opus = page.getByLabel('opus 模型', { exact: true });
  await expect(opus).toHaveValue('');
  await expect(opus).toHaveAttribute('placeholder', '跟随默认模型 · claude-sonnet-4-6');
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-sonnet');
  const unify = page.getByRole('button', { name: '将默认模型用于全部角色' });
  await unify.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Sonnet');
  await expect(dialog).not.toContainText('Opus');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(unify).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: 'configuration', operation: 'set', field: 'default.model', value: 'claude-sonnet-4-6' },
  ]);
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-sonnet');
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
  await page.getByRole('dialog').getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await expect(page.getByRole('alert')).toContainText('模拟写入失败');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-sonnet');
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = false; });
  await page.getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '将默认模型用于全部角色' }).click();
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveAttribute('placeholder', '跟随默认模型 · claude-opus-4-8');
});

test('Codex quick hides builtin provider fields and keeps a real custom summary', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=codex&level=quick');
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('gpt-6.1-sol');
  await expect(page.getByLabel('供应商 ID', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('请求地址', { exact: true })).not.toBeVisible();
  await expect(page.getByText('模型参数', { exact: true })).not.toBeVisible();
  await expect(page.locator('[data-config-step="model"]').getByText('gateway', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    view.values = { model: 'gpt-6.1-sol', model_provider: 'openai' };
    view.customConnection = false;
    return view;
  }));
  await expect(page.locator('[data-config-step="model"]').getByText('gateway', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('供应商 ID', { exact: true })).not.toBeVisible();
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    view.values.base_url = 'https://gateway.example.test/v1';
    view.customConnection = true;
    return view;
  }));
  await expect(page.locator('[data-config-step="model"]').getByText('openai', { exact: true })).toBeVisible();
  await expect(page.locator('[data-config-step="model"]')).toContainText('https://gateway.example.test/v1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([]);
});

test('Codex quick and advanced share one draft and the same native targets', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=codex&level=quick');
  await page.getByLabel('模型', { exact: true }).fill('gpt-quick');
  await page.evaluate(() => (window as unknown as { __setLevel: (value: string) => void }).__setLevel('advanced'));
  await expect(page.getByLabel('供应商 ID', { exact: true })).toBeVisible();
  await expect(page.getByLabel('供应商 ID', { exact: true })).toHaveValue('gateway');
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('gpt-quick');
  await expect(page.getByText(/接口协议：responses/)).toBeVisible();
  await expect(page.getByText('模型参数', { exact: true })).not.toBeVisible();
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    view.wireProtocol = 'chat';
    return view;
  }));
  await expect(page.getByText(/接口协议：chat/)).toBeVisible();
  await page.evaluate(() => (window as unknown as { __setSection: (value: string) => void }).__setSection('settings'));
  await expect(page.getByLabel('推理强度（Codex 原生）')).toHaveValue('ultra');
  await page.getByLabel('推理强度（Codex 原生）').selectOption('');
  await page.getByLabel('上下文窗口（Token）').fill('131072');
  await page.evaluate(() => (window as unknown as { __setLevel: (value: string) => void }).__setLevel('quick'));
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('gpt-quick');
  await expect(page.getByLabel('推理强度（Codex 原生）')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: 'configuration', operation: 'set', field: 'model', value: 'gpt-quick' },
    { version: 1, target: 'configuration', operation: 'reset', field: 'model_reasoning_effort', value: null },
    { version: 1, target: 'configuration', operation: 'set', field: 'model_context_window', value: 131072 },
  ]);
});

test('Claude quick keeps only credential, default model and the real custom address', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude&level=quick');
  await expect(page.getByLabel('默认模型', { exact: true })).toHaveValue('claude-opus-4-8');
  await expect(page.getByLabel('请求地址', { exact: true })).not.toBeVisible();
  await expect(page.getByText('角色、子代理与长上下文', { exact: true })).not.toBeVisible();
  await expect(page.getByText('推理参数', { exact: true })).not.toBeVisible();
  await expect(page.locator('[data-config-step="model"]')).not.toContainText('gateway');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    view.values.base_url = 'https://gateway.example.test/anthropic';
    view.baseUrlSource = 'env.ANTHROPIC_BASE_URL';
    return view;
  }));
  await expect(page.locator('[data-config-step="model"]').getByText('https://gateway.example.test/anthropic', { exact: true })).toBeVisible();
  await page.getByLabel('默认模型', { exact: true }).fill('claude-quick');
  await page.evaluate(() => (window as unknown as { __setLevel: (value: string) => void }).__setLevel('advanced'));
  await expect(page.getByLabel('请求地址', { exact: true })).toHaveValue('https://gateway.example.test/anthropic');
  await expect(page.getByText(/该地址来自原生配置 env.ANTHROPIC_BASE_URL/)).toBeVisible();
  await expect(page.getByLabel('默认模型', { exact: true })).toHaveValue('claude-quick');
  await page.evaluate(() => (window as unknown as { __setSection: (value: string) => void }).__setSection('settings'));
  await expect(page.getByLabel('sonnet 模型', { exact: true })).toHaveValue('gateway-sonnet');
  await expect(page.getByLabel('opus 模型', { exact: true })).toHaveAttribute('placeholder', '跟随默认模型 · claude-quick');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: 'configuration', operation: 'set', field: 'default.model', value: 'claude-quick' },
  ]);
});

test('Claude environment overrides state their real source', async ({ page }) => {
  await page.goto('/__configuration_editor_test?tool=claude');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => {
    view.effortOverride = 'max';
    view.modelEffortOverride = 'low';
    return view;
  }));
  await page.getByText('推理参数', { exact: true }).click();
  await expect(page.getByText(/CLAUDE_CODE_EFFORT_LEVEL 当前优先于 effortLevel（max）/)).toBeVisible();
  await expect(page.getByText(/modelSettings effort（low）/)).toBeVisible();
});
