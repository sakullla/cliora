import { test, expect } from '@playwright/test';
import { setupConfigurationWorkspace } from './configuration-workspace-fixture';

test('legacy model combobox fetches catalog inside the dropdown', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'grok');
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true }).click();
  const model = dialog.getByLabel('模型', { exact: true });
  await expect(model).toHaveAttribute('role', 'combobox');
  await model.click();
  await expect(dialog.getByRole('button', { name: '获取模型目录' })).toBeVisible();
  await page.screenshot({ path: 'test-results/legacy-model-closed.png' });
  await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await expect(dialog.getByRole('option', { name: 'new-1' })).toBeVisible();
  await page.screenshot({ path: 'test-results/legacy-model-open.png' });
  await dialog.getByRole('option', { name: 'new-1' }).click();
  await expect(model).toHaveValue('new-1');
  await model.click();
  await expect(dialog.getByRole('button', { name: '载入目录候选' })).toHaveCount(0);
});
