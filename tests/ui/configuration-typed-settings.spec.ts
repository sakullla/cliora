import { expect, test } from './sharedPage';
import { installConfigurationWorkspace } from './configuration-workspace-fixture';

async function openAntigravitySettings(page: import('@playwright/test').Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具', exact: true }).click();
  await page.locator('[data-profile-id="existing"]').getByRole('button', { name: '修改', exact: true }).click();
  // Workspaces open in the quick level; the raw-text view and its tabs only
  // exist in the advanced level.
  await page.getByRole('dialog').getByRole('button', { name: '高级配置', exact: true }).click();
}

test('antigravity typed settings edit persists one key and keeps unknown fields', async ({ page }) => {
  await installConfigurationWorkspace(page, 'antigravity', true, false, ['antigravity'], true, true);
  await page.goto('/');
  await openAntigravitySettings(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('模型显示名', { exact: true })).toHaveValue('Gemini 4 Carbon (Medium)');
  await expect(dialog.getByLabel('信任的工作区', { exact: true })).toHaveValue('["/home/example/projects/alpha"]');
  // The typed editor is the dedicated form; the generic connection chain is absent.
  await expect(dialog.getByRole('button', { name: '连接与模型', exact: true })).toHaveCount(0);
  // Session-only choices live at launch; the editor only notes them and keeps
  // the raw JSON path for unsupported keys.
  await expect(dialog.getByRole('button', { name: '原生文本', exact: true })).toBeVisible();
  await expect(dialog.getByText('执行模式与推理强度是会话启动参数：在项目卡的启动选择器中选择，仅对当次启动生效，不会写入 settings.json。', { exact: true })).toBeVisible();

  await dialog.getByLabel('模型显示名', { exact: true }).fill('Gemini 4 Carbon (High)');
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const profile = (window as any).workspaceFixture.profiles.find((item: any) => item.id === 'existing');
    return JSON.parse(profile.files.settings);
  })).toMatchObject({
    model: 'Gemini 4 Carbon (High)',
    trustedWorkspaces: ['/home/example/projects/alpha'],
    futureNative: { keep: true },
  });

  // Reopening reads the saved value, not the previous projection.
  await openAntigravitySettings(page);
  await expect(page.getByRole('dialog').getByLabel('模型显示名', { exact: true })).toHaveValue('Gemini 4 Carbon (High)');
});

test('antigravity settings stop the typed form when the install is unverified', async ({ page }) => {
  await installConfigurationWorkspace(page, 'antigravity', true, false, ['antigravity'], true, true);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具', exact: true }).click();
  await page.evaluate(() => { (window as any).configurationProtocol.typedSettings = false; });
  await page.locator('[data-profile-id="existing"]').getByRole('button', { name: '修改', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // Unverified installs fall back to the raw view; the level chrome still
  // starts quick, so switch to advanced before reading the native text.
  await dialog.getByRole('button', { name: '高级配置', exact: true }).click();
  await expect(dialog.getByText('当前安装未核验为 agy 1.5，类型化设置字段已停用。请在“原生文本”中编辑 settings.json；不会重建未支持或未核验的键。', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('模型显示名', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('信任的工作区', { exact: true })).toHaveCount(0);
  // The raw view is the recovery path for unverified installs: open it and
  // confirm the native editor is reachable.
  await dialog.getByRole('button', { name: '原生文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: /配置草稿$/ }).first()).toBeVisible();
});
