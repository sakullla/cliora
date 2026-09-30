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
  await page.getByText('恢复已有会话 · YOLO 启动', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '恢复会话 ID' })).toBeVisible();
  await page.getByRole('textbox', { name: '恢复会话 ID' }).fill('session-中文 1');
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByRole('button', { name: 'YOLO 恢复' }).click();
  const requests = await page.evaluate(() => (window as typeof window & { __launchRequests: Array<Record<string, unknown>> }).__launchRequests);
  expect(requests).toEqual([
    { toolId: 'grok', projectId: null, sessionId: 'session-中文 1', mode: 'normal' },
    { toolId: 'grok', projectId: null, sessionId: 'session-中文 1', mode: 'yolo' },
  ]);
});

test('tray repair opens the exact missing project even when no CLI is managed', async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number[]>();
    let nextCallback = 0;
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __emitRepair: (payload: unknown) => {
        for (const id of listeners.get('cliora:tray-repair') ?? []) callbacks.get(id)?.({ event: 'cliora:tray-repair', payload });
      },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => { const id = ++nextCallback; callbacks.set(id, callback); return id; },
        invoke: async (command: string, args: { event?: string; handler?: number } = {}) => {
          if (command === 'plugin:event|listen') { listeners.set(args.event!, [...(listeners.get(args.event!) ?? []), args.handler!]); return nextCallback; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [], theme: 'system' }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok', interfaceFormats: [] }], managedIds: [], preservedUnknown: [] };
          if (command === 'list_projects') return [{ id: 'moved-project', name: '旧项目', path: 'C:\\旧目录', available: false, preferredTool: 'grok', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} }];
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '旧项目 新目录' });
  await expect(input).toBeVisible();
  await page.evaluate(() => (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair({ page: 'home', projectId: 'moved-project', toolId: null, scope: null, projectPath: null, profileId: null }));
  await expect(input).toBeFocused();
  await expect(page.getByText('已有项目仍可查看和重新关联')).toBeVisible();
});

test('tray conflict targets the active tool page with project scope and profile', async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number[]>();
    const requests: unknown[] = [];
    let nextCallback = 0;
    const profile = { id: 'daily', tool: 'grok', name: '日常配置', version: 2, inheritCommon: false, files: { config: 'model = "grok"' }, suppressed: {}, nativeCredentials: {}, connection: null };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __workspaceRequests: requests,
      __emitRepair: (payload: unknown) => {
        for (const id of listeners.get('cliora:tray-repair') ?? []) callbacks.get(id)?.({ event: 'cliora:tray-repair', payload });
      },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => { const id = ++nextCallback; callbacks.set(id, callback); return id; },
        invoke: async (command: string, args: { event?: string; handler?: number; toolId?: string; scope?: string; projectPath?: string } = {}) => {
          if (command === 'plugin:event|listen') { listeners.set(args.event!, [...(listeners.get(args.event!) ?? []), args.handler!]); return nextCallback; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['grok'], theme: 'system' }, tools: [{ id: 'grok', name: 'Grok', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok', interfaceFormats: [] }], managedIds: ['grok'], preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'get_registered_tool_workspace') {
            requests.push({ toolId: args.toolId, scope: args.scope, projectPath: args.projectPath });
            return {
              probe: { selectedPath: 'C:\\tools\\grok.cmd', installations: [], nativeFiles: [{ role: 'config', path: 'C:\\项目\\.grok\\config.toml', format: 'toml', writable: true, reason: null, sensitive: false }], nativeWrites: { state: 'supported', reason: '可编辑原生配置' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
              profiles: [profile], common: null, binding: { profileId: 'daily', profileVersion: 1 }, snapshots: [], recoveryNeeded: [], customPath: null,
            };
          }
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });
  });
  await page.goto('/');
  await page.evaluate(() => (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair({ page: 'connections', toolId: 'grok', scope: 'global', projectId: null, projectPath: null, profileId: 'daily' }));
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await page.evaluate(() => (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair({ page: 'connections', toolId: 'grok', scope: 'project', projectId: 'project-1', projectPath: 'C:\\项目', profileId: 'daily' }));
  await expect(page.getByRole('combobox', { name: '配置范围' })).toHaveValue('project');
  await expect(page.getByRole('textbox', { name: '项目目录' })).toHaveValue('C:\\项目');
  await expect(page.getByRole('heading', { name: '日常配置' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __workspaceRequests: Array<Record<string, unknown>> }).__workspaceRequests.some((item) => item.toolId === 'grok' && item.scope === 'project' && item.projectPath === 'C:\\项目'))).toBe(true);
  await page.evaluate(() => (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair({ page: 'connections', toolId: 'grok', scope: 'project', projectId: 'project-1', projectPath: 'C:\\项目', profileId: 'daily', resourceView: 'skills' }));
  await expect(page.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '原生配置' }).click();
  await page.getByRole('button', { name: '常用设置' }).click();
  await page.getByRole('textbox', { name: '配置名称' }).fill('未保存的日常配置');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.evaluate(() => (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair({ page: 'connections', toolId: 'grok', scope: 'global', projectId: null, projectPath: null, profileId: 'daily' }));
  await expect(page.getByRole('combobox', { name: '配置范围' })).toHaveValue('project');
  await expect(page.getByRole('textbox', { name: '配置名称' })).toHaveValue('未保存的日常配置');
});

test('tray repair cannot discard unsaved form or native text when leaving the tool page', async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number[]>();
    let nextCallback = 0;
    const profile = { id: 'daily', tool: 'grok', name: '日常配置', version: 1, inheritCommon: false, files: { config: 'model = "grok"' }, suppressed: {}, nativeCredentials: {}, connection: null };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __emitRepair: (payload: unknown) => {
        for (const id of listeners.get('cliora:tray-repair') ?? []) callbacks.get(id)?.({ event: 'cliora:tray-repair', payload });
      },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => { const id = ++nextCallback; callbacks.set(id, callback); return id; },
        invoke: async (command: string, args: { event?: string; handler?: number } = {}) => {
          if (command === 'plugin:event|listen') { listeners.set(args.event!, [...(listeners.get(args.event!) ?? []), args.handler!]); return nextCallback; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['grok'], theme: 'system' }, tools: [{ id: 'grok', name: 'Grok', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok', interfaceFormats: [] }], managedIds: ['grok'], preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'get_registered_tool_workspace') return {
            probe: { selectedPath: 'C:\\tools\\grok.cmd', installations: [], nativeFiles: [{ role: 'config', path: 'C:\\项目\\.grok\\config.toml', format: 'toml', writable: true, reason: null, sensitive: false }], nativeWrites: { state: 'supported', reason: '可编辑原生配置' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
            profiles: [profile], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
          };
          if (command === 'inspect_registered_native_draft') return {};
          if (command === 'read_registered_native_file_for_edit') return 'model = "on disk"';
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }] };
          if (command === 'get_tray_status') return { available: true, error: null };
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });
  });
  const emit = (target: Record<string, unknown>) => page.evaluate((payload) =>
    (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair(payload), target);
  await page.goto('/');
  await page.getByRole('button', { name: '编辑配置 →' }).click();
  await expect(page.getByRole('heading', { name: '日常配置' })).toBeVisible();
  await page.getByRole('button', { name: '常用设置' }).click();
  const name = page.getByRole('textbox', { name: '配置名称' });
  await name.fill('未保存的表单');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await emit({ page: 'home', toolId: null, scope: null, projectId: 'moved-project', projectPath: null, profileId: null });
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(name).toHaveValue('未保存的表单');

  await name.fill('日常配置');
  await page.getByRole('button', { name: '原生文件' }).click();
  const nativeText = page.getByRole('textbox', { name: 'config 配置草稿' });
  await nativeText.fill('model = "edited locally"');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await emit({ page: 'settings', toolId: null, scope: null, projectId: null, projectPath: null, profileId: null });
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(nativeText).toHaveValue('model = "edited locally"');

  await nativeText.fill('model = "grok"');
  await page.getByRole('button', { name: '编辑当前磁盘原文' }).click();
  await expect(nativeText).toHaveValue('model = "on disk"');
  await nativeText.fill('model = "unsaved disk edit"');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await emit({ page: 'home', toolId: null, scope: null, projectId: 'moved-project', projectPath: null, profileId: null });
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(nativeText).toHaveValue('model = "unsaved disk edit"');

  page.once('dialog', (dialog) => void dialog.accept());
  await emit({ page: 'settings', toolId: null, scope: null, projectId: null, projectPath: null, profileId: null });
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '启动终端' })).toBeVisible();
});

test('home opens Claude Code native JSON editor with full disk text', async ({ page }) => {
  await page.addInitScript(() => {
    const profile = {
      id: 'claude-default', tool: 'claude_code', name: '日常', version: 1,
      inheritCommon: false, files: { settings: '{"model":"claude-sonnet"}' },
      suppressed: {}, nativeCredentials: {}, connection: null,
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'list_projects') return [];
        if (command === 'get_bootstrap') return {
          preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' },
          tools: [{ id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }],
        };
        if (command === 'list_cli_adapters') return {
          registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'] }],
          managedIds: ['claude_code'], preservedUnknown: [],
        };
        if (command === 'get_registered_tool_workspace') return {
          probe: {
            selectedPath: 'C:\\tools\\claude.cmd',
            installations: [{ path: 'C:\\tools\\claude.cmd', version: '2.1.283', source: 'npm_shim', status: 'available', detail: null }],
            nativeFiles: [{ role: 'settings', path: 'C:\\Users\\test\\.claude\\settings.json', format: 'json', writable: true, reason: null, sensitive: false }],
            nativeWrites: { state: 'supported', reason: '已验证此版本' },
            interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [],
            installUrl: 'https://code.claude.com/docs/en/setup', upgradeHint: '', installCommand: null, upgradeCommand: null,
          },
          profiles: [profile], common: null, binding: null,
          snapshots: [{ role: 'settings', fingerprint: 'present', error: null }],
          recoveryNeeded: [], customPath: null,
        };
        if (command === 'read_registered_native_file_for_edit') return '{"env":{"ANTHROPIC_API_KEY":"disk-key"},"model":"claude-sonnet"}';
        if (command === 'inspect_registered_native_draft') return {};
        throw new Error(`Unexpected native command: ${command}`);
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '编辑配置 →' }).click();
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '编辑当前磁盘原文' }).click();
  await expect(page.getByRole('textbox', { name: 'settings 配置草稿' })).toHaveValue(/ANTHROPIC_API_KEY.*disk-key/);
});

test('an existing Claude JSON file opens directly without first creating a named profile', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'list_projects') return [];
        if (command === 'get_bootstrap') return {
          preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' },
          tools: [{ id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }],
        };
        if (command === 'list_cli_adapters') return {
          registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'] }],
          managedIds: ['claude_code'], preservedUnknown: [],
        };
        if (command === 'get_registered_tool_workspace') return {
          probe: {
            selectedPath: 'C:\\tools\\claude.cmd', installations: [],
            nativeFiles: [{ role: 'settings', path: 'C:\\Users\\test\\.claude\\settings.json', format: 'json', writable: true, reason: null, sensitive: false }],
            nativeWrites: { state: 'supported', reason: '可编辑原生配置' },
            interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [],
            installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null,
          },
          profiles: [], common: null, binding: null,
          snapshots: [{ role: 'settings', fingerprint: 'present', error: null }],
          recoveryNeeded: [], customPath: null,
        };
        if (command === 'prepare_registered_native_import_from_disk') return {
          files: { settings: '{"model":"claude-sonnet"}' }, inspection: { connection: null },
          migratedSecret: true, nativeCredentials: {},
        };
        if (command === 'read_registered_native_file_for_edit') return '{"env":{"ANTHROPIC_API_KEY":"disk-key"},"model":"claude-sonnet"}';
        if (command === 'inspect_registered_native_draft') return {};
        throw new Error(`Unexpected native command: ${command}`);
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '编辑配置 →' }).click();
  await page.getByRole('button', { name: '编辑当前原生配置' }).click();
  await expect(page.getByRole('textbox', { name: 'settings 配置草稿' })).toHaveValue(/ANTHROPIC_API_KEY.*disk-key/);
});

test('a newly registered CLI appears without adding tool-specific shell code', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'list_projects') return [];
        if (command === 'get_bootstrap') return {
          preferences: { schema_version: 1, managed_tools: [], theme: 'system' }, tools: [],
        };
        if (command === 'list_cli_adapters') return {
          registered: [{ id: 'kimi_code', name: 'Kimi Code', interfaceFormats: ['openai_completions'] }],
          managedIds: ['kimi_code'], preservedUnknown: [],
        };
        if (command === 'get_registered_tool_workspace') return {
          probe: {
            selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '未发现 CLI' },
            interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null,
          },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        throw new Error(`Unexpected native command: ${command}`);
      } },
    });
  });
  await page.goto('/');
  await expect(page.locator('[aria-label="管理中的工具"]')).toContainText('Kimi Code');
  await page.getByRole('button', { name: '编辑配置 →' }).click();
  await expect(page.getByRole('tab', { name: 'Kimi Code' })).toBeVisible();
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
  expect((await page.evaluate(() => (window as any).__iconCalls)).find((call: any) => call.command === 'launch_cli').args.request).toMatchObject({ mode: 'normal', sessionId: null, projectId: null });
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
