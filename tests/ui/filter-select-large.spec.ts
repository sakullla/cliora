import { type Page } from '@playwright/test';
import { expect, test } from './sharedPage';

/** Rules library with hundreds of projects: the project filter is a shared FilterSelect. */
async function install(page: Page, count: number) {
  await page.addInitScript((total) => {
    const projects = Array.from({ length: total }, (_, index) => ({ id: `p${index}`, name: index === 7 ? `demo-module-${index}-示例项目的长名称与自动验证脚本测试` : `demo-module-${index}`, path: `/Users/dev/work/sample-workspaces/group${index % 9}/demo-module-${index}`, available: true, preferredTool: 'codex', lastOpened: 1790758800 - index, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }));
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return projects;
        if (command === 'get_launch_settings') return { selected: 'terminal', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'list_library_items') return [{ id: 'r-1', kind: 'rule', title: '提交前检查', body: '运行测试与构建', category: '流程', projectId: null, version: 1, updatedAt: 1790758700 }];
        if (command.startsWith('plugin:event|')) return 1;
        if (command.startsWith('list_')) return [];
        return null;
      },
    };
  }, count);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
}

/** Every rendered option keeps the fixed height it was laid out with and its text fits inside. */
async function rowsSettled(page: Page) {
  return page.getByRole('listbox', { name: '项目筛选' }).evaluate((list) => [...list.querySelectorAll<HTMLElement>('[role="option"]')].every((option) => {
    const declared = parseFloat(option.style.height);
    const copy = option.querySelector<HTMLElement>('span')!;
    return Math.abs(option.getBoundingClientRect().height - declared) < 0.5 && copy.getBoundingClientRect().height <= declared;
  }));
}

test('a picker over hundreds of projects paints its final rows at once and renders only the rows in view', async ({ page }) => {
  await install(page, 300);
  const trigger = page.getByRole('button', { name: '项目筛选' });
  // Sample the panel on the very first animation frame after the click: rows already have their final size.
  await page.evaluate(() => {
    document.addEventListener('click', () => requestAnimationFrame(() => {
      const list = document.querySelector('[role="listbox"]');
      (window as any).__firstFrame = list ? [...list.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => Math.round(option.getBoundingClientRect().height) === Math.round(parseFloat(option.style.height))) : null;
    }), { once: true, capture: true });
  });
  await trigger.click();
  const list = page.getByRole('listbox', { name: '项目筛选' });
  await expect(list).toBeVisible();
  // The click and the visibility check can both resolve before the first animation frame runs.
  await expect.poll(() => page.evaluate(() => Array.isArray((window as any).__firstFrame))).toBe(true);
  const first = await page.evaluate(() => (window as any).__firstFrame as boolean[] | null);
  expect(first?.length).toBeGreaterThan(0);
  expect(first!.every(Boolean)).toBe(true);
  expect(await rowsSettled(page)).toBe(true);
  // 302 choices (all, global, 300 projects) but only a window of rows is in the DOM.
  const rendered = await list.getByRole('option').count();
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(60);
  // A long name stays on one ellipsized line and keeps its full name in the tooltip.
  const long = list.getByRole('option', { name: /示例项目的长名称/ });
  await expect(long).toHaveAttribute('title', /demo-module-7-示例项目的长名称与自动验证脚本测试/);
  // Keyboard reaches the end of the list: the last row is rendered, active and inside the viewport.
  await page.keyboard.press('End');
  const last = list.getByRole('option', { name: /demo-module-299\b/ });
  await expect(last).toHaveAttribute('data-active', 'true');
  expect(await last.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const view = node.parentElement!.getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  })).toBe(true);
  expect(await rowsSettled(page)).toBe(true);
  // Scrolling by hand moves the window as well.
  await list.evaluate((node) => { node.scrollTop = 48 * 150; node.dispatchEvent(new Event('scroll')); });
  await expect(list.getByRole('option', { name: /demo-module-150\b/ })).toBeVisible();
  // Search narrows hundreds in one step and names how many matched.
  await page.keyboard.press('Home');
  await page.getByRole('textbox', { name: /搜索/ }).last().fill('module-29');
  await expect(list.getByRole('option')).toHaveCount(11);
  await expect(page.getByText('11 项', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(trigger).toContainText('demo-module-290');
});

test('a short picker renders every option without windowing', async ({ page }) => {
  await install(page, 3);
  await page.getByRole('button', { name: '项目筛选' }).click();
  const list = page.getByRole('listbox', { name: '项目筛选' });
  await expect(list.getByRole('option')).toHaveCount(5);
  await expect(list).not.toHaveAttribute('data-virtual', /.*/);
  expect(await rowsSettled(page)).toBe(true);
});
