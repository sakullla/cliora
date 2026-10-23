import { expect, test, type Page } from '@playwright/test';

/** Synthetic native IPC shared by the workbench terminal tests. */
async function installWorkbenchMock(page: Page) {
  await page.addInitScript(() => {
    const sessions = [{ id: 's1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() }];
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: string[] = [];
    Object.assign(window, {
      isTauri: true,
      __writes: writes,
      __output: (text: string) => {
        const bytes = new TextEncoder().encode(text);
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId: 's1', dataBase64: btoa(String.fromCharCode(...bytes)) } });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') return (window as unknown as { __replayOverride?: string }).__replayOverride ?? btoa('codex-ready\r\n> ');
          if (command === 'write_workbench_session') { writes.push(new TextDecoder().decode(Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0)))); return null; }
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
  await page.waitForTimeout(300);
  const viewport = page.locator('.xterm-viewport');
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop);
  const screen = page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const start = await scrollTop();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  const down = await scrollTop();
  expect(down).toBeGreaterThan(start);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(150);
  expect(await scrollTop()).toBeLessThan(down);
});

test('the mouse wheel scrolls the native viewport when the CLI does not track the mouse', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(lines + '\r\n');
  });
  await page.waitForTimeout(300);
  const viewport = page.locator('.xterm-viewport');
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop);
  const box = await page.getByRole('region', { name: '当前会话' }).locator('.xterm-screen').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const start = await scrollTop();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  expect(await scrollTop()).toBeGreaterThan(start);
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
  })).toBeLessThan(48);
  await expect(page.getByRole('button', { name: '回到最新输出' })).toHaveCount(0);
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
  await stage.locator('.xterm-screen').click({ button: 'right' });
  await page.getByRole('menu', { name: '终端操作' }).getByRole('menuitem', { name: '深色终端', exact: true }).click();
  await expect(root).toHaveAttribute('data-term-theme', 'dark');

  await page.keyboard.press('Control+Shift+F');
  await expect(stage.getByRole('searchbox', { name: '在终端输出中查找…' })).toBeFocused();
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
