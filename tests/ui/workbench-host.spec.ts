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
  await expect.poll(() => page.evaluate(() => (window as unknown as { __libraryCalls: Array<{ command: string; targetId?: string; kind?: string }> }).__libraryCalls.filter((item) => item.command === 'list_remote_library_items'))).toEqual([
    { command: 'list_remote_library_items', targetId: host.id, kind: 'prompt' },
  ]);
});
