import { expect, test } from '@playwright/test';

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
  await page.getByRole('combobox', { name: '主题' }).selectOption('dark');
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
  await page.getByLabel('主题', { exact: true }).selectOption('light');
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

