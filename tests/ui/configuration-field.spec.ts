import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const component = ts.transpileModule(readFileSync('src/components/configuration/ConfigurationField.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sources = {
  react: readFileSync('node_modules/react/cjs/react.development.js', 'utf8'),
  'react-dom': readFileSync('node_modules/react-dom/cjs/react-dom.development.js', 'utf8'),
  'react-dom/client': readFileSync('node_modules/react-dom/cjs/react-dom-client.development.js', 'utf8'),
  scheduler: readFileSync('node_modules/scheduler/cjs/scheduler.development.js', 'utf8'),
  'react/jsx-runtime': readFileSync('node_modules/react/cjs/react-jsx-runtime.development.js', 'utf8'),
  field: component,
};

async function mount(page: Page, lateFailure: boolean | 'enum' | 'enum-no-reset' | 'number' | 'number-late-projection' | 'info' | 'restore' | 'required') {
  await page.setContent('<div id="field-fixture"></div>');
  await page.evaluate(({ sources, lateFailure }) => {
    const cache: Record<string, { exports: unknown }> = {};
    const require = (name: string): any => {
      if (cache[name]) return cache[name].exports;
      const module = { exports: {} as Record<string, unknown> };
      cache[name] = module;
      // CSS module imports (e.g. './configuration.module.css') have no bundled
      // source in this fixture; hand the component an empty default export so
      // className lookups resolve to undefined instead of throwing.
      const source = sources[name as keyof typeof sources];
      if (source === undefined) module.exports = { default: {} };
      else new Function('module', 'exports', 'require', 'process', source)(module, module.exports, require, { env: { NODE_ENV: 'development' } });
      return module.exports;
    };
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { ConfigurationField } = require('field');
    let attempts = 0;
    const state = window as unknown as { failOldRequest?: () => void; changedValues: unknown[]; resets: number; completeNumber: (() => void)[]; publishNumber: (() => void)[] };
    state.changedValues = []; state.resets = 0; state.completeNumber = []; state.publishNumber = [];
    const isNumber = lateFailure === 'number' || lateFailure === 'number-late-projection';
    const isEnum = lateFailure === 'enum' || lateFailure === 'enum-no-reset';
    const isInfo = lateFailure === 'info';
    const isRestore = lateFailure === 'restore';
    const isRequired = lateFailure === 'required';
    function Fixture() {
      const [value, setValue] = React.useState(isNumber ? 10 : isEnum ? 'high' : isInfo ? 1024 : null);
      const [valid, setValid] = React.useState(true);
      const [origin, setOrigin] = React.useState('unset');
      return React.createElement('div', null,
        React.createElement(ConfigurationField, {
          field: { id: isInfo ? 'maxTokens' : 'reasoning', label: isInfo ? '最大输出' : '推理', kind: isNumber || isInfo ? 'integer' : isEnum || isRestore ? 'enum' : isRequired ? 'string' : 'boolean', required: isRequired, advanced: false, choices: isEnum || isRestore ? ['low', 'high'] : [], minimum: isNumber || isInfo ? 1 : null, defaultSource: isInfo || isRestore ? '原生默认' : null, unavailableReason: null },
          value, onValidityChange: setValid,
          presentation: isInfo ? { unit: 'tokens', description: '最大输出令牌数。', nativeField: 'MAX_TOKENS', origin: 'explicit' } : isRestore ? { nativeField: 'REASONING', origin } : undefined,
          onReset: lateFailure === 'enum' || isRestore || isRequired ? async () => { state.resets += 1; setValue(null); if (isRestore) setOrigin('unset'); } : undefined,
          onChange: async (next: unknown) => {
            state.changedValues.push(next);
            if (isEnum || isRestore || isRequired) { setValue(next); return; }
            if (isNumber) { await new Promise<void>(resolve => { state.completeNumber.push(resolve); }); if (lateFailure === 'number-late-projection') state.publishNumber.push(() => setValue(next)); else setValue(next); return; }
            attempts += 1;
            if (attempts === 1) {
              if (lateFailure) await new Promise((_resolve, reject) => { state.failOldRequest = () => reject(new Error('较旧失败')); });
              else throw new Error('暂时失败');
            } else setValue(next);
          },
        }),
        isRestore ? React.createElement('button', { onClick: () => { setValue('low'); setOrigin('explicit'); } }, '设为显式') : null,
        React.createElement('button', { disabled: !valid }, '保存草稿'),
        React.createElement('button', { onClick: () => setValue(999) }, '外部原文变更'));
    }
    createRoot(document.getElementById('field-fixture')).render(React.createElement(Fixture));
  }, { sources, lateFailure });
}

test('checkbox retries recover field validity after a temporary failure without a reset control', async ({ page }) => {
  await mount(page, false);
  await page.getByRole('checkbox', { name: '推理' }).click();
  await expect(page.getByRole('alert')).toHaveText('暂时失败');
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '推理' }).click();
  await expect(page.getByRole('checkbox', { name: '推理' })).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
});

test('a late checkbox failure cannot invalidate a more recent successful edit', async ({ page }) => {
  await mount(page, true);
  await page.getByRole('checkbox', { name: '推理' }).click();
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '推理' }).click();
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { failOldRequest: () => void }).failOldRequest(); });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
});


test('optional enum default selection resets ownership rather than setting an empty string', async ({ page }) => {
  await mount(page, 'enum');
  await page.getByRole('combobox', { name: '推理' }).selectOption('');
  await expect.poll(() => page.evaluate(() => (window as unknown as { resets: number }).resets)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { changedValues: unknown[] }).changedValues)).toEqual([]);
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
});

test('enum fields without a reset operation provide no selectable default action', async ({ page }) => {
  await mount(page, 'enum-no-reset');
  await expect(page.getByRole('combobox', { name: '推理' }).locator('option[value=""]')).toBeDisabled();
});

test('corrected numeric input stays visible while its asynchronous edit is pending', async ({ page }) => {
  await mount(page, 'number');
  const input = page.getByRole('textbox', { name: '推理' });
  await input.fill('invalid');
  await expect(page.getByRole('alert')).toHaveText('请输入完整数值');
  await input.fill('123');
  await expect(input).toHaveValue('123');
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { changedValues: unknown[] }).changedValues)).toEqual([123]);
  await page.evaluate(() => (window as unknown as { completeNumber: (() => void)[] }).completeNumber[0]());
  await expect(input).toHaveValue('123');
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
});

test('rapid numeric edits retain the latest local text through an earlier completed response', async ({ page }) => {
  await mount(page, 'number');
  const input = page.getByRole('textbox', { name: '推理' });
  await input.fill('123');
  await input.fill('1234');
  await page.evaluate(() => (window as unknown as { completeNumber: (() => void)[] }).completeNumber[0]());
  await expect(input).toHaveValue('1234');
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { completeNumber: (() => void)[] }).completeNumber[1]());
  await expect(input).toHaveValue('1234');
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
  await page.getByRole('button', { name: '外部原文变更' }).click();
  await expect(input).toHaveValue('999');
});


test('字段信息入口展开显示来源状态、原生说明与字段说明', async ({ page }) => {
  await mount(page, 'info');
  const toggle = page.getByRole('button', { name: '字段信息' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('最大输出令牌数。')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const controls = await toggle.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  await expect(page.locator(`#${controls}`)).toBeVisible();
  await expect(page.getByText('本层显式值', { exact: true })).toBeVisible();
  await expect(page.getByText('最大输出令牌数。')).toBeVisible();
  await expect(page.getByText(/原生字段：\s*MAX_TOKENS/)).toBeVisible();
  await expect(page.getByText(/未设置时：原生默认/)).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('最大输出令牌数。')).toHaveCount(0);
});

test('恢复默认仅在字段偏离默认时出现，点击后走现有 reset 语义', async ({ page }) => {
  await mount(page, 'restore');
  await expect(page.getByRole('button', { name: '恢复默认' })).toHaveCount(0);
  await page.getByRole('button', { name: '设为显式' }).click();
  const restore = page.getByRole('button', { name: '恢复默认' });
  await expect(restore).toBeVisible();
  await restore.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { resets: number }).resets)).toBe(1);
  await expect(page.getByRole('combobox', { name: '推理' })).toHaveValue('');
  await expect(page.getByRole('button', { name: '恢复默认' })).toHaveCount(0);
});

test('必填校验错误保持原位可见，不折叠进字段信息面板', async ({ page }) => {
  await mount(page, 'required');
  const input = page.getByRole('textbox', { name: '推理 *' });
  await input.fill('手动值');
  await input.fill('');
  await expect(page.getByRole('alert')).toHaveText('此项必填');
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '字段信息' })).toHaveAttribute('aria-expanded', 'false');
});

test('successful numeric writes retain local text until the parent publishes the new projection', async ({ page }) => {
  await mount(page, 'number-late-projection');
  const input = page.getByRole('textbox', { name: '推理' });
  await input.fill('invalid');
  await input.fill('123');
  await page.evaluate(() => (window as unknown as { completeNumber: (() => void)[] }).completeNumber[0]());
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled();
  await expect(input).toHaveValue('123');
  await page.evaluate(() => (window as unknown as { publishNumber: (() => void)[] }).publishNumber[0]());
  await expect(input).toHaveValue('123');
});
