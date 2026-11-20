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
/** A restore that finishes late must not replace the session the user is already on. */
test('a late restore does not change the session the workbench keeps across page switches', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions: Array<Record<string, unknown>> = [
      { id: 's1', toolId: 'codex', projectId: null, directory: 'C:/home', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000 },
    ];
    const saved = [{ id: 'old', toolId: 'claude_code', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null }];
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __releaseRestore: () => (window as unknown as { __releaseRestoreRun?: () => void }).__releaseRestoreRun?.(),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }, { id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: ['codex', 'claude_code'].map((id) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: ['codex', 'claude_code'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'list_workbench_restore_sessions') return saved.map((item) => ({ ...item }));
          if (command === 'restore_workbench_sessions') {
            // The saved record is only restored once the test releases it.
            await new Promise<void>((resolve) => { (window as unknown as { __releaseRestoreRun?: () => void }).__releaseRestoreRun = resolve; });
            const restored = { id: 'late', toolId: 'claude_code', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() };
            sessions.push(restored);
            bridge.handlers[bridge.listens['cliora:workbench-restore']]?.({ payload: { restoreId: 'restore-1', savedSessionId: 'old', stage: 'restored', detail: null, candidates: [], session: restored } });
            return { restored: { old: 'late' }, failures: [] };
          }
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
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  const rail = page.getByRole('tablist', { name: '会话列表' });
  const earlier = rail.getByRole('tab', { name: /Codex/ });
  await expect(earlier).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('待恢复的会话')).toBeVisible();

  await page.evaluate(() => (window as unknown as { __releaseRestore: () => void }).__releaseRestore());
  const late = rail.getByRole('tab', { name: /Claude Code/ });
  await expect(late).toBeVisible();
  // The session the user already had stays selected; the late completion only joins the list.
  await expect(earlier).toHaveAttribute('aria-selected', 'true');
  await expect(late).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByLabel('待恢复的会话')).toHaveCount(0);

  await nav.getByRole('button', { name: '首页' }).click();
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(earlier).toHaveAttribute('aria-selected', 'true');
  await expect(late).toBeVisible();
});

/** The row actions are not pointer-only: Tab reveals them and Enter opens the session menu. */
test('tabbing through the session rail reaches the row menu and remove buttons', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions = [
      { id: 's1', toolId: 'codex', projectId: null, directory: 'C:/home', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000 },
      { id: 's2', toolId: 'claude_code', projectId: null, directory: 'C:/work', mode: 'normal', running: false, exitCode: 0, startedAt: Date.now() - 120_000 },
    ];
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light' }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
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
  const rail = page.getByRole('tablist', { name: '会话列表' });

  // Tab from a running row's tab reaches its menu button; the focused row reveals the actions.
  const runningTab = rail.getByRole('tab', { name: /Codex/ });
  await runningTab.focus();
  await page.keyboard.press('Tab');
  const runningMenu = rail.getByRole('button', { name: 'Codex 会话操作', exact: true });
  await expect(runningMenu).toBeVisible();
  await expect(runningMenu).toBeFocused();
  await expect.poll(() => runningMenu.evaluate((node) => getComputedStyle(node.parentElement!).opacity)).toBe('1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Codex 会话操作' })).toBeVisible();
  await page.keyboard.press('Escape');

  // An ended row carries the same menu button, then its remove button as the next Tab stop.
  const endedTab = rail.getByRole('tab', { name: /Claude Code/ });
  await endedTab.focus();
  await page.keyboard.press('Tab');
  const endedMenu = rail.getByRole('button', { name: 'Claude Code 会话操作', exact: true });
  await expect(endedMenu).toBeVisible();
  await expect(endedMenu).toBeFocused();
  await expect.poll(() => endedMenu.evaluate((node) => getComputedStyle(node.parentElement!).opacity)).toBe('1');
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Claude Code 会话操作' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  // Closing the menu hands focus back to the row's tab, so one more Tab passes the menu button.
  await expect(endedTab).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const remove = rail.getByRole('button', { name: '移除会话：Claude Code', exact: true });
  await expect(remove).toBeVisible();
  await expect(remove).toBeFocused();
  await expect.poll(() => remove.evaluate((node) => getComputedStyle(node.parentElement!).opacity)).toBe('1');
});

test('selected rail row keeps metadata visible at rest, docked live keeps accent, and pending differs from ended', async ({ page }) => {
  await page.addInitScript(() => {
    const host = {
      id: 'host-1', name: '远端主机', host: '203.0.113.10', port: 22, user: 'root', authMethod: 'key', identityFile: '',
      sshConfig: null, defaultPath: '/srv/project', enabled: true, createdAt: 1, updatedAt: 1,
    };
    const project = { id: 'proj-1', targetId: host.id, name: 'project', path: '/srv/project', preferredTool: 'codex', updatedAt: 1 };
    localStorage.setItem('cliora:remote-target', host.id);
    const startedAt = Date.now() - 8 * 60_000;
    const sessions = [
      { id: 'r-live', toolId: 'codex', projectId: `remote:${project.id}`, directory: project.path, mode: 'normal', running: true, exitCode: null, startedAt, remoteSessionId: 'cliora-live1111', connectionState: 'connected', reattachable: false, stateRevision: 0, remoteEndResult: null },
      { id: 'r-pending', toolId: 'claude_code', projectId: `remote:${project.id}`, directory: project.path, mode: 'normal', running: false, exitCode: 255, startedAt, remoteSessionId: 'cliora-pend2222', connectionState: 'unknown', reattachable: true, stateRevision: 0, remoteEndResult: null },
      { id: 'r-ended', toolId: 'codex', projectId: `remote:${project.id}`, directory: project.path, mode: 'normal', running: false, exitCode: 0, startedAt, remoteSessionId: 'cliora-end3333', connectionState: 'remote_ended', reattachable: false, stateRevision: 0, remoteEndResult: { outcome: 'confirmed_absent', exitCode: 0 } },
    ];
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __emit: (event: string, payload: unknown) => bridge.handlers[bridge.listens[event]]?.({ payload }),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_projects') return [project];
          if (command === 'list_remote_directories') return { parent: args.parent, items: [], truncated: false };
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

  await page.setViewportSize({ width: 1360, height: 800 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const rail = page.getByRole('tablist', { name: '会话列表' });
  await expect(rail).toBeVisible();

  // Trigger live output on selected session so it enters live tone.
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit('cliora:session-output', { sessionId: 'r-live', dataBase64: btoa('working...\r\n') }));

  const liveRow = rail.locator('[data-drag-id="r-live"]');
  const pendingRow = rail.locator('[data-drag-id="r-pending"]');
  const endedRow = rail.locator('[data-drag-id="r-ended"]');

  // Selected row keeps .sessionMeta visible at rest when focus is not inside the row.
  await page.mouse.move(10, 10);
  await expect.poll(() => liveRow.locator('[class*="sessionMeta"]').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');

  // Docked rail preserves live accent ring on .sessionIconWrap[data-tone="live"].
  const liveIcon = liveRow.locator('[data-rail-icon]');
  await expect(liveIcon).toHaveAttribute('data-tone', 'live');
  await expect.poll(() => liveIcon.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');

  // Remote-unknown (pending) session has distinct warning indicator compared to confirmed ended.
  await expect(pendingRow).toHaveAttribute('data-pending', 'true');
  const pendingIcon = pendingRow.locator('[data-rail-icon]');
  const endedIcon = endedRow.locator('[data-rail-icon]');
  await expect(pendingIcon).toHaveAttribute('data-tone', 'pending');
  await expect(endedIcon).toHaveAttribute('data-tone', 'ended');
  const pendingDotColor = await pendingIcon.locator('[data-activity-slot="rail"]').evaluate((el) => getComputedStyle(el).color);
  const endedDotColor = await endedIcon.locator('[data-activity-slot="rail"]').evaluate((el) => getComputedStyle(el).color);
  expect(pendingDotColor).not.toBe(endedDotColor);

  // Even in narrow strip mode, pending icon retains its distinct warning tone and non-grayscale styling.
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(pendingIcon).toHaveAttribute('data-tone', 'pending');
  const stripPendingColor = await pendingIcon.locator('[data-activity-slot="rail"]').evaluate((el) => getComputedStyle(el).color);
  const stripEndedColor = await endedIcon.locator('[data-activity-slot="rail"]').evaluate((el) => getComputedStyle(el).color);
  expect(stripPendingColor).not.toBe(stripEndedColor);
});

test('empty workbench tool chips reserve right padding for the hover arrow', async ({ page }) => {
  await page.addInitScript(() => {
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light' }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return [];
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 0;
          return [];
        },
      },
    });
  });

  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const chip = page.getByRole('button', { name: 'Claude Code' });
  await expect(chip).toBeVisible();
  const paddingRight = await chip.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
  expect(paddingRight).toBeGreaterThanOrEqual(40);
});
