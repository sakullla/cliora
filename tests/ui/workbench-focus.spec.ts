import { expect, test } from '@playwright/test';

/** A session launched elsewhere is focused once; later visits keep the user's own choice. */
test('returning to the workbench keeps the session the user selected', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions: Array<Record<string, unknown>> = [
      { id: 's1', toolId: 'codex', projectId: null, directory: 'C:/home', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000 },
    ];
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __emitOutput: (sessionId: string, text: string) => {
        const bytes = new TextEncoder().encode(text);
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId, dataBase64: btoa(String.fromCharCode(...bytes)) } });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light' }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_projects') return [{ id: 'p1', name: 'Alpha', path: 'C:/alpha', available: true, preferredTool: 'claude_code', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'launch_cli') {
            const id = `wb-${sessions.length + 1}`;
            sessions.push({ id, toolId: args.request.toolId, projectId: args.request.projectId ?? null, directory: 'C:/alpha', mode: args.request.mode, running: true, exitCode: null, startedAt: Date.now() });
            return { toolId: args.request.toolId, projectId: args.request.projectId ?? null, mode: args.request.mode, terminal: 'workbench', status: 'session_started', sessionId: id };
          }
          if (command === 'replay_workbench_session') return btoa(`ready-${args.sessionId}`);
          if (command === 'workbench_git_context') return args.sessionId === 's1' ? { branch: 'feature/quiet-ui', commit: null, worktree: 'cliora-ui', repository: 'cliora' } : null;
          if (['write_workbench_session', 'resize_workbench_session'].includes(command)) return null;
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  const launcher = page.getByRole('region', { name: '项目与启动' });
  await launcher.getByRole('button', { name: '启动', exact: true }).click();
  const rail = page.getByRole('tablist', { name: '会话列表' });
  const launched = rail.getByRole('tab', { name: /Claude Code/ });
  const earlier = rail.getByRole('tab', { name: /Codex/ });
  await expect(launched).toHaveAttribute('aria-selected', 'true');

  const stage = page.getByRole('region', { name: '当前会话' });
  const footer = stage.locator('footer');
  await expect(footer).not.toContainText('feature/quiet-ui');
  await expect(footer).not.toContainText(/\d+×\d+/);

  await earlier.click();
  await expect(earlier).toHaveAttribute('aria-selected', 'true');
  const git = footer.getByLabel('Git 分支 feature/quiet-ui · 工作树 cliora-ui · 仓库 cliora');
  await expect(git).toContainText('feature/quiet-ui');
  await expect(git).toContainText('工作树');
  await nav.getByRole('button', { name: '快速开始' }).click();
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(earlier).toHaveAttribute('aria-selected', 'true');
  await expect(launched).toHaveAttribute('aria-selected', 'false');
});

test('a CLI spinner in front of the terminal title is not part of the session name', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions = [{ id: 's1', toolId: 'claude_code', projectId: null, directory: 'C:/home', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() }];
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __emitOutput: (text: string) => {
        const bytes = new TextEncoder().encode(text);
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId: 's1', dataBase64: btoa(String.fromCharCode(...bytes)) } });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'light' }, tools: [{ id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['claude_code'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') return btoa('ready');
          if (command === 'workbench_git_context') return null;
          if (['write_workbench_session', 'resize_workbench_session'].includes(command)) return null;
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const tab = page.getByRole('tablist', { name: '会话列表' }).getByRole('tab', { name: /Claude Code/ });
  await expect(tab).toBeVisible();
  const emit = (text: string) => page.evaluate((value) => (window as unknown as { __emitOutput: (text: string) => void }).__emitOutput(value), text);
  await emit('\u001b]0;\u2733 develop分支更新\u0007');
  await expect(tab.locator('strong')).toHaveText('develop分支更新');
  await emit('\u001b]0;\u25d1 \u2736 修复登录\u0007');
  await expect(tab.locator('strong')).toHaveText('修复登录');
});
