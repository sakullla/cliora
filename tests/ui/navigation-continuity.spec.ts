import { expect, test, type Page } from '@playwright/test';
import { installConfigurationWorkspace } from './configuration-workspace-fixture';

async function install(page: Page, options: { nameFailure?: boolean } = {}) {
  await installConfigurationWorkspace(page, 'codex');
  await page.addInitScript(({ nameFailure }) => {
    const app = window as any;
    const invoke = app.__TAURI_INTERNALS__.invoke;
    const projects = ['api-one', 'api-two', 'website', 'desktop', 'docs'].map((name, index) => ({
      id: `p${index}`, name, path: `C:/projects/${name}`, available: true, preferredTool: 'codex', lastOpened: 1790758800,
      modelOverrides: {}, selectedProfiles: { codex: 'existing' }, appliedProfiles: { codex: 'existing' },
    }));
    const hosts = ['a', 'b'].map(id => ({ id: `remote-${id}`, name: `开发主机 ${id}`, host: `host-${id}.example.test`, user: 'dev', port: 22, enabled: true, authMethod: 'key', createdAt: 1, updatedAt: 1 }));
    const state = app.navigationFixture = { projects, hosts, nameReads: 0, hostReads: 0, hostChanges: [] as string[], intents: [] as unknown[], projectDelay: false, releaseProjects: null as (() => void) | null };
    window.addEventListener('cliora:remote-target-changed', (event: any) => state.hostChanges.push(event.detail));
    window.addEventListener('cliora:open-remote-session', (event: any) => state.intents.push(event.detail));
    app.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'get_bootstrap') {
        const result = await invoke(command, args);
        result.preferences.remote_ssh_enabled = true;
        return result;
      }
      if (command === 'list_cli_adapters') {
        const result = await invoke(command, args);
        for (const tool of result.registered) Object.assign(tool, { name: 'Codex', launch: { state: 'available', reason: '' }, nativeConfig: { state: 'available', reason: '' } });
        return result;
      }
      if (command === 'list_projects') {
        if (state.projectDelay) await new Promise<void>(resolve => { state.releaseProjects = resolve; });
        return structuredClone(state.projects);
      }
      if (command === 'remove_project') { state.projects = state.projects.filter((project: any) => project.id !== args.projectId); return null; }
      if (command === 'list_remote_targets') { state.hostReads++; return structuredClone(state.hosts); }
      if (command === 'list_remote_projects') return state.hosts.flatMap((host: any) => [0, 1].map(index => ({ id: `${host.id}-${index}`, targetId: host.id, name: `远程项目 ${index}`, path: `/srv/project-${index}`, preferredTool: 'codex', updatedAt: 1 })));
      if (command === 'get_registered_tool_workspace' && args.summary) {
        state.nameReads++;
        if (nameFailure) throw { message: '配置名称读取失败' };
      }
      return invoke(command, args);
    };
  }, options);
  await page.goto('/');
  await expect(page.locator('[data-project-id]')).toHaveCount(5);
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '页面' }).getByRole('button', { name, exact: true });
const search = (page: Page) => page.getByRole('textbox', { name: '搜索项目', exact: true });
async function changeHost(page: Page, name: string) {
  await page.locator('.sidebar-host .host-switcher-trigger').click();
  await page.getByRole('menuitemradio').filter({ hasText: name }).click();
}

test('home restores its query and scroll after delayed reads and same-page navigation', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 650 });
  await install(page);
  await search(page).fill('api');
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
  await page.locator('main').evaluate(el => { el.scrollTop = 280; });
  const previous = await page.locator('main').evaluate(el => el.scrollTop);
  expect(previous).toBeGreaterThan(0);
  await nav(page, '资料库').click();
  await page.evaluate(() => { (window as any).navigationFixture.projectDelay = true; });
  await nav(page, '首页').click();
  await expect(search(page)).toHaveValue('api');
  await expect.poll(() => page.evaluate(() => !!(window as any).navigationFixture.releaseProjects)).toBe(true);
  await page.evaluate(() => { const fixture = (window as any).navigationFixture; fixture.projectDelay = false; fixture.releaseProjects(); });
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
  await expect.poll(() => page.locator('main').evaluate(el => el.scrollTop)).toBe(previous);
  await nav(page, '首页').click();
  await expect.poll(() => page.locator('main').evaluate(el => el.scrollTop)).toBe(previous);
});

test('project search stays clearable after deleting across the visibility threshold and when nothing matches', async ({ page }) => {
  await install(page);
  await search(page).fill('api');
  const first = page.locator('[data-project-id="p0"]');
  await first.getByRole('button', { name: 'api-one 的更多操作' }).click();
  await page.getByRole('menuitem', { name: '修改', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移除项目', exact: true }).click();
  await page.getByRole('dialog', { name: '移除项目', exact: true }).getByRole('button', { name: '移除项目', exact: true }).click();
  await expect(page.locator('[data-project-id]')).toHaveCount(1);
  await expect(search(page)).toHaveValue('api');
  await search(page).fill('no-matching-project');
  await page.getByRole('button', { name: '清空搜索', exact: true }).last().click();
  await expect(page.locator('[data-project-id]')).toHaveCount(4);
});

test('home searches belong to the selected host and an unread host has no success indicator', async ({ page }) => {
  await install(page);
  await search(page).fill('api');
  await changeHost(page, '开发主机 a');
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
  await expect(search(page)).toHaveCount(0);
  const pseudoContent = await page.locator('.sidebar-host .host-switcher-glyph').evaluate(el => getComputedStyle(el, '::after').content);
  expect(['none', 'normal']).toContain(pseudoContent);
  await changeHost(page, '本机');
  await expect(search(page)).toHaveValue('api');
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
});

test('project configuration names use one tool summary and fallback preserves the project', async ({ page }) => {
  await install(page);
  await expect(page.locator('[data-project-id="p0"] [data-profile-name="resolved"]')).toHaveText('配置 工作配置');
  const reads = await page.evaluate(() => (window as any).navigationFixture.nameReads);
  expect(reads).toBeLessThanOrEqual(2); // ManagedTools can already have completed its own summary read.
  await search(page).fill('api');
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).navigationFixture.nameReads)).toBe(reads);
});

test('failed configuration-name lookup keeps a labeled ID and legal launch available', async ({ page }) => {
  await install(page, { nameFailure: true });
  const card = page.locator('[data-project-id="p0"]');
  await expect(card.locator('[data-profile-name]')).toHaveAttribute('title', /名称暂不可用/);
  await expect(card.locator('[data-profile-name]')).toHaveText('配置 ID existing');
  await expect(card.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
});

async function dirtyConfiguration(page: Page) {
  await nav(page, '工具').click();
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  await page.getByRole('dialog').getByLabel('配置名称').fill('仍在编辑的配置');
}
async function requestRemoteSession(page: Page, targetId: string) {
  await page.evaluate(targetId => window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { targetId } })), targetId);
}

test('a repeated shell navigation to the current page does not discard a configuration draft', async ({ page }) => {
  await install(page);
  await dirtyConfiguration(page);
  // Exercise the shell's action directly while the modal owns pointer input.
  await nav(page, '工具').dispatchEvent('click');
  await expect(page.getByRole('dialog', { name: '放弃未保存修改？' })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('仍在编辑的配置');
});

test('remote launch confirms before changing host; cancellation preserves draft and duplicate requests do not replace the target', async ({ page }) => {
  await install(page);
  await dirtyConfiguration(page);
  await requestRemoteSession(page, 'remote-a');
  const confirmation = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(confirmation).toBeVisible();
  expect(await page.evaluate(() => (window as any).navigationFixture.hostChanges)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('cliora:remote-target'))).toBeNull();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('仍在编辑的配置');
  await requestRemoteSession(page, 'remote-a');
  await expect(confirmation).toBeVisible();
  await requestRemoteSession(page, 'remote-b');
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).navigationFixture.hostChanges)).toEqual(['remote-a']);
  expect(await page.evaluate(() => localStorage.getItem('cliora:remote-target'))).toBe('remote-a');
  await expect(nav(page, '工作台')).toHaveAttribute('aria-current', 'page');
});

test('a disabled destination cannot consume a pending draft confirmation', async ({ page }) => {
  await install(page);
  await dirtyConfiguration(page);
  await requestRemoteSession(page, 'remote-a');
  const confirmation = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(confirmation).toBeVisible();
  const reads = await page.evaluate(() => (window as any).navigationFixture.hostReads);
  await page.evaluate(() => {
    (window as any).navigationFixture.hosts[0].enabled = false;
    window.dispatchEvent(new Event('cliora:remote-targets-changed'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).navigationFixture.hostReads)).toBeGreaterThan(reads);
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('仍在编辑的配置');
  expect(await page.evaluate(() => (window as any).navigationFixture.hostChanges)).toEqual([]);
  await expect(nav(page, '工具')).toHaveAttribute('aria-current', 'page');
});
