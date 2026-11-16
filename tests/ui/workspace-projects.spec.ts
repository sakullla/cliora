import { expect, test, type Page } from '@playwright/test';
import { installWorkspaceFixtures } from '../../scripts/capture-workspace-fixtures.mjs';

async function install(page: Page) {
  await page.addInitScript(() => {
    const callbacks: Array<(value: unknown) => void> = [];
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => { callbacks.push(callback); return callbacks.length - 1; },
        invoke: async (command: string) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal', launch: { state: 'supported', reason: '' }, nativeConfig: { state: 'supported', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings' || command === 'set_preferred_terminal') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], worktreeLaunch: 'direct' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          if (command === 'workbench_replay') return { dataBase64: '', endOffset: 0, cols: 80, rows: 24 };
          if (command.startsWith('list_')) return [];
          if (command === 'get_registered_tool_workspace') return { profiles: [], snapshots: [], recoveryNeeded: [], common: null, customPath: null, probe: { selectedPath: '/fixture/codex', installations: [{ path: '/fixture/codex', version: '0.160.0', status: 'available' }], nativeFiles: [], interfaceFormats: [], providerPresets: [], dependencies: [], nativeWrites: { state: 'supported', reason: '' }, installUrl: '', upgradeHint: '' } };
          return null;
        },
      },
    });
  });
  await page.addInitScript(installWorkspaceFixtures);
  await page.goto('/');
  await expect(page.locator('[data-business-workspaces]').first()).toBeVisible();
}

test('multi-repository projects search same-name paths, favorite, and launch the selected checkout', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  await expect(project.locator('[data-repository-id]')).toHaveCount(48);
  await project.getByRole('textbox', { name: '搜索仓库名称或路径' }).fill('team-1/api');
  const row = project.locator('[data-repository-id]');
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '收藏仓库', exact: true }).click();
  await expect(row.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
  await row.getByLabel('api 工作目录').selectOption('/work/commerce/team-1/api-feature');
  await row.getByRole('button', { name: '启动会话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__workspaceFixture.launches[0]);
  expect(request.workspaceId).toBe('workspace-commerce');
  expect(request.repositoryId).toBe('repo-1');
  expect(request.request.directory).toBe('/work/commerce/team-1/api-feature');
  expect(request.request.worktreeIntent).toBe('given');
  await expect(page.locator('[data-focus-mode]').or(page.getByText('电商平台 / api', { exact: true })).first()).toBeVisible();
});

test('a partial repository batch keeps the failure and retries only the failed selection', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__workspaceFixture.failBatch = true; });
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '添加仓库', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择要添加的仓库' });
  await expect(dialog.getByText('Permission denied')).toBeVisible();
  await dialog.getByRole('button', { name: '添加所选 2 个仓库' }).click();
  await expect(dialog.getByRole('alert')).toContainText('/work/new/web');
  await expect(dialog.getByRole('button', { name: '添加所选 1 个仓库' })).toBeVisible();
  await page.evaluate(() => { (window as any).__workspaceFixture.failBatch = false; });
  await dialog.getByRole('button', { name: '添加所选 1 个仓库' }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).__workspaceFixture.workspaces[0].repositories.filter((repo: any) => repo.id.startsWith('added:')).length)).toBe(2);
});

test('scan cancellation preserves partial results and manifest attach requires preview', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__workspaceFixture.scanDelayed = true; });
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '扫描目录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择要添加的仓库' });
  await dialog.getByRole('button', { name: '停止扫描' }).click();
  await expect(dialog.getByRole('status')).toContainText('扫描未完成');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await project.getByRole('button', { name: '打开项目清单', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '关联项目清单' });
  await expect(preview.getByText('shared-api', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__workspaceFixture.workspaces.length)).toBe(2);
  await preview.getByRole('button', { name: '关联项目', exact: true }).click();
  await expect(preview).not.toBeVisible();
  await expect(project).toContainText('已关联项目清单');
  expect(await page.evaluate(() => (window as any).__workspaceFixture.workspaces.length)).toBe(3);
});

test('new workbench sessions carry the chosen business project without creating a worktree', async ({ page }) => {
  await install(page);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  const browser = dialog.locator('[data-business-workspaces]');
  await browser.getByRole('textbox', { name: '搜索仓库名称或路径' }).fill('team-0/api');
  await browser.getByRole('button', { name: '使用此仓库', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('电商平台 / api');
  await dialog.getByRole('button', { name: '启动会话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches.length)).toBe(1);
  const launched = await page.evaluate(() => (window as any).__workspaceFixture.launches[0]);
  expect(launched.workspaceId).toBe('workspace-commerce');
  expect(launched.repositoryId).toBe('repo-0');
  expect(launched.request.directory).toBe('/work/commerce/team-0/api');
  expect(launched.request.worktreeIntent).toBe('given');
});
