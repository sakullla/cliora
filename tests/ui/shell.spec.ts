import { expect, test, type Locator, type Page } from '@playwright/test';

const pageNames = ['快速开始', '工作台', '工具与连接', '资料库', '使用记录', '设置'] as const;

async function expectPageLanded(page: Page, name: (typeof pageNames)[number]) {
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const root = document.documentElement;
    const main = document.querySelector('main.content');
    const docOverflow = root.scrollWidth - window.innerWidth;
    const mainOverflow = main ? main.scrollWidth - main.clientWidth : 0;
    if (docOverflow <= 0 && mainOverflow <= 0) return '';
    const mainRect = main?.getBoundingClientRect();
    const wide = main ? [...main.querySelectorAll<HTMLElement>('*')].flatMap((el) => {
      const rect = el.getBoundingClientRect();
      if (!mainRect || rect.width < 2 || (rect.right <= mainRect.right + 1 && rect.left >= mainRect.left - 1)) return [];
      const cls = [...el.classList].slice(0, 2).join('.');
      return [`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} ${Math.round(rect.left)}..${Math.round(rect.right)}`];
    }).slice(0, 8) : [];
    return `doc ${docOverflow} main ${mainOverflow} ${wide.join(' | ')}`;
  })).toBe('');
}

async function expectFullyInFirstScreen(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  await expect.poll(() => page.locator('main.content').evaluate((el) => el.scrollTop)).toBe(0);
}

async function installDesktop(page: Page, projects: unknown[] = []) {
  await page.addInitScript((seed) => {
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', pi: 'Pi', open_code: 'OpenCode' };
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const workspace = () => ({
      probe: {
        selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' },
        interfaceFormats: [], installUrl: '', upgradeHint: '', dependencies: [], installCommand: null, upgradeCommand: null, providerPresets: [],
      },
      profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    const usage = () => ({
      generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', previous: null, timeline: [],
      totals: { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 },
      byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0,
      partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans: [],
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'system' }, tools };
          if (command === 'list_cli_adapters') return {
            registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, launch: { state: 'planned', reason: '' }, resume: { state: 'planned', reason: '' }, resources: { state: 'planned', reason: '' }, history: { state: 'planned', reason: '' } })),
            managedIds: Object.keys(names), preservedUnknown: [],
          };
          if (command === 'get_registered_tool_workspace') return workspace();
          if (command === 'list_projects') return seed;
          if (command === 'list_library_items' || command === 'list_history_sessions' || command === 'list_history_prices' || command === 'refresh_history' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp' || command === 'list_portable_items') return [];
          if (command === 'get_usage_report') return usage();
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return () => {};
          return null;
        },
      },
    });
  }, projects);
}

test('full pages are navigable and browser mode never implies native data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('浏览器预览');
  // The skip link is the first Tab stop: invisible for mouse users, visible under keyboard
  // focus, and Enter hands focus to the main region.
  const skip = page.getByRole('link', { name: '跳到主内容' });
  await expect(skip).toHaveCSS('opacity', '0');
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await expect(page.locator('#main')).toHaveAttribute('tabindex', '-1');
  // After the skip link, focus lands on the collapse control, then quick jump, then the page list.
  await page.reload();
  // Wait for the app to mount again before tabbing: keys pressed mid-mount reset focus.
  await expect(page.getByRole('status')).toContainText('浏览器预览');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '折叠侧栏', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /快速前往/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' })).toBeFocused();
  await expect(page.locator('.brandmark')).toBeVisible();
  await expect(page.locator('.brandmark')).toHaveAttribute('src', /128x128/);
  for (const name of ['快速开始', '工作台', '工具与连接', '资料库', '使用记录', '设置']) {
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name }).click();
    await expectPageLanded(page, name);
  }
  await expect(page.getByRole('checkbox').first()).toBeDisabled();
  await expect(page.locator('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 760 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('native settings result drives the home list and empty management stays recoverable', async ({ page }) => {
  await page.addInitScript(() => {
    let managed = ['codex', 'claude_code', 'grok', 'pi', 'open_code'];
    let theme = 'system';
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', pi: 'Pi', open_code: 'OpenCode' };
    const bootstrap = () => ({
      preferences: { schema_version: 1, managed_tools: managed, theme },
      tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })),
    });
    const catalog = () => ({
      registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, launch: { state: 'planned', reason: '' }, resume: { state: 'planned', reason: '' }, resources: { state: 'planned', reason: '' }, history: { state: 'planned', reason: '' } })),
      managedIds: managed, preservedUnknown: [],
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { managedIds?: string[]; theme?: string } = {}) => {
          if (command === 'set_registered_managed_tools') { managed = args.managedIds ?? managed; return catalog(); }
          if (command === 'set_theme') theme = args.theme ?? theme;
          if (command === 'list_cli_adapters') return catalog();
          if (command === 'list_projects') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_registered_tool_workspace') return {
            probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' } },
            profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
          };
          return bootstrap();
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  for (const name of ['Codex', 'Claude Code', 'Grok', 'Pi', 'OpenCode']) {
    await page.getByRole('checkbox', { name: new RegExp(name) }).uncheck();
  }
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(page.getByText('尚未管理工具')).toBeVisible();
  await page.getByRole('button', { name: '前往设置' }).click();
  await page.getByRole('checkbox', { name: /Codex/ }).check();
  const themes = page.getByRole('radiogroup', { name: '主题' });
  await themes.getByRole('radio', { name: '浅色' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(themes.getByRole('radio', { name: '深色' })).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(page.getByRole('button', { name: '去安装 →' })).toHaveCount(1);
  await expect(page.locator('[aria-label="管理中的工具"]')).toContainText('Codex');
});

test('settings default YOLO mode launches both a CLI and a project', async ({ page }) => {
  await page.addInitScript(() => {
    const requests: unknown[] = [];
    let modes = { cliMode: 'normal', projectMode: 'normal' };
    const workspace = (path: string) => ({
      probe: { selectedPath: path, installations: [{ path, version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' } },
      profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    const settings = () => ({ selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], ...modes });
    Object.assign(window, {
      isTauri: true,
      __launchRequests: requests,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: { target?: 'cli' | 'project'; mode?: string; request?: { mode: string } } = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['grok', 'pi'], theme: 'system' }, tools: [{ id: 'grok', name: 'Grok' }, { id: 'pi', name: 'Pi' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok', interfaceFormats: [], yoloAvailable: true }, { id: 'pi', name: 'Pi', interfaceFormats: [], yoloAvailable: false }], managedIds: ['grok', 'pi'], preservedUnknown: [] };
        if (command === 'list_projects') return [
          { id: 'desk', name: '栖点', path: 'C:/Projects/cliora', available: true, preferredTool: 'grok', lastOpened: 2, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} },
          { id: 'notes', name: '笔记', path: 'C:/Projects/notes', available: true, preferredTool: 'pi', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} },
        ];
        if (command === 'get_registered_tool_workspace') return workspace(args && 'toolId' in args ? 'C:/tool.cmd' : 'C:/tool.cmd');
        if (command === 'get_launch_settings') return settings();
        if (command === 'set_default_launch_mode') { if (args.target === 'cli' || args.target === 'project') modes = { ...modes, [args.target === 'cli' ? 'cliMode' : 'projectMode']: args.mode }; return settings(); }
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:dialog|open') return 'C:/chosen';
        if (command === 'launch_cli') { requests.push(args.request); return { mode: args.request?.mode, status: 'terminal_requested' }; }
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const projects = page.getByRole('region', { name: '项目与启动' });
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toHaveCount(2);
  await expect(projects.getByRole('button', { name: '启动', exact: true })).toHaveCount(2);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await page.getByRole('combobox', { name: 'CLI 默认启动模式' }).selectOption('yolo');
  await page.getByRole('combobox', { name: '项目默认启动模式' }).selectOption('yolo');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toHaveCount(2);
  await expect(projects.getByRole('button', { name: '启动', exact: true })).toHaveCount(2);
  const toolLaunch = tools.getByRole('button', { name: '启动', exact: true });
  const projectLaunch = projects.getByRole('button', { name: '启动', exact: true });
  await toolLaunch.nth(0).click();
  await toolLaunch.nth(1).click();
  await projectLaunch.nth(0).click();
  await projectLaunch.nth(1).click();
  const requests = await page.evaluate(() => (window as typeof window & { __launchRequests: Array<Record<string, unknown>> }).__launchRequests);
  expect(requests).toEqual([
    { toolId: 'grok', projectId: null, sessionId: null, mode: 'yolo', directory: 'C:/chosen' },
    { toolId: 'pi', projectId: null, sessionId: null, mode: 'normal', directory: 'C:/chosen' },
    { toolId: 'grok', projectId: 'desk', sessionId: null, mode: 'yolo', directory: null },
    { toolId: 'pi', projectId: 'notes', sessionId: null, mode: 'normal', directory: null },
  ]);
});

test('home resumes with native session ID and explicit normal or YOLO mode', async ({ page }) => {
  await page.addInitScript(() => {
    const requests: unknown[] = [];
    Object.assign(window, {
      isTauri: true,
      __launchRequests: requests,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: { request?: { mode: string } } = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['grok'], theme: 'system' }, tools: [{ id: 'grok', name: 'Grok', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok', interfaceFormats: [], yoloAvailable: true, resume: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['grok'], preservedUnknown: [] };
        if (command === 'list_projects') return [];
        if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        if (command === 'launch_cli') { requests.push(args.request); return { mode: args.request?.mode, status: 'terminal_requested' }; }
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
  await page.goto('/');
  await page.getByText('恢复指定会话', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '恢复会话 ID' })).toBeVisible();
  await page.getByRole('textbox', { name: '恢复会话 ID' }).fill('session-中文 1');
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByRole('button', { name: 'YOLO 恢复' }).click();
  const requests = await page.evaluate(() => (window as typeof window & { __launchRequests: Array<Record<string, unknown>> }).__launchRequests);
  expect(requests).toEqual([
    { toolId: 'grok', projectId: null, sessionId: 'session-中文 1', mode: 'normal', directory: null },
    { toolId: 'grok', projectId: null, sessionId: 'session-中文 1', mode: 'yolo', directory: null },
  ]);
});

test('storage failure preserves an actionable page and retry loads repaired data', { tag: '@integration' }, async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__storageRepaired = false;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'list_projects') return [];
        if (command === 'get_bootstrap') {
          if (!(window as any).__storageRepaired) throw { code: 'storage_unavailable', message: '无法打开本机数据库', action: '先备份原数据库，再检查磁盘和权限；修复后点击重试。', data_directory: 'C:\\Users\\test\\AppData\\Roaming\\Cliora' };
        }
        if (command === 'list_cli_adapters') return {
          registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }],
          managedIds: ['codex'], preservedUnknown: [],
        };
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' } },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        return {
          preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' },
          tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }],
        };
      } },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('无法打开本机数据库');
  await expect(page.getByRole('alert')).toContainText('C:\\Users\\test');
  await expect(page.getByText('暂时无法读取本机资料')).toBeVisible();
  await expect(page.locator('.tool-row')).toHaveCount(0);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate(() => { (window as any).__storageRepaired = true; });
  await page.getByRole('button', { name: '重试读取' }).click();
  await expect(page.getByRole('checkbox', { name: /Codex/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});


test('custom tool icons persist across reload, preserve theme and management, and reset across pages', async ({ page }) => {
  await page.addInitScript(() => {
    const read = () => JSON.parse(localStorage.getItem('icon-preferences') ?? '{"schema_version":1,"managed_tools":["codex"],"theme":"dark","tool_icons":{}}');
    const bootstrap = () => ({ preferences: read(), tools: [{ id: 'codex', name: 'Codex' }] });
    Object.assign(window, { isTauri: true, __iconCalls: [], __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      (window as any).__iconCalls.push({ command, args });
      if (command === 'get_bootstrap') return bootstrap();
      if (command === 'set_tool_icon' || command === 'set_theme') {
        const next = read();
        if (command === 'set_theme') next.theme = args.theme;
        else if (args.dataUrl) next.tool_icons[args.toolId] = args.dataUrl;
        else delete next.tool_icons[args.toolId];
        localStorage.setItem('icon-preferences', JSON.stringify(next));
        return bootstrap();
      }
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }], managedIds: read().managed_tools, preservedUnknown: [] };
      if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
      if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: 'C:/codex.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' }, profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command === 'plugin:dialog|open') return 'C:/chosen project';
      if (command === 'launch_cli') return { mode: args.request.mode, status: 'terminal_requested' };
      throw new Error(`Unexpected IPC: ${command}`);
    } } });
  });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  const logo = page.getByLabel('管理中的工具').locator('img').first();
  await expect(logo).toBeVisible();
  const defaultSource = await logo.getAttribute('src');
  await page.getByRole('button', { name: '启动', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__iconCalls)).find((call: any) => call.command === 'launch_cli').args.request).toMatchObject({ mode: 'normal', sessionId: null, projectId: null, directory: 'C:/chosen project' });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('自定义工具图标', { exact: true }).click();
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2kAAAAASUVORK5CYII=';
  await page.getByLabel('Codex 自定义图标').setInputFiles({ name: 'custom.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
  await expect(page.locator('.managed-checks img')).toHaveAttribute('src', `data:image/png;base64,${base64}`);
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '浅色' }).click();
  await nav.getByRole('button', { name: '工具与连接' }).click();
  await expect(page.locator('[data-workspace-chrome] h2 img').first()).toHaveAttribute('src', `data:image/png;base64,${base64}`);
  await page.reload();
  await expect(logo).toHaveAttribute('src', `data:image/png;base64,${base64}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked();
  await page.getByText('自定义工具图标', { exact: true }).click();
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await nav.getByRole('button', { name: '快速开始' }).click();
  await expect(logo).toHaveAttribute('src', defaultSource!);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('home switches the active configuration from the tool row', async ({ page }) => {
  await page.addInitScript(() => {
    const applied = { codex: 'daily' };
    const profiles = [
      { id: 'daily', tool: 'codex', name: '日常', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5' } },
      { id: 'work', tool: 'codex', name: '工作', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5-codex' } },
    ];
    Object.assign(window, {
      isTauri: true,
      __switchCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, string> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') {
          const profile = profiles.find((item) => item.id === applied.codex);
          return { probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' }, profiles, binding: { scopeKey: 'global', tool: 'codex', profileId: applied.codex, profileVersion: profile?.version ?? 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        }
        if (command === 'apply_registered_native_profile') { (window as unknown as { __switchCalls: unknown[] }).__switchCalls.push(args); applied.codex = args.profileId; return { applications: [] }; }
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
  await page.goto('/');
  const group = page.getByRole('radiogroup', { name: '切换Codex的配置' });
  await expect(group.getByRole('radio', { name: '日常' })).toHaveAttribute('aria-checked', 'true');
  await group.getByRole('radio', { name: '工作' }).click();
  await expect(group.getByRole('radio', { name: '工作' })).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio', { name: '日常' })).toHaveAttribute('aria-checked', 'false');
  const calls = await page.evaluate(() => (window as unknown as { __switchCalls: Array<Record<string, unknown>> }).__switchCalls);
  expect(calls[0]).toMatchObject({ toolId: 'codex', profileId: 'work', scope: 'global', allowTakeover: false });
});

test('browser preview keeps every page reachable at 640 and does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 768 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  const status = page.locator('.sidebar-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveText('浏览器预览');
  await expect(status).not.toContainText('本机资料');
  const statusBox = await status.boundingBox();
  expect(statusBox).not.toBeNull();
  expect(statusBox!.x).toBeGreaterThanOrEqual(0);
  expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(640 + 1);
  for (const name of pageNames) {
    const button = nav.getByRole('button', { name });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(36);
    await button.click();
    await expectPageLanded(page, name);
    await expect(status).toBeVisible();
  }
  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: 768 });
    for (const name of pageNames) {
      await nav.getByRole('button', { name }).click();
      await expectPageLanded(page, name);
      await expectNoHorizontalScroll(page);
    }
  }
});

test('desktop shell keeps on-device copy, first-screen actions, and no sideways scroll', async ({ page }) => {
  await installDesktop(page);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  const status = page.locator('.sidebar-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveText('本机资料 · 仅存于此设备');
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '设置' }).click();
  await expectFullyInFirstScreen(page, page.getByRole('heading', { name: '管理的 CLI' }));
  await nav.getByRole('button', { name: '资料库' }).click();
  await expectFullyInFirstScreen(page, page.getByRole('button', { name: '新建提示词', exact: true }));
  await nav.getByRole('button', { name: '使用记录' }).click();
  const search = page.getByRole('textbox', { name: '搜索会话' });
  const sessions = page.getByRole('tab', { name: '会话' });
  await expect(search.or(sessions).first()).toBeVisible();
  if (await search.isVisible()) await expectFullyInFirstScreen(page, search);
  else await expectFullyInFirstScreen(page, sessions);
  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: width === 640 ? 760 : 768 });
    for (const name of pageNames) {
      const button = nav.getByRole('button', { name });
      await button.click();
      await expectPageLanded(page, name);
      await expect(status).toHaveText('本机资料 · 仅存于此设备');
      await expectNoHorizontalScroll(page);
    }
  }
  await expect(status).toHaveText('本机资料 · 仅存于此设备');
  const narrowBox = await status.boundingBox();
  expect(narrowBox).not.toBeNull();
  expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(640 + 1);
});



test('sidebar collapse preserves navigation and records use the wide viewport', async ({ page }) => {
  await installDesktop(page);
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/');
  const sidebar = page.getByLabel('主导航');
  await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 999).toBeLessThan(80);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '使用记录', exact: true })).toBeVisible();
  expect((await page.locator('.content-inner').boundingBox())!.width).toBeGreaterThan(2400);
  await expectNoHorizontalScroll(page);
  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '折叠侧栏', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(180);
  await page.setViewportSize({ width: 640, height: 760 });
  await expectNoHorizontalScroll(page);
});

test('quick jump sits above the page list and leaves the sidebar footer to theme and status', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  const jump = page.getByRole('button', { name: /快速前往/ });
  const nav = page.getByRole('navigation', { name: '页面' });
  const foot = page.locator('.sidebar-foot');
  await expect(jump).toBeVisible();
  await expect(foot).not.toContainText('快速前往');
  const jumpBox = await jump.boundingBox();
  const navBox = await nav.boundingBox();
  expect(jumpBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(jumpBox!.y + jumpBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  await jump.click();
  const dialog = page.getByRole('dialog', { name: '快速前往' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  await expect(jump).toBeVisible();
  const collapsed = await jump.boundingBox();
  expect(collapsed).not.toBeNull();
  expect(collapsed!.width).toBeLessThanOrEqual(48);
  expect(collapsed!.height).toBeLessThanOrEqual(48);

  await page.setViewportSize({ width: 640, height: 760 });
  await expect(jump).toBeHidden();
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: '快速前往' })).toBeVisible();
});

test('command palette jumps between pages and the sidebar shortcut collapses navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: '快速前往' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('设置');
  await dialog.getByRole('option', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await expect(page.locator('dialog')).toHaveCount(0);

  await page.keyboard.press('Control+K');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('没有这个页面');
  await expect(dialog.getByRole('status')).toContainText('没有匹配');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);

  await page.keyboard.press('Control+K');
  await dialog.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('资料库');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '资料库', level: 1 })).toBeVisible();

  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '键盘快捷键', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toContainText('快速前往');
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toContainText(/\+1…6/);
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).not.toContainText('侧栏工具列表');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Backslash');
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Backslash');
  await expect(page.getByRole('button', { name: '折叠侧栏', exact: true })).toBeVisible();
});

test('command palette scrolls a filtered project into view', async ({ page }) => {
  const projects = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index}`,
    name: `项目${index}`,
    path: `/work/p${index}`,
    available: true,
    preferredTool: null,
    lastOpened: index,
    modelOverrides: {},
    selectedProfiles: {},
    appliedProfiles: {},
    reapplyProfiles: {},
  }));
  await installDesktop(page, projects);
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.goto('/');
  const target = page.locator('[data-project-id="p7"]');
  const search = page.getByRole('textbox', { name: '搜索项目' });
  await search.fill('项目0');
  await expect(target).toHaveCount(0);

  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: '快速前往' });
  await dialog.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('项目7');
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(search).toHaveValue('');
  await expect.poll(() => target.evaluate((element) => {
    const main = document.querySelector('main');
    if (!main) return false;
    const item = element.getBoundingClientRect();
    const box = main.getBoundingClientRect();
    return item.top >= box.top - 1 && item.bottom <= box.bottom + 1;
  })).toBe(true);
  await expect.poll(() => page.locator('main.content').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(target).toBeFocused();
  await search.fill('项目0');
  await expect(target).toHaveCount(0);
  await expect(page.locator('[data-project-id="p0"]')).toHaveCount(1);
});

/** Native mock with indexed sessions and library items; records every IPC call. */
async function installPaletteData(page: Page) {
  await page.addInitScript(() => {
    const commands: string[] = [];
    const resumes: unknown[] = [];
    // Indexed DB snapshot: s1 is the most recent, s7 the oldest, s5 has no title.
    const sessions = Array.from({ length: 7 }, (_, index) => ({
      id: `s${index + 1}`, toolId: 'codex', nativeId: null, title: index === 4 ? '' : `面板会话${index + 1}`,
      cwd: null, model: null, projectId: null, startedAt: null, updatedAt: 8 - index, favorite: false,
      partial: false, stale: false, messageCount: index + 1, usageCount: 0,
    }));
    const entry = (kind: string, index: number) => ({
      id: `${kind}-${index}`, kind, title: kind === 'rule' ? `面板规则${index}` : `面板提示词${index}`,
      body: `内容 ${index}`, category: '', projectId: null, version: 1, updatedAt: index,
    });
    const prompts = [1, 2, 3].map((index) => entry('prompt', index));
    const rules = [1, 2].map((index) => entry('rule', index));
    Object.assign(window, {
      isTauri: true,
      __commands: commands,
      __resumes: resumes,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        commands.push(command);
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], resume: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return [];
        if (command === 'list_history_sessions') return sessions;
        if (command === 'list_library_items') return args.kind === 'rule' ? rules : prompts;
        if (command === 'resume_history_session') { resumes.push(args); return { mode: args.mode, status: 'terminal_requested' }; }
        if (command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'list_native_mcp' || command === 'list_history_prices' || command === 'list_portable_items') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return () => {};
        return null;
      } },
    });
  });
}

test('command palette lists indexed sessions and library entries without scanning', async ({ page }) => {
  await installPaletteData(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: '快速前往' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.command-group', { hasText: '最近会话' })).toBeVisible();
  await expect(dialog.locator('.command-group', { hasText: '资料库' })).toBeVisible();
  // Both groups are capped at five entries; the sixth and seventh sessions stay out.
  await expect(dialog.getByRole('option', { name: /面板会话/ })).toHaveCount(4);
  await expect(dialog.getByRole('option', { name: /未命名会话/ })).toHaveCount(1);
  await expect(dialog.getByRole('option', { name: '面板会话6' })).toHaveCount(0);
  await expect(dialog.getByRole('option', { name: /面板提示词|面板规则/ })).toHaveCount(5);
  // The palette reads the indexed snapshot only: opening it never triggers a scan.
  const opened = await page.evaluate(() => (window as typeof window & { __commands: string[] }).__commands);
  expect(opened).toContain('list_history_sessions');
  expect(opened).toContain('list_library_items');
  expect(opened).not.toContain('refresh_history');
  // Choosing a session reuses the Records resume command and its default mode.
  await dialog.getByRole('option', { name: '面板会话1' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __resumes: unknown[] }).__resumes)).toEqual([{ id: 's1', mode: 'normal' }]);
  expect(await page.evaluate(() => (window as typeof window & { __commands: string[] }).__commands)).not.toContain('refresh_history');
});

test('a desktop command-palette resume failure stays on the current page', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions = [
      { id: 'desk', toolId: 'cursor', nativeId: null, title: '桌面会话', cwd: null, model: null, projectId: null, startedAt: null, updatedAt: 2, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 },
      { id: 'term', toolId: 'codex', nativeId: null, title: '终端会话', cwd: null, model: null, projectId: null, startedAt: null, updatedAt: 1, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 },
    ];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['cursor', 'codex'], theme: 'light' }, tools: [{ id: 'cursor', name: 'Cursor' }, { id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'cursor', name: 'Cursor', launchForm: 'desktop', interfaceFormats: [], history: { state: 'available', reason: '' } }, { id: 'codex', name: 'Codex', launchForm: 'terminal', interfaceFormats: [], history: { state: 'available', reason: '' } }], managedIds: ['cursor', 'codex'], preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_library_items' || command === 'list_history_prices') return [];
          if (command === 'list_history_sessions') return sessions;
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'resume_history_session') throw new Error(args.id === 'desk' ? '桌面会话没有恢复' : '终端会话没有恢复');
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /快速前往/ }).click();
  await page.getByRole('dialog', { name: '快速前往' }).getByRole('option', { name: '桌面会话' }).click();
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '桌面会话没有恢复' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toHaveCount(0);
  await page.getByRole('button', { name: /快速前往/ }).click();
  await page.getByRole('dialog', { name: '快速前往' }).getByRole('option', { name: '终端会话' }).click();
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: '当前会话' }).getByRole('alert')).toContainText('终端会话没有恢复');
});

test('command palette hides the session and library groups when data is empty', async ({ page }) => {
  await installDesktop(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: '快速前往' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.command-group', { hasText: '页面' })).toBeVisible();
  await expect(dialog.locator('.command-group', { hasText: '最近会话' })).toHaveCount(0);
  await expect(dialog.locator('.command-group', { hasText: '资料库' })).toHaveCount(0);
  await expect(dialog.getByRole('option', { name: /未命名会话/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('command palette library entry jumps to the library page and opens the item', async ({ page }) => {
  await installPaletteData(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: '快速前往' });
  await dialog.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('面板规则2');
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '资料库', level: 1 })).toBeVisible();
  // The spotlight lands on the rule tab even though the library opens on prompts.
  await expect(page.getByRole('tab', { name: /^长期规则/ })).toHaveAttribute('aria-selected', 'true');
  const editor = page.getByRole('dialog', { name: '修改规则' });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('标题')).toHaveValue('面板规则2');
  await expect(editor.getByRole('button', { name: '复制全文' })).toBeVisible();
});

test('workbench separates two sessions, marks a self-exit, and returns to management pages', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions = [
      { id: 's1', toolId: 'codex', projectId: 'p1', directory: 'C:/alpha', mode: 'normal', running: true, exitCode: null },
      { id: 's2', toolId: 'claude_code', projectId: null, directory: 'D:/beta-work', mode: 'yolo', running: true, exitCode: null },
    ];
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: Array<{ sessionId: string; dataBase64: string }> = [];
    const closed: string[] = [];
    Object.assign(window, {
      isTauri: true, __writes: writes, __closed: closed, __events: bridge,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __emit: (event: string, payload: { sessionId?: string; exitCode?: number | null }) => {
        if (event === 'cliora:session-exit') {
          const item = sessions.find((entry) => entry.id === payload.sessionId);
          if (item) { item.running = false; item.exitCode = payload.exitCode ?? null; }
        }
        const id = bridge.listens[event];
        bridge.handlers[id]?.({ payload });
      },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light' }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_projects') return [{ id: 'p1', name: 'Alpha', path: 'C:/alpha', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') {
            const text = args.sessionId === 's2' ? 'claude-ready' : 'codex-ready';
            const encoded = btoa(text);
            const emitOutput = (dataBase64: string) => {
              const id = bridge.listens['cliora:session-output'];
              bridge.handlers[id]?.({ payload: { sessionId: args.sessionId, dataBase64 } });
            };
            queueMicrotask(() => {
              emitOutput(args.sessionId === 's2' ? encoded : btoa('ready'));
              if (args.sessionId === 's2') emitOutput(btoa('!'));
            });
            return encoded;
          }
          if (command === 'write_workbench_session') { writes.push({ sessionId: args.sessionId, dataBase64: args.dataBase64 }); return null; }
          if (command === 'resize_workbench_session') return null;
          if (command === 'close_workbench_session') { closed.push(args.sessionId); const index = sessions.findIndex((item) => item.id === args.sessionId); if (index >= 0) sessions.splice(index, 1); return null; }
          if (command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: args.theme }, tools: [] };
          if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
          if (command === 'list_library_items' || command === 'list_history_sessions' || command === 'list_history_prices' || command === 'refresh_history' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'list_rule_placements' || command === 'list_portable_items' || command === 'list_native_mcp' || command === 'scan_native_skills') return [];
          if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
          if (command === 'get_usage_report') return { generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', previous: null, timeline: [], totals: { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 }, byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0, partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans: [] };
          if (command === 'get_webdav_status') return { configured: false, enabled: false, endpoint: null, lastSuccess: null, lastError: null, retryAfter: null, uploaded: 0, downloaded: 0, pendingChanges: 0, conflicts: [] };
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return null;
        },
      },
    });
  });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  const codex = page.getByRole('tab', { name: /Codex/ });
  const claude = page.getByRole('tab', { name: /Claude Code/ });
  await expect(codex).toContainText('Alpha');
  // Rail cards only flag the exceptional YOLO mode; the normal mode stays in the stage header.
  await expect(codex).not.toContainText('YOLO');
  await expect(claude).toContainText('YOLO');
  await expect(claude).toContainText('beta-work');

  // Cards only switch sessions; drag gestures and synthetic drag events never reorder them.
  const railList = page.getByRole('tablist', { name: '会话列表' });
  await expect(railList.getByRole('tab').first()).toHaveText(/Codex/);
  await expect(railList.locator('[draggable="true"]')).toHaveCount(0);
  await claude.dragTo(codex);
  await expect(railList.getByRole('tab').first()).toHaveText(/Codex/);
  await page.evaluate(() => {
    const source = document.querySelector('[data-session-id="s2"]')!.parentElement!;
    const target = document.querySelector('[data-session-id="s1"]')!.parentElement!;
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    const rect = target.getBoundingClientRect();
    for (const type of ['dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + 12, clientY: rect.top + 8 }));
    }
  });
  await expect(railList.getByRole('tab').first()).toHaveText(/Codex/);
  const codexOutput = page.locator('.xterm-accessibility-tree').first();
  await expect(codexOutput).toContainText('codex-ready');
  await expect(codexOutput).not.toContainText('codex-readyready');
  const stage = page.getByRole('region', { name: '当前会话' });
  // A CLI names its task through OSC 0; the rail and header keep the spinner glyph as the live icon.
  await page.evaluate(() => {
    const bridge = (window as unknown as { __events: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } }).__events;
    const title = String.fromCharCode(0x1b) + ']0;\u280b \u4fee\u590d\u767b\u5f55' + String.fromCharCode(7);
    const bytes = new TextEncoder().encode(title);
    bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId: 's1', dataBase64: btoa(String.fromCharCode(...bytes)) } });
  });
  await expect(codex.locator('strong')).toHaveText('⠋ 修复登录');
  await expect(codex.locator('[class*="sessionPlace"]')).toHaveText('Alpha');
  await expect(stage).toContainText('修复登录');
  // User-facing emoji in an OSC title survives title sanitizing. This is
  // important for remote CLIs that use emoji to indicate the active task.
  await page.evaluate(() => {
    const bridge = (window as unknown as { __events: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } }).__events;
    const title = String.fromCharCode(0x1b) + ']0;✨ 远端修复' + String.fromCharCode(7);
    const bytes = new TextEncoder().encode(title);
    bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId: 's1', dataBase64: btoa(String.fromCharCode(...bytes)) } });
  });
  await expect(codex.locator('strong')).toHaveText('✨ 远端修复');
  await codex.click({ button: 'right' });
  const rowMenu = page.getByRole('menu', { name: 'Codex 会话操作' });
  await expect(rowMenu.getByRole('menuitem')).toHaveText(['置顶', '发送中断 (Ctrl+C)', '同目录新开', '复制输出', '复制工作目录路径', '打开所在文件夹', '结束此会话']);
  await page.keyboard.press('Escape');
  await expect(rowMenu).toHaveCount(0);
  await expect(codex).toBeFocused();
  await codex.press('Shift+F10');
  await expect(rowMenu).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(rowMenu).toHaveCount(0);
  // Pinning remains available without drag sorting and moves Claude Code to the top.
  await claude.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Claude Code 会话操作' }).getByRole('menuitem', { name: '置顶' }).click();
  await expect(railList.getByRole('tab').first()).toHaveText(/Claude Code/);
  await expect(claude.locator('[title="取消置顶"]')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cliora:workbench-rail-arrange') ?? '{}'))).toMatchObject({ pinned: ['s2'] });
  await codex.click();
  await expect(codex).toHaveAttribute('aria-selected', 'true');
  await expect(stage).toContainText('Codex');
  await expect(stage).toContainText('Alpha');
  await expect(stage).toContainText('普通');
  await page.locator('.xterm-helper-textarea:visible').focus();
  await page.keyboard.type('a');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __writes: Array<{ sessionId: string }> }).__writes.map((item) => item.sessionId))).toEqual(['s1']);
  await claude.click();
  await expect(stage).toContainText('Claude Code');
  await expect(stage).toContainText('YOLO');
  const claudeOutput = page.locator('.xterm-accessibility-tree').last();
  await expect(claudeOutput).toContainText('claude-ready!');
  await expect(claudeOutput).not.toContainText('claude-readyclaude-ready');
  await page.evaluate(() => { (window as unknown as { __writes: unknown[] }).__writes.length = 0; });
  await stage.getByRole('button', { name: '快捷输入', exact: true }).click();
  const composer = stage.getByRole('region', { name: '多行输入与提示词投递' });
  const composerInput = composer.getByRole('textbox');
  await composerInput.fill('second-session draft');
  await codex.click();
  await expect(composerInput).toHaveValue('');
  await composerInput.fill('  first draft  ');
  await claude.click();
  await expect(composerInput).toHaveValue('second-session draft');
  await composerInput.fill('  second draft  ');
  await composerInput.press('Enter');
  await expect(composerInput).toHaveValue('');
  await codex.click();
  await expect(composerInput).toHaveValue('  first draft  ');
  await composerInput.press('Enter');
  await expect(composerInput).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __writes: Array<{ sessionId: string; dataBase64: string }> }).__writes.map((item) => ({ sessionId: item.sessionId, text: atob(item.dataBase64) })))).toEqual([
    { sessionId: 's2', text: '  second draft  \r' },
    { sessionId: 's1', text: '  first draft  \r' },
  ]);
  const collapsed = await composerInput.boundingBox();
  await composerInput.fill(Array.from({ length: 6 }, (_, index) => `line-${index + 1}`).join('\n'));
  await expect.poll(async () => (await composerInput.boundingBox())!.height).toBeGreaterThan(collapsed!.height);
  expect((await composerInput.boundingBox())!.height).toBeLessThanOrEqual(144);
  const terminalBox = await stage.locator('.xterm:visible').boundingBox();
  const composerBox = await composer.boundingBox();
  expect(composerBox!.y).toBeGreaterThanOrEqual(terminalBox!.y + terminalBox!.height);
  await page.evaluate(() => { (window as unknown as { __writes: unknown[] }).__writes.length = 0; });
  await claude.click();
  await page.locator('.xterm-helper-textarea:visible').focus();
  await page.keyboard.type('z');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __writes: Array<{ sessionId: string }> }).__writes.map((item) => item.sessionId))).toEqual(['s2']);
  await stage.getByRole('button', { name: '结束此会话' }).click();
  const endConfirmation = page.getByRole('dialog', { name: '结束这个会话？' });
  await expect(endConfirmation).toBeVisible();
  await endConfirmation.getByRole('button', { name: '取消' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __closed: string[] }).__closed)).toEqual([]);
  await stage.getByRole('button', { name: '结束此会话' }).click();
  await endConfirmation.getByRole('button', { name: '结束进程' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __closed: string[] }).__closed)).toEqual(['s2']);
  await expect(claude).toHaveCount(0);
  await expect(codex).toBeVisible();
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit('cliora:session-exit', { sessionId: 's1', exitCode: 0 }));
  await expect(codex).toContainText('已结束');
  await expect(stage).toContainText('已结束');
  const openPage = async (name: string) => {
    const button = nav.getByRole('button', { name, exact: true });
    const discard = page.getByRole('dialog', { name: '放弃未保存修改？' });
    await button.click();
    if (await discard.isVisible()) await discard.getByRole('button', { name: '放弃修改' }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    // Stay until the tools workspace paints. Leaving earlier skips the probe render.
    if (name === '工具与连接') await expect(page.getByText('安装与更新', { exact: true }).first()).toBeVisible();
  };
  for (const name of ['快速开始', '工作台', '工具与连接', '资料库', '使用记录', '设置']) await openPage(name);
  await openPage('工作台');
  await expect(codex).toContainText('已结束');
  await expect(page.getByRole('tab', { name: /Claude Code/ })).toHaveCount(0);
});

test('workbench modal dialog scales to 40+ CLIs, supports on-demand composer, find, bell attention, and ended cleanup', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions: Array<{ id: string; toolId: string; projectId: string | null; directory: string; mode: string; running: boolean; exitCode: number | null; startedAt: number }> = [];
    const launches: Array<Record<string, unknown>> = [];
    const writes: Array<{ sessionId: string; text: string }> = [];
    const closed: string[] = [];
    const names: Record<string, string> = {
      codex: 'Codex',
      claude_code: 'Claude Code',
      ...Object.fromEntries(Array.from({ length: 42 }, (_, idx) => [`cli_tool_${idx + 1}`, `CLI Tool ${idx + 1}`])),
    };
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true, __launches: launches, __writes: writes, __closed: closed,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __emitExit: (sessionId: string, exitCode: number) => {
        const item = sessions.find((entry) => entry.id === sessionId);
        if (item) { item.running = false; item.exitCode = exitCode; }
        const id = bridge.listens['cliora:session-exit'];
        bridge.handlers[id]?.({ payload: { sessionId, exitCode } });
      },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light' }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: true, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_projects') return [{ id: 'p1', name: 'Alpha', path: 'C:/alpha', available: true, preferredTool: 'claude_code', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
          if (command === 'list_library_items') return args.kind === 'prompt' ? [{ id: 'pr1', kind: 'prompt', title: '代码审查', body: '请审查当前改动', category: '开发', projectId: null, version: 1, updatedAt: 1 }] : [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'launch_cli') {
            launches.push(args.request);
            const id = `wb-${sessions.length + 1}`;
            sessions.push({
              id,
              toolId: args.request.toolId,
              projectId: args.request.projectId ?? null,
              directory: args.request.projectId === 'p1' ? 'C:/alpha' : (args.request.directory ?? 'C:/home'),
              mode: args.request.mode,
              running: true,
              exitCode: null,
              startedAt: Date.now(),
            });
            return { toolId: args.request.toolId, projectId: args.request.projectId ?? null, mode: args.request.mode, terminal: 'workbench', status: 'session_started', sessionId: id };
          }
          if (command === 'replay_workbench_session') return btoa(`welcome-${args.sessionId}\r\nready-line-alpha`);
          if (command === 'write_workbench_session') {
            writes.push({ sessionId: args.sessionId, text: atob(args.dataBase64) });
            return null;
          }
          if (command === 'resize_workbench_session') return null;
          if (command === 'close_workbench_session') {
            closed.push(args.sessionId);
            const idx = sessions.findIndex((item) => item.id === args.sessionId);
            if (idx >= 0) sessions.splice(idx, 1);
            return null;
          }
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  });

  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage.getByRole('heading', { name: '还没有进行中的会话' })).toBeVisible();

  // Open the New Session Modal Dialog from the clean empty state
  await stage.getByRole('button', { name: '新建会话' }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await expect(dialog).toBeVisible();

  // Select workspace project (which auto-selects Claude Code) and choose YOLO mode + library prompt
  await dialog.getByRole('button', { name: '工作目录 / 项目' }).click();
  await page.getByRole('option', { name: /Alpha/ }).click();
  await dialog.getByRole('radio', { name: /YOLO/ }).click();
  await dialog.getByRole('button', { name: '代码审查' }).click();
  await dialog.getByRole('button', { name: '启动会话' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('tab', { name: /Claude Code/ })).toContainText('Alpha');
  await expect(page.getByRole('tab', { name: /Claude Code/ })).toContainText('YOLO');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, unknown>> }).__launches)).toEqual([
    { toolId: 'claude_code', projectId: 'p1', sessionId: null, mode: 'yolo', directory: null, initialPrompt: '请审查当前改动' },
  ]);

  // Open the docked quick-input composer and send multi-line / prompt text
  await stage.locator('.xterm-screen').click();
  await page.keyboard.press('Control+Shift+M');
  const composer = stage.getByRole('textbox', { name: /编写多行内容或从资料库选入提示词/ });
  await composer.fill('status check');
  await composer.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __writes: Array<{ sessionId: string; text: string }> }).__writes)).toEqual([
    { sessionId: 'wb-1', text: 'status check\r' },
  ]);

  // Search terminal output
  await page.keyboard.press('Control+Shift+F');
  await stage.getByRole('searchbox', { name: '在终端输出中查找…' }).fill('ready-line');
  await expect(stage).toContainText('1 / 1');

  // Toggle Focus Mode
  await stage.getByRole('button', { name: '专注模式（隐藏侧栏）' }).click();
  await expect(stage.getByRole('button', { name: '展开会话列表' })).toBeVisible();
  await stage.getByRole('button', { name: '展开会话列表' }).click();

  // Open New Session Modal from the rail and search among 40+ CLIs
  const rail = page.getByRole('complementary', { name: '会话列表' });
  await rail.getByRole('button', { name: '新建会话' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'CLI 工具' }).click();
  await page.getByRole('textbox', { name: '搜索 40+ CLI 工具名称或标识' }).fill('CLI Tool 38');
  await page.getByRole('option', { name: /CLI Tool 38/ }).click();
  await dialog.getByRole('button', { name: '启动会话' }).click();
  await expect(page.getByRole('tab', { name: /CLI Tool 38/ })).toBeVisible();

  // Mark wb-1 exited, filter by ended, and clear ended sessions
  await page.evaluate(() => (window as unknown as { __emitExit: (id: string, code: number) => void }).__emitExit('wb-1', 0));
  await rail.getByRole('button', { name: /已结束/ }).first().click();
  await expect(page.getByRole('tab', { name: /Claude Code/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /CLI Tool 38/ })).toHaveCount(0);
  await rail.getByRole('button', { name: /清理已结束/ }).click();
  await expect(page.getByRole('tab', { name: /CLI Tool 38/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Claude Code/ })).toHaveCount(0);
});
