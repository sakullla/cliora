import { expect, test, type Page } from '@playwright/test';
import { installConfigurationWorkspace } from './configuration-workspace-fixture';

type InstallOptions = { nameFailure?: boolean; savedHost?: string; hostRead?: 'reject' | 'pending' };
async function install(page: Page, options: InstallOptions = {}) {
  await installConfigurationWorkspace(page, 'codex');
  await page.addInitScript(({ nameFailure, savedHost, hostRead }) => {
    if (savedHost) localStorage.setItem('cliora:remote-target', savedHost);
    const app = window as any;
    const invoke = app.__TAURI_INTERNALS__.invoke;
    const projects = ['api-one', 'api-two', 'website', 'desktop', 'docs'].map((name, index) => ({
      id: `p${index}`, name, path: `C:/projects/${name}`, available: true, preferredTool: 'codex', lastOpened: 1790758800,
      modelOverrides: {}, selectedProfiles: { codex: 'existing' }, appliedProfiles: { codex: 'existing' },
    }));
    const hosts = ['a', 'b'].map(id => ({ id: `remote-${id}`, name: `开发主机 ${id}`, host: `host-${id}.example.test`, user: 'dev', port: 22, enabled: true, authMethod: 'key', createdAt: 1, updatedAt: 1 }));
    const state = app.navigationFixture = { projects, hosts, nameReads: 0, hostReads: 0, hostChanges: [] as string[], intents: [] as unknown[], projectDelay: false, releaseProjects: null as (() => void) | null, nameHold: false as false | 'stale' | 'current', heldNames: [] as Array<() => void> };
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
      if (command === 'list_remote_targets') {
        state.hostReads++;
        if (hostRead === 'reject') throw { message: '远程主机列表读取失败' };
        if (hostRead === 'pending') return new Promise(() => {});
        return structuredClone(state.hosts);
      }
      if (command === 'list_remote_projects') return state.hosts.flatMap((host: any) => [0, 1].map(index => ({ id: `${host.id}-${index}`, targetId: host.id, name: `远程项目 ${index}`, path: `/srv/project-${index}`, preferredTool: 'codex', updatedAt: 1 })));
      if (command === 'get_registered_tool_workspace' && args.summary) {
        state.nameReads++;
        if (nameFailure) throw { message: '配置名称读取失败' };
        if (state.nameHold) {
          // A held read answers late; a stale one carries names from a context the user left.
          const stale = state.nameHold === 'stale';
          await new Promise<void>(resolve => state.heldNames.push(resolve));
          const result = await invoke(command, args);
          if (stale) for (const profile of result?.profiles ?? []) profile.name = '过期名称';
          return result;
        }
      }
      return invoke(command, args);
    };
  }, { nameFailure: false, savedHost: '', hostRead: undefined, ...options });
  await page.goto('/');
  if (!options.savedHost) await expect(page.locator('[data-project-id]')).toHaveCount(5);
  else await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
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

for (const hostRead of ['reject', 'pending'] as const) {
  test(`page navigation keeps working when the saved host list ${hostRead === 'reject' ? 'fails to load' : 'is still loading'}`, async ({ page }) => {
    await install(page, { savedHost: 'remote-a', hostRead });
    await expect.poll(() => page.evaluate(() => (window as any).navigationFixture.hostReads)).toBeGreaterThan(0);
    await nav(page, '资料库').click();
    await expect(nav(page, '资料库')).toHaveAttribute('aria-current', 'page');
    await nav(page, '工具').click();
    await expect(nav(page, '工具')).toHaveAttribute('aria-current', 'page');
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('ControlOrMeta+1');
    await expect(nav(page, '首页')).toHaveAttribute('aria-current', 'page');
    // Page-only moves keep the saved host; nothing was broadcast or persisted.
    expect(await page.evaluate(() => (window as any).navigationFixture.hostChanges)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('cliora:remote-target'))).toBe('remote-a');
  });
}

test('a command-palette project reveal overrides the saved home scroll', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 650 });
  await install(page);
  const main = page.locator('main');
  await main.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const saved = await main.evaluate(el => el.scrollTop);
  expect(saved).toBeGreaterThan(0);
  await nav(page, '资料库').click();
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: '快速前往' });
  await palette.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('api-one');
  await expect(palette.getByRole('option', { name: /api-one/ }).first()).toBeVisible();
  // Home remounts with its list still loading, so the saved position would be restored late.
  await page.evaluate(() => { (window as any).navigationFixture.projectDelay = true; });
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => !!(window as any).navigationFixture.releaseProjects)).toBe(true);
  await page.evaluate(() => { const fixture = (window as any).navigationFixture; fixture.projectDelay = false; fixture.releaseProjects(); });
  const target = page.locator('[data-project-id="p0"]');
  const inView = () => target.evaluate(element => {
    const box = document.querySelector('main')!.getBoundingClientRect();
    const item = element.getBoundingClientRect();
    return item.top >= box.top - 1 && item.bottom <= box.bottom + 1;
  });
  await expect.poll(inView).toBe(true);
  await expect(target).toBeFocused();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await inView()).toBe(true);
  expect(await main.evaluate(el => el.scrollTop)).toBeLessThan(saved);
});

test('a late configuration-name read from an earlier context does not overwrite current names', async ({ page }) => {
  await install(page);
  const name = page.locator('[data-project-id="p0"] [data-profile-name]');
  await expect(name).toHaveText('配置 工作配置');
  const release = () => page.evaluate(() => (window as any).navigationFixture.heldNames.splice(0).forEach((resolve: () => void) => resolve()));
  const held = () => page.evaluate(() => (window as any).navigationFixture.heldNames.length);
  await page.evaluate(() => { (window as any).navigationFixture.nameHold = 'stale'; });
  await changeHost(page, '开发主机 a');
  await changeHost(page, '本机');
  await expect.poll(held).toBeGreaterThan(0);
  // The local read answers only after the user moved to another host.
  await changeHost(page, '开发主机 a');
  await release();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
  await page.evaluate(() => { (window as any).navigationFixture.nameHold = 'current'; });
  await changeHost(page, '本机');
  await expect.poll(held).toBeGreaterThan(0);
  await expect(name).not.toHaveAttribute('data-profile-name', 'resolved');
  await expect(name).not.toContainText('过期名称');
  await release();
  await expect(name).toHaveText('配置 工作配置');
});

test('a late local project list after switching hosts does not replace the remote view or its search state', async ({ page }) => {
  await install(page);
  await search(page).fill('api');
  await nav(page, '资料库').click();
  await page.evaluate(() => { (window as any).navigationFixture.projectDelay = true; });
  await nav(page, '首页').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).navigationFixture.releaseProjects)).toBe(true);
  await changeHost(page, '开发主机 a');
  await page.evaluate(() => { const fixture = (window as any).navigationFixture; fixture.projectDelay = false; fixture.releaseProjects(); });
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
  await expect(page.locator('[data-project-id]').first()).toContainText('远程项目');
  await expect(search(page)).toHaveCount(0);
  await changeHost(page, '本机');
  await expect(search(page)).toHaveValue('api');
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
  await expect(page.locator('[data-project-id="p0"]')).toBeVisible();
});
