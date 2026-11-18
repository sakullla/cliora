import { expect, test, type Page } from '@playwright/test';
import { installWorkspaceFixtures } from '../../scripts/capture-workspace-fixtures.mjs';

async function projectAction(page: Page, name: string) {
  await page.locator('[data-business-workspaces]').first().getByRole('button', { name: '项目操作', exact: true }).click();
  await page.getByRole('menu', { name: '项目操作' }).getByRole('menuitem', { name, exact: true }).click();
}

async function chooseRepository(page: Page, search: string, option: RegExp) {
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await dialog.getByRole('button', { name: '工作目录 / 项目', exact: true }).click();
  await page.getByRole('textbox', { name: /搜索/ }).last().fill(search);
  await page.getByRole('option', { name: option }).first().click();
}

async function install(page: Page, repositories = 48) {
  await page.addInitScript(count => { (window as any).__workspaceRepositoryCount = count; }, repositories);
  await page.addInitScript(() => {
    const callbacks: Array<(value: unknown) => void> = [];
    const handlers: Record<string, number> = {};
    Object.assign(window, {
      isTauri: true,
      __emitWorkspaceLink: (url: string) => {
        const id = handlers['deep-link://new-url'];
        if (id === undefined) return false;
        callbacks[id]?.({ payload: [url] });
        return true;
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => { callbacks.push(callback); return callbacks.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal', launch: { state: 'supported', reason: '' }, nativeConfig: { state: 'supported', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings' || command === 'set_preferred_terminal') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], worktreeLaunch: 'direct' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'plugin:event|listen') { handlers[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
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
  // The session is named by its directory; the business project is not part of its label.
  await expect(page.getByText(/api-feature/).first()).toBeVisible();
  await expect(page.getByText('电商平台 / api', { exact: true })).toHaveCount(0);
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
  await projectAction(page, '扫描目录');
  const dialog = page.getByRole('dialog', { name: '选择要添加的仓库' });
  await dialog.getByRole('button', { name: '停止扫描' }).click();
  await expect(dialog.getByRole('status')).toContainText('扫描未完成');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await projectAction(page, '打开项目清单');
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
  await expect(dialog.locator('[data-business-workspaces]')).toHaveCount(0);
  await chooseRepository(page, 'team-0/api', /^api 电商平台/);
  await expect(dialog.getByRole('button', { name: '工作目录 / 项目', exact: true })).toContainText('api');
  await dialog.getByRole('button', { name: '启动会话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches.length)).toBe(1);
  const launched = await page.evaluate(() => (window as any).__workspaceFixture.launches[0]);
  expect(launched.workspaceId).toBe('workspace-commerce');
  expect(launched.repositoryId).toBe('repo-0');
  expect(launched.request.directory).toBe('/work/commerce/team-0/api');
  expect(launched.request.worktreeIntent).toBe('given');
});

for (const action of ['cancel', 'accept'] as const) {
  test(`a ${action === 'accept' ? 'accepted' : 'cancelled'} deep-link project preview stays consumed after leaving and returning home`, async ({ page }) => {
    await install(page);
    await expect.poll(() => page.evaluate(() => (window as any).__emitWorkspaceLink('cliora://workspace?v=1&file=%2Fwork%2Fshared.dev-workspace.json'))).toBe(true);
    const preview = page.getByRole('dialog', { name: '关联项目清单' });
    await expect(preview).toBeVisible();
    if (action === 'cancel') await preview.getByRole('button', { name: '关闭', exact: true }).click();
    else await preview.getByRole('button', { name: '关联项目', exact: true }).click();
    await expect(preview).not.toBeVisible();
    const nav = page.getByRole('navigation', { name: '页面' });
    await nav.getByRole('button', { name: '工作台', exact: true }).click();
    await nav.getByRole('button', { name: '首页', exact: true }).click();
    await expect(page.locator('[data-business-workspaces]').first()).toBeVisible();
    await expect(preview).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__workspaceFixture.calls.filter((item: any) => item.command === 'attach_workspace_manifest').length)).toBe(action === 'accept' ? 1 : 0);
  });
}

test('missing repository directories are counted, filterable, and offer relinking without blocking the rest', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '需处理 1', exact: true }).click();
  const rows = project.locator('[data-repository-id]');
  await expect(rows).toHaveCount(1);
  const moved = project.locator('[data-repository-id="repo-46"]');
  await expect(moved).toHaveAttribute('data-state', 'unavailable');
  await expect(moved).toContainText('目录失效');
  await expect(moved.getByRole('button', { name: '启动会话', exact: true })).toHaveCount(0);
  await expect(moved).toContainText('目录不存在');
  await moved.getByRole('button', { name: '关联本机目录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: any) => call.command === 'relink_workspace_repository').length)).toBe(1);
  // Once relinked nothing needs attention: the list returns to every repository.
  await expect(project.getByRole('button', { name: /^需处理/ })).toHaveCount(0);
  await expect(rows).toHaveCount(48);
});

test('favorite repositories lead the list and the new-session directory picker', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const last = project.locator('[data-repository-id="repo-47"]');
  await last.getByRole('button', { name: '收藏仓库', exact: true }).click();
  await expect(project.locator('[data-repository-id]').first()).toHaveAttribute('data-repository-id', 'repo-47');
  await project.getByRole('button', { name: '收藏 1', exact: true }).click();
  await expect(project.locator('[data-repository-id]')).toHaveCount(1);

  // The new-session directory picker lists the favorite first and carries worktrees as choices.
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.getByRole('dialog', { name: '新建工作台会话' }).getByRole('button', { name: '工作目录 / 项目', exact: true }).click();
  // Repositories fold under their project: the heading shows the count and opens with a click.
  const options = page.getByRole('option');
  const heading = options.nth(1);
  await expect(heading).toContainText('电商平台');
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(options.nth(2)).toContainText('service-47');
  await page.getByRole('textbox', { name: /搜索/ }).last().fill('team-1/api-feature');
  await expect(page.getByRole('option', { name: /^api · feature\/search/ })).toHaveCount(1);
});

test('narrow repository rows keep their name, path and worktree from overlapping', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await install(page);
  const row = page.locator('[data-business-workspaces]').first().locator('[data-repository-id="repo-1"]');
  const name = await row.locator('strong').first().boundingBox();
  // Rows drop the folder every repository shares; the header names it once.
  await expect(page.locator('[data-business-workspaces]').first()).toContainText('/work/commerce');
  const path = await row.getByText('team-1/api', { exact: true }).boundingBox();
  const rowBox = await row.boundingBox();
  expect(name && path && rowBox).toBeTruthy();
  expect(path!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
  expect(path!.y + path!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height + 1);
});

test('hundreds of repositories narrow by several words and favorites update without re-listing', async ({ page }) => {
  await install(page, 400);
  const project = page.locator('[data-business-workspaces]').first();
  await expect(project.getByText('400 个仓库', { exact: true })).toBeVisible();
  await expect(project.locator('[data-repository-id]')).toHaveCount(400);
  const listings = () => page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: { command: string }) => call.command === 'list_business_workspaces').length);
  const search = project.getByRole('textbox', { name: '搜索仓库名称或路径' });
  // Every word must match the name or a path.
  await search.fill('commerce 37');
  // 37, 137, 237, 337 and 370-379.
  await expect(project.locator('[data-repository-id]')).toHaveCount(14);
  await expect(project.getByRole('status').filter({ hasText: '14 / 400 个' })).toBeVisible();
  await search.fill('service 137');
  const row = project.locator('[data-repository-id]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-repository-id', 'repo-137');

  // A favorite updates its project from the operation result; no project is listed and probed again.
  const before = await listings();
  await row.getByRole('button', { name: '收藏仓库', exact: true }).click();
  await expect(row.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
  await search.fill('');
  await expect(project.locator('[data-repository-id]').first()).toHaveAttribute('data-repository-id', 'repo-137');
  // Returning to the window soon after a listing does not re-check every repository either.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(200);
  expect(await listings()).toBe(before);
});

test('a search with no matching repository clears in one action', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('textbox', { name: '搜索仓库名称或路径' }).fill('no-such-repository');
  await expect(project.getByText('没有匹配的仓库')).toBeVisible();
  await project.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(project.getByRole('textbox', { name: '搜索仓库名称或路径' })).toHaveValue('');
  await expect(project.locator('[data-repository-id]')).toHaveCount(48);
});

test('a project can be deleted from its menu and only the grouping goes away', async ({ page }) => {
  await install(page);
  await projectAction(page, '删除项目');
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: '删除项目' })).first();
  await expect(confirm).toContainText('仓库目录、分支和会话都不受影响');
  await confirm.getByRole('button', { name: '删除项目', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: any) => call.command === 'delete_business_workspace').map((call: any) => call.args.workspaceId))).toEqual(['workspace-commerce']);
  const project = page.locator('[data-business-workspaces]').first();
  await expect(project.locator('[data-repository-id]').first()).not.toHaveAttribute('data-repository-id', /^repo-/);
});

test('project errors can be dismissed and the workbench rail is not filtered by project', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__workspaceFixture.failBatch = true; });
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '添加仓库', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择要添加的仓库' });
  await dialog.getByRole('button', { name: '添加所选 2 个仓库' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const alert = project.getByRole('alert').filter({ hasText: '/work/new/web' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(alert).toHaveCount(0);

  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByText('所有业务项目')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '项目会话' })).toHaveCount(0);
});

test('linked manifest opens in Twiglane with %20 encoding, Home slash focuses repo search, and same-name root repos stay disambiguated', async ({ page }) => {
  await install(page, 2);
  await page.evaluate(() => {
    const win = window as any;
    win.__openedUrls = [] as string[];
    win.__failTwiglaneOpen = false;
    const orig = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'open_external_url') {
        if (win.__failTwiglaneOpen) throw { message: '无法打开 Twiglane' };
        win.__openedUrls.push(args.url);
        return null;
      }
      return orig(command, args);
    };
    const ws = win.__workspaceFixture.workspaces[0];
    ws.manifestPath = '/work/my team/commerce.dev-workspace.json';
    ws.manifestRevision = 3;
    ws.repositories = [
      { id: 'r-root', name: 'api', favorite: false, locations: [{ id: 'l1', path: '/work/commerce/api', available: true, kind: 'git', worktrees: [] }] },
      { id: 'r-sub', name: 'api', favorite: false, locations: [{ id: 'l2', path: '/work/commerce/services/api', available: true, kind: 'git', worktrees: [] }] },
    ];
    window.dispatchEvent(new CustomEvent('cliora:business-workspaces-changed', { detail: { workspace: ws } }));
  });

  const project = page.locator('[data-business-workspaces]').first();
  // Same-name repositories never leave the root-level one with an empty relative path.
  await expect(project.locator('[data-repository-id="r-root"]')).toContainText('commerce/api');
  await expect(project.locator('[data-repository-id="r-sub"]')).toContainText('services/api');

  // With <= 4 standalone projects, pressing "/" on Home focuses the Business Project search input.
  await page.locator('main').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('/');
  await expect(project.getByRole('textbox', { name: '搜索仓库名称或路径' })).toBeFocused();
  await page.keyboard.press('Escape');
  await project.getByRole('textbox', { name: '搜索仓库名称或路径' }).blur();

  // Linked manifest exposes 1-click Twiglane handoff with %20 (never '+') encoding.
  await projectAction(page, '在 Twiglane 中打开');
  await expect.poll(() => page.evaluate(() => (window as any).__openedUrls)).toEqual([
    'twiglane://workspace?v=1&file=%2Fwork%2Fmy%20team%2Fcommerce.dev-workspace.json',
  ]);

  // Failure surfaces cleanly in the project error banner.
  await page.evaluate(() => { (window as any).__failTwiglaneOpen = true; });
  await projectAction(page, '在 Twiglane 中打开');
  await expect(project.getByRole('alert')).toContainText('无法打开 Twiglane');

  // Tools scope picker folds Business Project repositories under their project heading.
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '配置范围', exact: true }).click();
  await expect(page.getByRole('option', { name: /^电商平台/ })).toBeVisible();
});
