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

async function install(page: Page, repositories = 48, projectMode: 'normal' | 'yolo' = 'normal', cliMode: 'normal' | 'yolo' = 'normal') {
  await page.addInitScript(count => { (window as any).__workspaceRepositoryCount = count; }, repositories);
  await page.addInitScript(modes => { (window as any).__workspaceProjectMode = modes[0]; (window as any).__workspaceCliMode = modes[1]; }, [projectMode, cliMode]);
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
      __workspaceLinkReady: () => handlers['deep-link://new-url'] !== undefined,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => { callbacks.push(callback); return callbacks.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, launchForm: 'terminal', launch: { state: 'supported', reason: '' }, nativeConfig: { state: 'supported', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings' || command === 'set_preferred_terminal') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], worktreeLaunch: 'direct', cliMode: (window as any).__workspaceCliMode, projectMode: (window as any).__workspaceProjectMode };
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
  expect(request.request.mode).toBe('normal');
  // The session is named by its directory; the business project is not part of its label.
  await expect(page.getByText(/api-feature/).first()).toBeVisible();
  await expect(page.getByText('电商平台 / api', { exact: true })).toHaveCount(0);
});

test('repository launch follows the project default YOLO mode', async ({ page }) => {
  await install(page, 48, 'yolo');
  const row = page.locator('[data-business-workspaces]').first().locator('[data-repository-id]').first();
  await row.getByRole('button', { name: '启动会话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__workspaceFixture.launches[0]);
  expect(request.request.mode).toBe('yolo');
});

test('the new-session dialog starts from the saved default mode and follows the chosen place', async ({ page }) => {
  await install(page, 48, 'yolo', 'normal');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  const modes = dialog.getByRole('radiogroup', { name: '启动模式' });
  await expect(modes.getByRole('radio', { name: /普通/ })).toHaveAttribute('aria-checked', 'true');
  await chooseRepository(page, 'team-0/api', /^api 电商平台/);
  await expect(modes.getByRole('radio', { name: /YOLO/ })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: '启动会话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__workspaceFixture.launches[0].request.mode)).toBe('yolo');
});

test('the new-session dialog uses the CLI default mode for a plain opening', async ({ page }) => {
  await install(page, 48, 'normal', 'yolo');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const modes = page.getByRole('dialog', { name: '新建工作台会话' }).getByRole('radiogroup', { name: '启动模式' });
  await expect(modes.getByRole('radio', { name: /YOLO/ })).toHaveAttribute('aria-checked', 'true');
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

test('a closed scan can finish while the next scan is still selecting candidates', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__workspaceFixture.scanDelayed = true; });
  const dialog = page.getByRole('dialog', { name: '选择要添加的仓库' });
  await projectAction(page, '扫描目录');
  await expect(dialog.getByRole('button', { name: '停止扫描' })).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).__workspaceFixture;
    fixture.finishOldScan = fixture.scanResolve;
    fixture.scanResolve = null; // The native cancellation acknowledgement can arrive later.
  });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await projectAction(page, '扫描目录');
  await expect(dialog.getByRole('button', { name: '停止扫描' })).toBeVisible();
  await page.evaluate(() => (window as any).__workspaceFixture.finishOldScan({ candidates: [], cancelled: true }));
  // The stop button must still belong to the second request and return its partial results.
  await dialog.getByRole('button', { name: '停止扫描' }).click();
  await expect(dialog.getByRole('button', { name: '添加所选 2 个仓库' })).toBeEnabled();
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

const LINK_FILE = '%2Fwork%2Fshared.dev-workspace.json';
const LINK_MEMBER = 'shared-api';
const VALID_LINK = `cliora://workspace?v=2&file=${LINK_FILE}&repository=${LINK_MEMBER}`;

/** Opens a member row's own menu: the Twiglane handoff belongs to the repository, not the project. */
async function memberAction(page: Page, repositoryId: string, name: string) {
  const row = page.locator(`[data-business-workspaces] [data-repository-id="${repositoryId}"]`).first();
  await row.getByRole('button', { name: /的更多操作$/ }).click();
  await page.getByRole('menu', { name: /的更多操作$/ }).getByRole('menuitem', { name, exact: true }).click();
}

/** Seeds an already linked copy of the shared project, as a previous acceptance would leave it. */
async function seedSharedProject(page: Page, options: { missing?: boolean; attached?: boolean } = {}) {
  await page.evaluate(options => {
    const fixture = (window as any).__workspaceFixture;
    fixture.linkAttached = options.attached === true;
    fixture.linkConflict = false;
    fixture.workspaces.push({
      id: 'shared-workspace', name: '共享研发项目', revision: 3,
      manifestPath: '/work/shared.dev-workspace.json', manifestRevision: 3, error: null,
      repositories: [{
        id: 'shared-api', name: 'shared-api', favorite: false,
        locations: [{ id: 'shared-location', hostId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', path: '/work/shared/api', projectId: null, targetId: null, available: options.missing !== true, kind: 'repository', reason: options.missing ? '目录不存在' : null, worktrees: options.missing ? [] : [{ name: 'main', branch: 'main', path: '/work/shared/api', current: true }] }],
      }],
    });
    window.dispatchEvent(new CustomEvent('cliora:business-workspaces-changed', { detail: {} }));
  }, options);
}

test('v1 and malformed workspace links are refused without writing a project or opening a repository', async ({ page }) => {
  await install(page);
  for (const [url, message] of [
    ['cliora://workspace?v=1&file=%2Fwork%2Fshared.dev-workspace.json', '仅支持 v=2'],
    [`cliora://workspace?v=2&file=${LINK_FILE}&repository=not-a-member`, '没有链接指定的仓库'],
  ] as const) {
    await expect.poll(() => page.evaluate(url => (window as any).__emitWorkspaceLink(url), url)).toBe(true);
    await expect(page.locator('.error-banner')).toContainText(message);
    await page.locator('.error-banner').getByRole('button', { name: '关闭错误提示' }).click();
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }
  await expect(page.getByRole('dialog', { name: '关联项目清单' })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).__workspaceFixture.calls.map((item: any) => item.command));
  expect(calls.filter((command: string) => command === 'attach_workspace_manifest')).toHaveLength(0);
  expect(calls.filter((command: string) => command === 'launch_workspace_cli')).toHaveLength(0);
});

test('unknown parameters and newer link versions keep the v2 preview contract', async ({ page }) => {
  await install(page);
  const preview = page.getByRole('dialog', { name: '关联项目清单' });
  for (const url of [
    // A newer sender may add fields; they must not break an older receiver.
    `${VALID_LINK}&adopt=1&future=1`,
    VALID_LINK.replace('v=2', 'v=3'),
  ]) {
    await expect.poll(() => page.evaluate(link => (window as any).__emitWorkspaceLink(link), url)).toBe(true);
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('shared-api');
    await preview.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(preview).toHaveCount(0);
  }
  const calls = await page.evaluate(() => (window as any).__workspaceFixture.calls.map((item: any) => item.command));
  expect(calls.filter((command: string) => command === 'preview_workspace_link')).toHaveLength(2);
});

for (const action of ['cancel', 'accept'] as const) {
  test(`a ${action === 'accept' ? 'accepted' : 'cancelled'} preview can reopen explicitly and stays consumed on returning home`, async ({ page }) => {
    await install(page);
    await expect.poll(() => page.evaluate(url => (window as any).__emitWorkspaceLink(url), VALID_LINK)).toBe(true);
    const preview = page.getByRole('dialog', { name: '关联项目清单' });
    await expect(preview).toBeVisible();
    if (action === 'cancel') await preview.getByRole('button', { name: '关闭', exact: true }).click();
    else await preview.getByRole('button', { name: '关联项目', exact: true }).click();
    await expect(preview).not.toBeVisible();
    // Accepting continues the sender's own member; cancelling leaves nothing to continue.
    const row = page.locator('[data-business-workspaces] [data-repository-id="shared-api"]').first();
    if (action === 'accept') await expect(row.getByRole('button', { name: '启动会话', exact: true })).toBeFocused();
    else await expect(page.locator('[data-business-workspaces] [data-repository-id="shared-api"]')).toHaveCount(0);
    // Reopening before navigating away exercises the lifetime of the same mounted intent.
    expect(await page.evaluate(url => (window as any).__emitWorkspaceLink(url), VALID_LINK)).toBe(true);
    await expect(preview).toBeVisible();
    expect(await linkPreviews(page)).toBe(2);
    await preview.getByRole('button', { name: action === 'cancel' ? '关闭' : '关联项目', exact: true }).click();
    await expect(preview).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: '页面' });
    await nav.getByRole('button', { name: '工作台', exact: true }).click();
    await nav.getByRole('button', { name: '首页', exact: true }).click();
    await expect(page.locator('[data-business-workspaces]').first()).toBeVisible();
    await expect(preview).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__workspaceFixture.calls.filter((item: any) => item.command === 'attach_workspace_manifest').length)).toBe(action === 'accept' ? 2 : 0);
  });
}

/** How many inbound v2 links the preview path actually read. */
async function linkPreviews(page: Page) {
  return page.evaluate(() => (window as any).__workspaceFixture.calls.filter((item: any) => item.command === 'preview_workspace_link').length);
}

test('one delivery of the same v2 link reads it once and shows one preview', async ({ page }) => {
  await install(page);
  // A cold start can surface one URL through get_current and the running event: one handoff.
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceLinkReady())).toBe(true);
  expect(await page.evaluate(url => {
    const emit = (window as any).__emitWorkspaceLink;
    return emit(url) && emit(url);
  }, VALID_LINK)).toBe(true);
  await expect(page.getByRole('dialog', { name: '关联项目清单' })).toBeVisible();
  await expect.poll(() => linkPreviews(page)).toBe(1);
  await expect(page.getByRole('dialog', { name: '关联项目清单' })).toHaveCount(1);
});

test('an already linked project continues its source member without a second confirmation', async ({ page }) => {
  await install(page);
  await seedSharedProject(page, { attached: true });
  await expect.poll(() => page.evaluate(url => (window as any).__emitWorkspaceLink(url), VALID_LINK)).toBe(true);
  // Linked with the same content: no preview dialog, the member row is focused instead.
  await expect(page.getByRole('dialog', { name: '关联项目清单' })).toHaveCount(0);
  const row = page.locator('[data-business-workspaces] [data-repository-id="shared-api"]').first();
  await expect(row.getByRole('button', { name: '启动会话', exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as any).__workspaceFixture.calls.filter((item: any) => item.command === 'attach_workspace_manifest').length)).toBe(0);
  expect(await page.evaluate(() => (window as any).__workspaceFixture.launches.length)).toBe(0);
});

test('a source member without a local directory stays the repair context instead of another repository', async ({ page }) => {
  await install(page);
  await seedSharedProject(page, { attached: true, missing: true });
  await expect.poll(() => page.evaluate(url => (window as any).__emitWorkspaceLink(url), VALID_LINK)).toBe(true);
  const row = page.locator('[data-business-workspaces] [data-repository-id="shared-api"]').first();
  // The row explains why, and its primary action is the relink entry the fix needs.
  await expect(row).toContainText('目录失效');
  await expect(row.getByRole('button', { name: '关联本机目录', exact: true })).toBeFocused();
  await expect(page.locator('[data-business-workspaces]').first().getByRole('status')).toContainText('关联本机目录');
  // Nothing else was opened or written on the way.
  const calls = await page.evaluate(() => (window as any).__workspaceFixture.calls.map((item: any) => item.command));
  expect(calls.filter((command: string) => command.startsWith('launch_') || command === 'attach_workspace_manifest')).toHaveLength(0);
});

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
  await search.fill('no-such-repository');
  await expect(project.getByText('没有匹配的仓库')).toBeVisible();
  await project.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(project.locator('[data-repository-id]')).toHaveCount(400);
  await expect(project.locator('[data-repository-id]').first()).toHaveAttribute('data-repository-id', 'repo-137');
  // Returning to the window soon after a listing does not re-check every repository either.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await listings()).toBe(before);
  const refreshes = () => page.evaluate(() => (window as any).__workspaceFixture.calls
    .filter((call: { command: string }) => call.command === 'refresh_workspace_manifest')
    .map((call: { args: { workspaceId: string } }) => call.args.workspaceId));
  await projectAction(page, '刷新项目');
  await expect.poll(listings).toBe(before + 1);
  expect(await refreshes()).toEqual([]);

  await switchProject(page, /支付系统/);
  await expect.poll(refreshes).toEqual(['workspace-payments']);
  await switchProject(page, /电商平台/);
  await expect.poll(refreshes).toEqual(['workspace-payments', 'workspace-commerce']);
});

test('a failed project deletion keeps the checkout its members still resolve', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const commerce = project.locator('[data-repository-id="repo-0"]');
  await commerce.getByLabel('api 工作目录').selectOption('/work/commerce/team-0/api-feature');
  await page.evaluate(() => { (window as any).__workspaceFixture.failDelete = true; });
  await projectAction(page, '删除项目');
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: '删除项目' })).first();
  await confirm.getByRole('button', { name: '删除项目', exact: true }).click();
  await expect(project.getByRole('alert')).toContainText('项目文件被其他窗口占用');
  // The project is still there, so the choice it still resolves stays put.
  await expect(project.getByRole('button', { name: '选择业务项目' })).toContainText('电商平台');
  await expect(commerce.getByLabel('api 工作目录')).toHaveValue('/work/commerce/team-0/api-feature');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cliora:workspace-paths') || '{}'))).toEqual({ 'workspace-commerce\u0000repo-0': '/work/commerce/team-0/api-feature' });
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

  // A linked manifest hands off the row's own repository: v2 names both the file and the member.
  await memberAction(page, 'r-root', '在 Twiglane 中打开');
  await expect.poll(() => page.evaluate(() => (window as any).__openedUrls)).toEqual([
    'twiglane://workspace?v=2&file=%2Fwork%2Fmy%20team%2Fcommerce.dev-workspace.json&repository=r-root',
  ]);

  // Failure surfaces cleanly in the project error banner.
  await page.evaluate(() => { (window as any).__failTwiglaneOpen = true; });
  await memberAction(page, 'r-sub', '在 Twiglane 中打开');
  await expect(project.getByRole('alert')).toContainText('无法打开 Twiglane');

  // Tools scope picker folds Business Project repositories under their project heading.
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '配置范围', exact: true }).click();
  await expect(page.getByRole('option', { name: /^电商平台/ })).toBeVisible();
});

test('a single-checkout project is one choice and folding a project keeps the list steady', async ({ page }) => {
  await install(page);
  await page.evaluate(() => {
    // The payments project keeps only its main checkout.
    const payments = (window as any).__workspaceFixture.workspaces[1];
    payments.repositories[0].locations[0].worktrees = [];
    payments.revision++;
    window.dispatchEvent(new CustomEvent('cliora:business-workspaces-changed', { detail: { workspace: payments } }));
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await dialog.getByRole('button', { name: '工作目录 / 项目', exact: true }).click();

  // No "支付系统 ▸ payment-api" tree for one checkout: the repository row stands in for the project.
  await expect(page.getByRole('option', { name: /^支付系统/ })).toHaveCount(0);
  const single = page.getByRole('option', { name: /^payment-api/ });
  await expect(single).toContainText('支付系统');
  await expect(single).not.toHaveAttribute('data-indent', /.*/);

  // Folding never moves focus out of the search field and never overflows the list.
  const search = page.getByRole('textbox', { name: /搜索/ }).last();
  await expect(search).toBeFocused();
  const heading = page.getByRole('option', { name: /^电商平台/ });
  const list = page.getByRole('listbox');
  for (const expanded of ['true', 'false']) {
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', expanded);
    await expect(search).toBeFocused();
  }
  const overflow = await list.evaluate((element) => ({ x: element.scrollWidth - element.clientWidth, y: element.scrollHeight - element.clientHeight }));
  expect(overflow).toEqual({ x: 0, y: 0 });

  await single.click();
  await expect(dialog.getByRole('button', { name: '工作目录 / 项目', exact: true })).toContainText('payment-api');
  await expect(dialog.getByRole('button', { name: '工作目录 / 项目', exact: true })).toHaveAttribute('title', /支付系统 \/ payment-api/);
});

test('a favorite flips at once without disabling the list and reverts when saving fails', async ({ page }) => {
  await install(page);
  await page.evaluate(() => {
    const win = window as any;
    const orig = win.__TAURI_INTERNALS__.invoke;
    win.__favoriteGate = null;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'favorite_workspace_repository') {
        await new Promise(resolve => { win.__favoriteGate = resolve; });
        if (win.__failFavorite) throw { message: '收藏未保存' };
      }
      return orig(command, args);
    };
  });
  const project = page.locator('[data-business-workspaces]').first();
  const row = project.locator('[data-repository-id="repo-5"]');
  await row.getByRole('button', { name: '收藏仓库', exact: true }).click();
  // Pressed before the save returns, and other rows can still launch meanwhile.
  await expect(row.getByRole('button', { name: '取消收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(project.locator('[data-repository-id="repo-6"]').getByRole('button', { name: '启动会话', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__favoriteGate());
  await expect(project.locator('[data-repository-id]').first()).toHaveAttribute('data-repository-id', 'repo-5');

  await page.evaluate(() => { (window as any).__failFavorite = true; });
  const other = project.locator('[data-repository-id="repo-7"]');
  await other.getByRole('button', { name: '收藏仓库', exact: true }).click();
  await expect(other.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__favoriteGate());
  await expect(other.getByRole('button', { name: '收藏仓库', exact: true })).toBeVisible();
  await expect(project.getByRole('alert')).toContainText('收藏未保存');
});

test('Enter in the search starts the one remaining repository with the chosen CLI', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const search = project.getByRole('textbox', { name: '搜索仓库名称或路径' });
  // Several matches: Enter does nothing.
  await search.fill('service-1');
  await search.press('Enter');
  await search.fill('service-12');
  await expect(project.locator('[data-repository-id]')).toHaveCount(1);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches.map((call: any) => call.repositoryId))).toEqual(['repo-12']);
});

async function switchProject(page: Page, name: RegExp) {
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '选择业务项目' }).click();
  await page.getByRole('option', { name }).click();
  return project;
}

test('a vanished member checkout falls back to an available one and says why', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const commerce = project.locator('[data-repository-id="repo-0"]');
  await commerce.getByLabel('api 工作目录').selectOption('/work/commerce/team-0/api-feature');
  // The remembered worktree disappears from the project; a different one is still there.
  await page.evaluate(() => {
    const fixture = (window as any).__workspaceFixture;
    fixture.setWorktrees('workspace-commerce', 'repo-0', [
      { name: 'main', branch: 'main', path: '/work/commerce/team-0/api', current: true },
      { name: 'hotfix', branch: 'hotfix/urgent', path: '/work/commerce/team-0/api-hotfix', current: false },
    ]);
  });
  await expect(commerce.getByLabel('api 工作目录')).toHaveValue('/work/commerce/team-0/api');
  await expect(commerce).toContainText('上次的工作目录已不可用');
  // Another checkout is still offered, so the note may point at choosing it.
  const fallback = commerce.locator('em').filter({ hasText: '上次的工作目录已不可用' });
  await expect(fallback).toHaveText('上次的工作目录已不可用，已回退到可用目录');
  await expect(fallback).toHaveAttribute('title', /选中其他目录即可替换这次回退/);
  await expect(fallback).toHaveAttribute('title', /api-feature/);
  // Choosing again replaces the fallback; starting then uses that choice.
  await commerce.getByLabel('api 工作目录').selectOption('/work/commerce/team-0/api-hotfix');
  await expect(commerce).not.toContainText('上次的工作目录已不可用');
  await commerce.getByRole('button', { name: '启动会话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__workspaceFixture.launches[0].request.directory)).toBe('/work/commerce/team-0/api-hotfix');
});

test('two projects that claim the same repository id keep their own checkout', async ({ page }) => {
  await install(page);
  await page.evaluate(() => {
    const fixture = (window as any).__workspaceFixture;
    // A second project declares the same repository id over its own host directory.
    fixture.workspaces.push({
      id: 'workspace-twin', name: '镜像项目', revision: 1, manifestPath: null, manifestRevision: null, error: null,
      repositories: [{
        id: 'repo-0', name: 'api', favorite: false,
        locations: [{
          id: 'location-twin', hostId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path: '/work/twin/team-0/api', projectId: null, targetId: null, available: true, kind: 'repository', reason: null,
          worktrees: [{ name: 'main', branch: 'main', path: '/work/twin/team-0/api', current: true }, { name: 'feature', branch: 'feature/search', path: '/work/twin/team-0/api-feature', current: false }],
        }],
      }],
    });
    // No project in the detail: the page lists the projects again and picks the twin up.
    window.dispatchEvent(new CustomEvent('cliora:business-workspaces-changed', { detail: {} }));
  });
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '选择业务项目' }).click();
  await expect(page.getByRole('option', { name: /^镜像项目/ })).toBeVisible();
  await page.getByRole('option', { name: /^电商平台/ }).click();
  await project.locator('[data-repository-id="repo-0"]').getByLabel('api 工作目录').selectOption('/work/commerce/team-0/api-feature');

  // The same repository id in another project starts from its own main checkout.
  await switchProject(page, /^镜像项目/);
  const twin = project.locator('[data-repository-id="repo-0"]');
  await expect(twin.getByLabel('api 工作目录')).toHaveValue('/work/twin/team-0/api');
  await twin.getByLabel('api 工作目录').selectOption('/work/twin/team-0/api-feature');
  // Both choices keep their project, also after the browser remounts on the next Home visit.
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await nav.getByRole('button', { name: '首页', exact: true }).click();
  const after = page.locator('[data-business-workspaces]').first();
  await expect(after.locator('[data-repository-id="repo-0"]').getByLabel('api 工作目录')).toHaveValue('/work/twin/team-0/api-feature');
  await switchProject(page, /^电商平台/);
  await expect(after.locator('[data-repository-id="repo-0"]').getByLabel('api 工作目录')).toHaveValue('/work/commerce/team-0/api-feature');
  await after.locator('[data-repository-id="repo-0"] [data-row-primary]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.launches[0]?.request.directory)).toBe('/work/commerce/team-0/api-feature');
});

test('a remembered checkout that is no longer available falls back without borrowing another project', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cliora:workspace-paths', JSON.stringify({
      'workspace-commerce\u0000repo-0': '/work/commerce/team-0/api-removed',
      'workspace-payments\u0000pay-api': '/work/payments/api-feature',
    }));
  });
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const commerce = project.locator('[data-repository-id="repo-0"]');
  // The stored checkout is gone, so the row starts in the main checkout and says why.
  await expect(commerce.getByLabel('api 工作目录')).toHaveValue('/work/commerce/team-0/api');
  await expect(commerce).toContainText('上次的工作目录已不可用');
  await switchProject(page, /^支付系统/);
  await expect(project.locator('[data-repository-id="pay-api"]').getByLabel('payment-api 工作目录')).toHaveValue('/work/payments/api-feature');
  await switchProject(page, /^电商平台/);
  await expect(commerce.getByLabel('api 工作目录')).toHaveValue('/work/commerce/team-0/api');
});

test('deleting a project trims only the checkouts it owned', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cliora:workspace-paths', JSON.stringify({
      'workspace-commerce\u0000repo-0': '/work/commerce/team-0/api-feature',
      'workspace-payments\u0000pay-api': '/work/payments/api-feature',
    }));
  });
  await install(page);
  await projectAction(page, '删除项目');
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: '删除项目' })).first();
  await expect(confirm).toContainText('仓库目录、分支和会话都不受影响');
  await confirm.getByRole('button', { name: '删除项目', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: any) => call.command === 'delete_business_workspace').map((call: any) => call.args.workspaceId))).toEqual(['workspace-commerce']);
  const project = page.locator('[data-business-workspaces]').first();
  await expect(project.locator('[data-repository-id]').first()).not.toHaveAttribute('data-repository-id', /^repo-/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cliora:workspace-paths') || '{}'))).toEqual({ 'workspace-payments\u0000pay-api': '/work/payments/api-feature' });
});

test('creating the first project keeps the keyboard in the new project', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__workspaceEmptyProjects = true; });
  await install(page);
  const block = page.locator('[data-business-workspaces]').first();
  await block.getByRole('button', { name: '新建项目', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建项目' });
  await create.getByRole('textbox', { name: '项目名称' }).fill('发布平台');
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect(create).toHaveCount(0);
  // The dialog's trigger belonged to the intro, which the first project replaced: the keyboard
  // continues in the new project instead of falling back to the page.
  const project = page.locator('[data-business-workspaces]').first();
  await expect(project.getByRole('button', { name: '添加仓库', exact: true })).toBeFocused();
});

test('creating a project and adding its members report the result and keep the keyboard in place', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const actions = project.getByRole('button', { name: '项目操作', exact: true });
  await actions.click();
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建项目' });
  await create.getByRole('textbox', { name: '项目名称' }).fill('发布平台');
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect(create).toHaveCount(0);
  // The new project is selected and holds the keyboard it had before the dialog opened.
  await expect(project.getByRole('button', { name: '选择业务项目' })).toContainText('发布平台');
  await expect(actions).toBeFocused();

  await project.getByRole('button', { name: '添加仓库', exact: true }).click();
  const batch = page.getByRole('dialog', { name: '选择要添加的仓库' });
  await batch.getByRole('button', { name: '添加所选 2 个仓库' }).click();
  await expect(batch).toHaveCount(0);
  await expect(project.getByRole('status').filter({ hasText: '已加入 2 个仓库' })).toBeVisible();
  await expect(project.locator('[data-repository-id]')).toHaveCount(2);
  await expect(project.getByRole('button', { name: '添加仓库', exact: true })).toBeFocused();
});

test('relinking, cancelling a removal and removing a member keep the result and the keyboard in place', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '需处理 1', exact: true }).click();
  const moved = project.locator('[data-repository-id="repo-46"]');
  await moved.getByRole('button', { name: '关联本机目录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: any) => call.command === 'relink_workspace_repository').length)).toBe(1);
  // The repaired row takes the keyboard instead of dropping it on the page, and needs no attention.
  await expect(moved.getByRole('button', { name: '启动会话', exact: true })).toBeFocused();
  await expect(project.getByRole('button', { name: /^需处理/ })).toHaveCount(0);

  const removed = () => page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: any) => call.command === 'remove_workspace_repository').map((call: any) => call.args.repositoryId));
  const last = project.locator('[data-repository-id="repo-47"]');
  await last.getByRole('button', { name: 'service-47 的更多操作' }).click();
  await page.getByRole('menuitem', { name: '移出项目', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '移出项目' });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(await removed()).toEqual([]);
  await expect(last.getByRole('button', { name: 'service-47 的更多操作' })).toBeFocused();

  // Confirming removes only the membership and continues on the row that takes its place.
  await last.getByRole('button', { name: 'service-47 的更多操作' }).click();
  await page.getByRole('menuitem', { name: '移出项目', exact: true }).click();
  await page.getByRole('dialog', { name: '移出项目' }).getByRole('button', { name: '移出项目', exact: true }).click();
  await expect.poll(removed).toEqual(['repo-47']);
  await expect(last).toHaveCount(0);
  await expect(project.locator('[data-repository-id="repo-46"]').getByRole('button', { name: '启动会话', exact: true })).toBeFocused();
});

test('a long project name stays readable and the primary actions stay reachable at the minimum window', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const long = '电商平台与内容分发中心（华东一区）';
  await page.evaluate(name => {
    const workspace = (window as any).__workspaceFixture.workspaces[0];
    workspace.name = name;
    workspace.revision++;
    window.dispatchEvent(new CustomEvent('cliora:business-workspaces-changed', { detail: { workspace } }));
  }, long);
  // A truncated trigger still names the whole project, so a long name stays identifiable.
  await expect(project.getByRole('button', { name: '选择业务项目' })).toHaveAttribute('title', new RegExp(long));
  await expect(project.getByRole('button', { name: '添加仓库', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(project.locator('[data-repository-id="repo-0"]').getByRole('button', { name: '启动会话', exact: true })).toBeInViewport({ ratio: 1 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test('the project fallback and its actions read in English too', async ({ page }) => {
  await install(page);
  // The stored interface language is synced through set_language, which returns the new bootstrap.
  await page.addInitScript(() => {
    localStorage.setItem('cliora:language', 'en');
    const internals = (window as any).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (command: string, args: Record<string, any> = {}) => command === 'set_language'
      ? { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', language: args.language }, tools: [{ id: 'codex', name: 'Codex' }] }
      : original(command, args);
  });
  await page.reload();
  const project = page.locator('[data-business-workspaces]').first();
  const row = project.locator('[data-repository-id="repo-0"]');
  await expect(project.getByRole('button', { name: 'Select project' })).toBeVisible();
  await row.getByLabel('api Working directory').selectOption('/work/commerce/team-0/api-feature');
  await page.evaluate(() => {
    (window as any).__workspaceFixture.setWorktrees('workspace-commerce', 'repo-0', [{ name: 'main', branch: 'main', path: '/work/commerce/team-0/api', current: true }]);
  });
  await expect(row).toContainText('The previous working directory is unavailable');
  // One checkout left means no picker, so the note names the directory used instead.
  const fallback = row.locator('em').filter({ hasText: 'The previous working directory is unavailable' });
  await expect(fallback).toHaveText('The previous working directory is unavailable; /work/commerce/team-0/api is used instead');
  await expect(fallback).toHaveAttribute('title', /api-feature/);
  await expect(fallback).not.toHaveAttribute('title', /Choosing another directory/);
});

test('a missing checkout keeps its status readable at medium widths', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '需处理 1', exact: true }).click();
  const status = project.locator('[data-repository-id="repo-46"] em');
  await expect(status).toHaveText('目录失效 · 目录不存在');
  // Neither the status nor any path text beside it is clipped to a stray "/".
  const clipped = await status.evaluate(node => [node, ...Array.from(node.parentElement!.querySelectorAll('span'))].filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.textContent));
  expect(clipped).toEqual([]);
});

test('a worktree fallback keeps the checkout path readable at medium widths', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  const row = project.locator('[data-repository-id="repo-0"]');
  await row.getByLabel('api 工作目录').selectOption('/work/commerce/team-0/api-feature');
  await page.evaluate(() => {
    (window as any).__workspaceFixture.setWorktrees('workspace-commerce', 'repo-0', [
      { name: 'main', branch: 'main', path: '/work/commerce/team-0/api', current: true },
      { name: 'hotfix', branch: 'hotfix/urgent', path: '/work/commerce/team-0/api-hotfix', current: false },
    ]);
  });
  await expect(row.locator('em').filter({ hasText: '上次的工作目录已不可用' })).toBeVisible();
  // The note wraps instead of squeezing same-named checkouts into an indistinguishable prefix.
  const path = row.getByText('team-0/api', { exact: true });
  await expect(path).toBeVisible();
  expect(await path.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  // The status itself is never cut to an ellipsis either.
  const note = row.locator('em').filter({ hasText: '上次的工作目录已不可用' });
  expect(await note.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node).textOverflow !== 'ellipsis')).toBe(true);
});

test('a uniquely named repository reads as one line and lines up with its neighbours', async ({ page }) => {
  await install(page);
  const project = page.locator('[data-business-workspaces]').first();
  await project.getByRole('button', { name: '紧凑列表', exact: true }).click();
  const unique = project.locator('[data-repository-id="repo-2"]');
  await expect(unique).toBeVisible();
  // Nothing tells a unique name apart, so no empty path track is reserved for it.
  await expect(unique.locator('em')).toHaveCount(0);
  const height = async (id: string) => (await project.locator(`[data-repository-id="${id}"]`).boundingBox())!.height;
  expect(await height('repo-2')).toBeLessThan(await height('repo-0'));
  const launch = async (id: string) => (await project.locator(`[data-repository-id="${id}"] [data-row-primary]`).boundingBox())!.x;
  expect(Math.abs(await launch('repo-0') - await launch('repo-2'))).toBeLessThanOrEqual(1);
});

test('large business projects default to multi-column card grid with smart prefix groups and view toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await install(page, 48);
  const names = [
    ...Array.from({ length: 8 }, (_, i) => `e6-common-mod-${i}`),
    ...Array.from({ length: 8 }, (_, i) => `e6-ms-service-${i}`),
    ...Array.from({ length: 4 }, (_, i) => `dmh-worker-${i}`),
  ];
  await page.evaluate((repoNames) => {
    const app = window as any;
    const orig = app.__TAURI_INTERNALS__.invoke;
    const largeWorkspace = [{
      id: 'ws-large',
      name: '端到端',
      revision: 1,
      manifestPath: '/Users/dev/e6.dev-workspace.json',
      manifestRevision: 1,
      error: null,
      repositories: repoNames.map((name: string, index: number) => ({
        id: `r-${index}`,
        name,
        favorite: index === 0,
        locations: [{
          id: `loc-${index}`,
          hostId: 'local',
          path: `/Users/dev/project/e6yun3.0/${name}`,
          projectId: `p-${index}`,
          targetId: null,
          available: true,
          kind: 'repository',
          reason: null,
          worktrees: [{ path: `/Users/dev/project/e6yun3.0/${name}`, name, branch: 'main', current: true }],
        }],
      })),
    }];
    app.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_business_workspaces') return largeWorkspace;
      if (command === 'refresh_workspace_manifest') return largeWorkspace[0];
      return orig(command, args);
    };
  }, names);
  await projectAction(page, '刷新项目');
  const project = page.locator('[data-business-workspaces]').first();
  const list = project.locator('[aria-label="清单中的仓库"]');
  await expect(project.locator('[data-repository-id="r-0"]')).toBeVisible();
  await expect(list).toHaveAttribute('data-view', 'grid');
  // Multi-column layout: the first two cards sit side by side on the same row.
  const first = (await project.locator('[data-repository-id="r-0"]').boundingBox())!;
  const second = (await project.locator('[data-repository-id="r-1"]').boundingBox())!;
  expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(2);
  expect(second.x).toBeGreaterThan(first.x + first.width - 1);

  // Smart prefix groups expand dominant `e6-*` into `e6-common` / `e6-ms` alongside `dmh`.
  const groups = project.getByRole('group', { name: '按前缀分组' });
  await expect(groups.getByRole('button', { name: /e6-common/ })).toBeVisible();
  await expect(groups.getByRole('button', { name: /e6-ms/ })).toBeVisible();
  await expect(groups.getByRole('button', { name: /dmh/ })).toBeVisible();
  await groups.getByRole('button', { name: /dmh/ }).click();
  await expect(project.locator('[data-repository-id]')).toHaveCount(4);
  await groups.getByRole('button', { name: /全部/ }).click();
  await expect(project.locator('[data-repository-id]')).toHaveCount(20);

  // Explicit view switch toggles to list mode and persists.
  await project.getByRole('button', { name: '紧凑列表', exact: true }).click();
  await expect(list).toHaveAttribute('data-view', 'list');
  const firstList = (await project.locator('[data-repository-id="r-0"]').boundingBox())!;
  const secondList = (await project.locator('[data-repository-id="r-1"]').boundingBox())!;
  expect(secondList.y).toBeGreaterThanOrEqual(firstList.y + firstList.height - 1);
});
