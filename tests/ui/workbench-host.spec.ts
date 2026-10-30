import { expect, test, type Page } from '@playwright/test';

const host = {
  id: 'host-1',
  name: '测试远程主机',
  host: '212.60.153.19',
  port: 22,
  user: 'root',
  authMethod: 'key',
  identityFile: '',
  sshConfig: null,
  defaultPath: '/srv/project',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

/** Hold list_remote_targets until the test releases it, so the workbench mounts against an empty host list. */
async function installHostDesktop(page: Page, options: { savedHost?: boolean; holdTargets?: boolean } = {}) {
  await page.addInitScript(({ host, savedHost, holdTargets }) => {
    if (savedHost) localStorage.setItem('cliora:remote-target', host.id);
    else localStorage.removeItem('cliora:remote-target');
    let releaseTargets = () => {};
    const targetsReady = new Promise<void>((resolve) => { releaseTargets = resolve; });
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const registered = Object.entries(names).map(([id, name]) => ({
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    }));
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __releaseTargets: () => releaseTargets(),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') {
            if (holdTargets) await targetsReady;
            return [host];
          }
          if (command === 'list_remote_directories') return [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions' || command === 'list_projects' || command === 'list_remote_projects' || command === 'list_remote_sessions' || command === 'list_library_items') return [];
          if (command === 'plugin:event|listen') { bridge.listens[String(args.event ?? '')] = Number(args.handler ?? 0); return args.handler ?? 0; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  }, { host, savedHost: options.savedHost ?? false, holdTargets: options.holdTargets ?? false });
}

test('a saved remote host stays the workbench target while its list is still loading', async ({ page }) => {
  await installHostDesktop(page, { savedHost: true, holdTargets: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage).toBeVisible();
  // The host list is still pending. This used to treat that gap as "host missing" and launch locally.
  await page.waitForTimeout(100);
  await page.evaluate(() => (window as unknown as { __releaseTargets: () => void }).__releaseTargets());
  await expect(stage.getByRole('heading', { name: '还没有进行中的会话' })).toBeVisible();
  const sidebarHost = page.locator('.sidebar-host').getByRole('button', { name: '运行位置：测试远程主机' });
  const stageHost = stage.getByRole('button', { name: '运行位置：测试远程主机' });
  await expect(sidebarHost).toBeVisible();
  await expect(stageHost).toBeVisible();
  await stage.getByRole('button', { name: '新建会话' }).click();
  await expect(page.getByRole('dialog', { name: '选择远程目录' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '新建工作台会话' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '选择远程目录' }).locator('select').first()).toContainText('测试远程主机 · root@212.60.153.19');
});

test('a typed remote directory stays in the path field', async ({ page }) => {
  await installHostDesktop(page, { savedHost: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('button', { name: '新建会话' }).click();
  const dialog = page.getByRole('dialog', { name: '选择远程目录' });
  const path = dialog.getByRole('textbox', { name: '远程路径' });
  await expect(path).toHaveValue('/srv/project');
  const layout = await path.evaluate((input) => {
    const span = input.closest('label')?.querySelector('span');
    const inputBox = input.getBoundingClientRect();
    const spanBox = span?.getBoundingClientRect();
    const style = getComputedStyle(input);
    return {
      userSelect: style.userSelect,
      overlap: !!spanBox && spanBox.bottom > inputBox.top + 1,
    };
  });
  expect(layout.overlap).toBe(false);
  expect(layout.userSelect).toBe('text');
  const name = dialog.getByRole('textbox', { name: '项目名称' });
  await path.fill('/tmp/typed-project');
  await name.fill('自定义项目');
  await expect(path).toHaveValue('/tmp/typed-project');
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  await page.waitForTimeout(200);
  await expect(path).toHaveValue('/tmp/typed-project');
  await expect(name).toHaveValue('自定义项目');
});

test('choosing a remote host in the sidebar makes the next new session remote', async ({ page }) => {
  await installHostDesktop(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage.getByRole('button', { name: '运行位置：本机' })).toBeVisible();
  await stage.getByRole('button', { name: '新建会话' }).click();
  const localDialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await expect(localDialog).toBeVisible();
  await localDialog.getByRole('button', { name: '关闭' }).click();
  await expect(localDialog).toBeHidden();

  await page.locator('.sidebar-host').getByRole('button', { name: '运行位置：本机' }).click();
  await page.getByRole('menuitemradio', { name: /测试远程主机/ }).click();
  await expect(stage.getByRole('button', { name: '运行位置：测试远程主机' })).toBeVisible();
  await stage.getByRole('button', { name: '新建会话' }).click();
  await expect(page.getByRole('dialog', { name: '选择远程目录' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '新建工作台会话' })).toHaveCount(0);
});

test('a remote session composer lists that host library, not this computer', async ({ page }) => {
  await page.addInitScript((host) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const sessions = [{ id: 'remote-1', toolId: 'codex', projectId: 'remote:proj-1', directory: '/srv/project', mode: 'normal', running: true, exitCode: null, startedAt: 1 }];
    const calls: Array<{ command: string; targetId?: string; kind?: string }> = [];
    const names: Record<string, string> = { codex: 'Codex' };
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __libraryCalls: calls,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'list_library_items' || command === 'list_remote_library_items') calls.push({ command, targetId: typeof args.targetId === 'string' ? args.targetId : undefined, kind: typeof args.kind === 'string' ? args.kind : undefined });
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_projects') return [{ id: 'proj-1', targetId: host.id, name: 'project', path: '/srv/project', preferredTool: 'codex', updatedAt: 1 }];
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'list_library_items') return args.kind === 'prompt' ? [{ id: 'local-1', kind: 'prompt', title: 'ui/ux重做', body: 'local-only-body', category: '', projectId: null, version: 1, updatedAt: 1 }] : [];
          if (command === 'list_remote_library_items') return args.targetId === host.id && args.kind === 'prompt' ? [{ id: 'remote-prompt', kind: 'prompt', title: '远端提示', body: 'remote-only-body', category: '', projectId: null, version: 1, updatedAt: 1 }] : [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'replay_workbench_session') return btoa('ready\r\n');
          if (command === 'resize_workbench_session' || command === 'write_workbench_session') return null;
          if (command === 'plugin:event|listen') { bridge.listens[String(args.event ?? '')] = Number(args.handler ?? 0); return args.handler ?? 0; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  }, host);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage).toContainText('/srv/project');
  await stage.getByRole('button', { name: '快捷输入', exact: true }).click();
  const composer = stage.getByRole('region', { name: '多行输入与提示词投递' });
  await expect(composer.getByRole('button', { name: '远端提示' })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'ui/ux重做' })).toHaveCount(0);
  // The workbench reads that host's library. A later open reuses a recent result, and never the local library.
  const remoteCalls = await page.evaluate(() => (window as unknown as { __libraryCalls: Array<{ command: string; targetId?: string; kind?: string }> }).__libraryCalls.filter((item) => item.command === 'list_remote_library_items'));
  expect(remoteCalls.length).toBeGreaterThan(0);
  expect(remoteCalls.every((item) => item.targetId === host.id && item.kind === 'prompt')).toBe(true);
});

/** Product entry-point checks; the SSH/process identity is verified separately in Rust/native runs. */
async function installIndependentSessions(page: Page, options: { indexed?: boolean; empty?: boolean; fail?: boolean; hold?: boolean; initial?: 'local' | 'saved-a'; holdIndex?: boolean; holdListAfterLaunch?: boolean } = {}) {
  await page.addInitScript(({ host, options }) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const project = { id: 'same-project', targetId: host.id, name: 'shared-project', path: '/srv/project', preferredTool: 'codex', updatedAt: 1 };
    const make = (id: string) => ({ id, toolId: 'codex', projectId: `remote:${project.id}`, directory: project.path, mode: 'normal', running: true, exitCode: null as number | null, startedAt: 1, remoteSessionId: `cliora-${id}`, connectionState: 'connecting', reattachable: false, stateRevision: 0, remoteEndResult: null as unknown });
    const sessions = options.empty ? [] : [make('original-a')];
    if (options.initial === 'local') Object.assign(sessions[0], { projectId: null, directory: 'C:\\local-project', remoteSessionId: null });
    if (options.initial === 'saved-a') sessions[0].remoteSessionId = 'saved-a';
    const requests: Array<Record<string, unknown>> = [];
    let release = () => {};
    const ready = new Promise<void>(resolve => { release = resolve; });
    let releaseIndex = () => {};
    const indexReady = new Promise<void>(resolve => { releaseIndex = resolve; });
    const handlers: Array<(event: { payload: unknown }) => void> = [];
    const listens: Record<string, number> = {};
    let releaseList = () => {};
    const listReady = new Promise<void>(resolve => { releaseList = resolve; });
    const updateState = (patch: Record<string, unknown>) => {
      const session = sessions[0];
      Object.assign(session, patch, { stateRevision: session.stateRevision + 1 });
      handlers[listens['cliora:session-state']]?.({ payload: { ...session } });
    };
    const descriptor = { id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } };
    Object.assign(window, {
      isTauri: true, __independentRequests: requests, __independentSessions: sessions, __releaseIndependentLaunch: () => release(),
      __releaseIndependentIndex: () => releaseIndex(), __independentIndexPending: false,
      __releaseIndependentList: releaseList, __remoteState: updateState, __remoteEndFails: false, __remoteCloseCalls: [],
      __remoteExit: (stateRevision: number) => handlers[listens['cliora:session-exit']]?.({ payload: { sessionId: sessions[0].id, exitCode: 255, stateRevision } }),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { handlers.push(callback); return handlers.length - 1; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: true }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [descriptor], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings' || command === 'set_preferred_terminal') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_projects') return [project];
          if (command === 'list_remote_directories') return [project.path];
          if (command === 'save_remote_project') return { ...project, ...(args.project as object), id: project.id };
          if (command === 'list_workbench_sessions') {
            const snapshot = sessions.map(item => ({ ...item }));
            if (options.holdListAfterLaunch && requests.length) await listReady;
            return snapshot;
          }
          if (command === 'close_workbench_session') {
            const harness = window as unknown as { __remoteEndFails: boolean; __remoteCloseCalls: unknown[] };
            harness.__remoteCloseCalls.push(args.sessionId);
            if (harness.__remoteEndFails) {
              updateState({ connectionState: 'unknown', remoteEndResult: { outcome: 'unknown', stage: 'timeout', exitCode: null } });
              throw { message: '远程结束结果未知，记录已保留，请重试结束以核查' };
            }
            const index = sessions.findIndex(item => item.id === args.sessionId);
            if (index >= 0) sessions.splice(index, 1);
            return null;
          }
          if (command === 'reattach_workbench_session') { updateState({ running: true, connectionState: 'connecting', reattachable: false, exitCode: null }); return null; }
          if (command === 'list_remote_sessions') {
            Object.assign(window, { __independentIndexPending: true });
            if (options.holdIndex) await indexReady;
            return options.indexed ? ['a', 'b', 'c'].map(id => ({ remoteSessionId: `saved-${id}`, targetId: host.id, projectId: project.id, toolId: 'codex', directory: project.path, mode: 'normal', startedAt: 1, lastSeenAt: 1 })) : [];
          }
          if (command === 'launch_cli') {
            const request = args.request as Record<string, unknown>;
            requests.push(request);
            const ordinal = requests.length;
            if (options.hold) await ready;
            if (options.fail) throw { message: 'new remote process rejected' };
            const session = make(`new-${ordinal}`);
            const intent = request.remoteIntent as { kind?: string; remoteSessionId?: string } | undefined;
            if (intent?.kind === 'reattach') session.remoteSessionId = intent.remoteSessionId!;
            sessions.push(session);
            return { toolId: 'codex', projectId: `remote:${project.id}`, mode: 'normal', terminal: 'workbench', status: 'session_started', sessionId: session.id, remoteSessionId: session.remoteSessionId };
          }
          if (command === 'probe_remote_clis') return [{ targetId: host.id, toolId: 'codex', executable: 'codex', installed: true, version: '1.0', detail: null }];
          if (command === 'replay_workbench_session') return btoa('fixture-ready\r\n');
          if (command === 'restore_workbench_sessions') return { restored: {}, failures: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'plugin:event|listen') { listens[String(args.event)] = Number(args.handler); return args.handler; }
          if (command === 'plugin:event|unlisten' || command === 'resize_workbench_session' || command === 'write_workbench_session') return null;
          return [];
        },
      },
    });
  }, { host, options });
}

const independentRequests = (page: Page) => page.evaluate(() => (window as unknown as { __independentRequests: Array<Record<string, unknown>> }).__independentRequests);

async function quickRemoteLaunch(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { toolId: 'codex', targetId: 'host-1', quickLaunch: true } })));
}

test('remote tool quick launch creates a new request with an existing same-directory session and guards duplicate submission', async ({ page }) => {
  await installIndependentSessions(page, { hold: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('[role="tab"][data-session-id="original-a"]')).toBeVisible();
  await quickRemoteLaunch(page);
  await quickRemoteLaunch(page);
  await expect.poll(() => independentRequests(page)).toHaveLength(1);
  expect((await independentRequests(page))[0]).toMatchObject({ projectId: 'remote:same-project', sessionId: null, remoteIntent: { kind: 'new' } });
  await page.evaluate(() => (window as unknown as { __releaseIndependentLaunch: () => void }).__releaseIndependentLaunch());
  await expect(page.locator('[role="tab"][data-session-id="new-1"]')).toBeVisible();
  await quickRemoteLaunch(page);
  await expect.poll(() => independentRequests(page)).toHaveLength(2);
  await expect(page.locator('[role="tab"][data-session-id="new-2"]')).toBeVisible();
  await expect(page.locator('[role="tab"][data-session-id="original-a"]')).toBeVisible();
});

test('remote project launch sends new intent even when its directory is already running', async ({ page }) => {
  await installIndependentSessions(page);
  await page.goto('/');
  const card = page.locator('[data-project-id="remote:same-project"]');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '启动', exact: true }).click();
  await expect.poll(() => independentRequests(page)).toHaveLength(1);
  expect((await independentRequests(page))[0]).toMatchObject({ projectId: 'remote:same-project', sessionId: null, remoteIntent: { kind: 'new' } });
});

test('workbench new remote dialog creates an independent request for the saved directory', async ({ page }) => {
  await installIndependentSessions(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const directory = page.getByRole('dialog', { name: '选择远程目录' });
  await directory.getByRole('button', { name: '继续启动', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => independentRequests(page)).toHaveLength(1);
  expect((await independentRequests(page))[0]).toMatchObject({ projectId: 'remote:same-project', sessionId: null, remoteIntent: { kind: 'new' } });
});

test('remote startup restores every indexed identity and never falls back to an unindexed project', async ({ page }) => {
  await installIndependentSessions(page, { indexed: true, empty: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect.poll(() => independentRequests(page)).toHaveLength(3);
  const requests = await independentRequests(page);
  expect(requests.map(item => item.remoteIntent)).toEqual(['a', 'b', 'c'].map(id => ({ kind: 'reattach', remoteSessionId: `saved-${id}` })));
  expect(requests.every(item => item.sessionId === null)).toBe(true);
});

test('remote startup restores indexed sessions alongside an existing local session', async ({ page }) => {
  await installIndependentSessions(page, { indexed: true, initial: 'local' });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect.poll(() => independentRequests(page)).toHaveLength(3);
  expect((await independentRequests(page)).map(item => item.remoteIntent)).toEqual(['a', 'b', 'c'].map(id => ({ kind: 'reattach', remoteSessionId: `saved-${id}` })));
  await expect(page.locator('[role="tab"][data-session-id="new-3"]')).toBeVisible();
  await page.locator('.sidebar-host').getByRole('button', { name: '运行位置：测试远程主机' }).click();
  await page.getByRole('menuitemradio', { name: /本机/ }).click();
  await expect(page.locator('[role="tab"][data-session-id="original-a"]')).toBeVisible();
});

test('remote startup restores only missing identities when one indexed session is already attached', async ({ page }) => {
  await installIndependentSessions(page, { indexed: true, initial: 'saved-a' });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect.poll(() => independentRequests(page)).toHaveLength(2);
  expect((await independentRequests(page)).map(item => item.remoteIntent)).toEqual(['b', 'c'].map(id => ({ kind: 'reattach', remoteSessionId: `saved-${id}` })));
  for (const id of ['original-a', 'new-1', 'new-2']) await expect(page.locator(`[role="tab"][data-session-id="${id}"]`)).toBeVisible();
});

test('late remote index discovery preserves a newly launched session and still restores saved identities', async ({ page }) => {
  await installIndependentSessions(page, { indexed: true, empty: true, holdIndex: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __independentIndexPending: boolean }).__independentIndexPending)).toBe(true);
  await quickRemoteLaunch(page);
  await expect(page.locator('[role="tab"][data-session-id="new-1"]')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __releaseIndependentIndex: () => void }).__releaseIndependentIndex());
  await expect.poll(() => independentRequests(page)).toHaveLength(4);
  expect((await independentRequests(page)).map(item => item.remoteIntent)).toEqual([{ kind: 'new' }, ...['a', 'b', 'c'].map(id => ({ kind: 'reattach', remoteSessionId: `saved-${id}` }))]);
  for (const id of ['new-1', 'new-2', 'new-3', 'new-4']) await expect(page.locator(`[role="tab"][data-session-id="${id}"]`)).toBeVisible();
});

test('remote startup without an index does not create a session implicitly', async ({ page }) => {
  await installIndependentSessions(page, { empty: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有进行中的会话' })).toBeVisible();
  expect(await independentRequests(page)).toEqual([]);
});

test('failed same-directory quick launch keeps the old session and reports the new failure', async ({ page }) => {
  await installIndependentSessions(page, { fail: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('[role="tab"][data-session-id="original-a"]')).toBeVisible();
  await quickRemoteLaunch(page);
  await expect.poll(() => independentRequests(page)).toHaveLength(1);
  await expect(page.locator('[role="tab"][data-session-id="original-a"]')).toBeVisible();
  await expect(page.getByText('new remote process rejected', { exact: false })).toBeVisible();
});

test('remote readiness, disconnect, unknown and remote end stay distinct from CLI activity', async ({ page }) => {
  await installIndependentSessions(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage).toContainText('SSH · 连接中');
  const state = (patch: Record<string, unknown>) => page.evaluate(patch => (window as unknown as { __remoteState: (patch: Record<string, unknown>) => void }).__remoteState(patch), patch);
  await state({ connectionState: 'connected' });
  await expect(stage).toContainText('SSH · 已连接');
  await state({ running: false, connectionState: 'disconnected', reattachable: true, exitCode: 255 });
  await expect(stage).toContainText('SSH · 已断开，可重新附着');
  await expect(stage).toContainText('CLI 活动未知');
  await expect(page.getByRole('button', { name: '清理已结束', exact: true })).toHaveCount(0);
  await stage.getByRole('button', { name: '继续会话', exact: true }).first().click();
  await expect(stage).toContainText('SSH · 连接中');
  await expect(stage.locator('textarea')).toBeEnabled();
  await state({ running: false, connectionState: 'unknown', reattachable: true, exitCode: 46 });
  await expect(stage).toContainText('SSH · 远端状态未知');
  await state({ running: false, connectionState: 'remote_ended', reattachable: false, exitCode: 44 });
  await expect(stage).toContainText('SSH · 远端已结束');
  await expect(stage.getByRole('button', { name: '重新附着远程会话', exact: true })).toHaveCount(0);
});

test('an unconfirmed remote end preserves its tab, terminal and recovery action', async ({ page }) => {
  await installIndependentSessions(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.evaluate(() => { (window as unknown as { __remoteEndFails: boolean }).__remoteEndFails = true; });
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('button', { name: '结束此会话', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '结束进程', exact: true }).click();
  await expect(page.locator('[data-session-id="original-a"]')).toBeVisible();
  await expect(stage).toContainText('结束未确认，记录已保留');
  await expect(stage.locator('textarea')).toBeEnabled();
  await expect(stage.getByRole('button', { name: '结束此会话', exact: true })).toBeEnabled();
});

test('a selected session awaiting listing never displays or accepts input in the previous terminal', async ({ page }) => {
  await installIndependentSessions(page, { holdListAfterLaunch: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('[data-pane-session="original-a"]')).toBeVisible();
  await quickRemoteLaunch(page);
  await expect.poll(() => independentRequests(page)).toHaveLength(1);
  await expect(page.locator('[data-pane-session="original-a"]')).toBeHidden();
  await expect(page.locator('[data-pane-session="original-a"] textarea')).toBeDisabled();
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('正在读取会话');
  await page.evaluate(() => (window as unknown as { __remoteState: (patch: object) => void }).__remoteState({ connectionState: 'connected' }));
  await page.evaluate(() => (window as unknown as { __releaseIndependentList: () => void }).__releaseIndependentList());
  await expect(page.locator('[data-pane-session="new-1"]')).toBeVisible();
  await expect(page.locator('[data-pane-session="new-1"] textarea')).toBeEnabled();
  await page.locator('[data-session-id="original-a"]').click();
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('SSH · 已连接');
  await page.evaluate(() => (window as unknown as { __remoteExit: (revision: number) => void }).__remoteExit(0));
  await expect(page.locator('[data-pane-session="original-a"] textarea')).toBeEnabled();
});
