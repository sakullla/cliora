import { expect, test, type Locator, type Page } from '@playwright/test';

// The existing accessible scrollbar exposes the public buffer's row position.
// xterm 6 virtualizes scrolling instead of assigning a native DOM scrollTop.
function scrollState(node: Element) {
  const scrollbar = node.closest('[data-pane-session]')?.querySelector('[role="scrollbar"]');
  const top = Number(scrollbar?.getAttribute('aria-valuenow') ?? 0);
  const max = Number(scrollbar?.getAttribute('aria-valuemax') ?? 0);
  return { top, max, remaining: max - top, ratio: max ? top / max : 0 };
}
const readScroll = (viewport: Locator) => viewport.evaluate(scrollState);
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
// These real terminal renderers share the software GPU. Keep this file on one
// worker so competing contexts cannot starve its rendering assertions.
test.describe.configure({ mode: 'default' });

test.describe('product WebGL input integration', () => {
  test('composition retains its text and anchor while the real renderer receives output', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    await expect(page.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible();
    const textarea = page.locator('.xterm-helper-textarea:visible');
    await textarea.focus();
    await resetWrites(page);
    const before = await textarea.evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      (input as HTMLTextAreaElement).value = '你好7，';
      input.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你好7，', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, isComposing: true, bubbles: true }));
      return { left: (input as HTMLElement).style.left, top: (input as HTMLElement).style.top };
    });
    await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b[10;20Hbackground redraw'));
    await expect(textarea).toHaveValue('你好7，');
    expect(await textarea.evaluate(input => ({ left: (input as HTMLElement).style.left, top: (input as HTMLElement).style.top }))).toEqual(before);
    expect(await writes(page)).toEqual([]);
    await textarea.dispatchEvent('compositionend', { data: '你好7，' });
    await expect.poll(async () => (await writes(page)).join('')).toBe('你好7，');
    expect(await textarea.evaluate(input => document.activeElement === input)).toBe(true);
  });
});

test('terminal code loads on demand and an opening request survives the first module load', async ({ page }) => {
  await installWorkbenchMock(page);
  let loads = 0;
  let release = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/SessionWorkbench-*.js', async route => { loads++; await ready; await route.continue(); });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '页面' })).toBeVisible();
  expect(loads).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { toolId: 'codex', targetId: 'local' } })));
  await expect.poll(() => loads).toBe(1);
  release();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Codex');
});

/** Synthetic native IPC shared by the workbench terminal tests. */
async function installWorkbenchMock(page: Page, holdStartup = false) {
  await page.addInitScript((holdStartup) => {
    let releaseStartup = () => {};
    const startupReady = new Promise<void>((resolve) => { releaseStartup = resolve; });
    const sessions = [{ id: 's1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: (window as unknown as { __oldSessions?: boolean }).__oldSessions ? 1 : Date.now() }];
    if ((window as unknown as { __twoSessions?: boolean }).__twoSessions) sessions.push({ id: 's2', toolId: 'claude_code', projectId: null, directory: 'D:/a-long-project-directory/for-the-second-session', mode: 'yolo', running: true, exitCode: null, startedAt: Date.now() });
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: string[] = [];
    const writeBytes: number[][] = [];
    const writeLog: Array<{ sessionId: string; text: string }> = [];
    const opened: string[] = [];
    const pathOpens: Array<{ sessionId: string; path: string; cwd?: string }> = [];
    const resizes: Array<{ sessionId: string; cols: number; rows: number }> = [];
    Object.assign(window, {
      isTauri: true,
      __resizes: resizes,
      __writes: writes,
      __writeBytes: writeBytes,
      __writeLog: writeLog,
      __opened: opened,
      __pathOpens: pathOpens,
      __releaseStartup: releaseStartup,
      __output: (text: string, sessionId = 's1', offset?: number) => {
        const bytes = new TextEncoder().encode(text);
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId, dataBase64: btoa(String.fromCharCode(...bytes)), ...(offset === undefined ? {} : { offset }) } });
      },
      __exit: (exitCode: number | null, sessionId = 's1') => {
        bridge.handlers[bridge.listens['cliora:session-exit']]?.({ payload: { sessionId, exitCode } });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (holdStartup && ['list_projects', 'get_launch_settings', 'list_remote_targets', 'list_remote_sessions'].includes(command)) await startupReady;
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: 'light', remote_ssh_enabled: holdStartup }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }, { id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: args.theme }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }, { id: 'claude_code', name: 'Claude Code', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex', 'claude_code'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'set_workbench_directory') {
            const session = sessions.find(item => item.id === args.sessionId);
            if (session) session.directory = args.directory;
            return args.directory;
          }
          if (command === 'open_workbench_path') {
            pathOpens.push({ sessionId: args.sessionId, path: args.path, cwd: sessions.find(item => item.id === args.sessionId)?.directory });
            if ((window as unknown as { __failPathOpen?: boolean }).__failPathOpen) throw new Error('文件或文件夹不存在');
            return null;
          }
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'restore_workbench_sessions') {
            const harness = window as unknown as { __restoreReport?: unknown; __restoreCalls?: number };
            harness.__restoreCalls = (harness.__restoreCalls ?? 0) + 1;
            return harness.__restoreReport ?? { restored: {}, failures: [] };
          }
          if (command === 'forget_workbench_restore') { Object.assign(window, { __forgottenRestore: args.sessionId }); return null; }
          if (command === 'open_external_url') {
            if ((window as unknown as { __failOpen?: boolean }).__failOpen) throw new Error('浏览器不可用');
            opened.push(args.url);
            return null;
          }
          if (command === 'replay_workbench_session') return (window as unknown as { __replayOverride?: string }).__replayOverride ?? btoa(args.sessionId === 's2' ? 'claude-ready\r\n> ' : 'codex-ready\r\n> ');
          if (command === 'write_workbench_session') {
            const raw = Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0));
            const text = new TextDecoder().decode(raw);
            writes.push(text);
            writeBytes.push([...raw]);
            writeLog.push({ sessionId: args.sessionId, text });
            const beforeWrite = (window as unknown as { __beforeWrite?: (sessionId: string, text: string) => Promise<void> }).__beforeWrite;
            if (beforeWrite) await beforeWrite(args.sessionId, text);
            return null;
          }
          if (command === 'resize_workbench_session') { resizes.push({ sessionId: args.sessionId, cols: args.cols, rows: args.rows }); return null; }
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  }, holdStartup);
}

test('CLI output and terminal replies do not wait for project, host or settings discovery', async ({ page }) => {
  await installWorkbenchMock(page, true);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b[6n'));
  await expect.poll(() => writes(page)).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
  // Auxiliary data finishing later must not overwrite an exit received meanwhile.
  await page.evaluate(() => (window as unknown as { __exit: (code: number) => void }).__exit(0));
  await page.evaluate(() => (window as unknown as { __releaseStartup: () => void }).__releaseStartup());
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('此会话进程已结束');
});

test('shell current-directory metadata updates the visible path without parsing ordinary output', async ({ page }) => {
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('C:/work');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b]7;file:///C:/cliora%20project\x07'));
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('C:\\cliora project');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('ordinary text C:/ignored'));
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('C:\\cliora project');
});

async function openWorkbench(page: Page, english = false) {
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: english ? 'Pages' : '页面' }).getByRole('button', { name: english ? 'Workbench' : '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  await expect(page.getByTitle('拖入文件可插入路径')).toHaveCount(0);
  const input = page.locator('.xterm-helper-textarea:visible');
  await input.focus();
  return input;
}

const writes = (page: Page) => page.evaluate(() => (window as unknown as { __writes: string[] }).__writes.slice());
const resetWrites = (page: Page) => page.evaluate(() => { (window as unknown as { __writes: string[] }).__writes.length = 0; });
const openedUrls = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.slice());

test('terminal and quick input preserve session order while another session stays independent', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  const input = await openWorkbench(page);
  await page.evaluate(() => {
    let release = () => {};
    const ready = new Promise<void>(resolve => { release = resolve; });
    (window as unknown as { __writeLog: unknown[] }).__writeLog.length = 0;
    Object.assign(window, {
      __releaseWrite: release,
      __beforeWrite: async (id: string, text: string) => { if (id === 's1' && text === 'b') await ready; },
    });
  });
  await input.press('b');
  await input.press('Enter');
  await page.getByRole('button', { name: '快捷输入', exact: true }).click();
  const composer = page.getByRole('region', { name: '多行输入与提示词投递' });
  await composer.locator('textarea').fill('quick-command');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await page.locator('.xterm-helper-textarea:visible').press('x');
  await expect.poll(() => writeLog(page)).toEqual([{ sessionId: 's1', text: 'b' }, { sessionId: 's2', text: 'x' }]);
  await page.evaluate(() => (window as unknown as { __releaseWrite: () => void }).__releaseWrite());
  await expect.poll(() => writeLog(page)).toEqual([
    { sessionId: 's1', text: 'b' }, { sessionId: 's2', text: 'x' },
    { sessionId: 's1', text: '\r' }, { sessionId: 's1', text: 'quick-command\r' },
  ]);
});

test('a failed input reports its error and releases queued and later input', async ({ page }) => {
  const input = await openWorkbench(page);
  await page.evaluate(() => {
    let reject = (_error: Error) => {};
    const ready = new Promise<void>((_resolve, fail) => { reject = fail; });
    (window as unknown as { __writeLog: unknown[] }).__writeLog.length = 0;
    Object.assign(window, {
      __rejectWrite: () => reject(new Error('input-write-failed')),
      __beforeWrite: async (_id: string, text: string) => { if (text === 'b') await ready; },
    });
  });
  await input.press('b');
  await input.press('Enter');
  expect(await writeLog(page)).toEqual([{ sessionId: 's1', text: 'b' }]);
  await page.evaluate(() => (window as unknown as { __rejectWrite: () => void }).__rejectWrite());
  await expect(page.getByRole('alert')).toContainText('input-write-failed');
  await expect.poll(() => writeLog(page)).toEqual([{ sessionId: 's1', text: 'b' }, { sessionId: 's1', text: '\r' }]);
  await input.press('z');
  await expect.poll(() => writeLog(page)).toEqual([
    { sessionId: 's1', text: 'b' }, { sessionId: 's1', text: '\r' }, { sessionId: 's1', text: 'z' },
  ]);
});

async function pointForTerminalText(page: Page, text: string, last = false) {
  const locate = () => page.evaluate(({ text, last }) => {
    const rows = [...document.querySelectorAll<HTMLElement>('.xterm-rows > div')].filter((row) => row.getClientRects().length);
    if (last) rows.reverse();
    for (const row of rows) {
      const content = row.textContent ?? '';
      const start = content.indexOf(text);
      if (start < 0) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (start >= offset && start < offset + length) {
          const range = document.createRange();
          range.setStart(node, start - offset);
          range.setEnd(node, start - offset + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width && rect.height) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        offset += length;
        node = walker.nextNode();
      }
    }
    return null;
  }, { text, last });
  await expect.poll(locate).not.toBeNull();
  return (await locate())!;
}

test('live output and idle waiting keep distinct activity icons in every workbench slot', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkbench(page);
  const root = page.locator('[data-term-theme]');
  // Wide windows dock the session list in the app sidebar, outside the workbench root.
  const workbench = page.locator('.shell');
  const stage = page.getByRole('region', { name: '当前会话' });
  const statusIcon = root.locator('[data-activity-slot="status"]');
  const idleBox = await statusIcon.boundingBox();

  await expect(workbench.locator('[data-activity-icon="idle"]')).toHaveCount(4);
  await expect(statusIcon.locator('svg')).toHaveAttribute('data-shape', 'idle');
  await expect(statusIcon.locator('circle')).toBeVisible();
  await expect(stage.locator('header [data-state]').first()).toContainText('等待输入', { useInnerText: true });

  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('current output\r\n'));
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'live');
  await expect(workbench.locator('[data-activity-icon="live"]')).toHaveCount(3);
  await expect(workbench.locator('[data-activity-icon="idle"]')).toHaveCount(1);
  await expect(statusIcon.locator('svg')).toHaveAttribute('data-shape', 'live');
  await expect(stage.locator('header [data-state]').first()).toContainText('正在输出', { useInnerText: true });
  expect(await statusIcon.boundingBox()).toEqual(idleBox);

  await stage.getByRole('button', { name: '分屏', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('split output\r\n'));
  await expect(root.locator('[data-activity-slot="pane"][data-activity-icon="live"]')).toHaveCount(1);
  await expect(root.locator('[data-activity-slot="pane"][data-activity-icon="idle"]')).toHaveCount(1);
  await expect(stage.getByRole('img', { name: '正在输出', exact: true })).toBeVisible();
  await expect(stage.getByRole('img', { name: '等待输入', exact: true })).toBeVisible();

  const rail = page.getByRole('complementary', { name: '会话列表' });
  await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('compact output\r\n'));
  await expect(workbench.locator('[data-activity-slot="rail"][data-activity-icon="live"]')).toBeVisible();
  await expect(workbench.locator('[data-activity-slot="rail"][data-activity-icon="idle"]')).toBeVisible();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(root).toHaveAttribute('data-narrow', 'true');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('narrow output\r\n'));
  await expect(workbench.locator('[data-activity-slot="rail"][data-activity-icon="live"]')).toHaveCount(1);
  await expect(workbench.locator('[data-activity-slot="rail"][data-activity-icon="idle"]')).toHaveCount(1);
  // Split view uses the tight header: the chip keeps its dot and names the state on hover.
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'live');
  await expect(stage.locator('header [data-state]').first()).toHaveAttribute('title', '正在输出');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('reduced motion output\r\n'));
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'live');
  await expect(statusIcon.locator('svg')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('animated output\r\n'));
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'live');
  await expect(statusIcon.locator('svg')).not.toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(statusIcon.locator('svg')).toHaveCSS('animation-name', 'none');
  await page.getByRole('group', { name: '切换主题' }).getByRole('button', { name: '深色主题' }).click();
  await expect(root).toHaveAttribute('data-term-theme', 'dark');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('dark output\r\n'));
  await expect(statusIcon.locator('svg')).toHaveAttribute('data-shape', 'live');

  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'idle');
  await expect(statusIcon.locator('svg')).toHaveAttribute('data-shape', 'idle');
  await page.evaluate(() => (window as unknown as { __output: (text: string, id: string) => void }).__output('\u0007', 's2'));
  await expect(page.getByRole('tab', { name: /Claude Code/ }).locator('[data-activity-icon="bell"]')).toBeVisible();
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'idle');
  await page.evaluate(() => (window as unknown as { __exit: (code: number) => void }).__exit(1));
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'error');
  await expect(stage.locator('header [data-state]').first()).toHaveAttribute('title', '异常');

  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await page.evaluate(() => (window as unknown as { __exit: (code: number, id: string) => void }).__exit(0, 's2'));
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'ended');
  await expect(stage.locator('header [data-state]').first()).toHaveAttribute('title', '已结束');
});

for (const width of [1280, 640]) {
  test(`English activity states preserve status and title geometry at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('cliora:language', 'en'); });
    await page.setViewportSize({ width, height: 800 });
    await openWorkbench(page, true);
    const root = page.locator('[data-term-theme]');
    const stage = page.getByRole('region', { name: 'Current session' });
    const statusIcon = root.locator('[data-activity-slot="status"]');
    const title = stage.getByRole('heading', { level: 2 });
    const longTitle = 'A deliberately long session title that must remain truncated while output activity changes';
    const readLayout = () => page.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      // The state icons sit inside a Badge label; the Badge itself is the chip.
      const chip = document.querySelector('[data-activity-slot="status"]')!.parentElement!.closest('[data-tone]')!;
      return {
        chip: box(chip),
        title: box(chip.parentElement!.querySelector('h2')!),
      };
    });
    const setLongTitle = () => page.evaluate((value) => {
      (window as unknown as { __output: (text: string) => void }).__output('\u001b]2;' + value + '\u0007');
    }, longTitle);
    const expectStableState = async (tone: string, layout: unknown) => {
      await expect(statusIcon).toHaveAttribute('data-activity-icon', tone);
      expect(await readLayout()).toEqual(layout);
      const reserves = statusIcon.locator('..').locator(':scope > span > span[aria-hidden="true"]');
      await expect(reserves).toHaveCount(4);
      for (let index = 0; index < 4; index += 1) {
        await expect(reserves.nth(index)).toHaveCSS('visibility', 'hidden');
      }
    };

    await setLongTitle();
    await expect(title).toContainText('A deliberately long session title');
    await expect(statusIcon).toHaveAttribute('data-activity-icon', 'idle');
    expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const idleLayout = await readLayout();

    await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('current output\r\n'));
    await expectStableState('live', idleLayout);
    await expectStableState('idle', idleLayout);
    await page.evaluate(() => {
      document.hasFocus = () => false;
      (window as unknown as { __output: (text: string) => void }).__output('\u0007');
    });
    await expectStableState('bell', idleLayout);
    await page.evaluate(() => { document.hasFocus = () => true; });
    await page.evaluate(() => (window as unknown as { __exit: (code: number) => void }).__exit(1));
    await expectStableState('error', idleLayout);

    await page.reload();
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Workbench', exact: true }).click();
    await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
    await setLongTitle();
    await expectStableState('idle', idleLayout);
    await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('final output\r\n'));
    await expectStableState('live', idleLayout);
    await page.evaluate(() => (window as unknown as { __exit: (code: number) => void }).__exit(0));
    await expectStableState('ended', idleLayout);

    for (const nextWidth of [900, 640, 600]) {
      await page.setViewportSize({ width: nextWidth, height: 800 });
      if (nextWidth <= 720) await expect(root).toHaveAttribute('data-narrow', 'true');
      if (nextWidth <= 620) await expect(root).toHaveAttribute('data-compact', 'true');
      await expect(stage.locator('footer')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  });
}

test('session actions are available from the rail card', async ({ page }) => {
  await openWorkbench(page);
  await page.getByRole('button', { name: 'Codex 会话操作', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Codex 会话操作', exact: true });
  await expect(menu.getByRole('menuitem', { name: '置顶', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Codex/ })).toBeFocused();
});

for (const split of [false, true]) {
test(`the session rail moves through sessions with vertical arrow keys${split ? ' in split view' : ''}`, async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  if (split) await page.getByRole('button', { name: '分屏', exact: true }).click();
  const codex = page.getByRole('tab', { name: /Codex/ });
  const claude = page.getByRole('tab', { name: /Claude Code/ });
  await codex.focus();
  await page.evaluate(() => {
    const targets: string[] = [];
    Object.assign(window, { __railFocusTargets: targets });
    document.addEventListener('focusin', (event) => {
      const target = event.target as HTMLElement;
      targets.push(target.dataset.sessionId ?? target.tagName);
    });
  });
  // Drain scheduled terminal activation work so transient focus theft cannot
  // hide behind a later animation frame that restores the tab focus.
  const settleFocus = () => page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.keyboard.press('ArrowDown');
  await expect(claude).toBeFocused();
  await expect(claude).toHaveAttribute('aria-selected', 'true');
  await settleFocus();
  await expect(claude).toBeFocused();
  await page.keyboard.press('Home');
  await expect(codex).toBeFocused();
  await expect(codex).toHaveAttribute('aria-selected', 'true');
  await settleFocus();
  await expect(codex).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __railFocusTargets: string[] }).__railFocusTargets)).toEqual(['s2', 's1']);
  await claude.click();
  await expect(page.locator('[data-pane-session="s2"] .xterm-helper-textarea')).toBeFocused();
});
}

test('Shift+Enter sends a line feed and Enter still submits', async ({ page }) => {
  await openWorkbench(page);
  await page.keyboard.type('a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Enter');
  await expect.poll(() => writes(page)).toEqual(['a', '\n', '\r']);
});

test('Ctrl+V pastes clipboard text instead of sending ^V, and an image-only clipboard passes ^V through', async ({ page }) => {
  const input = await openWorkbench(page);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(100);
  expect(await writes(page)).not.toContain('\u0016');
  await input.evaluate((node) => {
    const data = new DataTransfer();
    data.setData('text/plain', '粘贴的文本');
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => writes(page)).toEqual(['粘贴的文本']);
  await resetWrites(page);
  await input.evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => writes(page)).toEqual(['\u0016']);
});

test('Ctrl+C copies a selection instead of interrupting, and interrupts without one', async ({ page }) => {
  await openWorkbench(page);
  const canvas = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  await canvas.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '终端操作' });
  await menu.getByRole('menuitem', { name: /全选/ }).click();
  await page.locator('.xterm-helper-textarea:visible').focus();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(100);
  expect(await writes(page)).toEqual([]);
  await page.keyboard.press('Control+c');
  await expect.poll(() => writes(page)).toEqual(['\u0003']);
});

test('the mouse wheel on the alternate screen never turns into arrow keys', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\u001b[?1049h\u001b[Halt-screen'));
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('alt-screen');
  const screen = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -400);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(150);
  expect(await writes(page)).toEqual([]);
});

test('a mouse-tracking CLI receives the wheel, and Shift+wheel reads normal scrollback', async ({ page }) => {
  await openWorkbench(page);
  // Grok enables wheel reporting and scrolls its own transcript. The unmodified wheel must
  // reach the CLI. Moving the xterm viewport instead opens a blank gap above the TUI.
  // Shift+wheel still reads normal-buffer scrollback for a CLI that ignores those reports.
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output('\u001b[?1002h' + lines + '\r\n');
  });
  const viewport = page.locator('.xterm-scrollable-element');
  const remaining = async () => (await readScroll(viewport)).remaining;
  await expect.poll(remaining).toBeLessThan(3);
  const scrollTop = async () => (await readScroll(viewport)).top;
  const screen = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await resetWrites(page);
  const start = await scrollTop();
  await page.mouse.wheel(0, -600);
  await expect.poll(remaining).toBeLessThan(3);
  expect(await scrollTop()).toBe(start);
  expect((await writes(page)).some((item) => item.includes('\u001b[M'))).toBe(true);
  await expect(page.getByRole('button', { name: '回到最新输出' })).toHaveCount(0);

  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -600);
  await page.keyboard.up('Shift');
  await expect.poll(scrollTop).toBeLessThan(start);
  const up = await scrollTop();
  await page.mouse.wheel(0, 600);
  await expect.poll(scrollTop).toBeGreaterThan(up);
  const down = await scrollTop();
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -900);
  await page.keyboard.up('Shift');
  await expect.poll(scrollTop).toBeLessThan(down);
});

test('the wheel on a fullscreen TUI scrolls the CLI instead of the xterm viewport', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 40 }, (_, index) => `history-${index}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(`${lines}\r\n\u001b[?1049h\u001b[?1000h\u001b[Hgrok-transcript`);
  });
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('grok-transcript');
  const viewport = page.locator('.xterm-scrollable-element:visible');
  const scrollTop = async () => (await readScroll(viewport)).top;
  const screen = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await resetWrites(page);
  const start = await scrollTop();
  await page.mouse.wheel(0, -700);
  await page.mouse.wheel(0, -700);
  expect(await scrollTop()).toBe(start);
  expect((await writes(page)).some((item) => item.includes('\u001b[M'))).toBe(true);
  await expect(page.getByRole('button', { name: '回到最新输出' })).toHaveCount(0);
});

test('the mouse wheel scrolls the native viewport when the CLI does not track the mouse', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(lines + '\r\n');
  });
  const viewport = page.locator('.xterm-scrollable-element');
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
  const scrollTop = async () => (await readScroll(viewport)).top;
  const box = await page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const start = await scrollTop();
  await page.mouse.wheel(0, -600);
  await expect.poll(scrollTop).toBeLessThan(start);
  const up = await scrollTop();
  await page.mouse.wheel(0, 600);
  await expect.poll(scrollTop).toBeGreaterThan(up);
});

test('tmux-style SGR wheel reports stay with the hovered alternate-screen session', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('button', { name: '分屏', exact: true }).click();
  await expect(stage.locator('[data-pane-session="s2"]')).toContainText('claude-ready');
  await page.evaluate(() => {
    const output = (window as unknown as { __output: (text: string, id: string) => void }).__output;
    for (const id of ['s1', 's2']) output(`\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[Hmux-${id}`, id);
  });
  for (const id of ['s1', 's2']) await expect(stage.locator(`[data-pane-session="${id}"]`)).toContainText(`mux-${id}`);
  // Keep keyboard focus on the other pane: mouse ownership follows the pane
  // receiving the event, even when both tmux clients request SGR tracking.
  for (const [id, other] of [['s1', 's2'], ['s2', 's1']]) {
    await stage.locator(`[data-pane-session="${other}"] .xterm-helper-textarea`).focus();
    const pane = stage.locator(`[data-pane-session="${id}"]`);
    const box = (await pane.locator('.xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.evaluate(() => { (window as unknown as { __writeLog: unknown[] }).__writeLog.length = 0; });
    await page.mouse.wheel(0, -400);
    await expect.poll(async () => (await writeLog(page)).some(item => item.sessionId === id && /^\x1b\[<64;\d+;\d+M$/.test(item.text))).toBe(true);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => (await writeLog(page)).some(item => item.sessionId === id && /^\x1b\[<65;\d+;\d+M$/.test(item.text))).toBe(true);
    const reports = await writeLog(page);
    expect(reports.every(item => item.sessionId === id && /^\x1b\[<6[45];\d+;\d+M$/.test(item.text))).toBe(true);
    expect((await readScroll(pane.locator('.xterm-scrollable-element'))).top).toBe(0);
  }
});

test('mouse-tracking terminal clicks are forwarded to the CLI', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\u001b[?1000hclick-target'));
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('click-target');
  const screen = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect.poll(async () => (await writes(page)).some((item) => item.includes('\u001b[M'))).toBe(true);
});

test('a mouse report past column 95 keeps its raw column byte', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\u001b[?1000hwide-target'));
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('wide-target');
  const screen = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  const box = await screen.boundingBox();
  await resetWrites(page);
  await page.mouse.click(box!.x + box!.width - 8, box!.y + 24);
  const bytes = () => page.evaluate(() => {
    const packets = (window as unknown as { __writeBytes: number[][] }).__writeBytes;
    return packets[packets.length - 1] ?? [];
  });
  await expect.poll(async () => (await bytes()).slice(0, 3)).toEqual([0x1b, 0x5b, 0x4d]);
  const report = await bytes();
  expect(report).toHaveLength(6);
  expect(report[4]).toBeGreaterThan(127);
});

test('OSC 52 from the CLI copies text and a query does not', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWorkbench(page);
  const encoded = await page.evaluate(() => {
    const raw = new TextEncoder().encode('复制一段');
    let binary = '';
    raw.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  });
  await page.evaluate((payload) => {
    (window as unknown as { __output: (text: string) => void }).__output(`\u001b]52;c;${payload}\u0007`);
  }, encoded);
  await expect(page.getByRole('status').filter({ hasText: '已复制选中内容' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('复制一段');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\u001b]52;c;?\u0007'));
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('复制一段');
});

test('terminal cursor-position replies are forwarded through the binary input channel', async ({ page }) => {
  await openWorkbench(page);
  await resetWrites(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\u001b[6n'));
  await expect.poll(async () => (await writes(page)).some((item) => /\u001b\[\d+;\d+R/.test(item))).toBe(true);
});

test('initial replay waits for the workbench to receive layout space', async ({ page }) => {
  await installWorkbenchMock(page);
  await page.setViewportSize({ width: 1360, height: 898 });
  await page.addInitScript(() => {
    Object.assign(window, { __replayOverride: btoa(Array.from({ length: 100 }, (_, index) => `history-${index}`).join('\r\n')) });
  });
  await page.goto('/');
  const collapsed = await page.addStyleTag({ content: '[data-term-theme] { height: 0 !important; max-height: 0 !important; }' });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm')).toHaveCount(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as unknown as { __resizes: unknown[] }).__resizes)).toEqual([]);
  await collapsed.evaluate(node => node.remove());
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('history-99');
  await expect.poll(() => page.locator('.xterm-rows > div').evaluateAll(rows => rows.filter(row => row.textContent?.includes('history-')).length)).toBeGreaterThan(20);
  const grids = await page.evaluate(() => (window as unknown as { __resizes: Array<{ rows: number }> }).__resizes);
  expect(grids.length).toBeGreaterThan(0);
  expect(grids.every(grid => grid.rows > 20)).toBe(true);
});

test('a replayed session with long output opens scrolled to the latest line', async ({ page }) => {
  await installWorkbenchMock(page);
  const lines = Array.from({ length: 300 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\r\n');
  await page.addInitScript((encoded) => {
    Object.assign(window, { __replayOverride: encoded });
  }, btoa(lines + '\r\nlatest-output-marker\r\n> '));
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('latest-output-marker');
  // The viewport parks on the latest output, not at the top of the scrollback.
  await expect.poll(async () => (await readScroll(page.locator('.xterm-scrollable-element'))).remaining).toBe(0);
  await expect(page.getByRole('button', { name: '回到最新输出' })).toHaveCount(0);
  const screen = await page.locator('.xterm-screen:visible').boundingBox();
  await page.mouse.move(screen!.x + screen!.width / 2, screen!.y + screen!.height / 2);
  await page.mouse.wheel(0, -480);
  const latest = page.getByRole('button', { name: '回到最新输出', exact: true });
  await expect(latest).toBeVisible();
  await latest.click();
  await expect.poll(async () => (await readScroll(page.locator('.xterm-scrollable-element:visible'))).remaining).toBe(0);
});

test('numbered output that overlaps the replay is written once', async ({ page }) => {
  await installWorkbenchMock(page);
  // The host replay ends at stream offset 40; a live event re-sends its last bytes.
  await page.addInitScript((encoded) => {
    Object.assign(window, { __replayOverride: { dataBase64: encoded, endOffset: 40 } });
  }, btoa('replayed-head\r\nshared-tail'));
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const tree = page.locator('.xterm-accessibility-tree').first();
  await expect(tree).toContainText('shared-tail');
  await page.evaluate(() => {
    const output = (window as unknown as { __output: (text: string, sessionId?: string, offset?: number) => void }).__output;
    output('-tail', 's1', 35); // bytes 35..39 were already replayed: only 40.. is new, which is empty here
    output('shared-tail=fresh-line', 's1', 29); // 29..39 duplicate, '=fresh-line' is new
    output('stale', 's1', 10); // entirely inside the replay
  });
  await expect(tree).toContainText('shared-tail=fresh-line');
  const text = await tree.innerText();
  expect(text.match(/shared-tail/g)?.length).toBe(1);
  expect(text).not.toContain('-tail-tail');
  expect(text).not.toContain('stale');
});

test('find opens over the terminal without resizing the PTY canvas', async ({ page }) => {
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  const screen = stage.locator('.xterm-screen:visible');
  const before = await screen.boundingBox();
  await page.keyboard.press('Control+Shift+F');
  const search = stage.getByRole('searchbox', { name: '在终端输出中查找…' });
  await expect(search).toBeFocused();
  await search.fill('codex-ready');
  await expect(stage).toContainText('1 / 1');
  const overlay = stage.getByRole('search');
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox!.y + overlayBox!.height).toBeGreaterThan(before!.y);
  await expect.poll(async () => {
    const current = await screen.boundingBox();
    return current ? { width: current.width, height: current.height } : null;
  }).toEqual({ width: before!.width, height: before!.height });
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  const after = await screen.boundingBox();
  expect(after!.width).toBe(before!.width);
  expect(after!.height).toBe(before!.height);
});

test('font zoom, terminal colours, and a page that never scrolls sideways', async ({ page }) => {
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  const storedFont = () => page.evaluate(() => localStorage.getItem('cliora:workbench-font-size'));
  await page.keyboard.press('Control+=');
  await expect.poll(storedFont).toBe('15');
  await page.keyboard.press('Control+0');
  await expect.poll(storedFont).toBe('14');
  expect(await writes(page)).toEqual([]);

  const root = page.locator('[data-term-theme]');
  await expect(root).toHaveAttribute('data-term-theme', 'light');
  await stage.getByRole('button', { name: '终端显示', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: '终端显示' });
  await appearance.getByRole('button', { name: '深色终端', exact: true }).click();
  await expect(root).toHaveAttribute('data-term-theme', 'dark');
  await page.keyboard.press('Escape');
  await expect(appearance).toHaveCount(0);

  await page.keyboard.press('Control+Shift+F');
  const find = stage.getByRole('searchbox', { name: '在终端输出中查找…' });
  await expect(find).toBeFocused();
  await find.fill('codex-ready');
  await expect(stage).toContainText('1 / 1');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\r\ncodex-ready\r\n> '));
  await expect(stage).toContainText('1 / 2');
  await page.keyboard.press('Escape');

  // An IME caret near the right edge used to scroll every ancestor and slide the window left.
  const shifted = await page.evaluate(async () => {
    const main = document.querySelector('main')!;
    main.scrollLeft = 80;
    document.documentElement.scrollLeft = 80;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return main.scrollLeft + document.documentElement.scrollLeft;
  });
  expect(shifted).toBe(0);

  // Indicator light reflects active output vs idle standby once output stops.
  const dot = page.getByRole('tab', { name: /Codex/ }).locator('[data-tone]').first();
  await expect(dot).toHaveAttribute('data-tone', 'idle');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('streaming...'));
  await expect(dot).toHaveAttribute('data-tone', 'live');
  await expect(dot).toHaveAttribute('data-tone', 'idle', { timeout: 3000 });
});

test('long task titles, metadata, and toolbar actions keep their own space at every width', async ({ page }) => {
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  const heading = stage.getByRole('heading', { level: 2 });
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\u001b]0;' + '重构终端与多会话工作流'.repeat(8) + '\u0007'));
  await expect(heading).toContainText('重构终端');
  await expect(heading).toHaveAttribute('title', /^Codex · /);
  const end = stage.getByRole('button', { name: '结束此会话', exact: true });
  const path = stage.getByTitle(/复制工作目录路径/);
  const toolbar = stage.getByRole('toolbar', { name: '终端操作' });
  for (const width of [1280, 900, 640]) {
    await page.setViewportSize({ width, height: 760 });
    await expect.poll(async () => {
      const titleBox = await heading.boundingBox();
      const endBox = await end.boundingBox();
      const pathBox = await path.boundingBox();
      const stageBox = await stage.boundingBox();
      if (!titleBox || !endBox || !pathBox || !stageBox) return false;
      return titleBox.x + titleBox.width <= endBox.x
        && pathBox.y >= titleBox.y + titleBox.height - 1
        && endBox.x + endBox.width <= stageBox.x + stageBox.width;
    }).toBe(true);
    await expect.poll(() => toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    for (const name of ['查找输出', '快捷输入', '发送中断 (Ctrl+C)', '更多终端操作']) {
      await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();
    }
    // Display settings live in the status bar, next to the shortcut reference.
    await expect(stage.locator('footer').getByRole('button', { name: '终端显示', exact: true })).toBeVisible();
  }
  expect(await heading.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
});

test('the terminal has a slim inset scrollbar and a working return-to-latest action', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, index) => `scrollbar-line-${index}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(lines + '\r\n');
  });
  const viewport = page.locator('.xterm-scrollable-element:visible');
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('scrollbar-line-199');
  const measure = () => viewport.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const screen = node.closest('.xterm')!.querySelector('.xterm-screen')!.getBoundingClientRect();
    const gutter = node.offsetWidth - node.clientWidth;
    const style = getComputedStyle(node);
    return {
      hasOverflow: Number(node.closest('[data-pane-session]')?.querySelector('[role="scrollbar"]')?.getAttribute('aria-valuemax')) > 0,
      contentClear: screen.right <= bounds.right - gutter + 1,
      background: style.backgroundColor,
      nativeHidden: [...node.querySelectorAll('.scrollbar')].every(bar => getComputedStyle(bar).display === 'none'),
    };
  });
  await expect.poll(async () => {
    const metrics = await measure();
    return metrics.hasOverflow && metrics.contentClear && metrics.nativeHidden && metrics.background === 'rgb(251, 252, 250)';
  }).toBe(true);
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
  const scrollbar = page.getByRole('scrollbar', { name: '终端滚动条', exact: true });
  await expect(scrollbar).toBeVisible();
  await expect(scrollbar).toHaveCSS('width', '14px');
  const latest = page.getByRole('button', { name: '回到最新输出', exact: true });
  const track = await scrollbar.boundingBox();
  const trackX = track!.x + 7;
  await page.mouse.move(trackX, track!.y + track!.height * 0.85);
  await page.mouse.down();
  await page.mouse.move(trackX, track!.y + track!.height * 0.45, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await readScroll(viewport)).ratio).toBeGreaterThan(0.3);
  await expect.poll(async () => (await readScroll(viewport)).ratio).toBeLessThan(0.65);
  await scrollbar.focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await readScroll(viewport)).top).toBe(0);
  await expect(page.locator('.xterm-rows > div').first()).toContainText('codex-ready');
  await expect.poll(() => page.locator('[data-scroll-away]').count()).toBe(1);
  await expect(latest).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.locator('.xterm-rows')).toContainText('scrollbar-line-199');
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
  await expect(page.locator('[data-scroll-away]')).toHaveCount(0);
  const initialScroll = (await readScroll(viewport)).top;
  expect(initialScroll).toBeGreaterThan(0);
  const screen = await page.locator('.xterm-screen:visible').boundingBox();
  await page.mouse.move(screen!.x + screen!.width / 2, screen!.y + screen!.height / 2);
  await page.mouse.wheel(0, -1000);
  await expect.poll(async () => (await readScroll(viewport)).top).toBeLessThan(initialScroll);
  await expect(latest).toBeVisible();
  const readingPosition = (await readScroll(viewport)).top;
  const visibleReadingLine = await page.locator('.xterm-rows > div').first().textContent();
  const readingHeight = (await readScroll(viewport)).max;
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\r\nwhile-reading\r\n'));
  await expect.poll(async () => (await readScroll(viewport)).max).toBeGreaterThan(readingHeight);
  // The public virtual viewport preserves the same row after output reflow.
  await expect.poll(async () => Math.abs((await readScroll(viewport)).top - readingPosition)).toBeLessThanOrEqual(1);
  await expect(page.locator('.xterm-rows > div').first()).toHaveText(visibleReadingLine ?? '');
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(page.locator('.xterm-rows')).toContainText('while-reading');
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
});

test('a live agent footer redraw does not bounce the viewport', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 50 }, (_, index) => `history-${String(index).padStart(2, '0')}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(`${lines}\r\n> `);
  });
  const viewport = page.locator('.xterm-scrollable-element:visible');
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
  const result = await page.evaluate(async () => {
    const scrollbar = document.querySelector('[role="scrollbar"]')!;
    const read = () => ({ top: Number(scrollbar.getAttribute('aria-valuenow')), max: Number(scrollbar.getAttribute('aria-valuemax')) });
    const output = (window as unknown as { __output: (text: string) => void }).__output;
    let dips = 0;
    let previous = read().top;
    for (let index = 0; index < 16; index += 1) {
      output(`\u001b7\u001b[2;1Hagent ${index} running · 3m ${String(index).padStart(2, '0')}s · 56.0k\u001b8`);
      output(`\rfooter ${String(index).padStart(2, '0')}`);
      output(`\nexplore-${index}\r\n> `);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const top = read().top;
      if (top + 1 < previous) dips += 1;
      previous = top;
    }
    return { dips, remaining: read().max - read().top };
  });
  expect(result.dips).toBe(0);
  expect(result.remaining).toBeLessThan(3);
});

test('terminal URLs require Ctrl+left click and preserve their complete target', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkbench(page);
  const url = 'https://example.test/actions/runs/42?tab=tests#result';
  const unicode = 'https://example.test/文档';
  const balanced = 'https://example.test/a_(b)';
  await page.evaluate(({ url, unicode, balanced }) => {
    (window as unknown as { __output: (text: string) => void }).__output(`\r\nRelease (${url}).\r\n文档 ${unicode} ${balanced}\r\n`);
  }, { url, unicode, balanced });
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('Release');
  const point = await pointForTerminalText(page, url);
  const tooltip = page.getByRole('tooltip');
  await page.mouse.move(point.x, point.y);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(url);
  await expect(tooltip).toContainText('Ctrl + 点击打开');
  await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(0);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(80);
  expect(await openedUrls(page)).toEqual([]);

  await page.keyboard.down('Control');
  await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(1);
  await page.mouse.click(point.x, point.y, { button: 'middle' });
  expect(await openedUrls(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('terminal-link-light.png') });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  await expect.poll(() => openedUrls(page)).toEqual([url]);

  for (const target of [unicode, balanced]) {
    const next = await pointForTerminalText(page, target);
    await page.keyboard.down('Control');
    await page.mouse.click(next.x, next.y);
    await page.keyboard.up('Control');
  }
  await expect.poll(() => openedUrls(page)).toEqual([url, unicode, balanced]);
});

test('a wrapped terminal URL opens in full and its hint is cleaned up with the session', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await page.setViewportSize({ width: 720, height: 760 });
  await openWorkbench(page);
  const url = 'https://example.test/docs/' + 'segment/'.repeat(28) + '?q=1#result';
  await page.evaluate((url) => (window as unknown as { __output: (text: string) => void }).__output(`\r\n${url}\r\n`), url);
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('q=1');
  const point = await pointForTerminalText(page, url.slice(-12), true);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toContainText(url);
  await page.keyboard.down('Control');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  await expect.poll(() => openedUrls(page)).toEqual([url]);

  await page.mouse.move(8, 8);
  await page.mouse.move(point.x + 24, point.y);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByRole('tab', { name: /Codex/ }).click();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始', exact: true }).click();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('terminal paths use modifier clicks, the owning session and its latest cwd without hover IPC', async ({ page }, testInfo) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await page.setViewportSize({ width: 1360, height: 898 });
  await openWorkbench(page);
  const requests = () => page.evaluate(() => (window as unknown as { __pathOpens: Array<{ sessionId: string; path: string; cwd: string }> }).__pathOpens);
  const paths = ['src/features/app.tsx:42:3', '../README.md', 'C:\\work\\文档.txt', '/tmp/result.txt'];
  await page.evaluate(paths => (window as unknown as { __output: (text: string) => void }).__output(`\r\n${paths.map(path => `中文 🐱 (${path}).`).join('\r\n')}\r\n`), paths);
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('/tmp/result.txt');
  const point = await pointForTerminalText(page, paths[0]);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toContainText(paths[0]);
  await page.mouse.click(point.x, point.y);
  expect(await requests()).toEqual([]);
  await page.keyboard.down('Control');
  await page.mouse.click(point.x, point.y, { button: 'middle' });
  await page.keyboard.up('Control');
  expect(await requests()).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('terminal-file-path-light.png') });
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b]7;file:///C:/changed%20cwd\x07'));
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('C:\\changed cwd');
  for (const path of paths) {
    const point = await pointForTerminalText(page, path);
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
  }
  await expect.poll(requests).toEqual(paths.map(path => ({ sessionId: 's1', path, cwd: 'C:\\changed cwd' })));
  expect(await openedUrls(page)).toEqual([]);
  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await page.evaluate(() => (window as unknown as { __output: (text: string, id: string) => void }).__output('\r\n./second.txt\r\n', 's2'));
  const second = await pointForTerminalText(page, './second.txt');
  await page.keyboard.down('Control');
  await page.mouse.click(second.x, second.y);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await requests()).at(-1)).toEqual({ sessionId: 's2', path: './second.txt', cwd: 'D:/a-long-project-directory/for-the-second-session' });
});

test('wrapped paths, quoted spaces and OSC file links open intact and surface missing files', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await openWorkbench(page);
  await page.getByRole('group', { name: '切换主题' }).getByRole('button', { name: '深色主题' }).click();
  const path = './src/' + 'segment/'.repeat(12) + '中文文件.ts:18';
  const quoted = 'C:\\work space\\中文 file.txt';
  const uri = 'file:///C:/work/a%20b.txt';
  await page.evaluate(({ path, quoted, uri }) => (window as unknown as { __output: (text: string) => void }).__output(`\r\n${path}\r\n"${quoted}"\r\n\x1b]8;;${uri}\x1b\\本地文件\x1b]8;;\x1b\\\r\n`), { path, quoted, uri });
  const requests = () => page.evaluate(() => (window as unknown as { __pathOpens: Array<{ path: string }> }).__pathOpens.map(item => item.path));
  for (const [label, expected] of [['中文文件.ts:18', path], [quoted, quoted], ['本地文件', uri]]) {
    const point = await pointForTerminalText(page, label);
    await page.mouse.move(point.x, point.y);
    await expect(page.getByRole('tooltip')).toContainText(expected);
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
  }
  await expect.poll(requests).toEqual([path, quoted, uri]);
  await page.evaluate(() => { Object.assign(window, { __failPathOpen: true }); });
  const point = await pointForTerminalText(page, quoted);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toContainText(quoted);
  await page.screenshot({ path: testInfo.outputPath('terminal-file-path-dark-narrow.png') });
  await page.keyboard.down('Control');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  await expect(page.getByRole('alert')).toContainText('文件或文件夹不存在');
});

test('long output does not probe files and overlong logical lines keep the terminal responsive', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\r\n' + 'src/file.ts\r\n'.repeat(1000) + './' + 'a'.repeat(20_000) + '/last.txt\r\n'));
  // The final filename may straddle two physical rows; hover within the same
  // oversized logical line without depending on where the font wraps its tail.
  const point = await pointForTerminalText(page, 'aaaaaaaa', true);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pathOpens: unknown[] }).__pathOpens)).toEqual([]);
  await resetWrites(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b[6n'));
  await expect.poll(() => writes(page)).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
});

test('a redrawn terminal line uses the new path instead of a cached target', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\r\nsrc/old.ts'));
  let point = await pointForTerminalText(page, 'src/old.ts');
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toContainText('src/old.ts');
  await page.mouse.move(8, 8);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\r\x1b[2Ksrc/new.ts'));
  point = await pointForTerminalText(page, 'src/new.ts');
  // xterm ignores a mousemove that returns to exactly its previous buffer cell.
  await page.mouse.move(point.x + 24, point.y);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toContainText('src/new.ts');
  await page.keyboard.down('Control');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pathOpens: Array<{ path: string }> }).__pathOpens.map(item => item.path))).toEqual(['src/new.ts']);
});

test('OSC 8 links reveal their destination and report browser failures', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await openWorkbench(page);
  const url = 'https://example.test/releases/v0.4.52';
  await page.evaluate((url) => {
    (window as unknown as { __output: (text: string) => void }).__output(`\r\n\u001b]8;;${url}\u001b\\发布说明\u001b]8;;\u001b\\\r\n`);
  }, url);
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('发布说明');
  const point = await pointForTerminalText(page, '发布说明');
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toContainText(url);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(80);
  expect(await openedUrls(page)).toEqual([]);
  await page.keyboard.down('Control');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  await expect.poll(() => openedUrls(page)).toEqual([url]);

  await page.evaluate(() => { (window as unknown as { __failOpen: boolean }).__failOpen = true; });
  await page.keyboard.down('Control');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  await expect(page.getByRole('alert')).toContainText('浏览器不可用');
  await expect(page.getByRole('alert')).not.toContainText('输入没有送进当前会话');
  expect(dialogs).toEqual([]);
});

test('terminal link hint stays within a narrow dark viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await openWorkbench(page);
  await page.getByRole('group', { name: '切换主题' }).getByRole('button', { name: '深色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('[data-term-theme]')).toHaveAttribute('data-term-theme', 'dark');
  const url = 'https://example.test/releases/v0.4.52';
  const marker = 'https://';
  // Column count follows the font and the rail. A fixed 60-column pad splits the marker when the row is narrower.
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output(`\r\n${'x'.repeat(240)}\r\n`));
  await expect.poll(() => page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.xterm-rows > div')].filter((row) => row.getClientRects().length);
    return Math.max(0, ...rows.map((row) => (row.textContent ?? '').match(/x+/)?.[0].length ?? 0));
  })).toBeGreaterThan(24);
  const cols = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.xterm-rows > div')].filter((row) => row.getClientRects().length);
    return Math.max(0, ...rows.map((row) => (row.textContent ?? '').match(/x+/)?.[0].length ?? 0));
  });
  const lead = cols - marker.length;
  expect((lead + 0.5) / cols).toBeGreaterThan(0.7);
  await page.evaluate(({ lead, url }) => (window as unknown as { __output: (text: string) => void }).__output(`\r\n${'y'.repeat(lead)}${url}\r\n`), { lead, url });
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText(url);
  const point = await pointForTerminalText(page, marker);
  const screen = await page.locator('.xterm-screen:visible').boundingBox();
  expect(point.x).toBeGreaterThan(screen!.x + screen!.width * 0.7);
  await page.mouse.move(point.x, point.y);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(url);
  await page.keyboard.down('Control');
  await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(1);
  const bounds = await tooltip.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(640);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({ path: testInfo.outputPath('terminal-link-dark-640.png') });
  await page.keyboard.up('Control');
  await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(0);
});

const writeLog = (page: Page) => page.evaluate(() => (window as unknown as { __writeLog: Array<{ sessionId: string; text: string }> }).__writeLog.slice());

test('split view shows two sessions side by side and keyboard input follows the focused pane', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  const split = stage.getByRole('button', { name: '分屏', exact: true });
  await split.click();
  await expect(split).toHaveAttribute('aria-pressed', 'true');
  const codexPane = stage.locator('[data-pane-session="s1"]');
  const claudePane = stage.locator('[data-pane-session="s2"]');
  await expect(codexPane).toBeVisible();
  await expect(claudePane).toBeVisible();
  await expect(codexPane).toContainText('codex-ready');
  await expect(claudePane).toContainText('claude-ready');
  const left = (await codexPane.boundingBox())!;
  const right = (await claudePane.boundingBox())!;
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
  expect(Math.abs(right.width - left.width)).toBeLessThan(4);
  await expect(codexPane).toHaveAttribute('data-focused', 'true');

  // Clicking the other pane moves focus there without swapping the layout.
  await claudePane.locator('.xterm-screen').click();
  await expect(page.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
  await expect(stage.getByRole('heading', { level: 2 })).toHaveText('Claude Code');
  await expect(claudePane).toHaveAttribute('data-focused', 'true');
  expect((await claudePane.boundingBox())!.x).toBe(right.x);
  await resetWrites(page);
  await page.keyboard.type('x');
  await expect.poll(() => writeLog(page)).toEqual([{ sessionId: 's2', text: 'x' }]);

  // The rail marks both on-screen sessions; Ctrl+Shift+D leaves split view.
  await expect(page.getByRole('tab', { name: /Codex/ })).toContainText('1');
  await page.keyboard.press('Control+Shift+D');
  await expect(split).toHaveAttribute('aria-pressed', 'false');
  await expect(codexPane).toBeHidden();
  await expect(claudePane).toBeVisible();
  expect((await writeLog(page)).map((item) => item.text)).toEqual(['x']);

  // Closing a pane keeps the other session on screen.
  await page.keyboard.press('Control+Shift+D');
  await expect(codexPane).toBeVisible();
  await stage.getByRole('button', { name: '关闭 Claude Code 分屏', exact: true }).click();
  await expect(split).toHaveAttribute('aria-pressed', 'false');
  await expect(codexPane).toBeVisible();
  await expect(claudePane).toBeHidden();
  await expect(page.getByRole('tab', { name: /Codex/ })).toHaveAttribute('aria-selected', 'true');
});

test('Ctrl+Tab cycles sessions and background output marks a card unread', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  const codex = page.getByRole('tab', { name: /Codex/ });
  const claude = page.getByRole('tab', { name: /Claude Code/ });
  await page.evaluate(() => (window as unknown as { __output: (text: string, id: string) => void }).__output('background work\r\n', 's2'));
  await expect(claude.getByLabel('有新输出')).toBeVisible();
  await expect(codex.getByLabel('有新输出')).toHaveCount(0);
  await page.locator('.xterm-helper-textarea:visible').focus();
  await resetWrites(page);
  await page.keyboard.press('Control+Tab');
  await expect(claude).toHaveAttribute('aria-selected', 'true');
  await expect(claude.getByLabel('有新输出')).toHaveCount(0);
  await page.locator('.xterm-helper-textarea:visible').focus();
  await page.keyboard.press('Control+Shift+Tab');
  await expect(codex).toHaveAttribute('aria-selected', 'true');
  expect(await writes(page)).toEqual([]);
});

test('switching back to a session does not resend its unchanged grid', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  const codex = page.getByRole('tab', { name: /Codex/ });
  const claude = page.getByRole('tab', { name: /Claude Code/ });
  const resizes = (id: string) => page.evaluate((sessionId) => (window as unknown as { __resizes: Array<{ sessionId: string }> }).__resizes.filter((item) => item.sessionId === sessionId).length, id);
  await expect.poll(() => resizes('s1')).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const settled = await resizes('s1');
  // Every resize makes an inline TUI repaint its live region; a repeat stacks the status lines.
  for (let round = 0; round < 3; round += 1) {
    await claude.click();
    await expect(claude).toHaveAttribute('aria-selected', 'true');
    await codex.click();
    await expect(codex).toHaveAttribute('aria-selected', 'true');
  }
  await page.waitForTimeout(300);
  expect(await resizes('s1')).toBe(settled);
});

test('hidden live terminals answer cursor queries without accepting keyboard input', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await resetWrites(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string, id: string) => void }).__output('\x1b[6n', 's1'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __writeLog: Array<{ sessionId: string; text: string }> }).__writeLog.filter(item => item.sessionId === 's1').map(item => item.text))).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
  await expect(page.locator('[data-pane-session="s1"] textarea')).toBeDisabled();
  await expect(page.locator('[data-pane-session="s2"] textarea')).toBeEnabled();
});

test('switching sessions preserves a reading position while background output keeps arriving', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output(Array.from({ length: 240 }, (_, index) => `reading-row-${index}`).join('\r\n') + '\r\n'));
  const viewport = page.locator('[data-pane-session="s1"] .xterm-scrollable-element');
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
  const scrollbar = page.getByRole('scrollbar', { name: '终端滚动条', exact: true });
  await scrollbar.focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await readScroll(viewport)).top).toBe(0);
  await expect(page.getByRole('button', { name: '回到最新输出', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Claude Code/ }).click();
  for (let index = 0; index < 12; index++) {
    await page.evaluate(index => (window as unknown as { __output: (text: string, id: string) => void }).__output(`background-ordered-${index}\r\n`, 's1'), index);
  }
  await page.getByRole('tab', { name: /Codex/ }).click();
  await expect(viewport).toBeVisible();
  await expect.poll(async () => (await readScroll(viewport)).top).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: '回到最新输出', exact: true })).toBeVisible();
  const terminalTree = page.locator('[data-pane-session="s1"] .xterm-accessibility-tree');
  // Explicitly returning to live output remains available after preserving history.
  await page.getByRole('button', { name: '回到最新输出', exact: true }).click();
  await expect(terminalTree).toContainText('background-ordered-11');
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
});

test('restoration keeps selected and pinned sessions and runs once across page switches', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __twoSessions: true, __restoreReport: { restored: { previous: 's2' }, failures: [] } });
    localStorage.setItem('cliora:workbench-selected', 'previous');
    localStorage.setItem('cliora:workbench-rail-arrange', JSON.stringify({ pinned: ['previous'], order: [] }));
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cliora:workbench-rail-arrange')!).pinned)).toEqual(['s2']);
  await navigation.getByRole('button', { name: '快速开始', exact: true }).click();
  await navigation.getByRole('button', { name: '工作台', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __restoreCalls: number }).__restoreCalls)).toBe(1);
});

test('unresolved restoration stays visible and can be dismissed explicitly', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __restoreReport: { restored: {}, failures: [{ session: { id: 'missing', toolId: 'codex', directory: 'C:/work' }, detail: '原会话不存在' }] } }));
  await openWorkbench(page);
  await expect(page.getByText('原会话不存在', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '重试恢复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __restoreCalls: number }).__restoreCalls)).toBe(2);
  await page.getByRole('button', { name: '不再恢复', exact: true }).click();
  await expect(page.getByRole('button', { name: '不再恢复', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __forgottenRestore: string }).__forgottenRestore)).toBe('missing');
});

test('replay uses the native grid before interpreting cursor-addressed output', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __twoSessions: true, __replayOverride: { dataBase64: btoa('codex-ready\x1b[1;100HX\x1b[6n'), endOffset: 27, cols: 120, rows: 30 } });
  });
  await openWorkbench(page);
  await expect.poll(() => writes(page)).toContain('\x1b[1;101R');
});

test('replayed history of an older session does not answer its old device queries', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __oldSessions: true, __replayOverride: { dataBase64: btoa('codex-ready\x1b[c\x1b[6n\x1b]11;?\x07\r\n> '), endOffset: 30, cols: 120, rows: 30 } });
  });
  await openWorkbench(page);
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  await page.waitForTimeout(150);
  expect(await writes(page)).toEqual([]);
  // Live queries after the replay are still answered.
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b[6n'));
  await expect.poll(() => writes(page)).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
});

test('find can match case, line spacing persists, shortcuts are listed, and the rail collapses to icons', async ({ page }) => {
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\r\nCODEX-READY\r\n> '));
  await page.keyboard.press('Control+Shift+F');
  const find = stage.getByRole('searchbox', { name: '在终端输出中查找…' });
  await find.fill('codex-ready');
  await expect(stage.getByRole('search')).toContainText('1 / 2');
  await stage.getByRole('button', { name: '区分大小写', exact: true }).click();
  await expect(stage.getByRole('search')).toContainText('1 / 1');
  await expect(find).toBeFocused();
  await page.keyboard.press('Escape');

  // Grid size and font size are noise in the status bar; font size lives in 终端显示.
  await expect(stage.locator('footer')).not.toContainText(/\d+×\d+|\d+px/);
  await stage.getByRole('button', { name: '终端显示', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: '终端显示' });
  await appearance.getByRole('radio', { name: '宽松', exact: true }).click();
  await expect(appearance.getByRole('radio', { name: '宽松', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-density'))).toBe('relaxed');
  await page.keyboard.press('Escape');

  await stage.getByRole('button', { name: '键盘快捷键', exact: true }).click();
  const shortcuts = page.getByRole('dialog', { name: '键盘快捷键' });
  await expect(shortcuts).toContainText('分屏');
  await expect(shortcuts).toContainText('查找输出');
  await page.keyboard.press('Escape');
  await expect(shortcuts).toHaveCount(0);

  const rail = page.getByRole('complementary', { name: '会话列表' });
  // The session list is docked in the app sidebar; folding the sidebar leaves one icon rail.
  await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await expect.poll(async () => (await page.getByLabel('主导航').boundingBox())!.width).toBeLessThan(80);
  await expect(page.getByRole('tab', { name: /Codex/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-slim'))).toBe('true');
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(rail).not.toHaveAttribute('data-slim', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-slim'))).toBe('false');
  expect(await writes(page)).toEqual([]);
});

test('double-clicks and Mod+Shift+B toggle the rail and focus mode; middle-click removes an ended session', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkbench(page);
  const root = page.locator('[data-term-theme]');
  const rail = page.getByRole('complementary', { name: '会话列表' });
  const stage = page.getByRole('region', { name: '当前会话' });
  const codex = page.getByRole('tab', { name: /Codex/ });

  // Double-clicking a session's icon collapses the rail; the slim icon expands it again.
  await codex.locator('[data-rail-icon]').dblclick();
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await codex.locator('[data-rail-icon]').dblclick();
  await expect(rail).not.toHaveAttribute('data-slim', 'true');

  // The title bar icon does the same, and the keyboard shortcut works from the terminal.
  await stage.locator('[data-stage-icon]').dblclick();
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await page.locator('.xterm-helper-textarea:visible').focus();
  await page.keyboard.press('Control+Shift+B');
  await expect(rail).not.toHaveAttribute('data-slim', 'true');
  expect(await writes(page)).toEqual([]);

  // Double-clicking the bare title bar enters focus mode; the stage icon brings the rail back.
  const header = stage.locator('header').first();
  const box = (await header.boundingBox())!;
  const toolbar = (await stage.getByRole('toolbar', { name: '终端操作' }).boundingBox())!;
  await page.mouse.dblclick(toolbar.x - 24, box.y + box.height / 2);
  await expect(root).toHaveAttribute('data-focus-mode', 'true');
  await expect(rail).toBeHidden();
  await stage.locator('[data-stage-icon]').dblclick();
  await expect(root).not.toHaveAttribute('data-focus-mode', 'true');
  await expect(rail).toBeVisible();

  // Middle-click closes an ended session like a browser tab.
  await page.evaluate(() => (window as unknown as { __exit: (code: number, id: string) => void }).__exit(0, 's2'));
  const claude = page.getByRole('tab', { name: /Claude Code/ });
  await expect(claude).toContainText('已结束');
  await claude.click({ button: 'middle' });
  await expect(claude).toHaveCount(0);
  await expect(codex).toBeVisible();
});

test('the workbench shares one sidebar: page icons on top, sessions below, and no card around the terminal', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await page.setViewportSize({ width: 1360, height: 860 });
  await openWorkbench(page);
  const sidebar = page.getByLabel('主导航');
  const nav = page.getByRole('navigation', { name: '页面' });
  const rail = page.getByRole('complementary', { name: '会话列表' });
  const stage = page.getByRole('region', { name: '当前会话' });

  // One column: the session list is docked inside the app sidebar, under the page icons.
  await expect(sidebar.getByRole('tablist', { name: '会话列表' })).toBeVisible();
  await expect(page.locator('[data-term-theme]').getByRole('tablist', { name: '会话列表' })).toHaveCount(0);
  const navBox = (await nav.boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  expect(navBox.height).toBeLessThan(48);
  expect(railBox.y).toBeGreaterThan(navBox.y + navBox.height - 1);
  await expect(nav.getByRole('button', { name: '使用记录', exact: true }).locator('.nav-text')).toBeHidden();
  // The terminal fills the canvas: no second frame, and no reserved scrollbar lane beside it.
  const frame = await stage.locator('header').evaluate((header) => {
    const window = header.parentElement!;
    const style = getComputedStyle(window);
    const canvas = document.querySelector<HTMLElement>('main')!;
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius, gap: canvas.getBoundingClientRect().right - window.getBoundingClientRect().right };
  });
  expect(frame).toEqual({ border: '0px', radius: '0px', gap: 0 });

  // The rail edge resizes the whole sidebar and keeps the stored width.
  const handle = page.getByRole('separator', { name: '拖动调整会话栏宽度，双击还原' });
  const handleBox = (await handle.boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 60, handleBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBeGreaterThan(300);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-width'))).not.toBeNull();

  // Ctrl+\ folds the shared sidebar to one icon rail and remembers it as the rail preference.
  await stage.locator('header h2').click();
  await page.keyboard.press('Control+Backslash');
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-slim'))).toBe('true');
  await page.keyboard.press('Control+Backslash');
  await expect(rail).not.toHaveAttribute('data-slim', 'true');

  // Focus mode folds the sidebar to page icons only; leaving it brings the sessions back.
  await stage.getByRole('button', { name: '专注模式（隐藏侧栏）' }).click();
  await expect(rail).toHaveCount(0);
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
  await expect(nav.getByRole('button', { name: '使用记录', exact: true })).toBeVisible();
  await stage.getByRole('button', { name: '展开会话列表' }).click();
  await expect(rail).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-slim'))).toBe('false');

  // Any page is one click away; other pages get the labelled list back without the sessions.
  await nav.getByRole('button', { name: '使用记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '使用记录', exact: true })).toBeVisible();
  await expect(rail).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '使用记录', exact: true }).locator('.nav-text')).toBeVisible();
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(sidebar.getByRole('tablist', { name: '会话列表' })).toBeVisible();

  // Narrow windows keep the stacked top bar and show the sessions as a strip above the terminal.
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(page.locator('[data-term-theme]').getByRole('tablist', { name: '会话列表' })).toBeVisible();
  await expect(sidebar.getByRole('tablist', { name: '会话列表' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
