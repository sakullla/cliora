import { loadApp } from './loadApp';
import { expect, test, type Locator, type Page } from '@playwright/test';

const host = {
  id: 'host-1',
  name: '粘贴测试主机',
  host: '203.0.113.20',
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
 * Workbench desktop mock with the upload IPC and session output wired up, so a
 * paste event with an image item can be routed end to end. Browser mocks verify
 * the routing and status behaviour only; native platform acceptance (real PNG
 * encoding in the WebView, real SSH transfer) is recorded separately.
 */
async function installPasteDesktop(page: Page, layout: 'remote' | 'local' = 'remote', toolId = 'codex', bracketed = false) {
  await page.addInitScript(({ host, project, layout, toolId, bracketed }) => {
    if (layout !== 'local') localStorage.setItem('cliora:remote-target', host.id);
    const names: Record<string, string> = { [toolId]: toolId };
    const sessions = layout === 'local'
      ? [{ id: 'local-1', toolId, projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: 1, stateRevision: 0 }]
      : [{ id: 'rs1', toolId, projectId: `remote:${project.id}`, directory: project.path, mode: 'normal', running: true, exitCode: null, startedAt: 1, remoteSessionId: 'cliora-rs1', connectionState: 'connected', reattachable: false, stateRevision: 0, remoteEndResult: null }];
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const registered = Object.entries(names).map(([id, name]) => ({
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    }));
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: Array<{ sessionId: string; text: string }> = [];
    const uploadCalls: Array<{ sessionId: string; projectId: string; localPaths: string[] | null; inlineFiles: Array<{ name: string; bytesBase64: string }> | null }> = [];
    const clipboardWrites: string[] = [];
    const uploadControls = { hold: false, released: false, failures: 0, failMessage: '远端写入失败' };
    let releaseHold = () => {};
    const holdReady = new Promise<void>(resolve => { releaseHold = resolve; });
    // The OSC 52 handler only writes the local clipboard; record writes instead of
    // relying on real clipboard permissions.
    try {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => { clipboardWrites.push(text); } });
    } catch { /* A restricted context keeps the real clipboard. */ }
    Object.assign(window, {
      isTauri: true,
      __writes: writes,
      __uploadCalls: uploadCalls,
      __clipboardWrites: clipboardWrites,
      __uploadControls: (patch: Partial<typeof uploadControls>) => Object.assign(uploadControls, patch),
      __releaseUpload: () => { uploadControls.released = true; releaseHold(); },
      __output: (text: string) => {
        const bytes = new TextEncoder().encode(text);
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId: 'rs1', dataBase64: btoa(String.fromCharCode(...bytes)) } });
      },
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
          if (command === 'replay_workbench_session') return btoa((bracketed ? '\x1b[?2004h' : '') + 'paste-fixture-ready\r\n> ');
          if (command === 'write_workbench_session') {
            const raw = Uint8Array.from(atob(args.dataBase64), c => c.charCodeAt(0));
            writes.push({ sessionId: args.sessionId, text: new TextDecoder().decode(raw) });
            return null;
          }
          if (command === 'resize_workbench_session' || command === 'close_workbench_session') return null;
          if (command === 'stage_session_paste_files') return (args.inlineFiles as Array<{ name: string }>).map(file => `C:/fixture/${file.name}`);
          if (command === 'upload_session_files') {
            uploadCalls.push({ sessionId: args.sessionId, projectId: args.projectId, localPaths: args.localPaths ?? null, inlineFiles: args.inlineFiles ?? null });
            if (uploadControls.hold && !uploadControls.released) await holdReady;
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
  }, { host, project, layout, toolId, bracketed });
}


async function openWorkbench(page: Page) {
  await loadApp(page);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前会话' })).toBeVisible();
}

/** Dispatch a paste event on the pane's terminal textarea: text, a real PNG file item, or junk bytes. */
async function pasteOnPane(page: Page, pane: Locator, payload: { text?: string; png?: boolean; junk?: boolean }) {
  await pane.locator('.xterm-helper-textarea').evaluate((node, payload) => {
    const data = new DataTransfer();
    if (payload.text !== undefined) data.setData('text/plain', payload.text);
    if (payload.png || payload.junk) {
      let bytes: Uint8Array;
      if (payload.png) {
        // A real PNG drawn here, so production decoding/validation runs.
        const canvas = document.createElement('canvas');
        canvas.width = 6;
        canvas.height = 4;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#336699';
        context.fillRect(0, 0, 6, 4);
        const url = canvas.toDataURL('image/png');
        const binary = atob(url.slice(url.indexOf(',') + 1));
        bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      } else {
        bytes = new TextEncoder().encode('definitely not an image');
      }
      data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    }
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, payload);
}

const writesFor = (page: Page, sessionId: string) => page.evaluate(
  sessionId => (window as unknown as { __writes: Array<{ sessionId: string; text: string }> }).__writes.filter(item => item.sessionId === sessionId).map(item => item.text),
  sessionId);
const uploadCalls = (page: Page) => page.evaluate(() => (window as unknown as { __uploadCalls: Array<Record<string, unknown>> }).__uploadCalls.slice());
const pasteName = /^cliora-paste-\d{8}-\d{6}-\d{3}\.png$/;

// Every terminal adapter registered by Cliora. Desktop launchers do not own a PTY.
for (const [tool, prefix] of [
  ['codex', ''], ['claude_code', ''], ['grok', ''], ['pi', ''], ['opencode', ''],
  ['qoder_cn', '@'], ['kimi_code', '@'], ['codebuddy', ''], ['mimo_code', ''],
  ['cline', '@'], ['devin', '@'], ['command_code', ''], ['antigravity', '@'],
  ['kiro', ''], ['minimax_code', '@'],
]) {
  test(`${tool} uses its adapter's attachment payload over negotiated bracketed paste`, async ({ page }) => {
    await installPasteDesktop(page, 'remote', tool, true);
    await openWorkbench(page);
    await pasteOnPane(page, page.locator('[data-pane-session="rs1"]'), { png: true });
    await expect.poll(async () => (await writesFor(page, 'rs1')).length).toBe(1);
    const [text] = await writesFor(page, 'rs1');
    expect(text.startsWith(`\x1b[200~${prefix}/srv/project/.cliora/uploads/`)).toBe(true);
    expect(text.endsWith('.png\x1b[201~')).toBe(true);
    expect(text).not.toContain('\x16');
    expect(text).not.toMatch(/[\r\n]/);
  });
}

test('multiple pasted files keep their names and bytes in a single transfer', async ({ page }) => {
  await installPasteDesktop(page);
  await openWorkbench(page);
  await page.locator('.xterm-helper-textarea:visible').evaluate(node => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0, 255, 1, 2])], 'binary.dat', { type: 'application/octet-stream' }));
    data.items.add(new File(['中文资料'], '说明.txt', { type: 'text/plain' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await writesFor(page, 'rs1')).length).toBe(1);
  const calls = await uploadCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].inlineFiles).toEqual([
    { name: 'binary.dat', bytesBase64: 'AP8BAg==' },
    { name: '说明.txt', bytesBase64: Buffer.from('中文资料').toString('base64') },
  ]);
});

test('the paste menu uploads PNG bytes without recompression', async ({ page }) => {
  await installPasteDesktop(page);
  await openWorkbench(page);
  const expectedBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const original = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    // Trailing bytes distinguish original PNG reuse from canvas recompression.
    const blob = new Blob([original, 'preserve-original-bytes'], { type: 'image/png' });
    Object.defineProperty(navigator.clipboard, 'read', { value: async () => [new ClipboardItem({ 'image/png': blob })] });
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  await page.locator('[data-pane-session="rs1"] .xterm-screen').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^粘贴/ }).click();
  await expect.poll(async () => (await writesFor(page, 'rs1')).length).toBe(1);
  expect((await uploadCalls(page))[0].inlineFiles).toEqual([{ name: expect.stringMatching(pasteName), bytesBase64: expectedBytes }]);
});

test('the paste menu can read text when the rich clipboard API is denied', async ({ page }) => {
  await installPasteDesktop(page);
  await openWorkbench(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'read', { value: async () => { throw new Error('unsupported'); } });
    Object.defineProperty(navigator.clipboard, 'readText', { value: async () => '菜单粘贴文本' });
  });
  await page.locator('[data-pane-session="rs1"] .xterm-screen').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^粘贴/ }).click();
  await expect.poll(() => writesFor(page, 'rs1')).toEqual(['菜单粘贴文本']);
  expect(await uploadCalls(page)).toEqual([]);
});

test('two images remain separate Codex paste frames after one upload batch', async ({ page }) => {
  await installPasteDesktop(page, 'remote', 'codex', true);
  await openWorkbench(page);
  await page.locator('.xterm-helper-textarea:visible').evaluate(async node => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const data = new DataTransfer();
    for (let i = 0; i < 2; i++) data.items.add(new File([blob], `image-${i}.png`, { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await writesFor(page, 'rs1')).length).toBe(1);
  const [text] = await writesFor(page, 'rs1');
  expect(text.match(/\x1b\[200~/g)).toHaveLength(2);
  expect(text.match(/\x1b\[201~/g)).toHaveLength(2);
  expect(await uploadCalls(page)).toHaveLength(1);
});

test('a remote pane pastes an image-only clipboard as a timestamped PNG upload and types the remote path', async ({ page }) => {
  await installPasteDesktop(page, 'remote');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await expect(pane).toBeVisible();
  await page.evaluate(hold => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ hold }), true);
  await pasteOnPane(page, pane, { png: true });
  // In progress: nothing typed while the encoded upload is in flight.
  const progress = page.getByRole('status', { name: '正在上传文件到远程会话' });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('上传中 0 / 1');
  expect(await writesFor(page, 'rs1')).toEqual([]);
  await page.evaluate(() => (window as unknown as { __releaseUpload: () => void }).__releaseUpload());
  // The upload carries the timestamped name and real PNG bytes; the pane types the
  // claimed remote path and takes focus.
  await expect.poll(async () => await writesFor(page, 'rs1')).toEqual([expect.stringMatching(/^\/srv\/project\/\.cliora\/uploads\/cliora-paste-\d{8}-\d{6}-\d{3}\.png$/)]);
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(progress).toHaveCount(0);
  const calls = await uploadCalls(page);
  expect(calls.length).toBe(1);
  expect(calls[0].sessionId).toBe('rs1');
  expect(calls[0].projectId).toBe('remote:proj-1');
  expect(calls[0].localPaths).toBe(null);
  const inline = calls[0].inlineFiles as Array<{ name: string; bytesBase64: string }>;
  expect(inline.length).toBe(1);
  expect(inline[0].name).toMatch(pasteName);
  // PNG magic bytes survive the upload.
  expect(inline[0].bytesBase64.startsWith('iVBORw0KGgo')).toBe(true);
});

test('a failed paste upload types no path, reports the error and retries to the same behaviour', async ({ page }) => {
  await installPasteDesktop(page, 'remote');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await expect(pane).toBeVisible();
  await page.evaluate(message => (window as unknown as { __uploadControls: (patch: object) => void }).__uploadControls({ failures: 1, failMessage: message }), '远端磁盘不可写');
  await pasteOnPane(page, pane, { png: true });
  const alert = page.getByRole('alert').filter({ hasText: '文件上传失败' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('远端磁盘不可写');
  expect(await writesFor(page, 'rs1')).toEqual([]);
  expect((await uploadCalls(page)).length).toBe(1);
  // Retry re-runs the same encoded image and behaves like the first success.
  await page.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect.poll(async () => (await writesFor(page, 'rs1'))[0]).toMatch(/^\/srv\/project\/\.cliora\/uploads\/cliora-paste-\d{8}-\d{6}-\d{3}\.png$/);
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
  const calls = await uploadCalls(page);
  expect(calls.length).toBe(2);
  const first = (calls[0].inlineFiles as Array<{ name: string }>)[0].name;
  const retry = (calls[1].inlineFiles as Array<{ name: string }>)[0].name;
  expect(retry).toBe(first);
});

test('an image that fails to decode or re-encode reports the failure and never calls the upload IPC', async ({ page }) => {
  await installPasteDesktop(page, 'remote');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await expect(pane).toBeVisible();
  await pasteOnPane(page, pane, { junk: true });
  const alert = page.getByRole('alert').filter({ hasText: '文件上传失败' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('剪贴板图片转 PNG 失败');
  await expect(page.getByRole('button', { name: '重试上传', exact: true })).toBeVisible();
  expect(await writesFor(page, 'rs1')).toEqual([]);
  expect(await uploadCalls(page)).toEqual([]);
});

test('a clipboard with text still pastes as text on a remote pane and uploads nothing', async ({ page }) => {
  await installPasteDesktop(page, 'remote');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await expect(pane).toBeVisible();
  // Text wins even when a file item rides along.
  await pasteOnPane(page, pane, { text: '粘贴的远端文本', png: true });
  await expect.poll(() => writesFor(page, 'rs1')).toEqual(['粘贴的远端文本']);
  expect(await uploadCalls(page)).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('status', { name: '正在上传文件到远程会话' })).toHaveCount(0);
});

test('a local pane stages image bytes and pastes their path without a simulated shortcut', async ({ page }) => {
  await installPasteDesktop(page, 'local');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="local-1"]');
  await expect(pane).toBeVisible();
  await pasteOnPane(page, pane, { png: true });
  await expect.poll(() => writesFor(page, 'local-1')).toEqual([expect.stringMatching(/^C:\/fixture\/cliora-paste-.*\.png$/)]);
  expect(await uploadCalls(page)).toEqual([]);
});

test('pasting an image inside the quick composer stages and inserts its path into the session', async ({ page }) => {
  await installPasteDesktop(page, 'local');
  await openWorkbench(page);
  await page.getByRole('button', { name: '快捷输入', exact: true }).click();
  const composer = page.getByRole('region', { name: '多行输入与提示词' }).getByRole('textbox');
  await expect(composer).toBeVisible();
  await composer.evaluate((node) => {
    const data = new DataTransfer();
    const canvas = document.createElement('canvas');
    canvas.width = 6;
    canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#225544';
    context.fillRect(0, 0, 6, 4);
    const url = canvas.toDataURL('image/png');
    const binary = atob(url.slice(url.indexOf(',') + 1));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    data.items.add(new File([bytes], 'composer-shot.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => writesFor(page, 'local-1')).toEqual([expect.stringMatching(/^C:\/fixture\/cliora-paste-.*\.png$/)]);
});

test('OSC 52 keeps its write-only behaviour: writes land in the clipboard, queries are ignored, nothing is sent back', async ({ page }) => {
  await installPasteDesktop(page, 'remote');
  await openWorkbench(page);
  const pane = page.locator('[data-pane-session="rs1"]');
  await expect(pane).toBeVisible();
  const encoded = btoa('osc52-copy');
  await page.evaluate(text => (window as unknown as { __output: (text: string) => void }).__output(text), `\x1b]52;c;${encoded}\x07`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites)).toEqual(['osc52-copy']);
  // A query and an empty payload stay ignored: no clipboard write, no PTY input.
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b]52;c;?\x07'));
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b]52;c;\x07'));
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites)).toEqual(['osc52-copy']);
  expect(await writesFor(page, 'rs1')).toEqual([]);
});
