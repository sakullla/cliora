import { expect, test } from '@playwright/test';

test('new native profile exposes identity, edits with history, migrates pasted credentials, and reopens after save', async ({ page }) => {
  await page.addInitScript(() => {
    const profiles = JSON.parse(localStorage.getItem('native-profile-flow') ?? '[]');
    const projects = [{ id: 'confirmation-project', name: '确认项目', path: 'C:/fixture/project', available: true, preferredTool: 'claude_code', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} }];
    window.confirm = () => { throw new Error('System/browser confirmation must not be called'); };
    Object.assign(window, { isTauri: true, __profileCalls: [], __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      (window as any).__profileCalls.push({ command, args });
      if (command.startsWith('plugin:dialog|')) throw new Error('Confirmation must stay inside the app');
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: [] }], managedIds: ['claude_code'], preservedUnknown: [] };
      if (command === 'list_projects') return structuredClone(projects);
      if (command === 'remove_project') { projects.splice(0, projects.length); return null; }
      if (command === 'test_registered_provider_connection') return { format: { state: 'passed', message: 'fixture format' }, connectivity: { state: 'passed', message: 'fixture connection' }, modelRequest: { state: 'passed', message: 'fixture request; no network' } };
      if (['list_mcp_definitions', 'list_native_mcp', 'list_skill_packages', 'scan_native_skills', 'list_skill_recovery_issues'].includes(command)) return [];
      if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: 'C:/claude.ps1', installations: [], nativeFiles: [{ role: 'settings', path: 'C:/settings.json', format: 'json', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' }, profiles: structuredClone(profiles), common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null };
      if (command === 'set_connection_secret') return args.secret === 'first-model-key' ? 'connection-first-model-key' : 'connection-new-model-key';
      if (command === 'list_provider_models') return { models: [args.connection.secretRef === 'connection-new-model-key' ? 'new-model' : 'first-model'], status: 'ready', source: 'provider_directory' };
      if (command === 'inspect_registered_native_draft') return {};
      if (command === 'preview_registered_native_profile') return { documents: { settings: JSON.parse(args.profile.files.settings) }, sources: {} };
      if (command === 'prepare_registered_native_import') {
        const value = JSON.parse(args.files.settings); const migratedSecret = !!value.env?.ANTHROPIC_API_KEY;
        if (migratedSecret) delete value.env.ANTHROPIC_API_KEY;
        return { files: { settings: JSON.stringify(value) }, inspection: { connection: null }, migratedSecret, nativeCredentials: migratedSecret ? { settings: { '/env/ANTHROPIC_API_KEY': 'system-secret-ref' } } : {} };
      }
      if (command === 'save_registered_native_profile') {
        if (args.profile.files.settings.includes('pasted-private-key')) throw { message: 'credential must be migrated before save' };
        const saved = { ...args.profile, id: args.profile.id || 'created-profile', version: 1, revision: 'saved-revision' };
        profiles.splice(0, profiles.length, saved); localStorage.setItem('native-profile-flow', JSON.stringify(profiles)); return saved;
      }
      throw new Error(`Unexpected IPC: ${command}`);
    } } });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  const name = page.getByRole('textbox', { name: '配置名称' });
  await expect(name).toBeVisible();
  await expect(name).toHaveValue('新配置');
  await name.fill('');
  await page.getByRole('button', { name: '仅保存', exact: true }).click();
  await expect(name).toBeFocused();
  await name.fill('中文日常配置');
  await page.getByRole('textbox', { name: 'API 地址', exact: true }).fill('https://fixture.invalid/v1');
  const key = page.getByLabel('API 密钥', {exact:true});
  await key.fill('first-model-key');
  await page.getByRole('button', { name: '获取模型', exact: true }).click();
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('first-model');
  await key.fill('new-model-key');
  await page.getByRole('button', { name: '获取模型', exact: true }).click();
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('new-model');
  expect((await page.evaluate(() => (window as any).__profileCalls)).filter((call: any) => call.command === 'list_provider_models').at(-1).args).toMatchObject({ connection: { secretRef: 'connection-new-model-key' }, force: true });
  await expect(key).toHaveValue('');
  await page.getByText('更多选项', { exact: true }).click();
  await page.getByRole('checkbox', { name: '继承本工具通用配置' }).check();
  const editor = page.getByRole('textbox', { name: 'settings 配置草稿' });
  await editor.fill('');
  await editor.focus();
  await expect.poll(() => editor.locator('..').locator('.cm-cursor').evaluateAll(elements => {
    const placeholder = document.querySelector('.cm-placeholder')?.getBoundingClientRect();
    const cursor = elements[0]?.getBoundingClientRect();
    return !!placeholder && !!cursor && Math.abs(cursor.left - placeholder.left) < 3 && Math.abs(cursor.top - placeholder.top) < 4;
  })).toBe(true);
  const source = '{\n "env": {"ANTHROPIC_API_KEY": "pasted-private-key"},\n "model": "claude-sonnet"\n}';
  await editor.fill(source);
  await expect(editor.locator('.code-string')).not.toHaveCount(0);
  await editor.press('Control+End'); await editor.press('Enter'); await editor.press('Tab');
  await expect(editor).toContainText('  ');
  await editor.press('Control+z'); await editor.fill(source);
  await page.getByRole('button', { name: '查看合并结果', exact: true }).click();
  await expect(name).toBeVisible();
  await expect(page.getByRole('textbox', { name: '合并配置预览' })).toHaveAttribute('aria-readonly', 'true');
  await page.getByRole('button', { name: '隐藏合并结果', exact: true }).click();
  await page.getByRole('button', { name: '仅保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '中文日常配置', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('native-profile-flow')!)[0])).toMatchObject({ inheritCommon: true, nativeCredentials: { settings: { '/env/ANTHROPIC_API_KEY': 'system-secret-ref' } } });
  await page.reload();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(name).toHaveValue('中文日常配置');
  await page.getByText('更多选项', { exact: true }).click();
  await expect(editor).not.toContainText('pasted-private-key');
  // The actual app dialog cancels by Escape/button; stale answers cannot
  // discard edits that arrive while the confirmation is pending.
  await name.fill('保留这个草稿');
  const commonButton = page.getByRole('button', { name: '通用配置', exact: true });
  const confirmation = page.getByRole('dialog');
  await commonButton.click();
  await expect(confirmation).toHaveAccessibleName('放弃未保存修改？');
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(commonButton).toBeFocused();
  await expect(name).toHaveValue('保留这个草稿');
  await commonButton.click();
  await expect(confirmation).toBeVisible();
  // Model an edit arriving from an in-flight update; modal focus correctly
  // prevents the user from interacting with the covered editor.
  await name.evaluate(element => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '确认期间继续修改');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(name).toHaveValue('确认期间继续修改');
  await commonButton.click();
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(name).toBeHidden();
  await expect(page.getByRole('heading', { name: '通用配置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '中文日常配置', exact: false }).click();
  await expect(page.getByRole('heading', { name: '中文日常配置', exact: true })).toBeVisible();
  await page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: /^更多选项$/ }) }).evaluate((el: HTMLDetailsElement) => { el.open = true; });
  await expect(page.getByText('高级连接选项', { exact: true })).toBeVisible();
  await page.getByText('高级连接选项', { exact: true }).click();
  await page.getByText('更多诊断', { exact: true }).click();
  const paid = page.getByRole('button', { name: '发送最小请求（可能计费）', exact: true });
  await paid.click();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__profileCalls)).filter((call: any) => call.command === 'test_registered_provider_connection')).toHaveLength(0);
  await paid.click();
  await confirmation.getByRole('button', { name: '发送请求', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).__profileCalls)).filter((call: any) => call.command === 'test_registered_provider_connection').length).toBe(1);
  expect((await page.evaluate(() => (window as any).__profileCalls)).find((call: any) => call.command === 'test_registered_provider_connection').args.allowModelRequest).toBe(true);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await page.getByText('项目选项', { exact: true }).click();
  await page.getByRole('button', { name: '移除项目', exact: true }).click();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText('确认项目', { exact: true })).toBeVisible();
  expect((await page.evaluate(() => (window as any).__profileCalls)).filter((call: any) => call.command === 'remove_project')).toHaveLength(0);
  await page.getByRole('button', { name: '移除项目', exact: true }).click();
  await confirmation.getByRole('button', { name: '移除项目', exact: true }).click();
  await expect(page.getByText('确认项目', { exact: true })).toBeHidden();
  expect((await page.evaluate(() => (window as any).__profileCalls)).filter((call: any) => call.command === 'remove_project')).toHaveLength(1);
  const dimensions = await page.evaluate(() => ({ html: [document.documentElement.scrollHeight, document.documentElement.clientHeight], body: [document.body.scrollHeight, document.body.clientHeight] }));
  expect(dimensions.html[0]).toBe(dimensions.html[1]); expect(dimensions.body[0]).toBe(dimensions.body[1]);
});

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
    { toolId: 'grok', projectId: null, sessionId: 'session-中文 1', mode: 'normal', directory: null },
    { toolId: 'grok', projectId: null, sessionId: 'session-中文 1', mode: 'yolo', directory: null },
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
  await expect(page.getByRole('combobox', { name: '配置项目' })).toHaveValue('C:\\项目');
  await expect(page.getByRole('heading', { name: '日常配置' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __workspaceRequests: Array<Record<string, unknown>> }).__workspaceRequests.some((item) => item.toolId === 'grok' && item.scope === 'project' && item.projectPath === 'C:\\项目'))).toBe(true);
  await page.evaluate(() => (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair({ page: 'connections', toolId: 'grok', scope: 'project', projectId: 'project-1', projectPath: 'C:\\项目', profileId: 'daily', resourceView: 'skills' }));
  await expect(page.getByRole('tab', { name: '添加 Skill' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '配置这个工具' }).click();
  await page.getByRole('textbox', { name: '配置名称' }).fill('未保存的日常配置');
  await page.evaluate(() => (window as typeof window & { __emitRepair: (target: unknown) => void }).__emitRepair({ page: 'connections', toolId: 'grok', scope: 'global', projectId: null, projectPath: null, profileId: 'daily' }));
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '配置范围' })).toHaveValue('project');
  await expect(page.getByRole('textbox', { name: '配置名称' })).toHaveValue('未保存的日常配置');
});

test('page navigation and tray repair preserve unsaved form and native text without discarding drafts', async ({ page }) => {
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
  const name = page.getByRole('textbox', { name: '配置名称' });
  await name.fill('未保存的表单');
  await emit({ page: 'home', toolId: null, scope: null, projectId: 'moved-project', projectPath: null, profileId: null });
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await page.getByRole('navigation', {name:'页面'}).getByRole('button',{name:'工具与连接'}).click();
  await expect(name).toHaveValue('未保存的表单');

  await name.fill('日常配置');
  await page.getByText('更多选项', { exact: true }).click();
  const nativeText = page.getByRole('textbox', { name: 'config 配置草稿' });
  await nativeText.fill('model = "edited locally"');
  await emit({ page: 'settings', toolId: null, scope: null, projectId: null, projectPath: null, profileId: null });
  await expect(page.getByRole('heading', {name:'设置',level:1})).toBeVisible();
  await page.getByRole('navigation', {name:'页面'}).getByRole('button',{name:'工具与连接'}).click();
  await expect(nativeText).toHaveText('model = "edited locally"');

  await nativeText.fill('model = "grok"');
  await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
  const abandon = page.getByRole('dialog').getByRole('button', { name: '放弃修改', exact: true });
  if (await abandon.isVisible().catch(() => false)) await abandon.click();
  await expect(page.getByRole('textbox', { name: 'config 配置草稿' })).toHaveText('model = "on disk"', { timeout: 10000 });
  await page.getByRole('textbox', { name: 'config 配置草稿' }).fill('model = "unsaved disk edit"');
  await emit({ page: 'home', toolId: null, scope: null, projectId: 'moved-project', projectPath: null, profileId: null });
  await expect(page.getByRole('heading', {name:'快速开始',level:1})).toBeVisible();
  await page.getByRole('navigation', {name:'页面'}).getByRole('button',{name:'工具与连接'}).click();
  await expect(page.getByRole('textbox', { name: 'config 配置草稿' })).toHaveText('model = "unsaved disk edit"');

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
  await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'settings 配置草稿' })).toHaveText(/ANTHROPIC_API_KEY.*disk-key/);
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
  await page.getByRole('button', { name: '直接修改正在使用的文件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'settings 配置草稿' })).toHaveText(/ANTHROPIC_API_KEY.*disk-key/);
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

test('wide home shows tool status beside a project launch without a new confirmation', async ({ page }) => {
  await page.addInitScript(() => {
    let theme = 'light';
    let applied = false;
    const profile = { id: 'daily', tool: 'codex', name: '日常', version: 1, inheritCommon: false, files: { settings: '{}' }, suppressed: {}, nativeCredentials: {}, connection: { providerId: 'openai', interfaceFormat: 'openai_responses', baseUrl: 'https://api.openai.com', model: 'gpt-5', secretRef: null, authEnvVar: null } };
    const workspace = () => ({
      probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.2.3', status: 'available' }], nativeFiles: [{ role: 'settings', path: 'C:/codex/config.toml', format: 'toml', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '可编辑原生配置' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
      profiles: [profile], common: null, binding: applied ? { scopeKey: 'global', tool: 'codex', profileId: 'daily', profileVersion: 1, managed: {} } : null, snapshots: [{ role: 'settings', fingerprint: 'present', text: null, error: null }], recoveryNeeded: [], customPath: null,
    });
    window.confirm = () => { throw new Error('System confirmation must not be called'); };
    Object.assign(window, { isTauri: true, __homeCalls: [], __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      (window as any).__homeCalls.push({ command, args });
      if (command.startsWith('plugin:dialog|')) throw new Error('Confirmation must stay inside the app');
      if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
      if (command === 'get_bootstrap' || command === 'set_theme') { if (command === 'set_theme') theme = args.theme; return { preferences: { schema_version: 1, managed_tools: ['codex'], theme }, tools: [{ id: 'codex', name: 'Codex' }] }; }
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'list_projects') return [{ id: 'desk', name: '栖点', path: 'C:/Projects/cliora', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} }];
      if (command === 'get_registered_tool_workspace') return workspace();
      if (command === 'apply_registered_native_profile') { applied = true; return { status: 'applied' }; }
      if (command === 'launch_cli') return { mode: args.request.mode, status: 'terminal_requested' };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }] };
      if (command === 'get_tray_status') return { available: false, error: null };
      throw new Error(`Unexpected IPC: ${command}`);
    } } });
  });

  async function expectWideBand() {
    await expect.poll(() => page.locator('main').evaluate((el) => el.scrollTop)).toBe(0);
    const status = page.getByText('原生配置已存在 · 供应商 / 模型未知', { exact: true });
    const launch = page.getByRole('region', { name: '项目与启动' }).getByRole('button', { name: '启动', exact: true });
    await expect(status).toBeInViewport({ ratio: 1 });
    await expect(launch).toBeInViewport({ ratio: 1 });
    const placed = await page.evaluate(() => {
      const tools = document.querySelector('.home-tools')!.getBoundingClientRect();
      const projects = document.querySelector('[aria-label="项目与启动"]')!.getBoundingClientRect();
      const columns = getComputedStyle(document.querySelector('.home-band')!).gridTemplateColumns.split(/\s+/).filter(Boolean);
      const track = (value: string) => {
        const px = Number.parseFloat(value);
        if (Number.isFinite(px)) return px;
        const match = value.match(/minmax\(([^,]+),\s*([\d.]+)fr\)/i);
        return match ? Number.parseFloat(match[2]) : 0;
      };
      return {
        columns: columns.length,
        configWider: track(columns[0] ?? '') > track(columns[1] ?? ''),
        projectsBesideTools: projects.x > tools.x + 80 && projects.y < tools.y + tools.height,
      };
    });
    expect(placed.columns).toBe(2);
    expect(placed.configWider).toBe(true);
    expect(placed.projectsBesideTools).toBe(true);
  }

  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto('/');
  await expectWideBand();
  await page.setViewportSize({ width: 900, height: 1000 });
  await expectWideBand();

  const config = page.getByRole('combobox', { name: 'Codex 全局配置' });
  await expect(config).toHaveValue('');
  await config.selectOption('daily');
  await expect.poll(() => page.evaluate(() => (window as any).__homeCalls.some((call: { command: string }) => call.command === 'apply_registered_native_profile'))).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => config.evaluate((element: HTMLSelectElement) => element.selectedOptions[0]?.textContent ?? '')).toBe('日常 · openai · gpt-5');
  await expect(config).toHaveValue('daily');
  const launch = page.getByRole('region', { name: '项目与启动' }).getByRole('button', { name: '启动', exact: true });
  await expect(launch).toBeEnabled();
  const yoloPlacement = await page.evaluate(() => {
    const region = document.querySelector('[aria-label="项目与启动"]')!;
    const options = [...region.querySelectorAll('details')].find((item) => item.querySelector('summary')?.textContent?.includes('项目选项'));
    const yolo = [...(options?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === 'YOLO');
    const project = options?.closest('[class]')?.parentElement ?? options?.parentElement;
    const start = [...(project?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === '启动' && !button.closest('details'));
    return {
      insideOptions: !!options && !!yolo,
      launchOutsideOptions: !!start,
    };
  });
  expect(yoloPlacement.insideOptions).toBe(true);
  expect(yoloPlacement.launchOutsideOptions).toBe(true);
  await launch.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__homeCalls.some((call: { command: string }) => call.command === 'launch_cli'))).toBe(true);

  await launch.evaluate((element: HTMLElement) => {
    element.blur();
    element.focus({ focusVisible: true });
  });
  await expect.poll(() => launch.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  })).toBe('solid 2px');

  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const theme = page.getByRole('combobox', { name: '主题' });
  await expect(theme.locator('option')).toHaveText(['跟随系统', '浅色', '深色']);
  await theme.selectOption('dark');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect.poll(() => config.evaluate((element: HTMLSelectElement) => element.selectedOptions[0]?.textContent ?? '')).toBe('日常 · openai · gpt-5');
  await page.setViewportSize({ width: 1360, height: 1000 });
  await expect.poll(() => page.locator('main').evaluate((el) => el.scrollTop)).toBe(0);
  const afterApply = await page.evaluate(() => {
    const tools = document.querySelector('.home-tools')!.getBoundingClientRect();
    const projects = document.querySelector('[aria-label="项目与启动"]')!.getBoundingClientRect();
    const columns = getComputedStyle(document.querySelector('.home-band')!).gridTemplateColumns.split(/\s+/).filter(Boolean);
    const track = (value: string) => {
      const px = Number.parseFloat(value);
      if (Number.isFinite(px)) return px;
      const match = value.match(/minmax\(([^,]+),\s*([\d.]+)fr\)/i);
      return match ? Number.parseFloat(match[2]) : 0;
    };
    return {
      columns: columns.length,
      configWider: track(columns[0] ?? '') > track(columns[1] ?? ''),
      projectsBesideTools: projects.x > tools.x + 80 && projects.y < tools.y + tools.height,
    };
  });
  expect(afterApply.columns).toBe(2);
  expect(afterApply.configWider).toBe(true);
  expect(afterApply.projectsBesideTools).toBe(true);

  await page.setViewportSize({ width: 640, height: 760 });
  const narrow = await page.evaluate(() => {
    const tools = document.querySelector('.home-tools')!.getBoundingClientRect();
    const projects = document.querySelector('[aria-label="项目与启动"]')!.getBoundingClientRect();
    const start = [...document.querySelectorAll('[aria-label="项目与启动"] button')].find((button) => button.textContent?.trim() === '启动')!.getBoundingClientRect();
    const options = [...document.querySelectorAll('[aria-label="项目与启动"] summary')].find((item) => item.textContent?.includes('项目选项'))!.getBoundingClientRect();
    const columns = getComputedStyle(document.querySelector('.home-band')!).gridTemplateColumns.split(/\s+/).filter(Boolean);
    return { columns: columns.length, stacked: projects.y > tools.y + tools.height - 1, launchBeforeOptions: start.y < options.y };
  });
  expect(narrow.columns).toBe(1);
  expect(narrow.stacked).toBe(true);
  expect(narrow.launchBeforeOptions).toBe(true);
  for (const name of ['快速开始', '工具与连接', '资料库', '使用记录', '设置']) {
    const button = page.getByRole('navigation', { name: '页面' }).getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
    expect(await button.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  }
});
