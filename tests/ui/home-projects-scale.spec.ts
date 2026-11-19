import { expect, test, type Page } from '@playwright/test';

/** Hundreds of standalone directories on the home page. */
async function install(page: Page, count = 300) {
  await page.addInitScript((total) => {
    const tools = ['codex', 'claude_code', null];
    const projects = Array.from({ length: total }, (_, index) => ({
      id: `p${index}`,
      name: index === 3 ? 'zz-最长的项目名称-栖点桌面工具远程开发环境主仓库与发布脚本与更多说明' : `service-${String(index).padStart(3, '0')}`,
      path: `/Users/dev/work/group${index % 7}/service-${index}`,
      available: index !== 5,
      preferredTool: tools[index % 3],
      // Most recent first: p0 was opened last.
      lastOpened: 1790758800 - index * 60,
      modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {},
    }));
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }, { id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }, { id: 'claude_code', name: 'Claude Code', interfaceFormats: [] }], managedIds: ['codex', 'claude_code'], preservedUnknown: [] };
        if (command === 'list_projects') return projects;
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('plugin:event|')) return 1;
        if (command.startsWith('list_')) return [];
        return null;
      },
    };
  }, count);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
}

test('hundreds of directories render as one compact page, grow on demand and never scroll sideways', async ({ page }) => {
  await install(page);
  const launcher = page.getByRole('region', { name: '项目与启动' });
  const rows = launcher.locator('[data-project-id]');
  await expect(rows).toHaveCount(12);
  // Most recently used first.
  await expect(rows.first()).toHaveAttribute('data-project-id', 'p0');
  // Compact rows of one height, each with exactly one primary launch.
  const heights = await rows.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  expect(Math.max(...heights)).toBeLessThanOrEqual(64);
  for (const row of await rows.all()) await expect(row.locator('[data-variant="primary"]')).toHaveCount(1);
  // A long name stays on one line inside its row and keeps the full name in its tooltip.
  const long = rows.filter({ hasText: '最长的项目名称' }).locator('strong').first();
  expect(await long.evaluate((node) => node.getBoundingClientRect().height < 26 && node.getBoundingClientRect().right <= node.closest('[data-project-id]')!.getBoundingClientRect().right)).toBe(true);
  await expect(long).toHaveAttribute('title', /^zz-最长的项目名称/);
  await launcher.getByRole('button', { name: '显示更多 · 还有 288 个', exact: true }).click();
  await expect(rows).toHaveCount(60);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // Every word must match the name or path; the page limit applies again to the matches.
  await launcher.getByRole('textbox', { name: '搜索项目' }).fill('group3 service-1');
  await expect(rows.first()).toBeVisible();
  const paths = await rows.evaluateAll((nodes) => nodes.map((node) => node.querySelector('[class*="cardPath"]')!.textContent ?? ''));
  expect(paths.length).toBeGreaterThan(1);
  expect(paths.length).toBeLessThanOrEqual(12);
  expect(paths.every((path) => path.includes('group3/service-1'))).toBe(true);
});

test('pins lead the list across reloads, name order is one click and attention filters what needs a look', async ({ page }) => {
  await install(page);
  const launcher = page.getByRole('region', { name: '项目与启动' });
  const rows = launcher.locator('[data-project-id]');
  await expect(rows).toHaveCount(12);
  // Pin a row from further down; it moves to the top and stays there after a reload.
  await launcher.getByRole('button', { name: '置顶 service-011', exact: true }).click();
  await expect(rows.first()).toHaveAttribute('data-project-id', 'p11');
  await expect(rows.first()).toHaveAttribute('data-pinned', 'true');
  await page.reload();
  await expect(rows.first()).toHaveAttribute('data-project-id', 'p11');
  await expect(launcher.getByRole('button', { name: '取消置顶 service-011', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Name order keeps the pin first, then sorts the rest by name.
  await launcher.getByRole('radio', { name: '名称', exact: true }).click();
  await expect(rows.first()).toHaveAttribute('data-project-id', 'p11');
  await expect(rows.nth(1)).toHaveAttribute('data-project-id', 'p0');
  await expect(rows.nth(2)).toHaveAttribute('data-project-id', 'p1');
  // 需处理: no tool (every third) or a missing directory.
  const attention = launcher.getByRole('button', { name: /^需处理 \d+$/ });
  await expect(attention).toHaveText('需处理 100');
  await attention.click();
  await expect(attention).toHaveAttribute('aria-pressed', 'true');
  for (const row of await rows.all()) {
    const missing = await row.getAttribute('data-unavailable');
    const noTool = await row.locator('[data-missing]').count();
    expect(!!missing || noTool > 0).toBe(true);
  }
  await expect(launcher.locator('[data-project-id="p5"]')).toContainText('目录失效');
  await attention.click();
  await launcher.getByRole('button', { name: '取消置顶 service-011', exact: true }).click();
  await expect(rows.first()).toHaveAttribute('data-project-id', 'p0');
});
