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

async function mount(page: Page, lateFailure: boolean) {
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
    const state = window as unknown as { failOldRequest?: () => void };
    function Fixture() {
      const [value, setValue] = React.useState(false);
      const [valid, setValid] = React.useState(true);
      return React.createElement('div', null,
        React.createElement(ConfigurationField, {
          field: { id: 'reasoning', label: '推理', kind: 'boolean', required: false, advanced: false, choices: [], minimum: null, defaultSource: null, unavailableReason: null },
          value, onValidityChange: setValid,
          onChange: async (next: boolean) => {
            attempts += 1;
            if (attempts === 1) {
              if (lateFailure) await new Promise((_resolve, reject) => { state.failOldRequest = () => reject(new Error('较旧失败')); });
              else throw new Error('暂时失败');
            } else setValue(next);
          },
        }),
        React.createElement('button', { disabled: !valid }, '保存草稿'));
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
