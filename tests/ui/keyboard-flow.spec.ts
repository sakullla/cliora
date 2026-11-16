import { expect, test, type Locator, type Page } from '@playwright/test';
import { cliSwitcher } from './cli-switcher';
import { setupConfigurationWorkspace } from './configuration-workspace-fixture';

// R6: navigation, launching a tool, a dialog and a row menu all work from the keyboard alone,
// and the focused control always shows a visible ring (02 ADR-6/ADR-7). Arrow keys move inside
// the header CLI switcher; the page buttons are reached with Tab or Mod+1..6.

async function install(page: Page) {
  await page.addInitScript(() => {
    const names: Record<string, string> = { codex: 'Codex', grok: 'Grok' };
    const ids = Object.keys(names);
    let preferred = 'codex';
    const project = () => ({ id: 'demo', name: 'Demo', path: 'C:/demo', available: true, preferredTool: preferred, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} });
    const calls: Array<[string, unknown]> = [];
    Object.assign(window, {
      isTauri: true,
      __calls: calls,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ids, theme: 'light' }, tools: ids.map((id) => ({ id, name: names[id] })) };
        if (command === 'list_cli_adapters') return { registered: ids.map((id) => ({ id, name: names[id], interfaceFormats: [], launchForm: 'terminal', yoloAvailable: id === 'grok', management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false } })), managedIds: ids, preservedUnknown: [] };
        if (command === 'list_projects') return [project()];
        if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: `C:/${args.toolId}.cmd`, installations: [{ path: `C:/${args.toolId}.cmd`, version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'yolo' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('plugin:event|')) return 1;
        if (command === 'set_project_tool') { calls.push([command, args]); preferred = args.toolId; return project(); }
        if (command === 'launch_cli') {
          calls.push([command, args.request]);
          return { mode: args.request.mode, status: 'terminal_requested', toolId: args.request.toolId, projectId: args.request.projectId, terminal: 'auto' };
        }
        if (command.startsWith('list_') || command === 'usage_presets') return [];
        return null;
      } },
    });
  });
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Array<[string, unknown]> }).__calls);

/** The focused element draws a non-zero outline or a focus shadow. */
async function expectVisibleFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  const ring = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    return { outline, shadow: style.boxShadow !== 'none' && style.boxShadow !== '', focusVisible: el.matches(':focus-visible') };
  });
  expect(ring.focusVisible, JSON.stringify(ring)).toBe(true);
  expect(ring.outline || ring.shadow, JSON.stringify(ring)).toBe(true);
}

test('the keyboard alone navigates, launches from the split button, closes a dialog and drives a row menu', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await install(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  const pagesButton = nav.getByRole('button', { name: '工具', exact: true });
  const card = page.getByRole('region', { name: '项目与启动' }).locator('[data-project-id="demo"]');
  await expect(card).toBeVisible();

  // Tab from the start of the page reaches the sidebar page buttons with a visible ring.
  await page.locator('body').focus();
  let reached = false;
  for (let step = 0; step < 20 && !reached; step += 1) {
    await page.keyboard.press('Tab');
    reached = await pagesButton.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await expectVisibleFocus(pagesButton);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '工具', level: 1 })).toBeVisible();

  // The header switcher opens from the keyboard; arrows choose and Enter opens the CLI.
  const picker = cliSwitcher(page);
  await expect(picker).toHaveAccessibleName('Codex，切换 CLI');
  await picker.focus();
  await expectVisibleFocus(picker);
  await page.keyboard.press('ArrowDown');
  const options = page.getByRole('listbox', { name: /，切换 CLI$/ }).getByRole('option');
  await expect(options.first()).toHaveAttribute('data-active', 'true');
  // Tab out of the open panel closes it: the trigger reports aria-expanded=false and the panel node is gone.
  await page.keyboard.press('Tab');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('listbox', { name: /，切换 CLI$/ })).toHaveCount(0);
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  await expect(options.first()).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.filter({ hasText: 'Grok' })).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Grok', level: 2 })).toBeVisible();
  await expect(picker).toHaveAccessibleName('Grok，切换 CLI');
  // Mod+1 returns home, Mod+3 switches to 工具 again, Mod+1 goes back.
  await page.keyboard.press('ControlOrMeta+1');
  await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+3');
  await expect(page.getByRole('heading', { name: '工具', level: 1 })).toBeVisible();
  await expect(nav.getByRole('button', { name: '工具', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ControlOrMeta+1');
  await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();

  // Split button: Tab from the main half to the menu half, Enter opens, arrows choose, Enter launches.
  await card.getByRole('button', { name: '启动', exact: true }).focus();
  await page.keyboard.press('Tab');
  const menuButton = card.getByRole('button', { name: '用其他工具启动 Demo' });
  await expectVisibleFocus(menuButton);
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: '用其他工具启动 Demo' });
  await expect(menu.getByRole('menuitem', { name: /Codex/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: /Grok/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect.poll(() => calls(page)).toEqual([
    ['set_project_tool', { projectId: 'demo', toolId: 'grok' }],
    ['launch_cli', { toolId: 'grok', projectId: 'demo', sessionId: null, mode: 'yolo', directory: null, worktreeIntent: 'given' }],
  ]);

  // Project editing lives in the more menu; Escape returns focus to its trigger.
  const more = card.getByRole('button', { name: 'Demo 的更多操作', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu', { name: 'Demo 的更多操作' }).getByRole('menuitem', { name: '修改', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改Demo' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectVisibleFocus(more);

  // The row menu: Enter opens on the first item, arrows move, Escape returns, Enter runs an item.
  const rowMenu = page.locator('[data-tool-row]').filter({ hasText: 'Codex' }).getByRole('button', { name: 'Codex 的更多操作', exact: true });
  await rowMenu.focus();
  await page.keyboard.press('Enter');
  const actions = page.getByRole('menu', { name: 'Codex 的更多操作' });
  const items = actions.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(actions).toHaveCount(0);
  await expectVisibleFocus(rowMenu);
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  const editConfig = actions.getByRole('menuitem', { name: '编辑配置', exact: true });
  for (let step = 0; step < 5 && !(await editConfig.evaluate((el) => el === document.activeElement)); step += 1) await page.keyboard.press('ArrowDown');
  await expect(editConfig).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '工具', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Codex', level: 2 })).toBeVisible();
  await expect(picker).toHaveAccessibleName('Codex，切换 CLI');

  // Command palette supports multi-keyword search, PageDown/PageUp navigation, and backdrop click dismissal.
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: '快速前往' });
  await expect(palette).toBeVisible();
  const paletteInput = palette.getByRole('combobox', { name: '搜索页面、工具或项目' });
  await paletteInput.fill('grok 打开配置');
  await expect(palette.getByRole('option', { name: /Grok/ })).toHaveAttribute('aria-selected', 'true');
  await paletteInput.fill('');
  await page.keyboard.press('PageDown');
  expect(await palette.getByRole('option').evaluateAll((nodes) => nodes.findIndex((node) => node.getAttribute('aria-selected') === 'true'))).toBeGreaterThan(0);
  await page.keyboard.press('PageUp');
  await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.mouse.click(8, 8);
  await expect(palette).toHaveCount(0);
});

test('a quick step jump switches advanced once, focuses the address and stops scheduling frames', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setupConfigurationWorkspace(page, 'codex');
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    const state = { count: 0 };
    (window as any).__rafAudit = state;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => { state.count += 1; return original(callback); };
  });
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '快速配置', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { (window as any).__rafAudit.count = 0; });
  await dialog.getByRole('button', { name: '供应商（已完成）', exact: true }).click();
  const address = dialog.getByLabel('请求地址', { exact: true });
  await expect(address).toBeFocused();
  await expect(dialog.getByRole('button', { name: '高级配置', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(250);
  const settled = await page.evaluate(() => (window as any).__rafAudit.count);
  expect(settled).toBeLessThanOrEqual(3);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).__rafAudit.count)).toBe(settled);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(100);
  const afterClose = await page.evaluate(() => (window as any).__rafAudit.count);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__rafAudit.count)).toBe(afterClose);
});

test('the configuration quick/advanced shell works from the keyboard and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setupConfigurationWorkspace(page, 'codex');
  const create = page.getByRole('button', { name: '新建配置', exact: true });
  await create.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expectVisibleFocus(create);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const quick = dialog.getByRole('button', { name: '快速配置', exact: true });
  const advanced = dialog.getByRole('button', { name: '高级配置', exact: true });
  await expect(quick).toHaveAttribute('aria-pressed', 'true');
  await quick.focus();
  await expectVisibleFocus(quick);
  await page.keyboard.press('Tab');
  await expectVisibleFocus(advanced);
  await page.keyboard.press('Enter');
  await expect(advanced).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const settings = dialog.getByRole('button', { name: '常用设置', exact: true });
  await expectVisibleFocus(settings);
  await page.keyboard.press('Enter');
  await expect(settings).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dialog).toHaveCount(0);
  const saved = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'save_configuration_draft'));
  expect(saved).toHaveLength(1);
  expect(saved[0].args.draft.profile.name).toMatch(/配置$/);
  await expectVisibleFocus(create);

  // An empty name blocks save and moves focus to the field that needs attention.
  await create.focus();
  await page.keyboard.press('Enter');
  const reopen = page.getByRole('dialog');
  const name = reopen.getByLabel('配置名称');
  await name.fill('');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(name).toBeFocused();
  await expect(reopen.getByRole('alert').filter({ hasText: '请输入配置名称' })).toBeVisible();
  // Escape asks before discarding; cancel keeps editing, and confirming returns focus to the opener.
  await page.keyboard.press('Escape');
  const leave = page.getByRole('dialog').filter({ hasText: '放弃未保存修改' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(reopen).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').filter({ hasText: '放弃未保存修改' }).getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(create).toBeFocused();
});
