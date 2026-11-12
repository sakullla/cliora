import { expect, test, type Page } from '@playwright/test';

const host = {
  id: 'host-1', name: '标题栏测试主机', host: '203.0.113.10', port: 22, user: 'root', authMethod: 'key', identityFile: '',
  sshConfig: null, defaultPath: '/srv/project', enabled: true, createdAt: 1, updatedAt: 1,
};
const project = { id: 'proj-1', targetId: host.id, name: 'project', path: '/srv/project', preferredTool: 'codex', updatedAt: 1 };
const longRemoteId = 'cliora-c1c75996-0e46-4936-9e6e-a5ae39726ed8-07921480e2c64e0cacc7951009d847eb';

type Layout = 'local' | 'remote' | 'remote-twins' | 'long-folder';
const longFolder = '/Users/me/project/qsyn/e6-ms-tms-base-new-mes-fetch';

/**
 * Minimal workbench desktop mock for the title bar. Browser mocks verify what the bar shows;
 * native platform acceptance is recorded separately.
 */
async function installDesktop(page: Page, layout: Layout) {
  await page.addInitScript(({ host, project, layout, longRemoteId, longFolder }) => {
    const remoteLayout = layout === 'remote' || layout === 'remote-twins';
    if (remoteLayout) localStorage.setItem('cliora:remote-target', host.id);
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const startedAt = Date.now() - 14 * 60_000;
    const remote = (id: string, remoteSessionId: string) => ({
      id, toolId: 'claude_code', projectId: `remote:${project.id}`, directory: project.path, mode: 'normal', running: true,
      exitCode: null, startedAt, remoteSessionId, connectionState: 'connected', reattachable: false, stateRevision: 0, remoteEndResult: null,
    });
    const sessions = layout === 'long-folder'
      ? [{ id: 'long-1', toolId: 'codex', projectId: null, directory: longFolder, mode: 'normal', running: true, exitCode: null, startedAt, stateRevision: 0 }]
      : layout === 'local'
      ? [
        { id: 'local-1', toolId: 'codex', projectId: null, directory: 'C:/work/alpha', mode: 'normal', running: true, exitCode: null, startedAt, stateRevision: 0 },
        { id: 'local-old', toolId: 'claude_code', projectId: null, directory: 'C:/work/beta', mode: 'normal', running: false, exitCode: 0, startedAt, stateRevision: 0 },
      ]
      : layout === 'remote' ? [remote('rs1', longRemoteId)] : [remote('rs1', 'cliora-aaaa1111'), remote('rs2', 'cliora-bbbb2222')];
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const registered = Object.entries(names).map(([id, name]) => ({
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    }));
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __emit: (event: string, payload: unknown) => bridge.handlers[bridge.listens[event]]?.({ payload }),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: remoteLayout }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_projects') return [project];
          if (command === 'list_remote_directories') return { parent: args.parent, items: [], truncated: false };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map(item => ({ ...item }));
          if (command === 'restore_workbench_sessions') return { restored: {}, failures: [] };
          // The CLI titles its window "task | folder", as Codex does; the folder name has hyphens.
          if (command === 'replay_workbench_session') return layout === 'long-folder'
            ? btoa(String.fromCharCode(...new TextEncoder().encode('\u001b]0;Write the API | e6-ms-tms-base-new-mes-fetch\u0007titlebar-fixture-ready\r\n> ')))
            : btoa('titlebar-fixture-ready\r\n> ');
          if (command === 'write_workbench_session' || command === 'resize_workbench_session' || command === 'close_workbench_session') return null;
          if (command === 'plugin:event|listen') { bridge.listens[String(args.event ?? '')] = Number(args.handler ?? 0); return args.handler ?? 0; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  }, { host, project, layout, longRemoteId, longFolder });
}

async function openWorkbench(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage).toBeVisible();
  return stage;
}

test('the title bar names the CLI by its icon and keeps the running time at every width', async ({ page }) => {
  await installDesktop(page, 'local');
  const stage = await openWorkbench(page);
  const bar = stage.locator('header').first();
  await expect(bar.getByRole('img', { name: 'Codex' })).toBeVisible();
  const elapsed = bar.getByTitle('会话时长 14m');
  await expect(elapsed).toHaveText('14m');
  // A session without a CLI title is headed by the CLI name once, never a second time as context.
  await expect(bar.getByText('Codex', { exact: true })).toHaveCount(1);
  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(elapsed).toBeVisible();
    // Whatever context is left is fully inside the bar: nothing is cut off mid-chip.
    const clipped = () => bar.evaluate((element) => {
      const row = element.querySelector('[class*="identitySub"]');
      if (!row) return [];
      const frame = row.getBoundingClientRect();
      return [...row.children].filter((child) => {
        const box = child.getBoundingClientRect();
        const shown = box.width > 0 && box.top < frame.bottom - 1;
        // The directory chip's hover padding hangs 6px outside the row; its content does not.
        return shown && box.right > frame.right + 7;
      }).map((child) => child.textContent);
    });
    await expect.poll(clipped, `clipped context at ${width}`).toEqual([]);
    // The directory gives way by shortening; it is still there while the bar has room for it.
    if (width >= 900) await expect(bar.getByRole('button', { name: /alpha/ })).toBeVisible();
  }
});

test('the running time stops when the session ends, and an already-ended session shows none', async ({ page }) => {
  await installDesktop(page, 'local');
  await page.clock.install();
  const stage = await openWorkbench(page);
  const bar = stage.locator('header').first();
  await expect(bar.getByTitle('会话时长 14m')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit('cliora:session-exit', { sessionId: 'local-1', exitCode: 0 }));
  // A clean exit is told by the ended banner; the title bar keeps only a failing code.
  await expect(stage.getByText('此会话进程已结束')).toBeVisible();
  await expect(bar.getByText('退出码 0')).toHaveCount(0);
  await page.clock.fastForward(30 * 60_000);
  await expect(bar.getByTitle('会话时长 14m')).toBeVisible();
  await expect(bar.getByTitle(/会话时长 4\dm/)).toHaveCount(0);
  // The other session was over before the app listed it: its end is unknown, so no time is claimed.
  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await expect(bar.getByRole('img', { name: 'Claude Code' })).toBeVisible();
  await expect(bar.getByTitle(/会话时长/)).toHaveCount(0);
});

test('a lone remote session shows no id suffix and the status bar keeps the remote id in a tooltip', async ({ page }) => {
  await installDesktop(page, 'remote');
  const stage = await openWorkbench(page);
  await expect(stage).toContainText('SSH · 已连接');
  await expect(stage).not.toContainText('09d847eb');
  await expect(stage).not.toContainText(longRemoteId);
  await expect(stage.getByTitle(new RegExp(`远端会话 ID：${longRemoteId}`))).toHaveText('SSH · 已连接');
  await expect(page.getByRole('tab', { name: /09d847eb/ })).toHaveCount(0);
});

test('a hyphenated folder suffix leaves the task title, and the folder chip keeps the distinguishing end', async ({ page }) => {
  await installDesktop(page, 'long-folder');
  const stage = await openWorkbench(page);
  const bar = stage.locator('header').first();
  await expect(bar.getByRole('heading', { level: 2 })).toHaveText('Write the API');
  await expect(page.getByRole('tab', { name: /Write the API/ })).not.toContainText('| e6-');
  const chip = bar.getByRole('button', { name: /mes-fetch/ });
  await expect(chip).toHaveText(/qsyn\/e6-ms-tms-base-new-mes-fetch$/);
  await expect(chip).toHaveAttribute('title', /qsyn\/e6-ms-tms-base-new-mes-fetch/);
  // A short chip folds from the left: parent folders, then the folder's head; its end stays whole.
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(chip.getByText('…/qsyn/')).toHaveJSProperty('clientWidth', 0);
  const tail = chip.getByText('mes-fetch', { exact: true });
  await expect.poll(() => tail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect.poll(() => tail.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(20);
});

test('remote sessions that would read the same keep their id suffix', async ({ page }) => {
  await installDesktop(page, 'remote-twins');
  await openWorkbench(page);
  await expect(page.getByRole('tab', { name: /aaaa1111/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /bbbb2222/ })).toBeVisible();
});
