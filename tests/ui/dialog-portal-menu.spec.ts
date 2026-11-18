import { expect, test } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

let harness: string;
test.beforeAll(async () => {
  const entry = 'virtual:dialog-portal-menu-test';
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import ${JSON.stringify(path.resolve('src/style.css'))};
    import ${JSON.stringify(path.resolve('src/i18n/index.ts'))};
    import { GuideDialog } from ${JSON.stringify(path.resolve('src/components/GuideDialog.tsx'))};
    import { RowMenu } from ${JSON.stringify(path.resolve('src/components/RowMenu.tsx'))};
    import { SplitButton } from ${JSON.stringify(path.resolve('src/components/ui/SplitButton.tsx'))};

    function Harness() {
      const [open, setOpen] = React.useState(true);
      const [picked, setPicked] = React.useState('');
      return React.createElement(GuideDialog, { open, title: '顶层弹窗菜单测试', onClose: () => setOpen(false) },
        React.createElement('div', { style: { display: 'flex', gap: '12px', padding: '16px 0' } },
          React.createElement(RowMenu, { label: '行内更多操作' },
            React.createElement('button', { type: 'button', role: 'menuitem', onClick: () => setPicked('row-action') }, '弹窗菜单项'),
          ),
          React.createElement(SplitButton, {
            menuLabel: '启动替代项',
            onClick: () => setPicked('primary'),
            menu: React.createElement('button', { type: 'button', role: 'menuitem', onClick: () => setPicked('split-action') }, '替代工具启动'),
          }, '主操作'),
          React.createElement('output', { 'data-testid': 'picked' }, picked),
        ),
      );
    }
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
  `;
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [react(), { name: 'dialog-portal-menu', resolveId: id => id === entry ? `\0${entry}` : undefined, load: id => id === `\0${entry}` ? source : undefined }],
    build: { write: false, minify: false, cssCodeSplit: false, rollupOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string; source?: string | Uint8Array }[] };
  const code = output.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  const css = output.output.filter(item => item.type === 'asset').map(item => String(item.source)).join('\n');
  harness = `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
});

test('RowMenu and SplitButton inside a modal <dialog> portal into the dialog Top Layer, stay clickable, and dismiss on Escape without closing the dialog', async ({ page }) => {
  await page.route('/__dialog_portal_menu', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: harness }));
  await page.goto('/__dialog_portal_menu');
  const dialog = page.getByRole('dialog', { name: '顶层弹窗菜单测试' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: '行内更多操作', exact: true }).click();
  const menu = dialog.getByRole('menu', { name: '行内更多操作' });
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate(node => node.getBoundingClientRect().left)).toBeGreaterThan(0);

  const hit = await menu.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      insideDialog: !!node.closest('dialog'),
      clickable: !!center && node.contains(center),
    };
  });
  expect(hit).toEqual({ insideDialog: true, clickable: true });

  // Escape dismisses only the open menu while keeping the parent modal dialog open.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // Reopen and click the RowMenu item.
  await dialog.getByRole('button', { name: '行内更多操作', exact: true }).click();
  await dialog.getByRole('menuitem', { name: '弹窗菜单项', exact: true }).click();
  await expect(dialog.getByTestId('picked')).toHaveText('row-action');

  // SplitButton menu inside the same modal dialog also portals into Top Layer and fires cleanly.
  await dialog.getByRole('button', { name: '启动替代项', exact: true }).click();
  await dialog.getByRole('menuitem', { name: '替代工具启动', exact: true }).click();
  await expect(dialog.getByTestId('picked')).toHaveText('split-action');
});
