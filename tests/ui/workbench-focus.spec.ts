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
          if (command === 'git_worktrees') return [{ name: 'cliora', branch: 'main', path: '/repo/cliora', current: false }, { name: 'cliora-ui', branch: 'feature/quiet-ui', path: '/repo/cliora-ui', current: true }];
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
  const git = footer.getByLabel(/^Git 分支 feature\/quiet-ui · 工作树 cliora-ui · 仓库 cliora/);
  // Git is one compact chip: the branch shows; the worktree name lives in its label and menu.
  await expect(git).toContainText('feature/quiet-ui');
  await expect(git).not.toContainText('工作树');
  // A session outside a saved project still reads its own repository's checkouts.
  await expect(git).toHaveAttribute('aria-haspopup', 'menu');
  await nav.getByRole('button', { name: '首页' }).click();
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(earlier).toHaveAttribute('aria-selected', 'true');
  await expect(launched).toHaveAttribute('aria-selected', 'false');
});

test('the CLI spinner stays in front of the terminal title', async ({ page }) => {
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
          if (command === 'git_worktrees') return [];
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
  // The CLI spinner is the live activity icon, so it belongs to the title.
  await expect(tab.locator('strong')).toHaveText('✳ develop分支更新');
  // The task title leads the card; the folder name sits underneath it.
  await expect(tab.locator('[class*="sessionPlace"]')).toHaveText('home');
  await emit('\u001b]0;\u25d1 \u2736 修复登录\u0007');
  await expect(tab.locator('strong')).toHaveText('◑ ✶ 修复登录');
  // Hover text must not follow the spinner, or the native tooltip restarts on every frame and flickers.
  const heading = page.getByRole('region', { name: '当前会话' }).locator('h2');
  await expect(tab).toHaveAttribute('title', /^修复登录\n/);
  await expect(heading).toHaveAttribute('title', 'Claude Code · 修复登录');
  await emit('\u001b]0;\u25d2 \u273b 修复登录\u0007');
  await expect(tab.locator('strong')).toHaveText('◒ ✻ 修复登录');
  await expect(tab).toHaveAttribute('title', /^修复登录\n/);
  await expect(heading).toHaveAttribute('title', 'Claude Code · 修复登录');
});

/** A running CLI cannot change folders from outside; another worktree opens a new session there. */
test('a worktree created mid-session appears and opens a new session there', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions: Array<Record<string, unknown>> = [
      { id: 's1', toolId: 'claude_code', projectId: null, directory: '/work/acme-svc-orders', mode: 'yolo', running: true, exitCode: null, startedAt: Date.now() - 60_000 },
    ];
    const trees = [{ name: 'acme-svc-orders', branch: 'feature/ABC-101', path: '/work/acme-svc-orders', current: true }];
    const calls: Array<[string, Record<string, any>]> = [];
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __calls: calls,
      // The agent adds a worktree by itself while the session runs.
      __addWorktree: () => trees.push({ name: 'ABC-102', branch: 'feature/ABC-102', path: '/work/acme-svc-orders/.claude/worktrees/ABC-102', current: false }),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          calls.push([command, args]);
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'light' }, tools: [{ id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['claude_code'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') return btoa('ready');
          if (command === 'workbench_git_context') return args.sessionId === 's1' ? { branch: 'feature/ABC-101', commit: null, worktree: null, repository: 'acme-svc-orders' } : null;
          if (command === 'git_worktrees') return trees.map((tree) => ({ ...tree }));
          if (command === 'launch_cli') {
            const id = `wb-${sessions.length + 1}`;
            sessions.push({ id, toolId: args.request.toolId, projectId: args.request.projectId ?? null, directory: args.request.directory, mode: args.request.mode, running: true, exitCode: null, startedAt: Date.now() });
            return { toolId: args.request.toolId, projectId: args.request.projectId ?? null, mode: args.request.mode, terminal: 'workbench', status: 'session_started', sessionId: id };
          }
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
  const footer = page.getByRole('region', { name: '当前会话' }).locator('footer');
  const chip = footer.getByLabel(/^Git 分支 feature\/ABC-101/);
  await expect(chip).toBeVisible();
  // One checkout: the menu holds no other checkout to open, but the review entry is there.
  await expect(chip).toHaveAttribute('aria-haspopup', 'menu');
  await chip.click();
  const alone = page.getByRole('menu', { name: '在工作树中新开会话' });
  await expect(alone.getByRole('menuitemradio')).toHaveCount(1);
  await expect(alone.getByRole('group', { name: '在 Twiglane 中审查' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as unknown as { __addWorktree: () => void }).__addWorktree());
  // Returning to the window re-reads the checkouts; the new worktree is offered without a restart.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(chip).toHaveAttribute('aria-haspopup', 'menu');
  await chip.click();
  const menu = page.getByRole('menu', { name: '在工作树中新开会话' });
  await expect(menu.getByRole('menuitemradio', { name: /acme-svc-orders/ })).toBeDisabled();
  await menu.getByRole('menuitemradio', { name: /ABC-102/ }).click();

  const calls = await page.evaluate(() => (window as unknown as { __calls: Array<[string, Record<string, any>]> }).__calls);
  const launch = calls.find(([command]) => command === 'launch_cli');
  expect(launch?.[1].request).toMatchObject({ toolId: 'claude_code', mode: 'yolo', directory: '/work/acme-svc-orders/.claude/worktrees/ABC-102' });
  // Nothing is typed into the running CLI: a `cd` would only reach the agent as a prompt.
  expect(calls.some(([command]) => command === 'write_workbench_session')).toBe(false);
  await expect(page.getByRole('tablist', { name: '会话列表' }).getByRole('tab')).toHaveCount(2);
});
