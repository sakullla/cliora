import { expect, test, type Page } from '@playwright/test';

/** Synthetic native IPC shared by the workbench terminal tests. */
async function installWorkbenchMock(page: Page) {
  await page.addInitScript(() => {
    const sessions = [{ id: 's1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() }];
    if ((window as unknown as { __twoSessions?: boolean }).__twoSessions) sessions.push({ id: 's2', toolId: 'claude_code', projectId: null, directory: 'D:/a-long-project-directory/for-the-second-session', mode: 'yolo', running: true, exitCode: null, startedAt: Date.now() });
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: string[] = [];
    const writeLog: Array<{ sessionId: string; text: string }> = [];
    const opened: string[] = [];
    Object.assign(window, {
      isTauri: true,
      __writes: writes,
      __writeLog: writeLog,
      __opened: opened,
      __output: (text: string, sessionId = 's1') => {
        const bytes = new TextEncoder().encode(text);
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId, dataBase64: btoa(String.fromCharCode(...bytes)) } });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }, { id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: args.theme }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }, { id: 'claude_code', name: 'Claude Code', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex', 'claude_code'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'open_external_url') {
            if ((window as unknown as { __failOpen?: boolean }).__failOpen) throw new Error('浏览器不可用');
            opened.push(args.url);
            return null;
          }
          if (command === 'replay_workbench_session') return (window as unknown as { __replayOverride?: string }).__replayOverride ?? btoa(args.sessionId === 's2' ? 'claude-ready\r\n> ' : 'codex-ready\r\n> ');
          if (command === 'write_workbench_session') {
            const text = new TextDecoder().decode(Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0)));
            writes.push(text);
            writeLog.push({ sessionId: args.sessionId, text });
            return null;
          }
          if (command === 'resize_workbench_session') return null;
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  });
}

async function openWorkbench(page: Page) {
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  const input = page.locator('.xterm-helper-textarea:visible');
  await input.focus();
  return input;
}

const writes = (page: Page) => page.evaluate(() => (window as unknown as { __writes: string[] }).__writes.slice());
const resetWrites = (page: Page) => page.evaluate(() => { (window as unknown as { __writes: string[] }).__writes.length = 0; });
const openedUrls = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.slice());

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

test('the mouse wheel scrolls the viewport when the CLI tracks the mouse in the normal buffer', async ({ page }) => {
  await openWorkbench(page);
  // Pi-style CLI: inline normal-buffer rendering with mouse tracking enabled for clicks. It never
  // consumes wheel reports, so the workbench must scroll the terminal itself instead of
  // forwarding the wheel to the app.
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output('\u001b[?1002h' + lines + '\r\n');
  });
  const viewport = page.locator('.xterm-viewport');
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3);
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop);
  const screen = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const start = await scrollTop();
  await page.mouse.wheel(0, -600);
  await expect.poll(scrollTop).toBeLessThan(start);
  const up = await scrollTop();
  await page.mouse.wheel(0, 600);
  await expect.poll(scrollTop).toBeGreaterThan(up);
  const down = await scrollTop();
  await page.mouse.wheel(0, -900);
  await expect.poll(scrollTop).toBeLessThan(down);
});

test('the mouse wheel scrolls the native viewport when the CLI does not track the mouse', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(lines + '\r\n');
  });
  const viewport = page.locator('.xterm-viewport');
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3);
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop);
  const box = await page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const start = await scrollTop();
  await page.mouse.wheel(0, -600);
  await expect.poll(scrollTop).toBeLessThan(start);
  const up = await scrollTop();
  await page.mouse.wheel(0, 600);
  await expect.poll(scrollTop).toBeGreaterThan(up);
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

test('terminal cursor-position replies are forwarded through the binary input channel', async ({ page }) => {
  await openWorkbench(page);
  await resetWrites(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\u001b[6n'));
  await expect.poll(async () => (await writes(page)).some((item) => /\u001b\[\d+;\d+R/.test(item))).toBe(true);
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
  await expect.poll(() => page.evaluate(() => {
    const viewport = document.querySelector('.xterm-viewport');
    if (!viewport) return Number.POSITIVE_INFINITY;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  })).toBeLessThan(3);
  await expect(page.getByRole('button', { name: '回到最新输出' })).toHaveCount(0);
  const screen = await page.locator('.xterm-screen:visible').boundingBox();
  await page.mouse.move(screen!.x + screen!.width / 2, screen!.y + screen!.height / 2);
  await page.mouse.wheel(0, -480);
  const latest = page.getByRole('button', { name: '回到最新输出', exact: true });
  await expect(latest).toBeVisible();
  await latest.click();
  await expect.poll(() => page.locator('.xterm-viewport:visible').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
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
    for (const name of ['查找输出', '复制输出', '快捷输入', '发送中断 (Ctrl+C)', '终端显示', '更多终端操作']) {
      await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();
    }
  }
  expect(await heading.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
});

test('the terminal has a slim inset scrollbar and a working return-to-latest action', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, index) => `scrollbar-line-${index}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(lines + '\r\n');
  });
  const viewport = page.locator('.xterm-viewport:visible');
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('scrollbar-line-199');
  const measure = () => viewport.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const screen = node.closest('.xterm')!.querySelector('.xterm-screen')!.getBoundingClientRect();
    const gutter = node.offsetWidth - node.clientWidth;
    const style = getComputedStyle(node);
    return {
      hasOverflow: node.scrollHeight > node.clientHeight,
      contentClear: screen.right <= bounds.right - gutter + 1,
      background: style.backgroundColor,
      nativeHidden: style.scrollbarWidth === 'none',
    };
  });
  await expect.poll(async () => {
    const metrics = await measure();
    return metrics.hasOverflow && metrics.contentClear && metrics.nativeHidden && metrics.background === 'rgb(251, 252, 250)';
  }).toBe(true);
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
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
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop / (node.scrollHeight - node.clientHeight))).toBeGreaterThan(0.3);
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop / (node.scrollHeight - node.clientHeight))).toBeLessThan(0.65);
  await scrollbar.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(0);
  await expect.poll(() => page.locator('[data-scroll-away]').count()).toBe(1);
  await expect(latest).toBeVisible();
  await page.keyboard.press('End');
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
  await expect(page.locator('[data-scroll-away]')).toHaveCount(0);
  const initialScroll = await viewport.evaluate((node) => node.scrollTop);
  expect(initialScroll).toBeGreaterThan(0);
  const screen = await page.locator('.xterm-screen:visible').boundingBox();
  await page.mouse.move(screen!.x + screen!.width / 2, screen!.y + screen!.height / 2);
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(initialScroll);
  await expect(latest).toBeVisible();
  const readingPosition = await viewport.evaluate((node) => node.scrollTop);
  const readingHeight = await viewport.evaluate((node) => node.scrollHeight);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\r\nwhile-reading\r\n'));
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight)).toBeGreaterThan(readingHeight);
  // Native viewport positions snap to the nearest terminal row after output reflow.
  await expect.poll(async () => Math.abs(await viewport.evaluate((node) => node.scrollTop) - readingPosition)).toBeLessThanOrEqual(24);
  await expect(latest).toBeVisible();
  await latest.click();
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
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
  await page.evaluate((url) => (window as unknown as { __output: (text: string) => void }).__output(`\r\n${'x'.repeat(60)}${url}\r\n`), url);
  const point = await pointForTerminalText(page, 'https://');
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
