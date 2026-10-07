import { expect, test, type Page } from '@playwright/test';

async function installDesktop(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [], theme: 'light' }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [], managedIds: [], preservedUnknown: [] };
          if (command === 'get_tray_status') return { available: true, error: null };
          if (command === 'get_launch_settings') return {
            selected: 'auto', custom: { program: '', args: [] }, presets: [],
            terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal',
          };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return [];
        },
      },
    });
  });
}

async function openSettings(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
}

test('中文环境默认中文，可切换英文、即时生效并在重启后保持', async ({ page }) => {
  await installDesktop(page);
  await openSettings(page);
  await expect(page.getByRole('heading', { name: '管理的 CLI' })).toBeVisible();
  const chinese = page.getByRole('radiogroup', { name: '界面语言' });
  await expect(chinese.getByRole('radio', { name: '中文' })).toHaveAttribute('aria-checked', 'true');
  await chinese.getByRole('radio', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Managed CLIs' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cliora:language'))).toBe('en');
  await page.reload();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Managed CLIs' })).toBeVisible();
  const english = page.getByRole('radiogroup', { name: 'Interface language' });
  await expect(english.getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
  await english.getByRole('radio', { name: '中文' }).click();
  await expect(page.getByRole('heading', { name: '管理的 CLI' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cliora:language'))).toBe('zh');
});

test.describe('英文系统环境', () => {
  test.use({ locale: 'en-US' });

  test('未存储偏好时默认英文', async ({ page }) => {
    await installDesktop(page);
    await openSettings(page);
    await expect(page.getByRole('heading', { name: 'Managed CLIs' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Interface language' }).getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
  });
});

test('缺失目标语言翻译时回退中文兜底，不留白或显示键名', async () => {
  const { default: i18n } = await import('../../src/i18n');
  i18n.addResource('zh', 'translation', 'settings.testFallbackOnly', '仅中文兜底文案');
  await i18n.changeLanguage('en');
  const value = i18n.t('settings.testFallbackOnly');
  expect(value).toBe('仅中文兜底文案');
  expect(value).not.toBe('settings.testFallbackOnly');
  await i18n.changeLanguage('zh');
});
