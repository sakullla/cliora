import { expect, test, type Page } from '@playwright/test';

/** Synthetic native IPC shared by the workbench terminal tests. */
async function installWorkbenchMock(page: Page) {
  await page.addInitScript(() => {
    const sessions = [{ id: 's1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() }];
    if ((window as unknown as { __twoSessions?: boolean }).__twoSessions) sessions.push({ id: 's2', toolId: 'claude_code', projectId: null, directory: 'D:/a-long-project-directory/for-the-second-session', mode: 'yolo', running: true, exitCode: null, startedAt: Date.now() });
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: string[] = [];
    const writeBytes: number[][] = [];
    const writeLog: Array<{ sessionId: string; text: string }> = [];
    const opened: string[] = [];
    Object.assign(window, {
      isTauri: true,
      __writes: writes,
      __writeBytes: writeBytes,
      __writeLog: writeLog,
      __opened: opened,
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
            const raw = Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0));
            const text = new TextDecoder().decode(raw);
            writes.push(text);
            writeBytes.push([...raw]);
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
  const stage = page.getByRole('region', { name: '当前会话' });
  const statusIcon = root.locator('[data-activity-slot="status"]');
  const idleBox = await statusIcon.boundingBox();

  await expect(root.locator('[data-activity-icon="idle"]')).toHaveCount(5);
  await expect(statusIcon.locator('svg')).toHaveAttribute('data-shape', 'idle');
  await expect(statusIcon.locator('circle')).toBeVisible();
  await expect(stage.locator('footer')).toContainText('等待输入');

  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('current output\r\n'));
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'live');
  await expect(root.locator('[data-activity-icon="live"]')).toHaveCount(4);
  await expect(root.locator('[data-activity-icon="idle"]')).toHaveCount(1);
  await expect(statusIcon.locator('svg')).toHaveAttribute('data-shape', 'live');
  await expect(stage.locator('footer')).toContainText('正在输出');
  expect(await statusIcon.boundingBox()).toEqual(idleBox);

  await stage.getByRole('button', { name: '分屏', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('split output\r\n'));
  await expect(root.locator('[data-activity-slot="pane"][data-activity-icon="live"]')).toHaveCount(1);
  await expect(root.locator('[data-activity-slot="pane"][data-activity-icon="idle"]')).toHaveCount(1);
  await expect(stage.getByRole('img', { name: '正在输出', exact: true })).toBeVisible();
  await expect(stage.getByRole('img', { name: '等待输入', exact: true })).toBeVisible();

  const rail = page.getByRole('complementary', { name: '会话列表' });
  await rail.getByRole('button', { name: '收起会话栏', exact: true }).click();
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('compact output\r\n'));
  await expect(root.locator('[data-activity-slot="rail"][data-activity-icon="live"]')).toBeVisible();
  await expect(root.locator('[data-activity-slot="rail"][data-activity-icon="idle"]')).toBeVisible();
  await rail.getByRole('button', { name: '展开会话栏', exact: true }).click();
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(root).toHaveAttribute('data-narrow', 'true');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('narrow output\r\n'));
  await expect(root.locator('[data-activity-slot="rail"][data-activity-icon="live"]')).toHaveCount(1);
  await expect(root.locator('[data-activity-slot="rail"][data-activity-icon="idle"]')).toHaveCount(1);
  await expect(stage.locator('footer')).toContainText('正在输出');
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
  await expect(stage.locator('footer')).toContainText('异常');

  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await page.evaluate(() => (window as unknown as { __exit: (code: number, id: string) => void }).__exit(0, 's2'));
  await expect(statusIcon).toHaveAttribute('data-activity-icon', 'ended');
  await expect(stage.locator('footer')).toContainText('已结束');
});

for (const width of [1280, 640]) {
  test(`English activity states preserve status, title, and footer geometry at ${width}px`, async ({ page }) => {
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
      const chip = document.querySelector('[data-activity-slot="status"]')!.parentElement!;
      const footerState = document.querySelector('[data-activity-slot="footer"]')!.parentElement!;
      return {
        chip: box(chip),
        title: box(chip.parentElement!.querySelector('h2')!),
        footerNext: box(footerState.nextElementSibling!),
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

test('the session rail moves through sessions with vertical arrow keys', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __twoSessions: true }); });
  await openWorkbench(page);
  const codex = page.getByRole('tab', { name: /Codex/ });
  const claude = page.getByRole('tab', { name: /Claude Code/ });
  await codex.focus();
  await page.keyboard.press('ArrowDown');
  await expect(claude).toBeFocused();
  await expect(claude).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(codex).toBeFocused();
  await expect(codex).toHaveAttribute('aria-selected', 'true');
});

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
  const viewport = page.locator('.xterm-viewport');
  const remaining = () => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(remaining).toBeLessThan(3);
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop);
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
  const viewport = page.locator('.xterm-viewport:visible');
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop);
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

test('a live agent footer redraw does not bounce the viewport', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 50 }, (_, index) => `history-${String(index).padStart(2, '0')}`).join('\r\n');
    (window as unknown as { __output: (text: string) => void }).__output(`${lines}\r\n> `);
  });
  const viewport = page.locator('.xterm-viewport:visible');
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
  const result = await page.evaluate(async () => {
    const node = document.querySelector<HTMLElement>('.xterm-viewport')!;
    const output = (window as unknown as { __output: (text: string) => void }).__output;
    let dips = 0;
    let previous = node.scrollTop;
    for (let index = 0; index < 16; index += 1) {
      output(`\u001b7\u001b[2;1Hagent ${index} running · 3m ${String(index).padStart(2, '0')}s · 56.0k\u001b8`);
      output(`\rfooter ${String(index).padStart(2, '0')}`);
      output(`\nexplore-${index}\r\n> `);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const top = node.scrollTop;
      if (top + 1 < previous) dips += 1;
      previous = top;
    }
    return { dips, remaining: node.scrollHeight - node.scrollTop - node.clientHeight };
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

  await expect(stage.locator('footer')).toContainText(/\d+×\d+/);
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
  await rail.getByRole('button', { name: '收起会话栏', exact: true }).click();
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeLessThan(80);
  await expect(page.getByRole('tab', { name: /Codex/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-slim'))).toBe('true');
  await rail.getByRole('button', { name: '展开会话栏', exact: true }).click();
  await expect(rail).not.toHaveAttribute('data-slim', 'true');
  expect(await writes(page)).toEqual([]);
});
