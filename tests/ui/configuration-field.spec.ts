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

async function mount(page: Page, lateFailure: boolean | 'enum' | 'enum-no-reset' | 'number' | 'number-late-projection') {
  await page.setContent('<div id="field-fixture"></div>');
  await page.evaluate(({ sources, lateFailure }) => {
    const cache: Record<string, { exports: unknown }> = {};
    const require = (name: string): any => {
      if (cache[name]) return cache[name].exports;
      const module = { exports: {} };
      cache[name] = module;
      new Function('module', 'exports', 'require', 'process', sources[name as keyof typeof sources])(module, module.exports, require, { env: { NODE_ENV: 'development' } });
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
    function Fixture() {
      const [value, setValue] = React.useState(isNumber ? 10 : isEnum ? 'high' : false);
      const [valid, setValid] = React.useState(true);
      return React.createElement('div', null,
        React.createElement(ConfigurationField, {
          field: { id: 'reasoning', label: '推理', kind: isNumber ? 'integer' : isEnum ? 'enum' : 'boolean', required: false, advanced: false, choices: isEnum ? ['low', 'high'] : [], minimum: isNumber ? 1 : null, defaultSource: null, unavailableReason: null },
          value, onValidityChange: setValid,
          onReset: lateFailure === 'enum' ? async () => { state.resets += 1; setValue(null); } : undefined,
          onChange: async (next: unknown) => {
            state.changedValues.push(next);
            if (isEnum) { setValue(next); return; }
            if (isNumber) { await new Promise<void>(resolve => { state.completeNumber.push(resolve); }); if (lateFailure === 'number-late-projection') state.publishNumber.push(() => setValue(next)); else setValue(next); return; }
            attempts += 1;
            if (attempts === 1) {
              if (lateFailure) await new Promise((_resolve, reject) => { state.failOldRequest = () => reject(new Error('较旧失败')); });
              else throw new Error('暂时失败');
            } else setValue(next);
          },
        }),
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
  await expect(page.getByRole('alert')).toHaveText('请输入有效数值');
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
