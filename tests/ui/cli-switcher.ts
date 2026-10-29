import { expect, type Page } from '@playwright/test';

/** The h2 switcher in the 工具与连接 header; its accessible name starts with the current CLI. */
export const cliSwitcher = (page: Page) => page.getByRole('button', { name: /，切换 CLI$/ });

/** Opens 工具与连接 and picks a CLI from the header switcher (a single managed CLI has no switcher). */
export async function openCli(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: '页面' });
  if (!await page.getByRole('heading', { name: '工具与连接', level: 1 }).isVisible()) await nav.getByRole('button', { name: '工具与连接', exact: true }).click();
  const title = page.locator('[data-workspace-chrome] h2');
  await expect(title).toBeVisible();
  const picker = cliSwitcher(page);
  if (!await picker.count()) return;
  if ((await picker.getAttribute('aria-label'))?.startsWith(`${name}，`)) return;
  await picker.click();
  await page.getByRole('listbox', { name: /，切换 CLI$/ }).getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click();
}
