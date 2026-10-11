import { expect, test, type Locator, type Page } from '@playwright/test';

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
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap' || command === 'set_tool_icon') return bootstrap();
          if (command === 'set_theme') { theme = args.theme ?? theme; return bootstrap(); }
          if (command === 'list_cli_adapters') return adapters();
          if (command === 'set_registered_managed_tools') { managed = args.managedIds ?? managed; return adapters(); }
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

async function expectSearchStroke(page: Page, theme: 'light' | 'dark') {
  const icon = await searchStroke(page);
  expect(icon.token).toBe(theme === 'dark' ? '#98968e' : '#6e6a63');
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
  const glyph = await paint(page.locator('.nav button.active .nav-glyph'));
  expect(channels(glyph.color), JSON.stringify(glyph)).toBe(channels(glyph.accent));
  await nav.getByRole('button', { name: '设置' }).hover();
  await expectBodyText(nav.getByRole('button', { name: '设置' }).locator('.nav-text'));

  const rows = page.locator('[data-tool-row]');
  await expect(rows.getByRole('button', { name: '启动', exact: true }).first()).toBeVisible();
  await expect(rows.getByRole('button', { name: '重新检测', exact: true }).first()).toBeVisible();
  await expect(rows.getByRole('button', { name: '编辑配置 →', exact: true }).first()).toBeVisible();
  await expect(rows.getByRole('button', { name: '去安装 →', exact: true }).first()).toBeVisible();
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
  await expectSearchStroke(page, 'light');
  const card = page.getByRole('article').filter({ has: cardTitle });
  const cardActionHeights = await sharedHeights(card.locator('button:not([data-card-title])'));
  expect(cardActionHeights.length).toBeGreaterThan(1);
  expect(Math.max(...cardActionHeights) - Math.min(...cardActionHeights)).toBeLessThanOrEqual(1);
  const libraryControls = await sharedHeights(page.locator('input[aria-label="搜索资料"], button[aria-label="项目筛选"], button[aria-label="标签筛选"]'));
  expect(libraryControls.length).toBe(3);
  expect(Math.max(...libraryControls) - Math.min(...libraryControls)).toBeLessThanOrEqual(1);

  await nav.getByRole('button', { name: '使用记录' }).click();
  const selectedTitle = page.locator('[aria-current="true"] strong');
  await expect(selectedTitle).toHaveText(sessionTitle);
  await expectBodyText(selectedTitle);
  await selectedTitle.hover();
  await expectBodyText(selectedTitle);
  await expectBodyText(page.getByRole('heading', { level: 2, name: sessionTitle }));
  await expect(page.getByRole('button', { name: '在外部终端继续', exact: true })).toBeVisible();
  const recordControls = await sharedHeights(page.locator('input[aria-label="搜索会话"], button[aria-label="筛选工具"]'));
  expect(recordControls.length).toBe(2);
  expect(Math.max(...recordControls) - Math.min(...recordControls)).toBeLessThanOrEqual(1);

  await nav.getByRole('button', { name: '工具与连接' }).click();
  const list = page.getByRole('tablist', { name: 'CLI' });
  await expect(list.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();
  const fitted = await list.evaluate((root) => {
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      items: buttons.map((node) => {
        const box = node.getBoundingClientRect();
        return { name: node.textContent?.trim() ?? '', top: Math.round(box.top), clipped: node.scrollWidth > node.clientWidth + 1 };
      }),
    };
  });
  expect(fitted.items.map((item) => item.name)).toEqual(tools.map((item) => item[1]));
  expect(fitted.items.every((item) => !item.clipped)).toBe(true);
  expect(new Set(fitted.items.map((item) => item.top)).size).toBe(1);
  expect(fitted.scrollWidth).toBeGreaterThan(fitted.clientWidth);
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
  await expect(page.getByRole('button', { name: '更多（8）', exact: true })).toBeVisible();
  for (const name of ['Codex', 'Claude Code', 'Grok', 'Pi', 'OpenCode', 'ZCode', 'Qoder CN', 'Kimi Code']) {
    await expect(page.getByRole('checkbox', { name: new RegExp(name) })).toBeEnabled();
  }

  await page.getByRole('group', { name: '切换主题' }).getByRole('button', { name: '深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectBodyText(page.locator('.nav button.active .nav-text'));
  await nav.getByRole('button', { name: '资料库' }).click();
  await cardTitle.hover();
  await expectBodyText(cardTitle);
  await expectSearchStroke(page, 'dark');
  await nav.getByRole('button', { name: '使用记录' }).click();
  await expectBodyText(page.locator('[aria-current="true"] strong'));
  await expectBodyText(page.getByRole('heading', { level: 2, name: sessionTitle }));

  for (const width of [1360, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await nav.getByRole('button', { name: '快速开始' }).click();
    await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
    await expect(rows.getByRole('button', { name: '启动', exact: true }).first()).toBeVisible();
    await expect(rows.getByRole('button', { name: '编辑配置 →', exact: true }).first()).toBeVisible();
    await expect(rows.getByRole('button', { name: '去安装 →', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('group', { name: '切换主题' })).toBeVisible();
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '工具与连接' }).click();
    await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建配置', exact: true }).first()).toBeVisible();
    const narrowTabs = await list.evaluate((root) => {
      const buttons = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, tops: buttons.map((node) => Math.round(node.getBoundingClientRect().top)) };
    });
    expect(new Set(narrowTabs.tops).size).toBe(1);
    expect(narrowTabs.scrollWidth).toBeGreaterThan(narrowTabs.clientWidth);
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '资料库' }).click();
    await expect(page.getByRole('button', { name: '新建提示词', exact: true })).toBeVisible();
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '使用记录' }).click();
    if (width <= 760) await page.getByRole('button', { name: new RegExp(sessionTitle) }).click();
    await expect(page.getByRole('button', { name: '在外部终端继续', exact: true })).toBeVisible();
    await expectNoSideScroll(page);

    await nav.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('radiogroup', { name: '主题' })).toBeVisible();
    await expect(page.locator('.managed-checks input[type="checkbox"]').first()).toBeVisible();
    await expectNoSideScroll(page);
  }
});
