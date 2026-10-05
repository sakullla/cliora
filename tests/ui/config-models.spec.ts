import { expect, test } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Registered editor harness: projections/actions match each Rust adapter's
// describe/read/edit_inherited contract. It does not establish native loading.
let harness: string;
test.beforeAll(async () => {
  const entry = 'virtual:multi-model-editor-test';
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { piUiAdapter } from ${JSON.stringify(path.resolve('src/adapters/pi/index.ts'))};
    import { opencodeUiAdapter } from ${JSON.stringify(path.resolve('src/adapters/opencode/index.ts'))};
    import { kimiCodeUiAdapter } from ${JSON.stringify(path.resolve('src/adapters/kimi_code/index.ts'))};
    const tool = new URL(location.href).searchParams.get('tool');
    const blank = new URL(location.href).searchParams.has('blank');
    const pi = tool === 'pi', kimi = tool === 'kimi';
    const fields = (pi ? [
      ['name','显示名称','string'],['contextWindow','上下文上限','number'],['maxTokens','输出上限','number'],['reasoning','支持思考','boolean'],['input','输入类型','json',false,true],['thinkingLevelMap','模型思考档位映射','json',false,true],['defaultThinkingLevel','启动思考档位','string',false,true,['off','minimal','low','medium','high','xhigh','max']],
    ] : kimi ? [
      ['model','请求模型 ID','string',true],['provider','供应商 ID','string',true],['max_context_size','上下文上限','integer',true],['display_name','显示名称','string'],['max_input_size','输入上限','integer',false,true],['max_output_size','输出上限','integer',false,true],['capabilities','原生能力声明','json',false,true],['support_efforts','支持的思考档位','json',false,true],['default_effort','模型思考档位','string',false,true],['adaptive_thinking','自适应思考','boolean',false,true],['protocol','模型协议','string',false,true],['thinking.enabled','默认启用思考','boolean',false,true],['thinking.effort','默认思考档位','string',false,true],['thinking.keep','思考内容保留','string',false,true],
    ] : [
      ['name','显示名称','string'],['limit.context','上下文上限','integer'],['limit.output','输出上限','integer'],['reasoning','支持推理','boolean'],['modalities.input','输入模态','json',false,true],['modalities.output','输出模态','json',false,true],['options','模型选项','json',false,true],['variants','推理变体','json',false,true],
    ]).map(([id,label,kind,required,advanced,choices]) => ({ id,label,kind,required:required ?? false,advanced:advanced ?? false,choices:choices ?? [],minimum:['number','integer'].includes(kind)?1:null,defaultSource:'跟随原生默认',unavailableReason:null }));
    const descriptor={version:1,fields,operations:['configure_provider','select_provider','create','copy','rename','delete','default','set','reset',...(pi?['create_override']:kimi?[]:['small_default'])]};
    window.__actions=[];window.__validity={};window.__fail=false;window.__delay=false;
    function nested(values,field,value,reset) { const keys=field.split('.');let node=values;for(const key of keys.slice(0,-1))node=node[key]??(node[key]={});if(reset)delete node[keys.at(-1)];else node[keys.at(-1)]=value; }
    const model = id => ({id,kind:'model',fields:kimi?{provider:'gateway',model:'request-'+id,max_context_size:128000,extension:{keep:true}}:pi?{id,name:id,contextWindow:128000,maxTokens:16384,input:['text'],extension:{keep:true}}:{name:id,limit:{context:128000,output:16384},modalities:{input:['text'],output:['text']},extension:{keep:true}}});
    function Harness() {
      const [draft,setDraft]=React.useState({sessionId:'multi-editor-test',revision:0,scope:'global',profile:{},baselineFiles:{},issues:[],view:{providerId:blank?null:'gateway',providers:blank?[]:['gateway','other'],models:blank?[]:[model('first'),model('second')],defaultModel:null,smallModel:null,settings:{},connection:{baseUrl:blank?null:'https://example.test',protocol:pi?'openai-completions':kimi?'openai':'@ai-sdk/openai-compatible'},capabilityReason:'原生能力未核验'}});
      const [valid,setValid]=React.useState(true);
      window.__replaceView=fn=>setDraft(old=>({...old,revision:old.revision+1,view:fn(structuredClone(old.view))}));
      window.__replaceSession=()=>setDraft(old=>({...old,sessionId:'another-session',revision:0}));
      window.__setIssues=issues=>setDraft(old=>({...old,issues}));
      const onAction=async action=>{
        window.__actions.push(action);
        if(window.__delay)await new Promise(resolve=>{window.__release=resolve;});
        if(window.__fail)throw new Error('模拟原生动作失败');
        setDraft(old=>{
          const next=structuredClone(old), view=next.view, target=action.target;next.revision++;
          const model=view.models.find(model=>model.id===target.id && model.kind===target.kind);
          if(action.operation==='configure_provider'){view.providerId=target.provider;if(!view.providers.includes(target.provider))view.providers.push(target.provider);view.connection={baseUrl:action.value.baseUrl,protocol:action.value.interfaceFormat};}
          else if(action.operation==='select_provider'){view.providerId=target.provider;view.models=[];}
          else if(['create','create_override'].includes(action.operation))view.models.push({id:target.id,kind:target.kind,fields:action.value});
          else if(action.operation==='copy')view.models.push({...structuredClone(model),id:action.value});
          else if(action.operation==='rename'){model.id=action.value;if(view.defaultModel===target.id)view.defaultModel=action.value;}
          else if(action.operation==='delete')view.models=view.models.filter(model=>model.id!==target.id||model.kind!==target.kind);
          else if(action.operation==='default')view.defaultModel=target.id;
          else if(action.operation==='small_default')view.smallModel=target.id;
          else if(target.kind==='settings')nested(view.settings,kimi?action.field.slice('thinking.'.length):action.field,action.value,action.operation==='reset');
          else nested(model.fields,action.field,action.value,action.operation==='reset');
          return next;
        });
      };
      const onValidityChange=(field,valid)=>{window.__validity[field]=valid;setValid(Object.values(window.__validity).every(Boolean));};
      const Editor=(pi?piUiAdapter:kimi?kimiCodeUiAdapter:opencodeUiAdapter).configuration.Editor;
      return React.createElement('div',null,React.createElement(Editor,{draft,descriptor,onAction,onValidityChange}),React.createElement('button',{disabled:!valid},'保存配置'));
    }
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Harness)));
  `;
  const result = await build({ configFile: false, logLevel: 'silent', plugins: [react(), { name: 'multi-model-test', resolveId: id => id === entry ? `\0${entry}` : undefined, load: id => id === `\0${entry}` ? source : undefined }], build: { write: false, minify: false, cssCodeSplit: false, rollupOptions: { input: entry } } });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string; source?: string | Uint8Array }[] };
  const code = output.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  const css = output.output.filter(item => item.type === 'asset').map(item => String(item.source)).join('\n');
  harness = `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
});
test.beforeEach(async ({ page }) => {
  await page.route(/\/__multi_model_editor\?/, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: harness }));
});

for (const tool of ['pi', 'opencode', 'kimi']) {
  test(`${tool}: create three models from a blank provider, copy, rename, defaults and delete`, async ({ page }) => {
    await page.goto(`/__multi_model_editor?tool=${tool}&blank`);
    await page.getByLabel('供应商标识').fill('gateway');
    await page.getByLabel('连接地址').fill('https://example.test');
    await page.getByLabel('接口协议').selectOption('openai_completions');
    await page.getByRole('button', { name: '设置供应商连接' }).click();
    for (const id of ['one', 'two', 'three']) {
      await page.getByRole('button', { name: '新增模型', exact: true }).click();
      const form = page.getByRole('group', { name: '新增模型表单' });
      await form.getByLabel(tool === 'kimi' ? '模型 alias' : '模型 ID', { exact: true }).fill(id);
      if (tool === 'kimi') {
        await expect(form.getByLabel('上下文上限')).toBeVisible();
        await form.getByLabel('请求模型 ID').fill('actual-request-id');
        await form.getByLabel('上下文上限').fill('128000');
      }
      await form.getByRole('button', { name: '创建模型' }).click();
      await expect(page.getByRole('article', { name: `模型 ${id}`, exact: true })).toBeVisible();
    }
    const third = page.getByRole('article', { name: '模型 three', exact: true });
    await third.getByText('复制或修改模型标识', { exact: true }).click();
    await third.getByLabel(tool === 'kimi' ? '新 alias' : '新模型 ID').fill('copied');
    await third.getByRole('button', { name: '复制模型', exact: true }).click();
    const copied = page.getByRole('article', { name: '模型 copied', exact: true });
    await copied.getByRole('button', { name: /copied · copied/ }).click();
    await copied.getByText('复制或修改模型标识', { exact: true }).click();
    await copied.getByLabel(tool === 'kimi' ? '新 alias' : '新模型 ID').fill('renamed');
    await copied.getByRole('button', { name: '修改模型标识', exact: true }).click();
    await expect(copied).toHaveCount(0);
    const renamed = page.getByRole('article', { name: '模型 renamed', exact: true });
    await renamed.getByRole('button', { name: /renamed · renamed/ }).click();
    await renamed.getByRole('button', { name: '设为默认模型', exact: true }).click();
    await expect(renamed.getByRole('button', { name: '删除模型', exact: true })).toBeDisabled();
    if (tool === 'opencode') {
      await renamed.getByRole('button', { name: '设为轻量模型' }).click();
      await expect(renamed.getByRole('button', { name: '当前轻量模型' })).toBeDisabled();
    }
    const one = page.getByRole('article', { name: '模型 one', exact: true });
    await one.getByRole('button', { name: /one · one/ }).click();
    await one.getByRole('button', { name: '删除模型', exact: true }).click();
    await expect(one).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
    const actions = await page.evaluate(() => (window as unknown as { __actions: { target: unknown; operation: string; value: unknown }[] }).__actions);
    expect(actions.filter(action => action.operation === 'create')).toHaveLength(3);
    expect(actions.find(action => action.operation === 'create')).toMatchObject({ target: { kind: 'model', provider: 'gateway', id: 'one' }, value: tool === 'kimi' ? { provider: 'gateway', model: 'actual-request-id', max_context_size: 128000 } : {} });
  });

  test(`${tool}: invalid input survives model navigation and blocks provider switches`, async ({ page }) => {
    await page.goto(`/__multi_model_editor?tool=${tool}`);
    const first = page.getByRole('article', { name: '模型 first', exact: true });
    await first.getByRole('button', { name: /first · first/ }).click();
    const context = first.getByLabel('上下文上限');
    await context.fill('invalid-number');
    await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
    await expect(page.getByLabel('当前供应商')).toBeDisabled();
    if (tool === 'kimi') await expect(first.getByLabel('供应商 ID')).toBeDisabled();
    const second = page.getByRole('article', { name: '模型 second', exact: true });
    await second.getByRole('button', { name: /second · second/ }).click();
    await expect(context).not.toBeVisible();
    await first.getByRole('button', { name: /first · first/ }).click();
    await expect(context).toHaveValue('invalid-number');
    await context.fill('262144');
    await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
    await expect(page.getByLabel('当前供应商')).toBeEnabled();
    if (tool === 'kimi') await expect(first.getByLabel('供应商 ID')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: { field: string; value: unknown }[] }).__actions.at(-1))).toMatchObject({ field: tool === 'pi' ? 'contextWindow' : tool === 'kimi' ? 'max_context_size' : 'limit.context', value: 262144 });
  });
}

test('Kimi requires context at creation, rejects fractional values and cancels local validity', async ({ page }) => {
  await page.goto('/__multi_model_editor?tool=kimi');
  await page.getByRole('button', { name: '新增模型', exact: true }).click();
  const form = page.getByRole('group', { name: '新增模型表单' });
  await form.getByLabel('模型 alias').fill('friendly-alias');
  await form.getByLabel('请求模型 ID').fill('real/request/id');
  await expect(form.getByRole('button', { name: '创建模型' })).toBeDisabled();
  await form.getByLabel('上下文上限').fill('1.5');
  await expect(form.getByRole('alert')).toContainText('请输入有效数值');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await form.getByRole('button', { name: '取消新增' }).click();
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await page.getByText('默认思考设置', { exact: true }).click();
  await page.getByLabel('默认启用思考').check();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([{ version: 1, target: { kind: 'settings' }, operation: 'set', field: 'thinking.enabled', value: true }]);
});

test('Pi distinguishes builtin overrides, preserves modalities and native field issues', async ({ page }) => {
  await page.goto('/__multi_model_editor?tool=pi');
  await page.evaluate(() => {
    const state = window as unknown as { __replaceView: (fn: (view: any) => any) => void; __setIssues: (issues: unknown[]) => void };
    state.__replaceView(view => { view.models.push({ id: 'builtin', kind: 'override', fields: { contextWindow: 9999 } }); return view; });
    state.__setIssues([{ target: { id: 'builtin', kind: 'override', provider: 'gateway' }, field: 'contextWindow', code: 'native', message: '原生字段问题' }]);
  });
  const override = page.getByRole('article', { name: '模型 builtin', exact: true });
  await override.getByRole('button', { name: /内置覆盖/ }).click();
  await expect(override.getByRole('alert')).toContainText('原生字段问题');
  await override.getByLabel('图片', { exact: true }).check();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions.at(-1))).toEqual({ version: 1, target: { kind: 'override', provider: 'gateway', id: 'builtin' }, operation: 'set', field: 'input', value: ['image'] });
});

test('OpenCode edits options and modalities while preserving unknown native choices', async ({ page }) => {
  await page.goto('/__multi_model_editor?tool=opencode');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => { view.models[0].fields.modalities.input.push('future-format'); return view; }));
  const first = page.getByRole('article', { name: '模型 first', exact: true });
  await first.getByRole('button', { name: /first · first/ }).click();
  const input = first.getByRole('group', { name: '输入模态' });
  await expect(input.getByLabel('future-format（原生值）')).toBeChecked();
  await input.getByLabel('图片', { exact: true }).check();
  await first.getByText('模型选项与推理变体', { exact: true }).click();
  await first.getByLabel('模型选项', { exact: true }).fill('{"temperature":0.7}');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).toEqual([
    { version: 1, target: { kind: 'model', provider: 'gateway', id: 'first' }, operation: 'set', field: 'modalities.input', value: ['text', 'future-format', 'image'] },
    { version: 1, target: { kind: 'model', provider: 'gateway', id: 'first' }, operation: 'set', field: 'options', value: { temperature: 0.7 } },
  ]);
});

test('pending and failed actions retain input and recover by retry or explicit cancellation', async ({ page }) => {
  await page.goto('/__multi_model_editor?tool=kimi');
  const first = page.getByRole('article', { name: '模型 first', exact: true });
  await first.getByRole('button', { name: /first · first/ }).click();
  await page.evaluate(() => { (window as unknown as { __delay: boolean }).__delay = true; });
  await first.getByLabel('上下文上限').fill('262144');
  await expect(first.getByLabel('上下文上限')).toHaveValue('262144');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.evaluate(() => { const state = window as unknown as { __delay: boolean; __release: () => void }; state.__delay = false; state.__release(); });
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = true; });
  await first.getByRole('button', { name: '设为默认模型' }).click();
  await expect(page.getByRole('alert')).toContainText('模拟原生动作失败');
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled();
  await page.getByRole('button', { name: '取消本次操作' }).click();
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = false; });
  await first.getByRole('button', { name: '设为默认模型' }).click();
  await expect(first.getByRole('button', { name: '当前默认模型' })).toBeDisabled();
});

test('deleting a model retires its invalid input; replacing a session retires old validity', async ({ page }) => {
  await page.goto('/__multi_model_editor?tool=pi');
  const first = page.getByRole('article', { name: '模型 first', exact: true });
  await first.getByRole('button', { name: /first · first/ }).click();
  await first.getByLabel('上下文上限').fill('bad');
  await first.getByRole('button', { name: '删除模型' }).click();
  await expect(first).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  const second = page.getByRole('article', { name: '模型 second', exact: true });
  await second.getByRole('button', { name: /second · second/ }).click();
  await second.getByLabel('上下文上限').fill('bad');
  await page.evaluate(() => (window as unknown as { __replaceSession: () => void }).__replaceSession());
  await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
});

for (const tool of ['pi', 'opencode', 'kimi']) {
  test(`${tool}: malformed native model values stay recoverable and external projection updates fields`, async ({ page }) => {
    await page.goto(`/__multi_model_editor?tool=${tool}`);
    const first = page.getByRole('article', { name: '模型 first', exact: true });
    await first.getByRole('button', { name: /first · first/ }).click();
    await page.evaluate(() => {
      const state = window as unknown as { __replaceView: (fn: (view: any) => any) => void; __setIssues: (issues: unknown[]) => void };
      state.__replaceView(view => { view.models[0].fields = null; return view; });
      state.__setIssues([{ target: { kind: 'model', provider: 'gateway', id: 'first' }, field: 'model', code: 'invalid_native_value', message: '模型字段须为对象' }]);
    });
    await expect(first).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: '模型字段须为对象' })).toBeVisible();
    await page.evaluate(({ tool }) => {
      const state = window as unknown as { __replaceView: (fn: (view: any) => any) => void; __setIssues: (issues: unknown[]) => void };
      state.__replaceView(view => { view.models[0].fields = tool === 'kimi' ? { provider: 'gateway', model: 'new-native-request', max_context_size: 262144 } : tool === 'pi' ? { contextWindow: 262144 } : { limit: { context: 262144 } }; return view; });
      state.__setIssues([]);
    }, { tool });
    await expect(first.getByLabel('上下文上限')).toHaveValue('262144');
    await expect(page.getByRole('button', { name: '保存配置' })).toBeEnabled();
  });
}

for (const tool of ['pi', 'opencode']) {
  test(`${tool}: creation uses modality controls without requiring native JSON`, async ({ page }) => {
    await page.goto(`/__multi_model_editor?tool=${tool}`);
    await page.getByRole('button', { name: '新增模型', exact: true }).click();
    const form = page.getByRole('group', { name: '新增模型表单' });
    await form.getByLabel('模型 ID', { exact: true }).fill('visual');
    await form.getByText('可选参数', { exact: true }).click();
    await form.getByRole('group', { name: tool === 'pi' ? '输入类型' : '输入模态' }).getByLabel('图片', { exact: true }).check();
    await form.getByRole('button', { name: '创建模型' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions.at(-1))).toMatchObject({ operation: 'create', value: tool === 'pi' ? { input: ['image'] } : { modalities: { input: ['image'] } } });
    const created = page.getByRole('article', { name: '模型 visual', exact: true });
    await expect(created.getByRole('group', { name: tool === 'pi' ? '输入类型' : '输入模态' }).getByLabel('图片', { exact: true })).toBeChecked();
  });
}

test('Kimi effort options use model declarations and preserve an unknown native effort', async ({ page }) => {
  await page.goto('/__multi_model_editor?tool=kimi');
  await page.evaluate(() => (window as unknown as { __replaceView: (fn: (view: any) => any) => void }).__replaceView(view => { view.models[0].fields.support_efforts = ['low', 'high']; view.models[0].fields.default_effort = 'future-effort'; return view; }));
  const first = page.getByRole('article', { name: '模型 first', exact: true });
  await first.getByRole('button', { name: /first · first/ }).click();
  await first.getByText('能力、思考与可选上限', { exact: true }).click();
  const effort = first.getByLabel('模型思考档位', { exact: true });
  await expect(effort).toHaveValue('future-effort');
  await expect(effort.locator('option')).toContainText(['跟随原生默认', 'future-effort（原生值）', 'low', 'high']);
  await effort.selectOption('high');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions.at(-1))).toMatchObject({ target: { kind: 'model', provider: 'gateway', id: 'first' }, operation: 'set', field: 'default_effort', value: 'high' });
});
