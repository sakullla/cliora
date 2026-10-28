import { expect, test, type Locator, type Page } from '@playwright/test';

// R6: navigation, launching a tool, a dialog and a row menu all work from the keyboard alone,
// and the focused control always shows a visible ring (02 ADR-6/ADR-7). Arrow keys move inside
// the sidebar CLI list; the page buttons are reached with Tab or Mod+1..6.

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
  const list = nav.getByRole('group', { name: '受管 CLI' });
  const codex = list.getByRole('button', { name: 'Codex', exact: true });
  const grok = list.getByRole('button', { name: 'Grok', exact: true });
  const card = page.getByRole('region', { name: '项目与启动' }).locator('[data-project-id="demo"]');
  await expect(card).toBeVisible();
  await expect(codex).toBeVisible();

  // Tab from the start of the page reaches the sidebar CLI list (one stop) with a visible ring.
  await page.locator('body').focus();
  let reached = false;
  for (let step = 0; step < 20 && !reached; step += 1) {
    await page.keyboard.press('Tab');
    reached = await codex.evaluate((el) => el === document.activeElement);
    if (!reached) expect(await grok.evaluate((el) => el === document.activeElement)).toBe(false);
  }
  expect(reached).toBe(true);
  await expectVisibleFocus(codex);
  await page.keyboard.press('ArrowDown');
  await expectVisibleFocus(grok);
  await page.keyboard.press('ArrowUp');
  await expect(codex).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Grok', level: 2 })).toBeVisible();
  await expect(grok).toHaveAttribute('aria-current', 'true');

  // Mod+1 returns home, Mod+3 switches to 工具与连接 again, Mod+1 goes back.
  await page.keyboard.press('ControlOrMeta+1');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+3');
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(nav.getByRole('button', { name: '工具与连接', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ControlOrMeta+1');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();

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
    ['launch_cli', { toolId: 'grok', projectId: 'demo', sessionId: null, mode: 'yolo', directory: null }],
  ]);

  // A dialog opens from its trigger and Escape closes it, returning focus to the trigger.
  const edit = card.getByRole('button', { name: '修改', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '修改Demo' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectVisibleFocus(edit);

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
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Codex', level: 2 })).toBeVisible();
  await expect(codex).toHaveAttribute('aria-current', 'true');
});
