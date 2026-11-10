import { expect, test, type Locator, type Page } from '@playwright/test';
import { cliSwitcher } from './cli-switcher';

const tools = [
  ['codex', 'Codex', true],
  ['claude_code', 'Claude Code', true],
  ['grok', 'Grok', false],
  ['pi', 'Pi', true],
  ['open_code', 'OpenCode', false],
  ['zcode', 'ZCode', true],
  ['qoder_cn', 'Qoder CN', false],
  ['kimi_code', 'Kimi Code', true],
  ['deepseek', 'DeepSeek Harness', false],
  ['codebuddy', 'CodeBuddy', true],
  ['mimo_code', 'MiMo Code', false],
  ['cline', 'Cline', true],
  ['devin', 'Devin', false],
  ['command_code', 'Command Code', true],
  ['antigravity', 'Antigravity', false],
  ['kiro', 'Kiro', true],
] as const;

const promptTitle = '整理一份很长的发布说明';
const sessionTitle = '梳理配置继承与应用流程';

async function install(page: Page) {
  await page.addInitScript(({ catalog, promptTitle: prompt, sessionTitle: session }) => {
    let theme = 'light';
    let managed = catalog.map((item) => item[0]);
    // The shell test flips one managed-tool write to fail so the global error notice renders.
    const control = { failManaged: false };
    const profiles = Array.from({ length: 5 }, (_, index) => ({ id: `profile-${index}`, name: `日常配置 ${index + 1}`, version: 1, connection: null }));
    const library = [{ id: 'prompt-1', kind: 'prompt', title: prompt, body: '按用户能直接感受到的变化来写。', category: '写作', projectId: null, version: 1, updatedAt: 1790758800 }];
    const records = [{ id: 'session-1', toolId: 'codex', nativeId: '1111-2222', title: session, cwd: 'C:\\project', model: 'gpt-6-astra', projectId: null, startedAt: 1790751600000, updatedAt: 1790758800000, favorite: false, partial: false, stale: false, messageCount: 4, usageCount: 1 }];
    const bootstrap = () => ({
      preferences: { schema_version: 1, managed_tools: managed, theme, tool_icons: {} },
      tools: catalog.map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })),
    });
    const adapters = () => ({
      registered: catalog.map(([id, name]) => ({ id, name, interfaceFormats: ['openai_responses'], yoloAvailable: true, nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })),
      managedIds: managed,
      preservedUnknown: [],
    });
    const workspace = (toolId: string) => {
      const installed = catalog.find((item) => item[0] === toolId)?.[2];
      return {
        probe: { tool: toolId, selectedPath: installed ? '/fixture/cli' : null, installations: installed ? [{ path: '/fixture/cli', version: '1.0.0', status: 'available', source: 'native' }] : [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
        profiles: toolId === 'codex' ? profiles : [],
        binding: null,
        common: null,
        snapshots: [],
        recoveryNeeded: [],
        customPath: null,
      };
    };
    const usage = () => ({
      generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', previous: null, timeline: [],
      totals: { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 },
      byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0,
      partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans: [],
    });
    Object.assign(window, {
      isTauri: true,
      __uiPolish: control,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap' || command === 'set_tool_icon') return bootstrap();
          if (command === 'set_theme') { theme = args.theme ?? theme; return bootstrap(); }
          if (command === 'list_cli_adapters') return adapters();
          if (command === 'set_registered_managed_tools') {
            if (control.failManaged) throw { message: '管理列表没有保存', action: '请重试。' };
            managed = args.managedIds ?? managed;
            return adapters();
          }
          if (command === 'get_registered_tool_workspace') return workspace(args.toolId);
          if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history' || command === 'list_rule_placements' || command === 'list_accounts' || command === 'list_usage_queries' || command === 'list_usage_cache' || command === 'usage_presets' || command === 'list_mcp_definitions' || command === 'list_skill_packages') return [];
          if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          if (command === 'list_history_sessions') return records;
          if (command === 'get_history_session') return { session: records[0], messages: [{ id: 'm1', role: 'user', text: session, timestamp: 1790751600000 }], usage: [], resumeReason: null };
          if (command === 'copy_history_resume_command') return "Set-Location -LiteralPath 'C:\\project'; & 'codex' 'resume' '1111-2222'";
          if (command === 'get_usage_report') return usage();
          if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command.startsWith('plugin:event|')) return 1;
          return null;
        },
      },
    });
  }, { catalog: tools, promptTitle, sessionTitle });
}

function channels(color: string) {
  const hex = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return [0, 2, 4].map((index) => String(parseInt(hex[1].slice(index, index + 2), 16))).join(',');
  }
  return (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => String(Math.round(Number(part)))).join(',');
}

async function paint(locator: Locator) {
  return locator.evaluate((el) => {
    const root = getComputedStyle(document.documentElement);
    return {
      color: getComputedStyle(el).color,
      text: root.getPropertyValue('--text').trim(),
      accent: root.getPropertyValue('--accent').trim(),
    };
  });
}

async function expectBodyText(locator: Locator) {
  let last = '';
  await expect.poll(async () => {
    const color = await paint(locator);
    last = JSON.stringify(color);
    const current = channels(color.color);
    return current === channels(color.text) && current !== channels(color.accent);
  }, { message: () => last }).toBe(true);
}

async function searchStroke(page: Page) {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLElement>('.search-field > input');
    const token = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim().toLowerCase();
    const image = input ? getComputedStyle(input).backgroundImage : '';
    let decoded = image;
    try { decoded = decodeURIComponent(image); } catch { /* The computed URL is already decoded. */ }
    const match = decoded.match(/stroke=['"]#([0-9a-fA-F]{6})/i);
    return { stroke: match ? `#${match[1].toLowerCase()}` : '', token };
  });
}

async function expectSearchStroke(page: Page) {
  const icon = await searchStroke(page);
  expect(icon.stroke).toBe(icon.token);
}

async function expectNoSideScroll(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const main = document.getElementById('main');
    if (!main) return 'missing main';
    const mainOverflow = main.scrollWidth - main.clientWidth;
    const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
    if (mainOverflow <= 1 && docOverflow <= 1) return '';
    const rect = main.getBoundingClientRect();
    const wide = [...main.querySelectorAll<HTMLElement>('*')].flatMap((el) => {
      const box = el.getBoundingClientRect();
      if (box.width < 2 || (box.right <= rect.right + 1 && box.left >= rect.left - 1)) return [];
      const cls = [...el.classList].slice(0, 2).join('.');
      return [`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} ${Math.round(box.left)}..${Math.round(box.right)}`];
    }).slice(0, 8);
    return `main ${mainOverflow} doc ${docOverflow} ${wide.join(' | ')}`;
  })).toBe('');
}

async function sharedHeights(locator: Locator) {
  return locator.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
}

test('long labels, search icon, switcher, and the five pages stay quiet', async ({ page }) => {
  test.setTimeout(120_000);
  await install(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  const nav = page.getByRole('navigation', { name: '页面' });

  await expectBodyText(page.locator('.nav button.active .nav-text'));
  // The current page uses emerald ink on a raised paper chip (a hairline ring, no stripe) rather than a luminous icon tile.
  const glyph = await paint(page.locator('.nav button.active .nav-glyph'));
  expect(channels(glyph.color), JSON.stringify(glyph)).toBe(channels(glyph.accent));
  expect(await page.locator('.nav button.active .nav-glyph').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  const activeChip = await page.locator('.nav button.active').evaluate((el) => ({ shadow: getComputedStyle(el).boxShadow, background: getComputedStyle(el).backgroundColor, sidebar: getComputedStyle(el.closest('.sidebar')!).backgroundColor }));
  expect(activeChip.shadow).not.toContain('inset');
  expect(activeChip.shadow).toContain('0px 0px 0px 1px');
  expect(activeChip.background).not.toBe(activeChip.sidebar);
  await nav.getByRole('button', { name: '设置' }).hover();
  await expectBodyText(nav.getByRole('button', { name: '设置' }).locator('.nav-text'));

  const rows = page.locator('[data-tool-row]');
  // Only the tool in daily use (Codex has profiles) stays listed; the other fifteen fold behind one toggle.
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: '其他 15 个工具', exact: true }).click();
  await expect(rows).toHaveCount(tools.length);
  await expect(rows.getByRole('button', { name: '启动', exact: true }).first()).toBeVisible();
  await expect(rows.getByRole('button', { name: '重新检测', exact: true }).first()).toBeVisible();
  // A healthy row keeps 编辑配置 in its row menu; only a not-installed row shows 去安装 → inline.
  const codexRow = rows.filter({ hasText: 'Codex' });
  await expect(rows.getByRole('button', { name: '编辑配置 →', exact: true })).toHaveCount(0);
  await expect(rows.getByRole('button', { name: '去安装 →', exact: true }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'Grok' }).getByRole('button', { name: '去安装 →', exact: true })).toBeVisible();
  await expect(codexRow.getByRole('button', { name: '去安装 →', exact: true })).toHaveCount(0);
  await codexRow.getByRole('button', { name: 'Codex 的更多操作', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Codex 的更多操作' }).getByRole('menuitem', { name: '编辑配置', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Codex 的更多操作' })).toHaveCount(0);
  const edges = await rows.getByRole('button', { name: /^(启动|重新检测)$/ }).evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return `${Math.round(box.left)}-${Math.round(box.right)}`;
  }));
  expect(new Set(edges).size).toBe(1);
  const codexHeights = await sharedHeights(rows.filter({ hasText: 'Codex' }).locator('button:not([role="menuitem"])'));
  expect(codexHeights.length).toBeGreaterThan(2);
  expect(Math.max(...codexHeights) - Math.min(...codexHeights)).toBeLessThanOrEqual(1);

  await nav.getByRole('button', { name: '资料库' }).click();
  const cardTitle = page.getByRole('button', { name: promptTitle, exact: true });
  await expect(cardTitle).toBeVisible();
  await expectBodyText(cardTitle);
  await cardTitle.hover();
  await expectBodyText(cardTitle);
  await expect(page.getByRole('button', { name: '新建提示词', exact: true })).toBeVisible();
  await expectSearchStroke(page);
  const card = page.getByRole('article').filter({ has: cardTitle });
  const cardActionHeights = await sharedHeights(card.locator('button:not([data-card-title])'));
  expect(cardActionHeights.length).toBeGreaterThan(1);
  expect(Math.max(...cardActionHeights) - Math.min(...cardActionHeights)).toBeLessThanOrEqual(1);
  const libraryControls = await sharedHeights(page.locator('input[aria-label="搜索资料"], button[aria-label="项目筛选"], button[aria-label="标签筛选"]'));
  expect(libraryControls.length).toBe(3);
  expect(Math.max(...libraryControls) - Math.min(...libraryControls)).toBeLessThanOrEqual(1);

  await nav.getByRole('button', { name: '记录' }).click();
  const selectedTitle = page.locator('[aria-current="true"] strong');
  await expect(selectedTitle).toHaveText(sessionTitle);
  await expectBodyText(selectedTitle);
  await selectedTitle.hover();
  await expectBodyText(selectedTitle);
  await expectBodyText(page.getByRole('heading', { level: 2, name: sessionTitle }));
  await expect(page.getByRole('button', { name: '在外部终端继续', exact: true })).toBeVisible();
  const recordControls = await sharedHeights(page.locator('input[aria-label="搜索会话"]:visible, button[aria-label="筛选工具"]:visible'));
  expect(recordControls.length).toBe(2);
  expect(Math.max(...recordControls) - Math.min(...recordControls)).toBeLessThanOrEqual(1);

  await nav.getByRole('button', { name: '工具' }).click();
  // The page header names the current CLI and switches it; the sidebar keeps only the pages.
  const picker = cliSwitcher(page);
  await expect(picker).toHaveAccessibleName('Codex，切换 CLI');
  await expect(page.getByRole('heading', { level: 2, name: /^Codex/ })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'CLI' })).toHaveCount(0);
  await expect(nav.getByRole('button')).toHaveCount(6);
  await expectBodyText(picker.getByText('Codex', { exact: true }));
  const headingActions = await sharedHeights(page.getByRole('button', { name: /^(启动|通用配置|新建配置)$/ }));
  expect(headingActions.length).toBe(3);
  expect(Math.max(...headingActions) - Math.min(...headingActions)).toBeLessThanOrEqual(1);
  const profileName = page.getByRole('button', { name: '日常配置 1', exact: true });
  await profileName.hover();
  await expectBodyText(profileName);

  await nav.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('radiogroup', { name: '主题' })).toBeVisible();
  await expect(page.getByRole('group', { name: '切换主题' })).toBeVisible();
  await expect(page.locator('.managed-checks input[type="checkbox"]')).toHaveCount(8);
  await expect(page.getByRole('main').getByRole('button', { name: '更多（8）', exact: true })).toBeVisible();
  for (const name of ['Codex', 'Claude Code', 'Grok', 'Pi', 'OpenCode', 'ZCode', 'Qoder CN', 'Kimi Code']) {
    await expect(page.getByRole('checkbox', { name: new RegExp(name) })).toBeEnabled();
  }

  await page.getByRole('group', { name: '切换主题' }).getByRole('button', { name: '深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectBodyText(page.locator('.nav button.active .nav-text'));
  await nav.getByRole('button', { name: '资料库' }).click();
  await cardTitle.hover();
  await expectBodyText(cardTitle);
  await expectSearchStroke(page);
  await nav.getByRole('button', { name: '记录' }).click();
  await expectBodyText(page.locator('[aria-current="true"] strong'));
  await expectBodyText(page.getByRole('heading', { level: 2, name: sessionTitle }));

  for (const width of [1360, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await nav.getByRole('button', { name: '首页' }).click();
    await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
    await expect(rows.getByRole('button', { name: '启动', exact: true }).first()).toBeVisible();
    await expect(codexRow.getByRole('button', { name: 'Codex 的更多操作', exact: true })).toBeVisible();
    await expect(rows.getByRole('button', { name: '去安装 →', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('group', { name: '切换主题' })).toBeVisible();
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '工具' }).click();
    await expect(page.getByRole('heading', { name: '工具', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建配置', exact: true }).first()).toBeVisible();
    await expect(cliSwitcher(page)).toBeVisible();    expect(await page.getByLabel('主导航').evaluate((aside) => aside.scrollWidth - aside.clientWidth)).toBeLessThanOrEqual(0);
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '资料库' }).click();
    await expect(page.getByRole('button', { name: '新建提示词', exact: true })).toBeVisible();
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '记录' }).click();
    if (width <= 760) await page.getByRole('button', { name: new RegExp(sessionTitle) }).click();
    await expect(page.getByRole('button', { name: '在外部终端继续', exact: true })).toBeVisible();
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('radiogroup', { name: '主题' })).toBeVisible();
    await expect(page.locator('.managed-checks input[type="checkbox"]').first()).toBeVisible();
    await expectNoSideScroll(page);
  }
});

/**
 * Resolved ink/surface tokens with their WCAG contrast, the shell's resting elevation and the
 * flat canvas. One block keeps every layer check in the same unit as the design tokens.
 */
async function shellInk(page: Page, selectors: string[]) {
  return page.evaluate((list) => {
    const resolve = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r, g, b] = channels(color).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + 0.05) / (dark + 0.05);
    };
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => resolve(root.getPropertyValue(name).trim());
    const ink: Record<string, string> = { text: token('--text'), 'text-2': token('--text-2'), 'text-3': token('--text-3') };
    const surfaces: Record<string, string> = { bg: token('--bg'), sidebar: token('--sidebar'), surface: token('--surface') };
    const ratios: Record<string, number> = {};
    for (const [inkName, inkColor] of Object.entries(ink)) {
      for (const [surfaceName, surfaceColor] of Object.entries(surfaces)) {
        ratios[`${inkName}/${surfaceName}`] = ratio(inkColor, surfaceColor);
      }
    }
    // Resolve the elevation tokens the same way the browser serialises a computed shadow.
    const shadowToken = (name: string) => {
      const probe = document.createElement('span');
      probe.style.boxShadow = `var(${name})`;
      document.body.append(probe);
      const shadow = getComputedStyle(probe).boxShadow;
      probe.remove();
      return shadow;
    };
    const softShadows = new Set([shadowToken('--shadow-xs'), shadowToken('--shadow-sm')]);
    const elevation = list.map((selector) => {
      const node = document.querySelector<HTMLElement>(selector);
      const shadow = node ? getComputedStyle(node).boxShadow : 'missing';
      return { selector, shadow, soft: shadow === 'none' || softShadows.has(shadow) };
    });
    return {
      ratios,
      layers: [surfaces.bg, surfaces.sidebar, surfaces.surface],
      elevation,
      canvasImage: getComputedStyle(document.querySelector('.content')!).backgroundImage,
    };
  }, selectors);
}

/** The shared notice geometry: one radius, one padding, one hairline in the tone, one soft tone wash. */
async function noticeShape(locator: Locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    return {
      radius: style.borderTopLeftRadius,
      radiusToken: root.getPropertyValue('--radius-lg').trim(),
      padTop: style.paddingTop,
      padLeft: style.paddingLeft,
      fontSize: style.fontSize,
      edge: style.borderLeftWidth,
      edgeColor: style.borderLeftColor,
      image: style.backgroundImage,
    };
  });
}

test('shell and shared feedback keep readable ink, three layers, flat controls and one notice shape', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await install(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  const nav = page.getByRole('navigation', { name: '页面' });
  // Quiet Studio controls are flat; the active page uses a wash and inset marker.
  const quietControls = ['.sidebar-command', '.theme-switch button:not([aria-pressed="true"])', '[data-variant="secondary"]'];

  const themeSwitch = page.getByRole('group', { name: '切换主题' });
  for (const [label, attribute] of [['浅色主题', 'light'], ['深色主题', 'dark']] as const) {
    await themeSwitch.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', attribute);
    const ink = await shellInk(page, quietControls);
    for (const [pair, value] of Object.entries(ink.ratios)) {
      expect(value, `${attribute} ${pair}`).toBeGreaterThanOrEqual(4.5);
    }
    // Frame, canvas and paper stay three distinct mineral layers in both themes.
    expect(new Set(ink.layers).size, attribute).toBe(3);
    for (const item of ink.elevation) expect(item.shadow, `${attribute} ${item.selector}`).toBe('none');
    expect(ink.canvasImage, attribute).toBe('none');
    expect(await page.locator('.nav button.active').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  }

  // A failed write raises the one global notice: same shape as the environment notice, tone only.
  await page.evaluate(() => { (window as unknown as { __uiPolish: { failManaged: boolean } }).__uiPolish.failManaged = true; });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  const managed = page.locator('.managed-checks input[type="checkbox"]').first();
  await expect(managed).toBeEnabled();
  await managed.click();
  const error = page.locator('.error-banner');
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('role', 'alert');
  const failure = await noticeShape(error);
  expect(failure.radius).toBe(failure.radiusToken);
  expect(failure.image).toBe('none');
  expect(failure.edge).toBe('3px');

  // Browser preview has no native storage, so the shell adds its environment notice there.
  const previewContext = await browser.newContext({ locale: 'zh-CN', reducedMotion: 'reduce' });
  const preview = await previewContext.newPage();
  await preview.goto(new URL('/', page.url()).href);
  const environment = preview.locator('.environment-banner');
  await expect(environment).toContainText('浏览器预览');
  const previewNotice = await noticeShape(environment);
  await previewContext.close();

  expect(previewNotice.radius).toBe(failure.radius);
  expect(previewNotice.padTop).toBe(failure.padTop);
  expect(previewNotice.padLeft).toBe(failure.padLeft);
  expect(previewNotice.fontSize).toBe(failure.fontSize);
  expect(previewNotice.edge).toBe(failure.edge);
  expect(previewNotice.image).toBe('none');
  expect(previewNotice.edgeColor).not.toBe(failure.edgeColor);

  // R6: interactive icon controls and menu items meet the 24x24 CSS px minimum target size.
  const targetBoxes = await page.evaluate(() => {
    const selectors = ['.sidebar-toggle', '.sidebar-command', '.theme-switch button', '.nav button', '.error-banner button'];
    return selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { selector, width: Math.round(rect.width), height: Math.round(rect.height) };
      }));
  });
  expect(targetBoxes.length).toBeGreaterThan(5);
  for (const box of targetBoxes) {
    expect(box.width, `${box.selector} width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `${box.selector} height`).toBeGreaterThanOrEqual(24);
  }
});

test('workbench session rail rows stay free of reorder arrows; drag and the keyboard reorder', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions = [
      { id: 's1', toolId: 'codex', projectId: null, directory: 'C:/alpha', mode: 'normal', running: true, exitCode: null },
      { id: 's2', toolId: 'claude_code', projectId: null, directory: 'D:/beta', mode: 'normal', running: true, exitCode: null },
    ];
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light' }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') return btoa('ready');
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command.startsWith('plugin:event|')) return 1;
          return [];
        },
      },
    });
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const railList = page.getByRole('tablist', { name: '会话列表' });
  const codex = railList.getByRole('tab', { name: /Codex/ });
  const codexRow = codex.locator('..');
  await expect(railList.getByRole('tab').first()).toHaveText(/Codex/);
  await codex.hover();
  // Hover shows only the row menu (and close for an ended session): no move arrows over the title.
  await expect(codexRow.getByRole('button', { name: /上移会话|下移会话/ })).toHaveCount(0);
  await expect(codexRow.getByRole('button', { name: /会话操作/ })).toBeVisible();
  await codex.focus();
  await page.keyboard.press('Alt+Shift+ArrowDown');
  await expect(railList.getByRole('tab').first()).toHaveText(/Claude Code/);
  await page.keyboard.press('Alt+Shift+ArrowUp');
  await expect(railList.getByRole('tab').first()).toHaveText(/Codex/);
});
