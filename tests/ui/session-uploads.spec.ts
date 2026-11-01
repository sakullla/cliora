import { expect, test, type Locator, type Page } from '@playwright/test';

const host = {
  id: 'host-1',
  name: '上传测试主机',
  host: '203.0.113.10',
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

const project = { id: 'proj-1', targetId: host.id, name: 'project', path: '/srv/project', preferredTool: 'codex', updatedAt: 1 };

/**
 * Workbench desktop mock with native drag-drop events and the upload IPC wired up.
 * `layout` picks the mounted sessions: one remote pane, two remote panes (split),
 * or a local pane. Browser mocks verify the routing and status behaviour only;
 * native platform acceptance is recorded separately.
 */
async function installUploadDesktop(page: Page, layout: 'remote' | 'two-remote' | 'local' = 'remote', bracketed = false) {
  await page.addInitScript(({ host, project, layout, bracketed }) => {
    if (layout !== 'local') localStorage.setItem('cliora:remote-target', host.id);
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const remoteSession = (id: string, tool: string) => ({
      id, toolId: tool, projectId: `remote:${project.id}`, directory: project.path, mode: 'normal', running: true,
      exitCode: null, startedAt: 1, remoteSessionId: `cliora-${id}`, connectionState: 'connected', reattachable: false, stateRevision: 0, remoteEndResult: null,
    });
    const sessions = layout === 'local'
      ? [{ id: 'local-1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: 1, stateRevision: 0 }]
      : layout === 'two-remote'
        ? [remoteSession('rs1', 'codex'), remoteSession('rs2', 'claude_code')]
        : [remoteSession('rs1', 'codex')];
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const registered = Object.entries(names).map(([id, name]) => ({
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    }));
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: Array<{ sessionId: string; text: string }> = [];
    const uploadCalls: Array<{ sessionId: string; projectId: string; targetId: string; localPaths: string[] | null; inlineFiles: Array<{ name: string; bytesBase64: string }> | null }> = [];
    let releaseHold = () => {};
    const holdReady = new Promise<void>(resolve => { releaseHold = resolve; });
    const uploadControls = { hold: false, released: false, failures: 0, failAt: 0, writeFailures: 0, failMessage: '远端写入失败' };
    Object.assign(window, {
      isTauri: true,
      __writes: writes,
      __uploadCalls: uploadCalls,
      __uploadControls: (patch: Partial<typeof uploadControls>) => Object.assign(uploadControls, patch),
      __releaseUpload: () => { uploadControls.released = true; releaseHold(); },
      __emitDrag: (payload: unknown) => bridge.handlers[bridge.listens['tauri://drag-drop']]?.({ payload }),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_projects') return [project];
          if (command === 'list_remote_directories') return { parent: args.parent, items: [], truncated: false };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions' || command === 'list_projects' || command === 'list_remote_sessions' || command === 'list_library_items') return command === 'list_workbench_sessions' ? sessions.map(item => ({ ...item })) : [];
          if (command === 'restore_workbench_sessions') return { restored: {}, failures: [] };
          if (command === 'replay_workbench_session') return btoa((bracketed ? '\x1b[?2004h' : '') + 'upload-fixture-ready\r\n> ');
          if (command === 'write_workbench_session') {
            if (uploadControls.writeFailures > 0) { uploadControls.writeFailures--; throw { message: 'PTY write failed' }; }
            const raw = Uint8Array.from(atob(args.dataBase64), c => c.charCodeAt(0));
            writes.push({ sessionId: args.sessionId, text: new TextDecoder().decode(raw) });
            return null;
          }
          if (command === 'resize_workbench_session' || command === 'close_workbench_session') return null;
          if (command === 'upload_session_files') {
            uploadCalls.push({
              sessionId: args.sessionId, projectId: args.projectId, targetId: args.targetId,
              localPaths: args.localPaths ?? null, inlineFiles: args.inlineFiles ?? null,
            });
            if (uploadControls.hold && !uploadControls.released) await holdReady;
            if (uploadControls.failAt === uploadCalls.length) throw { message: uploadControls.failMessage };
            if (uploadControls.failures > 0) { uploadControls.failures -= 1; throw { message: uploadControls.failMessage }; }
            const inputs = (args.localPaths as string[] | null) ?? (args.inlineFiles as Array<{ name: string }> | null)?.map(file => file.name) ?? [];
            return inputs.map(name => `${project.path}/.cliora/uploads/${String(name).split(/[\\/]/).pop()}`);
          }
          if (command === 'plugin:event|listen') { bridge.listens[String(args.event ?? '')] = Number(args.handler ?? 0); return args.handler ?? 0; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  }, { host, project, layout, bracketed });
}

async function openWorkbench(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前会话' })).toBeVisible();
}

/** Dispatch a native drop event over the middle of a pane; physical position follows the DPR. */
async function dropOnPane(page: Page, pane: Locator, paths: string[]) {
  const box = await pane.boundingBox();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.evaluate(({ point, paths }) => {
    const scale = window.devicePixelRatio || 1;
    (window as unknown as { __emitDrag: (payload: unknown) => void }).__emitDrag({
      type: 'drop', paths, position: { x: point.x * scale, y: point.y * scale },
    });
  }, { point, paths });
}

const writesFor = (page: Page, sessionId: string) => page.evaluate(
  sessionId => (window as unknown as { __writes: Array<{ sessionId: string; text: string }> }).__writes.filter(item => item.sessionId === sessionId).map(item => item.text),
  sessionId);
const uploadCalls = (page: Page) => page.evaluate(() => (window as unknown as { __uploadCalls: Array<Record<string, unknown>> }).__uploadCalls.slice());

test('retry keeps completed batches and a failed attempt pauses later drops', async ({ page }) => {
  await installUploadDesktop(page);
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await page.evaluate(() => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ failAt: 2 }));
  const files = Array.from({ length: 9 }, (_, i) => `C:/work/${i}.txt`);
  await dropOnPane(page, pane, files);
  await expect(page.getByRole('alert')).toContainText('远端写入失败');
  expect(await uploadCalls(page)).toHaveLength(2);
  await dropOnPane(page, pane, ['C:/work/later.txt']);
  await expect(page.getByRole('alert')).toContainText('远端写入失败');
  expect(await uploadCalls(page)).toHaveLength(2);
  expect(await writesFor(page, 'rs1')).toEqual([]);
  await page.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect.poll(async () => (await writesFor(page, 'rs1')).length).toBe(2);
  expect((await uploadCalls(page)).map(call => call.localPaths)).toEqual([
    files.slice(0, 8), files.slice(8), files.slice(8), ['C:/work/later.txt'],
  ]);
});

test('a PTY delivery failure retries the confirmed paths without uploading again', async ({ page }) => {
  await installUploadDesktop(page);
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ writeFailures: 1 }));
  await dropOnPane(page, page.locator('[data-pane-session="rs1"]'), ['C:/work/notes.md']);
  await expect(page.getByRole('alert')).toContainText('PTY write failed');
  await page.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect.poll(() => writesFor(page, 'rs1')).toEqual(['/srv/project/.cliora/uploads/notes.md']);
  expect(await uploadCalls(page)).toHaveLength(1);
});

test('an upload completing after switching panes stays in its originating session', async ({ page }) => {
  await installUploadDesktop(page, 'two-remote');
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ hold: true }));
  await dropOnPane(page, page.locator('[data-pane-session="rs1"]'), ['C:/work/background.md']);
  await expect(page.getByRole('status', { name: '正在上传文件到远程会话' })).toBeVisible();
  await page.locator('.xterm-helper-textarea:visible').press('Control+Tab');
  await expect(page.locator('[data-pane-session="rs2"]')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __releaseUpload: () => void }).__releaseUpload());
  await expect.poll(() => writesFor(page, 'rs1')).toEqual(['/srv/project/.cliora/uploads/background.md']);
  expect(await writesFor(page, 'rs2')).toEqual([]);
  await expect(page.locator('[data-pane-session="rs2"]')).toBeVisible();
});

test('a remote pane uploads dropped files, shows n/m progress and types the quoted remote paths', async ({ page }) => {
  await installUploadDesktop(page, 'remote');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await expect(pane).toBeVisible();
  await page.evaluate(hold => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ hold }), true);
  await dropOnPane(page, pane, ['C:/work/notes.md', 'C:/work/报告 v2.txt']);
  // In progress: honest counters, nothing typed yet.
  const progress = page.getByRole('status', { name: '正在上传文件到远程会话' });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('上传中 0 / 2');
  expect(await writesFor(page, 'rs1')).toEqual([]);
  await page.evaluate(() => (window as unknown as { __releaseUpload: () => void }).__releaseUpload());
  // Both files landed: one paste with the quoted joined remote paths, then focus.
  await expect.poll(() => writesFor(page, 'rs1')).toEqual(['/srv/project/.cliora/uploads/notes.md "/srv/project/.cliora/uploads/报告 v2.txt"']);
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(progress).toHaveCount(0);
  const calls = await uploadCalls(page);
  expect(calls.map(call => call.localPaths)).toEqual([['C:/work/notes.md', 'C:/work/报告 v2.txt']]);
  expect(calls.every(call => call.sessionId === 'rs1' && call.projectId === 'remote:proj-1' && call.targetId === 'host-1' && call.inlineFiles === null)).toBe(true);
});

test('a failed upload types no path, reports the error and retries with the same inputs', async ({ page }) => {
  await installUploadDesktop(page, 'remote');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await page.evaluate(message => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ failures: 1, failMessage: message }), '远端磁盘不可写');
  await dropOnPane(page, pane, ['C:/work/notes.md', 'C:/work/second.txt']);
  const alert = page.getByRole('alert').filter({ hasText: '文件上传失败' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('远端磁盘不可写');
  await expect(alert).not.toContainText(/配额|统计|批量清理|清理已上传/);
  expect(await writesFor(page, 'rs1')).toEqual([]);
  expect((await uploadCalls(page)).map(call => call.localPaths)).toEqual([['C:/work/notes.md', 'C:/work/second.txt']]);
  // Retry re-runs the same inputs and behaves like the first success.
  await page.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect.poll(() => writesFor(page, 'rs1')).toEqual(['/srv/project/.cliora/uploads/notes.md /srv/project/.cliora/uploads/second.txt']);
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
  expect((await uploadCalls(page)).map(call => call.localPaths)).toEqual([['C:/work/notes.md', 'C:/work/second.txt'], ['C:/work/notes.md', 'C:/work/second.txt']]);
});

test('a dropped directory reports the backend precheck error and types no path', async ({ page }) => {
  await installUploadDesktop(page, 'remote');
  await openWorkbench(page);
  await page.evaluate(message => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ failures: 1, failMessage: message }), '本地路径是目录，仅支持上传文件：C:/work/docs');
  await dropOnPane(page, page.locator('[data-pane-session="rs1"]'), ['C:/work/docs']);
  const alert = page.getByRole('alert').filter({ hasText: '文件上传失败' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('本地路径是目录，仅支持上传文件：C:/work/docs');
  expect(await writesFor(page, 'rs1')).toEqual([]);
});

test('a local pane still types the local paths directly and never calls the upload IPC', async ({ page }) => {
  await installUploadDesktop(page, 'local');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="local-1"]');
  await expect(pane).toBeVisible();
  await dropOnPane(page, pane, ['C:/work/notes.md', 'C:/work/本地 文档.txt']);
  await expect.poll(() => writesFor(page, 'local-1')).toEqual(['C:/work/notes.md "C:/work/本地 文档.txt"']);
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
  expect(await uploadCalls(page)).toEqual([]);
  await expect(page.getByRole('status', { name: '正在上传文件到远程会话' })).toHaveCount(0);
});

test('a split with two remote panes routes the dropped files to the pointed pane only', async ({ page }) => {
  await installUploadDesktop(page, 'two-remote');
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('button', { name: '分屏', exact: true }).click();
  const left = stage.locator('[data-pane-session="rs1"]');
  const right = stage.locator('[data-pane-session="rs2"]');
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await right.locator('.xterm-helper-textarea').focus();
  // The pointer is over the right pane; the focused/selected pane is irrelevant to routing.
  await dropOnPane(page, right, ['C:/work/right-side.md']);
  await expect.poll(() => writesFor(page, 'rs2')).toEqual(['/srv/project/.cliora/uploads/right-side.md']);
  expect(await writesFor(page, 'rs1')).toEqual([]);
  expect((await uploadCalls(page)).every(call => call.sessionId === 'rs2')).toBe(true);
  await expect(right.locator('.xterm-helper-textarea')).toBeFocused();
});

test('local image drops use the same adapter paste frames as uploaded images', async ({ page }) => {
  await installUploadDesktop(page, 'local', true);
  await openWorkbench(page);
  await dropOnPane(page, page.locator('[data-pane-session="local-1"]'), ['C:\\work\\one.png', 'C:\\work\\two shots.png']);
  await expect.poll(() => writesFor(page, 'local-1')).toEqual(['\x1b[200~C:/work/one.png\x1b[201~\x1b[200~"C:/work/two shots.png"\x1b[201~']);
  expect(await uploadCalls(page)).toEqual([]);
});
