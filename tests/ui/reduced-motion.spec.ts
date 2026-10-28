import { expect, test, type Locator, type Page } from '@playwright/test';

// R1: with reduced motion requested, dialogs and page switches no longer animate (02 ADR-7).
// The suite default is reducedMotion 'reduce', so each test sets the preference explicitly.

async function install(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], resume: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
      if (command === 'get_usage_report') return {
        generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', previous: null, timeline: [],
        totals: { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 },
        byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0,
        partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans: [],
      };
      if (command === 'refresh_history') return [];
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_') || command === 'usage_presets') return [];
      return null;
    } } });
  });
}

/** Longest animation and transition duration of an element, in milliseconds. */
async function motion(locator: Locator) {
  return locator.evaluate((el) => {
    const longest = (value: string) => Math.max(0, ...value.split(',').map((part) => {
      const text = part.trim();
      return text.endsWith('ms') ? parseFloat(text) : parseFloat(text) * 1000;
    }));
    const style = getComputedStyle(el);
    return { animationName: style.animationName, animation: longest(style.animationDuration), transition: longest(style.transitionDuration) };
  });
}

async function openShortcutHelp(page: Page) {
  await page.locator('#main').focus();
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: '键盘快捷键' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const pageContainer = (page: Page) => page.locator('.content-inner > :not(.environment-banner, .error-banner, .status-banner, .empty-state)').first();

test('without a motion preference the dialog and page switch animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await install(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  const dialog = await openShortcutHelp(page);
  const opened = await motion(dialog);
  expect(opened.animationName).not.toBe('none');
  expect(opened.animation).toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资料库', level: 1 })).toBeVisible();
  expect((await motion(pageContainer(page))).animation).toBeGreaterThan(100);
});

test('reduced motion stops dialog, page and control motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  const dialog = await openShortcutHelp(page);
  const opened = await motion(dialog);
  expect(opened.animation, JSON.stringify(opened)).toBeLessThanOrEqual(0.01);
  expect(opened.transition, JSON.stringify(opened)).toBeLessThanOrEqual(0.01);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  const nav = page.getByRole('navigation', { name: '页面' });
  for (const name of ['资料库', '使用记录', '设置', '工具与连接']) {
    await nav.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    const switched = await motion(pageContainer(page));
    expect(switched.animation, `${name} ${JSON.stringify(switched)}`).toBeLessThanOrEqual(0.01);
  }
  // Controls keep their hover/press states but drop the transition time.
  const button = nav.getByRole('button', { name: '快速开始', exact: true });
  expect((await motion(button)).transition).toBeLessThanOrEqual(0.01);
  const primary = page.locator('[data-variant="primary"]').first();
  await expect(primary).toBeVisible();
  expect((await motion(primary)).transition).toBeLessThanOrEqual(0.01);
});
