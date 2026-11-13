import { expect, test } from '@playwright/test';

test('settings wheel crosses adjacent categories at boundaries without skipping on inertia', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const general = page.getByRole('tab', { name: '通用', exact: true });
  const tools = page.getByRole('tab', { name: 'CLI 工具', exact: true });
  const launch = page.getByRole('tab', { name: '启动', exact: true });
  const main = page.locator('main.content');
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await main.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await main.hover({ position: { x: 400, y: 200 } });
  await page.mouse.wheel(0, 120);
  await expect(tools).toHaveAttribute('aria-selected', 'true');
  // One continuous gesture may scroll its destination but cannot skip it.
  for (let index = 0; index < 4; index++) await page.mouse.wheel(0, 120);
  await expect(tools).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(280);
  await main.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.mouse.wheel(0, 120);
  await expect(launch).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(280);
  await page.mouse.wheel(0, -120);
  await expect(tools).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(280);
  await page.mouse.wheel(0, -120);
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(280);
  await page.mouse.wheel(0, -120);
  await expect(general).toHaveAttribute('aria-selected', 'true');

  // On a short viewport the category's content must scroll before navigation.
  await page.setViewportSize({ width: 800, height: 400 });
  await main.evaluate((node) => { node.scrollTop = 0; });
  await page.waitForTimeout(280);
  await page.mouse.wheel(0, 100);
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});
