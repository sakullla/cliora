import { expect, test, type Locator, type Page } from '@playwright/test';

const pageNames = ['快速开始', '工具与连接', '资料库', '使用记录', '设置'] as const;

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

async function installDesktop(page: Page) {
  await page.addInitScript(() => {
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
      sessionCount: 0, usageSessions: 0, unknownUsageSessions: 0, partialSessions: 0, staleSessions: 0,
      input: null, output: null, cacheRead: null, cacheWrite: null, inputIncludesCache: null,
      estimatedCost: null, currency: null, priceSources: [], scans: [], models: [], byModel: [],
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
          if (command === 'list_projects' || command === 'list_library_items' || command === 'list_history_sessions' || command === 'list_history_prices' || command === 'refresh_history' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp' || command === 'list_portable_items') return [];
          if (command === 'get_history_usage') return usage();
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return () => {};
          return null;
        },
      },
    });
  });
}

test('five full pages are navigable and browser mode never implies native data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('浏览器预览');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' })).toBeFocused();
  for (const name of ['快速开始', '工具与连接', '资料库', '使用记录', '设置']) {
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
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
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(page.getByRole('button', { name: '编辑配置 →' })).toHaveCount(1);
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
        if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok', interfaceFormats: [], yoloAvailable: true }], managedIds: ['grok'], preservedUnknown: [] };
        if (command === 'list_projects') return [];
        if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        if (command === 'launch_cli') { requests.push(args.request); return { mode: args.request?.mode, status: 'terminal_requested' }; }
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
  await page.goto('/');
  await page.getByText('直接启动或恢复会话', { exact: true }).click();
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

test('storage failure preserves an actionable page and retry loads repaired data', async ({ page }) => {
  await page.addInitScript(() => {
    let bootstrapAttempts = 0;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'list_projects') return [];
        if (command === 'get_bootstrap') {
          bootstrapAttempts += 1;
          if (bootstrapAttempts <= 2) throw { code: 'storage_unavailable', message: '无法打开本机数据库', action: '先备份原数据库，再检查磁盘和权限；修复后点击重试。', data_directory: 'C:\\Users\\test\\AppData\\Roaming\\Cliora' };
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
  await expect(page.getByRole('tablist', { name: 'CLI' }).locator('img')).toHaveAttribute('src', `data:image/png;base64,${base64}`);
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

test('browser preview keeps five pages reachable at 640 and does not scroll sideways', async ({ page }) => {
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
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(status).toBeVisible();
  }
  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: 768 });
    for (const name of pageNames) {
      await nav.getByRole('button', { name }).click();
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
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
  await expectFullyInFirstScreen(page, page.getByRole('button', { name: '＋ 新建提示词', exact: true }));
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
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
      await expect(status).toHaveText('本机资料 · 仅存于此设备');
      await expectNoHorizontalScroll(page);
    }
  }
  await expect(status).toHaveText('本机资料 · 仅存于此设备');
  const narrowBox = await status.boundingBox();
  expect(narrowBox).not.toBeNull();
  expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(640 + 1);
});

