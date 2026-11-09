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
  test('IME commit insertText is sent once and intentional repeated input remains intact', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea:visible');
    await input.focus();
    expect(await input.evaluate(node => {
      const style = getComputedStyle(node);
      return { border: style.borderWidth, boxShadow: style.boxShadow };
    })).toEqual({ border: '0px', boxShadow: 'none' });
    await resetWrites(page);
    const commit = async () => {
      await input.evaluate(node => {
        const textarea = node as HTMLTextAreaElement;
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.value += '覆盖';
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '覆盖', bubbles: true }));
        // Candidate selection can happen with the mouse, after keyup cleared
        // xterm's keyDownSeen. WebView2 may commit it as insertText.
        textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Process', keyCode: 229, bubbles: true }));
        textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '覆盖', bubbles: true }));
        textarea.dispatchEvent(new InputEvent('input', { data: '覆盖', inputType: 'insertText', composed: true, bubbles: true }));
      });
    };
    await commit();
    await expect.poll(async () => (await writes(page)).join('')).toBe('覆盖');
    await commit();
    await expect.poll(async () => (await writes(page)).join('')).toBe('覆盖覆盖');
    // Emoji input without composition must still use xterm's input fallback.
    await input.evaluate(node => node.dispatchEvent(new InputEvent('input', { data: '🙂', inputType: 'insertText', bubbles: true })));
    await expect.poll(async () => (await writes(page)).join('')).toBe('覆盖覆盖🙂');
  });

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

  test('confirming an IME candidate sends each word once and keeps the candidate on the input cell', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea:visible');
    await input.focus();
    await resetWrites(page);
    const commit = (word: string, key: string, keyCode: number) => input.evaluate((node, payload) => {
      const textarea = node as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      textarea.value += payload.word;
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: payload.word, bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: payload.key, keyCode: payload.keyCode, bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: payload.word, bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { data: payload.word, inputType: 'insertText', bubbles: true }));
    }, { word, key, keyCode });
    await commit('升级', ' ', 32);
    await expect.poll(async () => (await writes(page)).join('')).toBe('升级');
    await commit('审计', '1', 49);
    await expect.poll(async () => (await writes(page)).join('')).toBe('升级审计');
    await commit('哈', ' ', 32);
    await commit('哈', ' ', 32);
    await expect.poll(async () => (await writes(page)).join('')).toBe('升级审计哈哈');

    await page.evaluate(async () => {
      (window as unknown as { __output: (text: string) => void }).__output('\x1b[?25l\x1b[3;1H\x1b[7mHIGHLIGHT\x1b[0m\x1b[8;10H\x1b[7m \x1b[0m\x1b[1;1H');
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    });
    const anchor = await input.evaluate(node => {
      const textarea = node as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const screen = textarea.closest('.xterm')?.querySelector('.xterm-screen');
      const screenRect = screen?.getBoundingClientRect();
      const style = getComputedStyle(textarea);
      return {
        top: Number.parseFloat(textarea.style.top),
        left: Number.parseFloat(textarea.style.left),
        screenHeight: screenRect?.height ?? 0,
        opacity: style.opacity,
        zIndex: textarea.style.zIndex,
      };
    });
    expect(anchor.opacity).toBe('1');
    expect(anchor.zIndex).not.toBe('-5');
    expect(anchor.screenHeight).toBeGreaterThan(80);
    // Row 8, column 10 of the hidden-cursor screen, not the parked hardware cursor at 0,0.
    expect(anchor.top).toBeGreaterThan(40);
    expect(anchor.top).toBeLessThan(anchor.screenHeight);
    expect(anchor.left).toBeGreaterThan(30);
  });

  // Reproduces evidence/user-reports/2026-11-09-ime-anchor-top-left.png: a full-screen TUI
  // hides the hardware cursor, parks it at 0,0, and draws its caret as a background block.
  test('hidden hardware cursor with a drawn background-block caret keeps the candidate on the caret cell', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea:visible');
    await input.focus();
    await page.evaluate(async () => {
      (window as unknown as { __output: (text: string) => void }).__output(
        '\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[41m!\x1b[49m\x1b[3;1HQoder CLI 1.2.3\x1b[8;10H\x1b[44m \x1b[49m\x1b[1;1H');
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    });
    const measure = async () => input.evaluate(node => {
      const textarea = node as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const screen = textarea.closest('.xterm')?.querySelector('.xterm-screen');
      const screenRect = screen?.getBoundingClientRect();
      const placement = {
        top: Number.parseFloat(textarea.style.top),
        left: Number.parseFloat(textarea.style.left),
        screenHeight: screenRect?.height ?? 0,
      };
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
      return placement;
    });
    const anchor = await measure();
    // The drawn block at row 8, column 10 — not the parked hardware cursor at 0,0.
    expect(anchor.top).toBeGreaterThan(40);
    expect(anchor.top).toBeLessThan(anchor.screenHeight);
    expect(anchor.left).toBeGreaterThan(30);
    // Once the block is gone, the last confirmed input point is kept, not the window origin.
    await page.evaluate(async () => {
      (window as unknown as { __output: (text: string) => void }).__output('\x1b[2J\x1b[H\x1b[3;1Hplain output only');
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(await measure()).toEqual(anchor);
  });

  test('hidden cursor with no drawn caret anchors the candidate in the bottom-left prompt area, never the window origin', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea:visible');
    await input.focus();
    await page.evaluate(async () => {
      (window as unknown as { __output: (text: string) => void }).__output(
        '\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[41m!\x1b[49m\x1b[3;1HQoder CLI 1.2.3\r\n\x1b[20;1H> 帮我改一个 bug');
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    });
    const anchor = await input.evaluate(node => {
      const textarea = node as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const screen = textarea.closest('.xterm')?.querySelector('.xterm-screen');
      const screenRect = screen?.getBoundingClientRect();
      const placement = {
        top: Number.parseFloat(textarea.style.top),
        left: Number.parseFloat(textarea.style.left),
        screenHeight: screenRect?.height ?? 0,
      };
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
      return placement;
    });
    expect(anchor.screenHeight).toBeGreaterThan(80);
    // The prompt lives at the bottom-left of the viewport; the parked hardware cursor does not.
    expect(anchor.top).toBeGreaterThan(anchor.screenHeight / 2);
    expect(anchor.top).toBeLessThan(anchor.screenHeight);
    expect(anchor.left).toBeLessThan(20);
  });

  // The two orders below sent 升级升级 before the transaction rewrite (evidence/ime-before.json).
  // 30 ms only moves an event to a later task; it is a test interval, not a product threshold.
  test('candidate commits that span event turns send each confirmed word exactly once', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea:visible');
    await expect(page.locator('[data-ime-bridge]').first()).toHaveAttribute('data-ime-bridge', 'ready');
    await input.focus();
    const commit = (word: string, order: string, key = ' ', keyCode = 32) => input.evaluate(async (node, payload) => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 30));
      const textarea = node as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      textarea.value += payload.word;
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: payload.word, bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: payload.key, keyCode: payload.keyCode, bubbles: true }));
      if (payload.order === 'delayed-end') await wait();
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: payload.word, bubbles: true }));
      if (payload.order === 'delayed-trailing-input') {
        await wait();
        textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Process', keyCode: 229, bubbles: true }));
      }
      textarea.dispatchEvent(new InputEvent('input', { data: payload.word, inputType: 'insertText', composed: true, bubbles: true }));
      await wait();
    }, { word, order, key, keyCode });
    for (const order of ['same-turn', 'delayed-end', 'delayed-trailing-input']) {
      await resetWrites(page);
      await commit('升级', order);
      expect(await writes(page), order).toEqual(['升级']);
      // A second confirmation of the same word is the user's input, never a duplicate.
      await commit('升级', order, '1', 49);
      expect(await writes(page), order).toEqual(['升级', '升级']);
    }
    // English and emoji still take their own paths after a commit.
    await resetWrites(page);
    await input.press('a');
    await input.evaluate(node => node.dispatchEvent(new InputEvent('input', { data: '🙂', inputType: 'insertText', bubbles: true })));
    await expect.poll(async () => (await writes(page)).join('')).toBe('a🙂');
  });

  test('a composition interrupted by blur or a session switch is never sent later or to the next session', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.assign(window, { __twoSessions: true });
    });
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const first = page.locator('[data-pane-session="s1"] .xterm-helper-textarea');
    await expect(first).toBeVisible();
    await first.focus();
    await page.evaluate(() => { (window as unknown as { __writeLog: unknown[] }).__writeLog.length = 0; });
    const begin = (locator: typeof first, word: string) => locator.evaluate((node, word) => {
      const textarea = node as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      textarea.value += word;
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: word, bubbles: true }));
    }, word);
    const finish = (locator: typeof first, word: string) => locator.evaluate((node, word) => {
      node.dispatchEvent(new CompositionEvent('compositionend', { data: word, bubbles: true }));
      node.dispatchEvent(new InputEvent('input', { data: word, inputType: 'insertText', composed: true, bubbles: true }));
    }, word);

    // Focus moves to the search field mid-composition; a late end must not type into the CLI.
    await begin(first, 'shengji');
    await page.getByRole('tab', { name: /Codex/ }).focus();
    await finish(first, 'shengji');
    await page.waitForTimeout(50);
    expect(await writeLog(page)).toEqual([]);

    // Switching sessions mid-composition: nothing reaches either session.
    await first.focus();
    await begin(first, '升级');
    await page.getByRole('tab', { name: /Claude Code/ }).click();
    const second = page.locator('[data-pane-session="s2"] .xterm-helper-textarea');
    await expect(second).toBeVisible();
    await finish(first, '升级');
    await page.waitForTimeout(50);
    expect(await writeLog(page)).toEqual([]);

    // The new session's own composition goes only to it, once.
    await second.focus();
    await begin(second, '审计');
    await finish(second, '审计');
    await expect.poll(() => writeLog(page)).toEqual([{ sessionId: 's2', text: '审计' }]);
  });

  test('the anchor stays inside a shrunken screen, skips a collapsed layout and returns with it', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea:visible');
    await input.focus();
    // Put the input cell on the last row, then hold it in a composition.
    await page.evaluate(async () => {
      (window as unknown as { __output: (text: string) => void }).__output('\x1b[999;60H');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))));
    });
    const box = () => input.evaluate(node => {
      const screen = node.closest('.xterm')!.querySelector('.xterm-screen')!.getBoundingClientRect();
      const field = node.getBoundingClientRect();
      return { top: field.top - screen.top, bottom: screen.bottom - field.bottom, left: field.left - screen.left, right: screen.right - field.right, styleTop: (node as HTMLElement).style.top, height: screen.height, fieldHeight: field.height, cellHeight: Number.parseFloat((node as HTMLElement).style.height) };
    });
    await input.evaluate(node => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      (node as HTMLTextAreaElement).value += '升级';
      node.dispatchEvent(new CompositionEvent('compositionupdate', { data: '升级', bubbles: true }));
    });
    const tall = await box();
    // The field is exactly one cell tall, not the shared 36px control height.
    expect(Math.abs(tall.fieldHeight - tall.cellHeight)).toBeLessThan(1);
    expect(tall.bottom).toBeGreaterThanOrEqual(-1);
    await page.setViewportSize({ width: 900, height: 520 });
    await expect.poll(async () => (await box()).height).toBeLessThan(tall.height);
    await expect.poll(async () => { const now = await box(); return now.bottom >= -1 && now.top >= -1 && now.right >= -1 && now.left >= -1; }).toBe(true);
    await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { data: '升级', bubbles: true })));
    await expect.poll(async () => (await writes(page)).join('')).toContain('升级');

    // A collapsed workbench keeps the last valid anchor instead of writing a zero-size one.
    const valid = (await box()).styleTop;
    await page.evaluate(() => { Object.assign(document.querySelector<HTMLElement>('[data-pane-session="s1"] .xterm')!.parentElement!.style, { flex: '0 0 0px', height: '0px' }); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));
    expect(await input.evaluate(node => (node as HTMLElement).style.top)).toBe(valid);
    await page.evaluate(() => { Object.assign(document.querySelector<HTMLElement>('[data-pane-session="s1"] .xterm')!.parentElement!.style, { flex: '', height: '' }); });
    await expect.poll(async () => { const now = await box(); return now.top >= -1 && now.bottom >= -1; }).toBe(true);
  });

  test('the pre-edit text sits in the terminal cell without a floating panel', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const input = page.locator('.xterm-helper-textarea:visible');
    await input.focus();
    await input.evaluate(node => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      (node as HTMLTextAreaElement).value += 'sheng';
      node.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'sheng', bubbles: true }));
    });
    const view = page.locator('[data-pane-session="s1"] .composition-view');
    await expect(view).toHaveClass(/active/);
    const style = await view.evaluate(node => {
      const css = getComputedStyle(node);
      return { shadow: css.boxShadow, radius: css.borderRadius, padding: css.paddingLeft, background: css.backgroundColor };
    });
    expect(style.shadow).toBe('none');
    expect(style.radius).toBe('0px');
    expect(style.padding).toBe('0px');
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    await input.evaluate(node => {
      (node as HTMLTextAreaElement).value = (node as HTMLTextAreaElement).value.replace(/sheng$/, '');
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      node.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
    });
    await expect(view).not.toHaveClass(/active/);
    await page.waitForTimeout(50);
    expect(await writes(page)).not.toContainEqual(expect.stringContaining('sheng'));
    expect(await writes(page)).not.toContain('\x1b');
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
    let language: string | null = null;
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: 'light', language, remote_ssh_enabled: holdStartup }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }, { id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }] });
    let releaseStartup = () => {};
    const startupReady = new Promise<void>((resolve) => { releaseStartup = resolve; });
    const sessions = [{ id: 's1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: (window as unknown as { __oldSessions?: boolean }).__oldSessions ? 1 : Date.now() }];
    if ((window as unknown as { __twoSessions?: boolean }).__twoSessions) sessions.push({ id: 's2', toolId: 'claude_code', projectId: null, directory: 'D:/a-long-project-directory/for-the-second-session', mode: 'yolo', running: true, exitCode: null, startedAt: Date.now() });
    if ((window as unknown as { __emptySessions?: boolean }).__emptySessions) sessions.length = 0;
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const writes: string[] = [];
    const writeBytes: number[][] = [];
    const writeLog: Array<{ sessionId: string; text: string }> = [];
    const opened: string[] = [];
    const pathOpens: Array<{ sessionId: string; path: string; cwd?: string }> = [];
    const resizes: Array<{ sessionId: string; cols: number; rows: number }> = [];
    Object.assign(window, {
      isTauri: true,
      // A session that shows up later (a launch, another process) must heal a stale pending row.
      __addSession: (session: Record<string, unknown>) => { if (!sessions.some((item) => item.id === session.id)) sessions.push(session as never); },
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
          if (command === 'get_bootstrap') return bootstrap();
          if (command === 'set_language') { language = args.language; return bootstrap(); }
          if (command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: ['codex', 'claude_code'], theme: args.theme }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }, { id: 'claude_code', name: 'Claude Code', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex', 'claude_code'], preservedUnknown: [] };
          if (command === 'get_launch_settings') {
            const harness = window as unknown as { __worktreeLaunch?: string; __worktreeLaunchError?: string | null };
            const error = harness.__worktreeLaunchError ?? null;
            return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal', worktreeLaunch: error ? null : (harness.__worktreeLaunch ?? 'direct'), worktreeLaunchError: error };
          }
          if (command === 'set_worktree_launch') {
            const harness = window as unknown as { __worktreeLaunch?: string; __worktreeLaunchError?: string | null; __worktreeSaves?: string[]; __worktreeSaveFails?: boolean };
            harness.__worktreeSaves = [...(harness.__worktreeSaves ?? []), args.mode];
            if (harness.__worktreeSaveFails) throw new Error('保存失败');
            harness.__worktreeLaunch = args.mode;
            harness.__worktreeLaunchError = null;
            return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal', worktreeLaunch: args.mode, worktreeLaunchError: null };
          }
          if (command === 'worktree_base_preview' || command === 'worktree_base_update') {
            const harness = window as unknown as {
              __basePreview?: Record<string, unknown>;
              __baseUpdateFails?: boolean;
              __baseReads?: unknown[];
              __baseUpdates?: unknown[];
            };
            const call = { directory: args.directory, base: args.base ?? null };
            if (command === 'worktree_base_preview') harness.__baseReads = [...(harness.__baseReads ?? []), call];
            else harness.__baseUpdates = [...(harness.__baseUpdates ?? []), call];
            if (command === 'worktree_base_update' && harness.__baseUpdateFails) throw new Error('更新远程基点失败：网络不可用');
            const base = args.base as { kind?: string; reference?: string } | null;
            const reference = base?.kind === 'reference' ? base.reference ?? null : base?.kind === 'head' ? 'HEAD' : 'origin/main';
            return {
              kind: base?.kind ?? 'default',
              reference,
              commit: 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff',
              shortCommit: 'c0ffee1',
              remote: reference && reference.includes('/') ? reference.split('/')[0] : null,
              branch: reference && reference.includes('/') ? reference.split('/').slice(1).join('/') : null,
              degraded: null,
              candidates: [],
              available: true,
              reason: null,
              // The branch the creation would allocate for the current task text.
              proposedBranch: String(args.taskText ?? '').trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean)
                ?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shop',
              ...(harness.__basePreview ?? {}),
            };
          }
          if (command === 'worktree_status') {
            const harness = window as unknown as {
              __worktreeStatus?: Record<string, Record<string, unknown>>;
              __worktreeStatusFails?: string[];
              __statusReads?: string[];
            };
            harness.__statusReads = [...(harness.__statusReads ?? []), args.directory];
            if ((harness.__worktreeStatusFails ?? []).includes(args.directory)) throw new Error('无法读取工作树状态');
            return harness.__worktreeStatus?.[args.directory] ?? {
              worktreePath: args.directory, managed: true, environment: 'prepared', branch: null, headOid: null, uncommittedFiles: 0, state: 'ready', reason: null,
            };
          }
          if (command === 'launch_cli') {
            const harness = window as unknown as {
              __launches?: unknown[];
              __worktreeScript?: Array<{ event?: { stage: string; worktreePath?: string; branch?: string; error?: string }; hold?: boolean; fail?: string }>;
              __worktreeRelease?: () => void;
            };
            const request = args.request as Record<string, any>;
            harness.__launches = [...(harness.__launches ?? []), request];
            const operationId: string | undefined = request?.worktree?.operationId;
            const emit = (stage: string, extra: Record<string, unknown> = {}) => {
              if (!operationId) return;
              bridge.handlers[bridge.listens['cliora:worktree-launch']]?.({ payload: { operationId, stage, worktreePath: null, branch: null, sessionId: null, error: null, ...extra } });
            };
            const settle = (directory: string) => {
              const id = `launched-${harness.__launches!.length}`;
              sessions.unshift({ id, toolId: request.toolId, projectId: request.projectId, directory, mode: request.mode || 'normal', running: true, exitCode: null, startedAt: Date.now() });
              return { toolId: request.toolId, projectId: request.projectId, mode: request.mode || 'normal', terminal: 'workbench', status: 'session_started', sessionId: id };
            };
            const explicit = request?.worktreeIntent === 'explicit' || request?.worktreeIntent === 'prepareRetry';
            if (!explicit) return settle(request.directory || 'C:/work');
            // A scripted explicit creation: real stage events, optional hold, failure or success.
            let directory = request.worktree?.retryDirectory ?? request.directory ?? 'C:/work-feat';
            for (const step of harness.__worktreeScript ?? []) {
              if (step.event) {
                directory = step.event.worktreePath ?? directory;
                emit(step.event.stage, {
                  ...(step.event.worktreePath ? { worktreePath: step.event.worktreePath } : {}),
                  ...(step.event.branch ? { branch: step.event.branch } : {}),
                  ...(step.event.error ? { error: step.event.error } : {}),
                });
              }
              if (step.hold) await new Promise<void>((resolve) => { harness.__worktreeRelease = resolve; });
              if (step.fail) throw new Error(step.fail);
            }
            const result = settle(directory);
            emit('succeeded', { worktreePath: directory, sessionId: result.sessionId });
            return result;
          }
          if (command === 'list_projects') return (window as unknown as { __projects?: unknown[] }).__projects ?? [];
          if (command === 'git_worktrees') {
            const harness = window as unknown as { __worktrees?: unknown[]; __worktreeReadFails?: boolean };
            if (harness.__worktreeReadFails) throw new Error('无法读取工作树列表');
            return harness.__worktrees ?? [];
          }
          if (command === 'list_worktree_ledger') return ((window as unknown as { __ledger?: unknown[] }).__ledger ?? []).map((item) => ({ ...(item as object) }));
          if (command === 'worktree_prepare') {
            const harness = window as unknown as { __prepareReads?: string[]; __prepareCommand?: string | null };
            harness.__prepareReads = [...(harness.__prepareReads ?? []), args.directory];
            return harness.__prepareCommand ?? null;
          }
          if (command === 'save_worktree_prepare') {
            const harness = window as unknown as { __prepareCommand?: string | null; __prepareSaves?: unknown[]; __prepareSaveFails?: boolean };
            harness.__prepareSaves = [...(harness.__prepareSaves ?? []), { directory: args.directory, command: args.command }];
            if (harness.__prepareSaveFails) throw new Error('保存失败');
            harness.__prepareCommand = args.command;
            return { mainCheckout: args.directory, command: args.command };
          }
          if (command === 'cleanup_worktree') {
            const harness = window as unknown as { __cleanups?: unknown[]; __cleanupError?: string; __cleanupNeedsConfirm?: boolean; __cleanupDetail?: string };
            harness.__cleanups = [...(harness.__cleanups ?? []), { path: args.path, confirm: args.confirm }];
            if (harness.__cleanupError) throw new Error(harness.__cleanupError);
            if (!args.confirm && harness.__cleanupNeedsConfirm) return { removed: false, needsConfirmation: true, detail: harness.__cleanupDetail ?? '将丢弃未提交的改动' };
            return { removed: true, needsConfirmation: false, detail: '' };
          }
          if (command === 'workbench_git_context') return (window as unknown as { __gitContext?: unknown }).__gitContext ?? null;
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
          if (command === 'list_workbench_restore_sessions') {
            const harness = window as unknown as {
              __savedRestores?: Array<Record<string, any>>;
              __savedRestoreFails?: boolean;
              __restoreReport?: { restored?: Record<string, string>; failures?: Array<Record<string, any>> };
            };
            if (harness.__savedRestoreFails) throw new Error('无法读取上次会话');
            harness.__restoreListCalls = (harness.__restoreListCalls ?? 0) + 1;
            if (harness.__savedRestores) return harness.__savedRestores.map((item) => ({ ...item }));
            // Tests written before the saved-record read only declare a batch report; derive the
            // pending rows from it so the same fixture still exercises the queue.
            const report = harness.__restoreReport;
            if (!report) return [];
            // A record from an earlier run: an old start time and its own directory, so it never
            // looks like one of the live fixture sessions.
            const base = { projectId: null, mode: 'normal', startedAt: Date.now() - 3_600_000, stoppedAt: null, nativeId: null, accountId: null, contextId: null };
            return [
              ...Object.keys(report.restored ?? {}).map((id) => ({ ...base, id, toolId: 'codex', directory: 'C:/previous-run' })),
              ...(report.failures ?? []).map((item) => ({ ...base, ...item.session })),
            ];
          }
          if (command === 'restore_workbench_sessions') {
            const harness = window as unknown as {
              __restoreReport?: unknown;
              __restoreCalls?: number;
              __savedRestores?: Array<Record<string, any>>;
              __restoreScript?: Array<{ hold?: boolean; event: Record<string, any> }>;
              __restoreRelease?: () => void;
              __restoreDelay?: number;
            };
            harness.__restoreCalls = (harness.__restoreCalls ?? 0) + 1;
            // A batch that only answers at the end is the pre-event baseline for the timing test.
            if (harness.__restoreDelay) await new Promise<void>((resolve) => setTimeout(resolve, harness.__restoreDelay));
            const script = harness.__restoreScript;
            if (!Array.isArray(script)) {
              const report = harness.__restoreReport ?? { restored: {}, failures: [] } as { restored?: Record<string, string>; failures?: unknown[] };
              // A report-only batch still has to hand the view real sessions: the restore report
              // carries ids, so the list must agree or the view has nothing to show.
              for (const [savedId, id] of Object.entries(report.restored ?? {})) {
                if (sessions.some((item) => item.id === id)) continue;
                const saved = (harness.__savedRestores ?? []).find((item) => item.id === savedId) ?? { toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal' };
                sessions.push({ id, toolId: saved.toolId, projectId: saved.projectId ?? null, directory: saved.directory, mode: saved.mode ?? 'normal', running: true, exitCode: null, startedAt: Date.now() });
              }
              return report;
            }
            // A scripted batch publishes each record's own stages; a held step keeps the batch
            // promise pending while the already published rows are on screen.
            const restoreId = 'restore-' + harness.__restoreCalls;
            const emit = (payload: Record<string, unknown>) => {
              bridge.handlers[bridge.listens['cliora:workbench-restore']]?.({ payload: { restoreId, detail: null, candidates: [], session: null, ...payload } });
            };
            const restored: Record<string, string> = {};
            const failures: unknown[] = [];
            for (const step of script) {
              const event = step.event;
              if (event) {
                if (event.stage === 'restored') {
                  const id: string = event.session?.id ?? 'restored-' + event.savedSessionId;
                  const snapshot = event.session ?? { id, toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() };
                  if (!sessions.some((item) => item.id === id)) sessions.push(snapshot);
                  restored[event.savedSessionId] = id;
                  emit({ ...event, session: snapshot });
                } else if (event.stage === 'failed') {
                  const saved = (harness.__savedRestores ?? []).find((item) => item.id === event.savedSessionId)
                    ?? { id: event.savedSessionId, toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal' };
                  failures.push({ session: saved, detail: event.detail ?? '', candidates: event.candidates ?? [] });
                  emit(event);
                } else {
                  emit(event);
                }
              }
              if (step.hold) await new Promise<void>((resolve) => { harness.__restoreRelease = resolve; });
            }
            return { restored, failures };
          }
          if (command === 'restore_workbench_session') {
            Object.assign(window, { __restoreChoice: args });
            const oneHarness = window as unknown as {
              __savedRestores?: Array<Record<string, any>>;
              __restoreOneFailure?: { detail: string; candidates: unknown[] };
              __restoreOne?: Array<{ sessionId: string; nativeId: string | null }>;
            };
            oneHarness.__restoreOne = [...(oneHarness.__restoreOne ?? []), { sessionId: args.sessionId, nativeId: args.nativeId ?? null }];
            const saved = (oneHarness.__savedRestores ?? []).find(item => item.id === args.sessionId);
            if (saved && !args.nativeId) {
              // A single record retried on its own: it may fail again without touching other rows.
              const retryFailure = oneHarness.__restoreOneFailure;
              if (retryFailure) return { restored: {}, failures: [{ session: saved, ...retryFailure }] };
              const retriedId = 'resumed-' + args.sessionId;
              if (!sessions.some(item => item.id === retriedId)) {
                sessions.push({ ...saved, id: retriedId, running: true, exitCode: null, startedAt: Date.now() });
              }
              return { restored: { [args.sessionId]: retriedId }, failures: [] };
            }
            const index = sessions.findIndex(item => item.id === args.sessionId);
            if (index >= 0) {
              const failure = (window as unknown as { __reconnectFailure?: { detail: string; candidates: unknown[] } }).__reconnectFailure;
              if (failure && !args.nativeId) return { restored: {}, failures: [{ session: sessions[index], ...failure }] };
              const id = `resumed-${args.sessionId}`;
              sessions.splice(index, 1, { ...sessions[index], id, running: true, exitCode: null });
              return { restored: { [args.sessionId]: id }, failures: [] };
            }
            return { restored: { [args.sessionId]: 's1' }, failures: [] };
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

/** Wall-clock numbers measured in the browser against synthetic IPC; never native evidence. */
function reportRestoreTiming(info: { attach: (name: string, body: { body: string; contentType: string }) => Promise<void> }, payload: Record<string, unknown>) {
  const record = { ...payload, nativePlatform: 'unverified', note: 'Browser timing with synthetic IPC; it does not measure WebView2, macOS or Linux restores.' };
  console.log('restore timing', record);
  void info.attach('restore-timing-' + String(payload.mode), { body: JSON.stringify(record), contentType: 'application/json' });
}

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
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('compact output\r\n'));
  await expect(workbench.locator('[data-activity-slot="rail"][data-activity-icon="live"]')).toBeVisible();
  await expect(workbench.locator('[data-activity-slot="rail"][data-activity-icon="idle"]')).toBeVisible();
  const compactLive = rail.locator('[data-rail-icon][data-tone="live"]');
  expect(await compactLive.evaluate(node => getComputedStyle(node, '::after').animationName)).toContain('wbTileRing');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await compactLive.evaluate(node => getComputedStyle(node, '::after').animationName)).toBe('none');
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
  await expect(statusIcon.locator('svg')).toHaveCSS('animation-name', /wbActivity/);
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

test('Ctrl+V pastes text and an invalid image reports an error without sending a shortcut', async ({ page }) => {
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
  await expect(page.getByRole('alert').filter({ hasText: '剪贴板图片转 PNG 失败' })).toBeVisible();
  expect(await writes(page)).toEqual([]);
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
  // Measure once the shell has settled (the session list docks into the sidebar after mount).
  let settled = '';
  await expect.poll(async () => {
    const box = await screen.boundingBox();
    const now = box ? `${box.width}x${box.height}` : '';
    const stable = !!now && now === settled;
    settled = now;
    return stable;
  }, { intervals: [150] }).toBe(true);
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

test('terminal content dominates quiet, opaque find and composer surfaces', async ({ page }) => {
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  const share = await stage.evaluate((element) => {
    const screen = element.querySelector('.xterm-screen');
    if (!screen) return 0;
    return screen.getBoundingClientRect().height / element.getBoundingClientRect().height;
  });
  expect(share).toBeGreaterThan(0.65);

  await stage.getByRole('button', { name: '查找输出', exact: true }).click();
  const findStyle = await stage.getByRole('search').evaluate((element) => {
    const style = getComputedStyle(element);
    return { backdrop: style.backdropFilter, background: style.backgroundImage };
  });
  expect(findStyle).toEqual({ backdrop: 'none', background: 'none' });
  await page.keyboard.press('Escape');

  await stage.getByRole('button', { name: '快捷输入', exact: true }).click();
  const composer = stage.getByRole('region', { name: '多行输入与提示词投递' });
  const input = composer.getByRole('textbox');
  await expect(input).toBeFocused();
  // The accent ring is the intentional focus state; the resting card itself stays flat.
  expect(await composer.locator(':scope > div').evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  await input.evaluate((element) => element.blur());
  await expect.poll(() => composer.locator(':scope > div').evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none');
  expect(await composer.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe('none');
  expect(await writes(page)).toEqual([]);
});

test('the empty launchpad keeps every entry without decorative motion or floating cards', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __emptySessions: true }); });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage.getByRole('heading', { name: '还没有进行中的会话' })).toBeVisible();
  const launcher = stage.getByRole('button', { name: '新建会话', exact: true });
  await expect(launcher).toBeVisible();
  await expect(stage.getByRole('region', { name: '直接启动 CLI' })).toBeVisible();
  await expect(stage.getByRole('region', { name: '最近项目' })).toHaveCount(0);
  const surfaces = await launcher.evaluate((element) => {
    const empty = element.closest('[class*="emptyShell"]')?.parentElement;
    const glyph = empty?.querySelector('[class*="emptyGlyph"]');
    return {
      launcherShadow: getComputedStyle(element).boxShadow,
      emptyBackground: empty ? getComputedStyle(empty).backgroundImage : '',
      glyphMotion: glyph ? getComputedStyle(glyph).animationName : '',
    };
  });
  expect(surfaces).toEqual({ launcherShadow: 'none', emptyBackground: 'none', glyphMotion: 'none' });
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(launcher).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
    return metrics.hasOverflow && metrics.contentClear && metrics.nativeHidden && metrics.background === 'rgb(253, 253, 252)';
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
  // Output parsing and the React scrollbar update finish asynchronously.
  // remaining === 0 also describes the initial, non-scrollable terminal, so
  // wait for the history and scrollbar before taking the redraw baseline.
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('history-49');
  const scrollbar = page.getByRole('scrollbar', { name: '终端滚动条', exact: true });
  await expect(scrollbar).toBeVisible();
  await expect.poll(async () => (await readScroll(viewport)).remaining).toBe(0);
  const result = await scrollbar.evaluate(async (scrollbar) => {
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

test('a link hint stays up while a TUI keeps redrawing the line under a still pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWorkbench(page);
  const path = '/Users/fixture/github/project/docs/sakullla-workflow/2026-10-31-git-gui管理工具';
  const draw = (stamp: string) => page.evaluate(({ path, stamp }) => (window as unknown as { __output: (text: string) => void }).__output(`\x1b[2;1H\x1b[2K❯ /using-workflow ${path}   ${stamp}`), { path, stamp });
  await draw('11:46:00');
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('using-workflow');
  const point = await pointForTerminalText(page, 'sakullla-workflow');
  await page.mouse.move(point.x, point.y);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  // Record every hide and every change of the shown target while the row is redrawn under a still pointer.
  await page.evaluate(() => {
    const hint = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    const state = { hides: 0, texts: new Set<string>() };
    Object.assign(window, { __hintState: state });
    new MutationObserver(() => { if (hint.hidden) state.hides++; state.texts.add(hint.querySelector('code')?.textContent ?? ''); }).observe(hint, { attributes: true, attributeFilter: ['hidden'], subtree: true, childList: true, characterData: true });
  });
  // Twelve redraws ~100 ms apart, each painted in two pieces, as a CLI status line does.
  const maxGap = await page.evaluate((path) => new Promise<number>((resolve) => {
    const output = (window as unknown as { __output: (text: string) => void }).__output;
    let index = 0;
    let gap = 0;
    const frame = () => {
      if (++index > 12) { resolve(gap); return; }
      output(`\x1b[2;1H\x1b[2K❯ /using-workflow ${path.slice(0, 24)}`);
      const half = performance.now();
      setTimeout(() => { gap = Math.max(gap, performance.now() - half); output(`${path.slice(24)}   11:46:${String(index).padStart(2, '0')}`); setTimeout(frame, 60); }, 40);
    };
    frame();
  }), path);
  await page.waitForTimeout(300);
  const seen = await page.evaluate(() => { const state = (window as unknown as { __hintState: { hides: number; texts: Set<string> } }).__hintState; return { hides: state.hides, texts: [...state.texts].filter(Boolean) }; });
  // A starved browser can hold a half-painted row longer than any grace period; only judge runs that kept the CLI's pace.
  expect(seen.texts.every((text) => text === path)).toBe(true);
  if (maxGap < 150) {
    expect(seen.hides).toBe(0);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(path);
  }
  // Moving off the link still hides it, and a redraw that removes the link hides it too.
  await page.mouse.move(point.x, point.y + 200);
  await expect(tooltip).toBeHidden();
  await page.mouse.move(point.x, point.y);
  await expect(tooltip).toBeVisible();
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b[2;1H\x1b[2Kplain text only'));
  await expect(tooltip).toBeHidden();
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
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '首页', exact: true }).click();
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

test('a wide character wrapped at the last column keeps the file path whole', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await openWorkbench(page);
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output(`\r\n${'x'.repeat(240)}\r\n`));
  const columnCount = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.xterm-rows > div')].filter((row) => row.getClientRects().length);
    return Math.max(0, ...rows.map((row) => (row.textContent ?? '').match(/x+/)?.[0].length ?? 0));
  });
  await expect.poll(columnCount).toBeGreaterThan(24);
  const cols = await columnCount();
  const prefix = '/C:/work/docs/';
  const beforeWidth = 2 + prefix.length;
  expect(cols).toBeGreaterThan(beforeWidth + 1);
  const path = `${prefix}${'a'.repeat(cols - 1 - beforeWidth)}通用工作流运行时约束与性能优化.md`;
  await page.evaluate((path) => (window as unknown as { __output: (text: string) => void }).__output(`\r\n（${path}）。\r\n`), path);
  await expect.poll(() => page.evaluate((prefix) => {
    const rows = [...document.querySelectorAll<HTMLElement>('.xterm-rows > div')].filter((row) => row.getClientRects().length);
    const index = rows.findIndex((row) => (row.textContent ?? '').includes(prefix));
    const first = rows[index]?.textContent ?? '';
    const next = (rows[index + 1]?.textContent ?? '').replace(/\s/g, '');
    return index >= 0 && !first.includes('通') && next.startsWith('通');
  }, prefix)).toBe(true);
  const requests = () => page.evaluate(() => (window as unknown as { __pathOpens: Array<{ path: string }> }).__pathOpens.map(item => item.path));
  for (const label of [prefix, '优化.md']) {
    const point = await pointForTerminalText(page, label);
    await page.mouse.move(point.x, point.y);
    await expect(page.getByRole('tooltip').locator('code')).toHaveText(path);
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
    await page.mouse.move(8, 8);
  }
  await expect.poll(requests).toEqual([path, path]);
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

test.describe('session switching with the production renderer', () => {
  test('synchronized TUI redraws keep status motion lightweight and avoid redundant frame scheduling', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      const request = window.requestAnimationFrame.bind(window);
      (window as any).__requestedFrames = 0;
      window.requestAnimationFrame = callback => {
        (window as any).__requestedFrames++;
        return request(callback);
      };
    });
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    await expect(page.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible();
    await resetWrites(page);
    const frames = await page.evaluate(async () => {
      const w = window as any;
      w.__requestedFrames = 0;
      for (let index = 0; index < 90; index++) {
        // CodeBuddy 2.181 uses this DEC synchronized-update envelope and a
        // 30 FPS render limit. The fixture contains no user's terminal content.
        w.__output(`\x1b[?2026h\x1b[?25l\r\x1b[2Ktask ${index}\r\n\x1b[2Kstatus\x1b[1A\r\x1b[?25h\x1b[?2026l`);
        await new Promise(resolve => setTimeout(resolve, 33));
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      return w.__requestedFrames as number;
    });
    expect(frames).toBeLessThan(90 * 4);
    for (const icon of await page.locator('[data-activity-icon="live"] svg').all()) {
      await expect(icon).toHaveCSS('animation-name', /wbActivity/);
    }
    const motion = await page.evaluate(() => {
      const animations = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations === Infinity);
      const paintProperties = new Set(['boxShadow', 'backgroundPosition', 'backgroundColor', 'borderColor', 'width', 'height', 'top', 'left']);
      return {
        count: animations.length,
        heavy: [...new Set(animations.flatMap(animation => (animation.effect?.getKeyframes() ?? []).flatMap(frame => Object.keys(frame).filter(key => paintProperties.has(key)))))],
      };
    });
    expect(motion.count).toBeGreaterThan(0);
    expect(motion.heavy).toEqual([]);
    await page.evaluate(() => (window as any).__output('\x1b[6n'));
    await expect.poll(() => writes(page)).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
    await page.getByRole('button', { name: '查找输出', exact: true }).click();
    await page.getByRole('searchbox', { name: '在终端输出中查找…' }).fill('task 89');
    await expect(page.getByRole('region', { name: '当前会话' })).toContainText('1 / 1');
  });

  test.use({
    deviceScaleFactor: 1.25,
  });

  test('revealing a WebGL terminal preserves its grid', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.assign(window, { __twoSessions: true });
    });
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const codex = page.getByRole('tab', { name: /Codex/ });
    const claude = page.getByRole('tab', { name: /Claude Code/ });
    const canvas = (id: string) => page.locator(`[data-pane-session="${id}"] .xterm-screen canvas:not(.xterm-link-layer)`);
    const grids = () => page.evaluate(() => (window as unknown as { __resizes: Array<{ sessionId: string; cols: number; rows: number }> }).__resizes.filter(item => item.sessionId === 's1'));
    await expect(canvas('s1')).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    await page.waitForTimeout(300);
    const settled = await grids();
    expect(settled.length).toBeGreaterThan(0);
    for (let round = 0; round < 3; round += 1) {
      await claude.click();
      await expect(canvas('s2')).toBeVisible();
      await codex.click();
      await expect(canvas('s1')).toBeVisible();
    }
    await page.waitForTimeout(300);
    expect(await grids()).toEqual(settled);
    // Actual layout changes must still reach the PTY; the fix must not freeze fitting.
    await page.setViewportSize({ width: 1100, height: 720 });
    await expect.poll(async () => (await grids()).at(-1)?.cols).toBeLessThan(settled.at(-1)!.cols);
  });

  test('rapid session switches reuse warm renderers with bounded contexts', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.assign(window, { __twoSessions: true, __webglCreates: 0 });
      const original = HTMLCanvasElement.prototype.getContext;
      const seen = new WeakSet<HTMLCanvasElement>();
      HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: unknown[]) {
        if (kind === 'webgl2' && !seen.has(this)) {
          seen.add(this);
          (window as any).__webglCreates++;
        }
        return original.call(this, kind as any, ...args);
      } as typeof original;
    });
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const canvas = (id: string) => page.locator(`[data-pane-session="${id}"] .xterm-screen canvas:not(.xterm-link-layer)`);
    await expect(canvas('s1')).toBeVisible();
    const durations: number[] = [];
    for (let round = 0; round < 6; round++) {
      const id = round % 2 ? 's1' : 's2';
      durations.push(await page.evaluate(async id => {
        const start = performance.now();
        document.querySelector<HTMLButtonElement>(`[role="tab"][data-session-id="${id}"]`)!.click();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return performance.now() - start;
      }, id));
      await expect(canvas(id)).toBeVisible();
    }
    const creates = await page.evaluate(() => (window as any).__webglCreates);
    console.log('session switch renderer cost', { creates, durations });
    await test.info().attach('session-switch-cost', { body: JSON.stringify({ creates, durations }), contentType: 'application/json' });
    expect(creates).toBe(2);
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '首页', exact: true }).click();
    await expect(page.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toHaveCount(0);
  });

  test('hiding the document releases WebGL and resumes the same terminal without losing replies', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    const terminal = page.locator('[data-pane-session="s1"]');
    const canvas = terminal.locator('.xterm-screen canvas:not(.xterm-link-layer)');
    for (let cycle = 0; cycle < 3; cycle++) {
      await expect(canvas).toBeVisible();
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(canvas).toHaveCount(0);
      await expect(terminal.locator('[data-blink]')).toHaveCount(0);
      await resetWrites(page);
      await page.evaluate(() => (window as any).__output('\r\nhidden-window-output\r\n\x1b[6n'));
      await expect.poll(() => writes(page)).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await expect(canvas).toBeVisible();
    await page.getByRole('button', { name: '查找输出', exact: true }).click();
    await page.getByRole('searchbox', { name: '在终端输出中查找…' }).fill('hidden-window-output');
    await expect(page.getByRole('region', { name: '当前会话' })).toContainText('1 / 3');
  });

  test('leaving the workbench releases WebGL while retaining output and protocol replies', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    await installWorkbenchMock(page);
    await page.goto('/');
    const navigation = page.getByRole('navigation', { name: '页面' });
    const terminal = page.locator('[data-pane-session="s1"]');
    const canvas = terminal.locator('.xterm-screen canvas:not(.xterm-link-layer)');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await navigation.getByRole('button', { name: '工作台', exact: true }).click();
      await expect(canvas).toBeVisible();
      await expect(terminal.locator('textarea')).toBeEnabled();
      await navigation.getByRole('button', { name: '首页', exact: true }).click();
      await expect(canvas).toHaveCount(0);
      await expect(terminal.locator('textarea')).toBeDisabled();
      await expect(terminal.locator('[data-blink]')).toHaveCount(0);
      await resetWrites(page);
      await page.evaluate(cycle => (window as unknown as { __output: (text: string) => void }).__output(`\r\nhidden-output-${cycle}\r\n\x1b[?12h\x1b[6n`), cycle);
      await expect.poll(() => writes(page)).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
      await expect(canvas).toHaveCount(0);
    }
    await navigation.getByRole('button', { name: '工作台', exact: true }).click();
    await expect(canvas).toBeVisible();
    await page.getByRole('button', { name: '查找输出', exact: true }).click();
    await page.getByRole('searchbox', { name: '在终端输出中查找…' }).fill('hidden-output-');
    await expect(page.getByRole('region', { name: '当前会话' })).toContainText('1 / 3');
    await page.keyboard.press('Escape');
    await terminal.locator('textarea').focus();
    await resetWrites(page);
    await page.keyboard.type('after-return');
    await expect.poll(async () => (await writes(page)).join('')).toBe('after-return');
  });
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

test('late output from many unmounted sessions has a bounded retained heap', async ({ page }) => {
  await openWorkbench(page);
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const usage = await cdp.send('Runtime.getHeapUsage');
    return usage.usedSize + usage.backingStorageSize;
  };
  const before = await heap();
  const growth: number[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate(cycle => {
      for (let index = 0; index < 256; index++) {
        const bytes = crypto.getRandomValues(new Uint8Array(48 * 1024));
        for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = 32 + (bytes[offset] & 63);
        (window as any).__output(String.fromCharCode(...bytes), `late-session-${cycle}-${index}`);
      }
    }, cycle);
    growth.push((await heap()) - before);
    expect(growth.at(-1)).toBeLessThan(8 * 1024 * 1024);
  }
  console.log('retained output bytes', { before, growth });
  await test.info().attach('retained-output-heap', { body: JSON.stringify({ before, growth }), contentType: 'application/json' });
  await cdp.detach();
  await resetWrites(page);
  await page.evaluate(() => (window as any).__output('\x1b[6n'));
  await expect.poll(() => writes(page)).toContainEqual(expect.stringMatching(/^\x1b\[\d+;\d+R$/));
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
  await navigation.getByRole('button', { name: '首页', exact: true }).click();
  await navigation.getByRole('button', { name: '工作台', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __restoreCalls: number }).__restoreCalls)).toBe(1);
});

test('restored sessions come back in the rail order they had before the restart', async ({ page }) => {
  await page.addInitScript(() => {
    // Before the restart Claude Code sat above Codex; the restore hands both new ids, and the
    // list already contains them (in launch order) before the report arrives.
    const reloaded = !!sessionStorage.getItem('seeded');
    // After a plain reload the sessions are still live, so there is nothing left to restore.
    Object.assign(window, { __twoSessions: true, __restoreReport: { restored: reloaded ? {} : { 'old-codex': 's1', 'old-claude': 's2' }, failures: [] } });
    if (!reloaded) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('cliora:workbench-rail-arrange', JSON.stringify({ pinned: [], order: ['old-claude', 'old-codex', 's1', 's2'] }));
    }
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: '会话列表' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toHaveText(/Claude Code/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cliora:workbench-rail-arrange')!).order)).toEqual(['s2', 's1']);
  // A session that was never moved by hand is ranked too, so the next restart keeps it in place.
  await page.reload();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(tabs.first()).toHaveText(/Claude Code/);
});

test('unresolved restoration stays visible and can be dismissed explicitly', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __savedRestores: [{ id: 'missing', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null }],
    __restoreReport: { restored: {}, failures: [{ session: { id: 'missing', toolId: 'codex', directory: 'C:/work' }, detail: '原会话不存在' }] },
    // Retrying the row fails again, and only this record is retried.
    __restoreOneFailure: { detail: '原会话不存在', candidates: [] },
  }));
  await openWorkbench(page);
  await expect(page.getByText('原会话不存在', { exact: false })).toBeVisible();
  const retry = page.getByRole('button', { name: '重试恢复', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __restoreOne: Array<{ sessionId: string; nativeId: string | null }> }).__restoreOne ?? [])).toEqual([{ sessionId: 'missing', nativeId: null }]);
  // The batch is not replayed: a single record retries on its own.
  expect(await page.evaluate(() => (window as unknown as { __restoreCalls: number }).__restoreCalls)).toBe(1);
  await expect(page.getByText('原会话不存在', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '不再恢复', exact: true }).click();
  await expect(page.getByRole('button', { name: '不再恢复', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __forgottenRestore: string }).__forgottenRestore)).toBe('missing');
});

test('ambiguous restoration lets the user choose a candidate without clearing other pending tabs', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __savedRestores: [
      { id: 'ambiguous', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null },
      { id: 'other', toolId: 'codex', projectId: null, directory: 'C:/other', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null },
    ],
    __restoreReport: { restored: {}, failures: [
    { session: { id: 'ambiguous', toolId: 'codex', directory: 'C:/work', mode: 'normal' }, detail: '发现多条可能的会话', candidates: [
      { nativeId: 'native-one', title: '第一个会话', startedAt: 1767225600000, updatedAt: 1767225600000 },
      { nativeId: 'native-two', title: '第二个会话', startedAt: 1767312000000, updatedAt: 1767312000000 },
    ] },
    { session: { id: 'other', toolId: 'codex', directory: 'C:/other', mode: 'normal' }, detail: '另一个待恢复', candidates: [] },
  ] } }));
  await openWorkbench(page);
  await page.getByRole('button', { name: '选择会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择要恢复的原会话' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /第一个会话/ })).toBeVisible();
  await dialog.getByRole('button', { name: /第二个会话/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('发现多条可能的会话', { exact: false })).toHaveCount(0);
  await expect(page.getByText('另一个待恢复', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __restoreChoice: unknown }).__restoreChoice)).toEqual({ sessionId: 'ambiguous', nativeId: 'native-two' });
  expect(await page.evaluate(() => (window as unknown as { __restoreCalls: number }).__restoreCalls)).toBe(1);
});

/** The stage a workbench with saved records shows first: no live session, pending rows. */
async function openRestoreQueue(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByLabel('待恢复的会话')).toBeVisible();
}

test('saved records show as pending rows before their sessions are restored', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __emptySessions: true,
    __savedRestores: [
      { id: 'old-codex', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null },
      { id: 'old-claude', toolId: 'claude_code', projectId: null, directory: 'D:/a-very-long-project-directory-name/that/keeps/going/past/the/restore/row/width', mode: 'normal', startedAt: 3, stoppedAt: 4, nativeId: null, accountId: null, contextId: null },
    ],
    // Nothing is restored yet: one record reports its stage and the batch keeps waiting.
    __restoreScript: [
      { event: { savedSessionId: 'old-claude', stage: 'discovering' }, hold: true },
      { event: { savedSessionId: 'old-codex', stage: 'restored', session: { id: 'codex-back', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
    ],
  }));
  await installWorkbenchMock(page);
  await page.setViewportSize({ width: 640, height: 720 });
  await openRestoreQueue(page);
  // A workbench with saved records is not the empty workbench.
  await expect(page.getByText('还没有进行中的会话')).toHaveCount(0);
  await expect(page.locator('[data-restore-row]')).toHaveCount(2);
  await expect(page.locator('[data-restore-row="old-claude"]')).toContainText('正在查找原会话…');
  await expect(page.locator('[data-restore-row="old-codex"]')).toContainText('等待恢复');
  await expect(page.getByRole('button', { name: '新建会话', exact: true }).first()).toBeVisible();
  // A long directory stays inside the row instead of widening the page.
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  // The finished record replaces its row; the other record keeps its own row.
  await page.evaluate(() => (window as unknown as { __restoreRelease: () => void }).__restoreRelease());
  await expect(page.locator('[data-session-id="codex-back"]')).toBeVisible();
  await expect(page.locator('[data-restore-row="old-codex"]')).toHaveCount(0);
  await expect(page.locator('[data-restore-row]')).toHaveCount(1);
});

test('a slow saved record does not block the ones that are already usable', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __emptySessions: true,
    __savedRestores: [
      { id: 'fast', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null },
      { id: 'slow', toolId: 'claude_code', projectId: null, directory: 'D:/slow', mode: 'normal', startedAt: 3, stoppedAt: 4, nativeId: null, accountId: null, contextId: null },
      { id: 'broken', toolId: 'codex', projectId: null, directory: 'C:/gone', mode: 'normal', startedAt: 5, stoppedAt: 6, nativeId: null, accountId: null, contextId: null },
    ],
    __restoreScript: [
      { event: { savedSessionId: 'broken', stage: 'failed', detail: '原会话已被删除' } },
      { event: { savedSessionId: 'fast', stage: 'restored', session: { id: 'fast-1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
      { event: { savedSessionId: 'slow', stage: 'starting' }, hold: true },
      { event: { savedSessionId: 'slow', stage: 'restored', session: { id: 'slow-1', toolId: 'claude_code', projectId: null, directory: 'D:/slow', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
    ],
    __restoreOneFailure: { detail: '原会话已被删除', candidates: [] },
  }));
  await installWorkbenchMock(page);
  await openRestoreQueue(page);
  // The ready record is a session while the slow one is still starting.
  await expect(page.locator('[data-session-id="fast-1"]')).toBeVisible();
  await expect(page.locator('[data-restore-row="fast"]')).toHaveCount(0);
  await expect(page.locator('[data-restore-row="slow"]')).toContainText('正在启动会话…');
  await expect(page.locator('[data-restore-row="broken"]')).toContainText('原会话已被删除');
  // Only the failed record offers a retry, and it retries that record alone.
  await expect(page.locator('[data-restore-row="fast"]').getByRole('button', { name: '重试恢复', exact: true })).toHaveCount(0);
  await page.locator('[data-restore-row="broken"]').getByRole('button', { name: '重试恢复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __restoreOne: Array<{ sessionId: string }> }).__restoreOne.map((item) => item.sessionId))).toEqual(['broken']);
  await page.evaluate(() => (window as unknown as { __restoreRelease: () => void }).__restoreRelease());
  await expect(page.locator('[data-session-id="slow-1"]')).toBeVisible();
  await expect(page.locator('[data-restore-row]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __restoreCalls: number }).__restoreCalls)).toBe(1);
});

test('a saved record for a session that is already running never becomes a pending row', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    // The default mock already has s1 running in C:/work. One record carries that session id
    // (a launch writes the record with the session's own id); the other was written for the same
    // terminal a moment earlier under another id.
    __savedRestores: [
      { id: 's1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: Date.now(), stoppedAt: null, nativeId: null, accountId: null, contextId: null },
      { id: 'record-for-s1', toolId: 'codex', projectId: null, directory: 'C:\\work\\', mode: 'normal', startedAt: Date.now(), stoppedAt: null, nativeId: null, accountId: null, contextId: null },
    ],
  }));
  await openWorkbench(page);
  // The record was read (so this is the live filter, not a skipped read) but nothing is pending.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __restoreListCalls?: number }).__restoreListCalls ?? 0)).toBe(1);
  await expect(page.locator('[data-restore-row]')).toHaveCount(0);
  await expect(page.getByRole('group', { name: '待恢复的会话' })).toHaveCount(0);
  // Nothing to restore means the batch is not replayed at all.
  expect(await page.evaluate(() => (window as unknown as { __restoreCalls?: number }).__restoreCalls ?? 0)).toBe(0);
  // The live session itself is still there.
  await expect(page.locator('[data-session-id="s1"]')).toBeVisible();
});

test('a pending row disappears once its session shows up', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __savedRestores: [{ id: 'ghost', toolId: 'codex', projectId: null, directory: 'C:/ghost', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null }],
    // The batch never answers: the row would otherwise wait forever.
    __restoreScript: [{ hold: true }],
  }));
  await openWorkbench(page);
  await expect(page.locator('[data-restore-row="ghost"]')).toHaveCount(1);
  // Another launch creates that session (same id, as the store writes it).
  await page.evaluate(() => (window as unknown as { __addSession: (session: Record<string, unknown>) => void }).__addSession({
    id: 'ghost', toolId: 'codex', projectId: null, directory: 'C:/ghost', mode: 'normal', running: true, exitCode: null, startedAt: Date.now(),
  }));
  // Coming back re-reads the list; the row is healed instead of staying forever.
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '首页', exact: true }).click();
  await navigation.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('[data-session-id="ghost"]')).toBeVisible();
  await expect(page.locator('[data-restore-row="ghost"]')).toHaveCount(0);
  await expect(page.getByRole('group', { name: '待恢复的会话' })).toHaveCount(0);
});

test('a waiting row can be forgotten from the keyboard', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __savedRestores: [{ id: 'waiting', toolId: 'codex', projectId: null, directory: 'C:/waiting', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null }],
    // No stage ever arrives for this record.
    __restoreScript: [{ hold: true }],
  }));
  await openWorkbench(page);
  const row = page.locator('[data-restore-row="waiting"]');
  await expect(row).toContainText('等待恢复');
  // A row that never progresses still offers its own exit, reachable with the keyboard.
  const dismiss = row.getByRole('button', { name: '不再恢复' });
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __forgottenRestore: string }).__forgottenRestore)).toBe('waiting');
});

/** More saved records than fit: the queue must scroll, not clip, at any window size. */
const manySavedRecords = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: 'saved-' + (index + 1),
  toolId: 'codex',
  projectId: null,
  directory: 'C:/projects/workspace-' + (index + 1),
  mode: 'normal',
  startedAt: 1,
  stoppedAt: 2,
  nativeId: null,
  accountId: null,
  contextId: null,
}));

async function openManyRecordQueue(page: Page, count: number) {
  await page.addInitScript((records) => {
    Object.assign(window, {
      __emptySessions: true,
      __savedRestores: records,
      // Every record already failed, so even the last row carries its own retry.
      __restoreScript: records.map((item: { id: string }) => ({ event: { savedSessionId: item.id, stage: 'failed', detail: '原会话已被删除' } })),
      __restoreOneFailure: { detail: '原会话已被删除', candidates: [] },
    });
  }, manySavedRecords(count));
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const queue = page.getByRole('group', { name: '待恢复的会话' });
  await expect(queue).toBeVisible();
  await expect(page.locator('[data-restore-row]')).toHaveCount(count);
  return queue;
}

for (const tier of [{ width: 1360, height: 900, count: 14 }, { width: 900, height: 640, count: 8 }, { width: 640, height: 720, count: 10 }]) {
  test('every saved record stays reachable when the queue is taller than the stage (' + tier.width + 'x' + tier.height + ')', async ({ page }) => {
    await page.setViewportSize({ width: tier.width, height: tier.height });
    await openManyRecordQueue(page, tier.count);
    const measure = await page.evaluate(() => {
      const node = document.querySelector('[data-restore-queue]') as HTMLElement;
      const rows = [...document.querySelectorAll('[data-restore-row]')];
      const queueRect = node.getBoundingClientRect();
      const stageRect = node.closest('section')!.getBoundingClientRect();
      const hiddenBeforeScroll = rows.filter((row) => row.getBoundingClientRect().bottom > queueRect.bottom + 1).length;
      // The container itself must stay inside the stage; its content scrolls, it is not clipped.
      const insideStage = queueRect.bottom <= stageRect.bottom + 1 && queueRect.top >= stageRect.top - 1;
      node.scrollTop = node.scrollHeight;
      const lastRect = rows.at(-1)!.getBoundingClientRect();
      const scrolledRect = node.getBoundingClientRect();
      const lastRowVisibleAtEnd = lastRect.bottom <= scrolledRect.bottom + 1 && lastRect.top >= scrolledRect.top - 1;
      const reachedEnd = node.scrollTop > 0;
      node.scrollTop = 0;
      return {
        scrolls: node.scrollHeight > node.clientHeight + 1,
        scrollRange: node.scrollHeight - node.clientHeight,
        focusable: node.tabIndex >= 0,
        insideStage,
        hiddenBeforeScroll,
        reachedEnd,
        lastRowVisibleAtEnd,
        queueHeight: Math.round(queueRect.height),
        stageHeight: Math.round(stageRect.height),
      };
    });
    // The queue keeps its box inside the stage and scrolls its own content: no row is cut off.
    expect(measure.insideStage).toBe(true);
    expect(measure.scrolls).toBe(true);
    expect(measure.focusable).toBe(true);
    expect(measure.hiddenBeforeScroll).toBeGreaterThan(0);
    expect(measure.reachedEnd).toBe(true);
    expect(measure.lastRowVisibleAtEnd).toBe(true);
    console.log('restore queue reachability', { viewport: tier.width + 'x' + tier.height, records: tier.count, ...measure });
    // Every row, including the last one, can be scrolled fully into the queue's view.
    for (let index = 1; index <= tier.count; index += 1) {
      const row = page.locator('[data-restore-row="saved-' + index + '"]');
      await row.scrollIntoViewIfNeeded();
      expect(await row.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const queueRect = node.closest('[data-restore-queue]')!.getBoundingClientRect();
        return rect.top >= queueRect.top - 1 && rect.bottom <= queueRect.bottom + 1;
      })).toBe(true);
    }
    // Keyboard: Tab reaches the last row's retry inside the scrolled view, and Enter runs it.
    await page.getByRole('group', { name: '待恢复的会话' }).focus();
    let reached = false;
    for (let step = 0; step < tier.count * 3 + 8; step += 1) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const row = active?.closest('[data-restore-row]');
        const queue = document.querySelector('[data-restore-queue]') as HTMLElement | null;
        if (!active || !row || !queue || !active.textContent) return null;
        const rect = active.getBoundingClientRect();
        const queueRect = queue.getBoundingClientRect();
        return {
          row: row.getAttribute('data-restore-row'),
          label: active.textContent.trim(),
          inView: rect.top >= queueRect.top - 1 && rect.bottom <= queueRect.bottom + 1,
        };
      });
      if (!focused) continue;
      if (focused.row === 'saved-' + tier.count && focused.label === '重试恢复') {
        // Focusing the button scrolled it into view: the keyboard reaches a hidden row.
        expect(focused.inView).toBe(true);
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __restoreOne?: Array<{ sessionId: string }> }).__restoreOne ?? [])).toEqual([{ sessionId: 'saved-' + tier.count, nativeId: null }]);
    // The retry failed again, so the last row is still there and still readable.
    await expect(page.locator('[data-restore-row="saved-' + tier.count + '"]')).toContainText('原会话已被删除');
  });
}

test('a completed record does not take a selection the user made afterwards', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __savedRestores: [
      { id: 'r1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null },
      { id: 'r2', toolId: 'claude_code', projectId: null, directory: 'D:/later', mode: 'normal', startedAt: 3, stoppedAt: 4, nativeId: null, accountId: null, contextId: null },
    ],
    __restoreScript: [
      { event: { savedSessionId: 'r1', stage: 'restored', session: { id: 'fast-1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
      { event: { savedSessionId: 'r2', stage: 'starting' }, hold: true },
      { event: { savedSessionId: 'r2', stage: 'restored', session: { id: 'fast-2', toolId: 'claude_code', projectId: null, directory: 'D:/later', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
    ],
  }));
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  // A restored session joins the list without taking a selection the workbench already had.
  await expect(page.locator('[data-session-id="fast-1"]')).toBeVisible();
  await expect(page.locator('[data-session-id="s1"]')).toHaveAttribute('aria-selected', 'true');
  // The user picks the restored session; the record that completes later must not steal it.
  await page.locator('[data-session-id="fast-1"]').click();
  await expect(page.locator('[data-session-id="fast-1"]')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => (window as unknown as { __restoreRelease: () => void }).__restoreRelease());
  await expect(page.locator('[data-session-id="fast-2"]')).toBeVisible();
  await expect(page.locator('[data-session-id="fast-1"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-session-id="fast-2"]')).toHaveAttribute('aria-selected', 'false');
});

test('no saved records shows the original empty workbench instead of a restore prompt', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __emptySessions: true }));
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByText('还没有进行中的会话')).toBeVisible();
  await expect(page.getByLabel('待恢复的会话')).toHaveCount(0);
  // No saved record means no restore call at all.
  expect(await page.evaluate(() => (window as unknown as { __restoreCalls?: number }).__restoreCalls ?? 0)).toBe(0);
});

test('saved records become usable before the whole batch ends (browser baseline)', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __emptySessions: true,
    __savedRestores: [
      { id: 'fast', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null },
      { id: 'slow', toolId: 'claude_code', projectId: null, directory: 'D:/slow', mode: 'normal', startedAt: 3, stoppedAt: 4, nativeId: null, accountId: null, contextId: null },
    ],
    __restoreScript: [
      { event: { savedSessionId: 'fast', stage: 'restored', session: { id: 'fast-1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
      { event: { savedSessionId: 'slow', stage: 'starting' }, hold: true },
      { event: { savedSessionId: 'slow', stage: 'restored', session: { id: 'slow-1', toolId: 'claude_code', projectId: null, directory: 'D:/slow', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
    ],
  }));
  await installWorkbenchMock(page);
  await page.goto('/');
  const started = Date.now();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('[data-session-id="fast-1"]')).toBeVisible();
  const firstUsable = Date.now() - started;
  // The slow record is still running; only its own row is left.
  await expect(page.locator('[data-restore-row="slow"]')).toBeVisible();
  const pendingAtFirst = await page.locator('[data-restore-row]').count();
  await page.evaluate(() => (window as unknown as { __restoreRelease: () => void }).__restoreRelease());
  await expect(page.locator('[data-restore-row]')).toHaveCount(0);
  const allDone = Date.now() - started;
  reportRestoreTiming(test.info(), { mode: 'per-item-events', firstUsableMs: firstUsable, allDoneMs: allDone, pendingRowsAtFirstUsable: pendingAtFirst });
  expect(firstUsable).toBeLessThan(allDone);
});

test('a batch that only answers at the end is the pre-event baseline (browser baseline)', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, {
    __emptySessions: true,
    __savedRestores: [
      { id: 'fast', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', startedAt: 1, stoppedAt: 2, nativeId: null, accountId: null, contextId: null },
      { id: 'slow', toolId: 'claude_code', projectId: null, directory: 'D:/slow', mode: 'normal', startedAt: 3, stoppedAt: 4, nativeId: null, accountId: null, contextId: null },
    ],
    // The same two records, but nothing is usable until the whole report arrives.
    __restoreDelay: 1200,
    __restoreReport: { restored: { fast: 'fast-1', slow: 'slow-1' }, failures: [] },
  }));
  await installWorkbenchMock(page);
  await page.goto('/');
  const started = Date.now();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('[data-session-id="fast-1"]')).toBeVisible();
  const firstUsable = Date.now() - started;
  await expect(page.locator('[data-session-id="slow-1"]')).toBeVisible();
  const allDone = Date.now() - started;
  reportRestoreTiming(test.info(), { mode: 'batch-only', firstUsableMs: firstUsable, allDoneMs: allDone, syntheticBatchDelayMs: 1200 });
  expect(firstUsable).toBeGreaterThanOrEqual(1200);
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
  // The whole app sidebar steps aside; the terminal canvas starts at the window edge.
  await expect(page.getByLabel('主导航')).toBeHidden();
  await expect.poll(async () => (await page.locator('main').boundingBox())!.x).toBeLessThan(20);
  await stage.locator('[data-stage-icon]').dblclick();
  await expect(root).not.toHaveAttribute('data-focus-mode', 'true');
  await expect(rail).toBeVisible();
  await expect(page.getByLabel('主导航')).toBeVisible();

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
  // The expanded sidebar has room for every page icon, so nothing is folded into the more menu.
  for (const name of ['首页', '工作台', '工具', '资料库', '记录', '设置']) await expect(nav.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: '工作台', exact: true }).locator('.nav-text')).toBeHidden();
  const more = nav.getByRole('button', { name: '更多页面' });
  const moreMenu = page.getByRole('menu', { name: '更多页面' });
  await expect(more).toHaveCount(0);
  const navRow = await nav.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(navRow.scroll).toBeLessThanOrEqual(navRow.client + 1);
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
  // Only when the row runs out of room does the overflow fold into the more menu, in page order.
  await handle.focus();
  for (let step = 0; step < 12; step++) await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBeLessThan(240);
  await expect(more).toBeVisible();
  const shown = await nav.locator('button[aria-current], button:not([aria-haspopup])').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  await more.click();
  const folded = (await moreMenu.getByRole('menuitem').allTextContents()).map((text) => text.replace(/Ctrl\+\d$/, ''));
  expect([...shown, ...folded]).toEqual(['首页', '工作台', '工具', '资料库', '记录', '设置']);
  expect(folded.length).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(moreMenu).toHaveCount(0);
  await page.getByRole('separator', { name: '拖动调整会话栏宽度，双击还原' }).dblclick();
  await expect(more).toHaveCount(0);

  // Ctrl+\ folds the shared sidebar to one icon rail and remembers it as the rail preference.
  await stage.locator('header h2').click();
  await page.keyboard.press('Control+Backslash');
  await expect(rail).toHaveAttribute('data-slim', 'true');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-slim'))).toBe('true');
  // In the icon rail the more menu opens beside the rail instead of over the sessions.
  await more.click();
  const moreRight = await more.evaluate((element) => element.getBoundingClientRect().right);
  await expect.poll(async () => (await moreMenu.boundingBox())?.x ?? -1).toBeGreaterThan(moreRight);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Backslash');
  await expect(rail).not.toHaveAttribute('data-slim', 'true');

  // Focus mode hides the whole sidebar; leaving it brings the pages and sessions back.
  await stage.getByRole('button', { name: '专注模式（隐藏侧栏）' }).click();
  await expect(rail).toHaveCount(0);
  await expect(sidebar).toBeHidden();
  await stage.getByRole('button', { name: '退出专注模式（显示侧栏）' }).click();
  await expect(rail).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cliora:workbench-rail-slim'))).toBe('false');

  // Any page is one click away; other pages get the labelled list back without the sessions.
  await expect(more).toHaveCount(0);
  await nav.getByRole('button', { name: '记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '记录', exact: true })).toBeVisible();
  await expect(rail).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '记录', exact: true }).locator('.nav-text')).toBeVisible();
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(sidebar.getByRole('tablist', { name: '会话列表' })).toBeVisible();

  // Narrow windows keep the stacked top bar and show the sessions as a strip above the terminal.
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(page.locator('[data-term-theme]').getByRole('tablist', { name: '会话列表' })).toBeVisible();
  await expect(sidebar.getByRole('tablist', { name: '会话列表' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('the new-session dialog follows the start preference saved in Settings', async ({ page }) => {
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await expect(dialog.getByRole('heading', { name: '新建工作台会话' })).toHaveCount(1);
  await expect(dialog.locator('[data-variant="primary"]')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: '启动会话' })).toHaveAttribute('data-variant', 'primary');
  // The dialog decides one launch; it does not nest another settings dialog.
  await expect(dialog.getByRole('button', { name: /工作树设置|管理工作树/ })).toHaveCount(0);
  await expect(dialog.getByRole('radiogroup', { name: '启动位置' }).getByRole('radio', { name: /^当前目录/ })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: '取消' }).click();
  // The preference is changed in Settings while the workbench stays mounted.
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const setting = page.getByRole('combobox', { name: '启动偏好' });
  await expect(setting).toHaveValue('direct');
  await setting.selectOption('worktree');
  await expect(setting).toHaveValue('worktree');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(dialog.getByRole('radiogroup', { name: '启动位置' }).getByRole('radio', { name: /^新建工作树/ })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByLabel('初始提示词（可选）').fill('feat: hello?\nmore');
  await dialog.getByRole('button', { name: '启动会话' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, unknown>> }).__launches)).toEqual([
    expect.objectContaining({ worktreeIntent: 'preference', taskText: 'feat: hello?', initialPrompt: 'feat: hello?\nmore' }),
  ]);
  expect(await page.evaluate(() => (window as unknown as { __worktreeSaves: string[] }).__worktreeSaves)).toEqual(['worktree']);
});

test('running duplicate follows the preference, while restart and an existing checkout keep the given directory', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __worktrees: [
        { name: 'shop', branch: 'main', path: 'C:/work', current: true },
        { name: 'shop-task', branch: 'task', path: 'C:/work-task', current: false },
      ],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  await page.evaluate(() => (window as unknown as { __output: (text: string) => void }).__output('\x1b]0;feat: hello?\x07'));
  await expect(page.getByRole('region', { name: '当前会话' }).locator('h2')).toContainText('feat: hello?');
  await page.getByRole('button', { name: '更多终端操作' }).click();
  // The launch preference and prepare command live in Settings, not in the context menus.
  const terminal = page.getByRole('menu', { name: '终端操作' });
  await expect(terminal.getByRole('menuitem', { name: '再开一个' })).toBeVisible();
  await expect(terminal.getByRole('menuitemradio')).toHaveCount(0);
  await expect(terminal.getByRole('textbox', { name: '准备命令' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Codex 会话操作' }).click();
  const sessionMenu = page.getByRole('menu', { name: 'Codex 会话操作' });
  await expect(sessionMenu.getByRole('menuitemradio', { name: '新建工作树' })).toHaveCount(0);
  await expect(sessionMenu.getByRole('textbox', { name: '准备命令' })).toHaveCount(0);
  await sessionMenu.getByRole('menuitem', { name: '再开一个' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, unknown>> }).__launches.at(-1))).toMatchObject({
    worktreeIntent: 'preference', directory: 'C:/work', taskText: 'feat: hello?',
  });
  await page.getByRole('button', { name: /在工作树中新开会话/ }).click();
  await page.getByRole('menu', { name: '在工作树中新开会话' }).getByRole('menuitemradio', { name: /shop-task/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, unknown>> }).__launches.at(-1))).toMatchObject({
    worktreeIntent: 'given', directory: 'C:/work-task',
  });
});

test('an ended session restarts in the directory it already had', async ({ page }) => {
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  await page.evaluate(() => (window as unknown as { __exit: (code: number) => void }).__exit(0));
  await page.getByRole('button', { name: '重新启动' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, unknown>> }).__launches.at(-1))).toMatchObject({
    worktreeIntent: 'given', directory: 'C:/work',
  });
});

test('a disconnected local CLI stops showing output activity and resumes its original session', async ({ page }) => {
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  await page.evaluate(() => {
    const harness = window as unknown as { __output: (text: string) => void; __exit: (code: number) => void };
    harness.__output('Disconnected from this task. Any running work continues.\r\n');
    harness.__exit(0);
  });
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage.locator('[data-activity-slot="status"]')).toHaveAttribute('data-activity-icon', 'ended');
  await stage.getByRole('button', { name: '恢复会话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __restoreChoice: unknown }).__restoreChoice)).toEqual({ sessionId: 's1', nativeId: null });
  await expect(page.locator('[data-pane-session="resumed-s1"]')).toBeVisible();
  await expect(page.locator('[data-pane-session="s1"]')).toHaveCount(0);
  await expect(stage.getByRole('button', { name: '快捷输入', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __launches?: unknown[] }).__launches ?? [])).toEqual([]);
});

test('local reconnect keeps the ended terminal when recovery fails and offers candidate selection', async ({ page }) => {
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.locator('.xterm-accessibility-tree').first()).toContainText('codex-ready');
  await page.evaluate(() => {
    Object.assign(window, { __reconnectFailure: { detail: '尚未找到原生会话记录', candidates: [] } });
    (window as unknown as { __exit: (code: number) => void }).__exit(0);
  });
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('button', { name: '恢复会话', exact: true }).click();
  await expect(page.getByText('尚未找到原生会话记录', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-pane-session="s1"]')).toBeVisible();
  await page.evaluate(() => Object.assign(window, { __reconnectFailure: { detail: '请选择原会话', candidates: [
    { nativeId: 'native-one', title: '第一条原会话', startedAt: null, updatedAt: null },
    { nativeId: 'native-two', title: '第二条原会话', startedAt: null, updatedAt: null },
  ] } }));
  await stage.getByRole('button', { name: '恢复会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择要恢复的原会话' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /第二条原会话/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-pane-session="resumed-s1"]')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __restoreChoice: unknown }).__restoreChoice)).toEqual({ sessionId: 's1', nativeId: 'native-two' });
});

test('an unrecognized worktree preference is shown and is not rewritten', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { __worktreeLaunchError: '启动偏好格式无法识别' }); });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const setting = page.getByRole('combobox', { name: '启动偏好' });
  await expect(setting).toHaveValue('');
  await expect(page.locator('.setting-row').filter({ hasText: '启动偏好' }).getByRole('alert')).toContainText('格式无法识别');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const place = page.getByRole('dialog', { name: '新建工作台会话' }).getByRole('radiogroup', { name: '启动位置' });
  await expect(place.getByRole('radio', { name: /^当前目录/ })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as unknown as { __worktreeSaves?: string[] }).__worktreeSaves ?? [])).toEqual([]);
});

test('an unprepared worktree carries no environment mark, and only ledger worktrees can be removed', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __twoSessions: true,
      __ledger: [{ mainCheckout: 'C:/repo', worktreePath: 'C:/work', branch: 'feat-hello', environment: 'unprepared' }],
      __worktrees: [
        { name: 'repo', branch: 'main', path: 'C:/repo', current: false },
        { name: 'feat-hello', branch: 'feat-hello', path: 'C:/work', current: true },
        { name: 'external', branch: 'external', path: 'C:/external', current: false },
      ],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage).toBeVisible();
  await expect(stage).not.toContainText('环境未准备');
  await page.getByRole('button', { name: '更多终端操作' }).click();
  const menu = page.getByRole('menu', { name: '终端操作' });
  // The menu holds one entry; cleanup and the setup command live in the management dialog.
  await expect(menu.getByRole('textbox', { name: '准备命令' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /清理/ })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: /管理工作树/ }).click();
  const setup = page.getByRole('dialog', { name: '管理工作树' });
  await expect(setup.getByRole('button', { name: /清理 feat-hello/ })).toBeVisible();
  await expect(setup.getByRole('button', { name: /清理 main/ })).toHaveCount(0);
  await expect(setup.getByRole('button', { name: /清理 external/ })).toHaveCount(0);
  await expect(setup.getByRole('button', { name: /清理 repo/ })).toHaveCount(0);
  // The session's repository setup command is offered in the same dialog.
  await expect(setup.getByRole('textbox', { name: '准备命令' })).toBeVisible();
  await expect(setup.getByRole('radiogroup', { name: '启动偏好' })).toHaveCount(0);
  await expect(setup).not.toContainText('环境未准备');
});

/** Worktree management (cleanup, setup command) opens as a dialog from the terminal menu. */
async function openWorktreeSetup(page: Page) {
  await page.getByRole('button', { name: '更多终端操作' }).click();
  await page.getByRole('menu', { name: '终端操作' }).getByRole('menuitem', { name: /管理工作树/ }).click();
  const setup = page.getByRole('dialog', { name: '管理工作树' });
  await expect(setup).toBeVisible();
  return setup;
}

test('removing a dirty worktree waits for confirmation and can be cancelled', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __ledger: [{ mainCheckout: 'C:/repo', worktreePath: 'C:/work-task', branch: 'feat-hello', environment: 'prepared' }],
      __cleanupNeedsConfirm: true,
      __cleanupDetail: '将丢弃未提交的改动：\n?? note.txt',
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前会话' })).not.toContainText('环境未准备');
  const setup = await openWorktreeSetup(page);
  await setup.getByRole('button', { name: /清理 feat-hello/ }).click();
  const confirm = page.getByRole('dialog', { name: '清理这个工作树？' });
  await expect(confirm).toContainText('note.txt');
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cleanups: Array<{ confirm: boolean }> }).__cleanups)).toEqual([{ path: 'C:/work-task', confirm: false }]);
  // Cancelling keeps the management dialog open on the same list.
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: /清理 feat-hello/ }).click();
  await page.getByRole('dialog', { name: '清理这个工作树？' }).getByRole('button', { name: '丢弃并清理' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cleanups: Array<{ confirm: boolean }> }).__cleanups)).toEqual([
    { path: 'C:/work-task', confirm: false },
    { path: 'C:/work-task', confirm: false },
    { path: 'C:/work-task', confirm: true },
  ]);
});

test('a git failure while removing a worktree keeps the reason on screen', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __ledger: [{ mainCheckout: 'C:/repo', worktreePath: 'C:/work-task', branch: 'feat-hello', environment: 'prepared' }],
      __cleanupError: 'Git 无法删除工作树：locked',
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const setup = await openWorktreeSetup(page);
  await setup.getByRole('button', { name: /清理 feat-hello/ }).click();
  await expect(setup.getByRole('alert')).toContainText('locked');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cleanups: unknown[] }).__cleanups)).toEqual([{ path: 'C:/work-task', confirm: false }]);
});

test('settings can save one prepare command for a project repository', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __projects: [
      { id: 'p1', name: 'Shop', path: 'C:/work', available: true, preferredTool: null, lastOpened: 2, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
      { id: 'p2', name: 'Docs', path: 'C:/docs', available: true, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
    ] });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const project = page.getByRole('combobox', { name: '准备命令所属项目' });
  await expect(project).toHaveValue('p1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prepareReads?: string[] }).__prepareReads ?? [])).toContain('C:/work');
  const input = page.getByRole('textbox', { name: '工作树准备命令' });
  await input.fill('npm ci');
  await page.locator('.setting-row').filter({ has: input }).getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prepareSaves?: Array<{ directory: string; command: string }> }).__prepareSaves ?? [])).toEqual([{ directory: 'C:/work', command: 'npm ci' }]);
  await expect(input).toHaveValue('npm ci');
  await page.evaluate(() => { (window as unknown as { __prepareSaveFails?: boolean }).__prepareSaveFails = true; });
  await project.selectOption('p2');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prepareReads?: string[] }).__prepareReads ?? [])).toContain('C:/docs');
  await input.fill('pnpm i');
  await input.press('Enter');
  await expect(page.locator('.setting-row').filter({ has: input }).getByRole('alert')).toContainText('保存失败');
});
test('a new worktree shows its base and is created without blocking other sessions', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __twoSessions: true,
      __projects: [{ id: 'p1', name: 'Shop', path: 'C:/work', available: true, preferredTool: null, lastOpened: 2, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }],
      __prepareCommand: 'npm ci',
      // A scripted creation: real stages, then the test decides when it finishes.
      __worktreeScript: [
        { event: { stage: 'creating' } },
        { event: { stage: 'preparing', worktreePath: 'C:/shop-feat', branch: 'feat-hello' } },
        { hold: true },
      ],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  const place = dialog.getByRole('radiogroup', { name: '启动位置' });
  // The saved preference (direct) seeds the choice, and the plain path needs no setup.
  await expect(place.getByRole('radio', { name: '当前目录' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: '工作目录 / 项目' }).click();
  await page.getByRole('option', { name: /Shop/ }).click();
  await place.getByRole('radio', { name: '新建工作树' }).click();
  // The repository default and its real short commit are visible before any write.
  await expect(dialog.locator('code').filter({ hasText: 'origin/main' })).toBeVisible();
  await expect(dialog.locator('code').filter({ hasText: 'c0ffee1' })).toBeVisible();
  // Base and branch are values edited in place; the default creation needs neither.
  await expect(dialog.getByLabel('基点 ref')).toHaveCount(0);
  await dialog.getByRole('button', { name: '更改基点' }).click();
  await expect(dialog.getByLabel('基点 ref')).toHaveValue('origin/main');
  // Leaving the shown default untouched keeps the repository default.
  await dialog.getByLabel('基点 ref').press('Enter');
  await expect(dialog.getByLabel('基点 ref')).toHaveCount(0);
  await dialog.getByRole('button', { name: '修改分支名' }).click();
  await dialog.getByLabel('分支名', { exact: true }).fill('feat-hello');
  await dialog.getByLabel('分支名', { exact: true }).press('Enter');
  // The repository's setup command is read into the panel and can be changed there.
  const setup = dialog.getByRole('textbox', { name: '准备命令' });
  await expect(setup).toHaveValue('npm ci');
  await setup.fill('npm ci --prefer-offline');
  await dialog.getByLabel('初始提示词（可选）').fill('feat: hello?');
  await dialog.getByRole('button', { name: '启动会话' }).click();

  // The dialog closes at once; the real stage and the worktree are on screen instead.
  await expect(dialog).toBeHidden();
  const operation = page.locator('[data-worktree-op]');
  await expect(operation).toHaveAttribute('data-stage', 'preparing');
  await expect(operation).toContainText('正在运行准备命令');
  await expect(operation).toContainText('shop-feat');
  // The changed command was saved for the repository before the creation read it.
  expect(await page.evaluate(() => (window as unknown as { __prepareSaves?: unknown[] }).__prepareSaves)).toEqual([{ directory: 'C:/work', command: 'npm ci --prefer-offline' }]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, any>> }).__launches.at(-1))).toMatchObject({
    worktreeIntent: 'explicit',
    directory: null,
    taskText: 'feat: hello?',
    worktree: { base: { kind: 'default' }, branch: 'feat-hello' },
  });
  expect(await page.evaluate(() => (window as unknown as { __launches: Array<Record<string, any>> }).__launches.at(-1)!.worktree.operationId)).toMatch(/^wt-/);
  // Other sessions keep working while the worktree is prepared.
  await page.getByRole('tab', { name: /Claude Code/ }).click();
  await page.evaluate(() => (window as unknown as { __worktreeRelease: () => void }).__worktreeRelease());
  // The finished creation must not pull the user away from the session they chose.
  await expect(page.getByRole('tablist', { name: '会话列表' }).getByRole('tab', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: unknown[] }).__launches.length)).toBe(1);
  await expect(page.locator('[data-pane-session^="launched-"]')).toHaveCount(1);
});

test('a failed environment setup retries inside the worktree it already created', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __projects: [{ id: 'p1', name: 'Shop', path: 'C:/work', available: true, preferredTool: null, lastOpened: 2, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }],
      __prepareCommand: 'npm ci',
      __worktreeScript: [
        { event: { stage: 'creating' } },
        { event: { stage: 'preparing', worktreePath: 'C:/shop-feat', branch: 'feat-hello' } },
        { event: { stage: 'failed', worktreePath: 'C:/shop-feat', branch: 'feat-hello', error: '环境准备失败：npm ci 退出码 1' } },
        { fail: '环境准备失败：npm ci 退出码 1' },
      ],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await dialog.getByRole('button', { name: '工作目录 / 项目' }).click();
  await page.getByRole('option', { name: /Shop/ }).click();
  await dialog.getByRole('radiogroup', { name: '启动位置' }).getByRole('radio', { name: '新建工作树' }).click();
  await expect(dialog.locator('code').filter({ hasText: 'origin/main' })).toBeVisible();
  await dialog.getByRole('button', { name: '启动会话' }).click();

  const operation = page.locator('[data-worktree-op]');
  await expect(operation).toHaveAttribute('data-stage', 'failed');
  await expect(operation).toContainText('npm ci 退出码 1');
  // The failure keeps the created directory so the retry reuses it.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: unknown[] }).__launches.length)).toBe(1);
  // An unchanged command is not written again.
  expect(await page.evaluate(() => (window as unknown as { __prepareSaves?: unknown[] }).__prepareSaves ?? [])).toEqual([]);
  // The command can be fixed from the failure itself, in the repository's management dialog.
  await operation.getByRole('button', { name: '修改命令' }).click();
  const manage = page.getByRole('dialog', { name: '管理工作树' });
  await expect(manage.getByRole('textbox', { name: '准备命令' })).toHaveValue('npm ci');
  await manage.getByRole('button', { name: '关闭' }).click();
  await page.evaluate(() => Object.assign(window, {
    __worktreeScript: [
      { event: { stage: 'preparing', worktreePath: 'C:/shop-feat', branch: 'feat-hello' } },
      { event: { stage: 'starting', worktreePath: 'C:/shop-feat', branch: 'feat-hello' } },
    ],
  }));
  await operation.getByRole('button', { name: '重试准备' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, any>> }).__launches.at(-1))).toMatchObject({
    worktreeIntent: 'prepareRetry',
    worktree: { retryDirectory: 'C:/shop-feat' },
  });
  // The retry starts in the same worktree: no second branch or directory is asked for.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, any>> }).__launches.length)).toBe(2);
  await expect(page.locator('[data-pane-session^="launched-"]')).toHaveCount(1);
});

test('the worktree menu shows real changes and unknown on a failed read', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __gitContext: { branch: 'feat-hello', commit: null, worktree: null, repository: 'repo' },
      __ledger: [{ mainCheckout: 'C:/repo', worktreePath: 'C:/work', branch: 'feat-hello', environment: 'unprepared' }],
      __worktrees: [
        { name: 'repo', branch: 'main', path: 'C:/repo', current: false },
        { name: 'feat-hello', branch: 'feat-hello', path: 'C:/work', current: true },
        { name: 'external', branch: 'a-very-long-branch-name-that-should-still-fit-inside-the-menu', path: 'C:/external', current: false },
      ],
      __worktreeStatus: {
        'C:/repo': { worktreePath: 'C:/repo', managed: false, environment: null, branch: 'main', headOid: null, uncommittedFiles: 3, state: 'ready', reason: null },
        'C:/work': { worktreePath: 'C:/work', managed: true, environment: 'unprepared', branch: 'feat-hello', headOid: null, uncommittedFiles: 0, state: 'ready', reason: null },
      },
      __worktreeStatusFails: ['C:/external'],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: /在工作树中新开会话/ }).click();
  const menu = page.getByRole('menu', { name: '在工作树中新开会话' });
  await expect(menu.getByRole('menuitemradio', { name: /^repo/ })).toContainText('3 处未提交改动');
  const current = menu.getByRole('menuitemradio', { name: /feat-hello/ });
  await expect(current).not.toContainText('环境未准备');
  await expect(current).toContainText('没有未提交改动');
  // A read failure stays unknown instead of claiming zero changes, and can be retried.
  const external = menu.getByRole('menuitemradio', { name: /external/ });
  await expect(external).toContainText('改动未知');
  await expect(external).toHaveAttribute('data-status', 'unknown');
  await expect(menu.getByRole('menuitem', { name: '重试状态' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __statusReads: string[] }).__statusReads.length)).toBe(3);
  const widths = await menu.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(widths.scroll <= widths.client).toBe(true);
  await page.setViewportSize({ width: 640, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('a failed worktree list is retried instead of shown as an empty repository', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __gitContext: { branch: 'main', commit: null, worktree: null, repository: 'repo' },
      __worktrees: [
        { name: 'repo', branch: 'main', path: 'C:/repo', current: true },
        { name: 'other', branch: 'feat-other', path: 'C:/other', current: false },
      ],
      __worktreeReadFails: true,
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: /在工作树中新开会话|Git 分支/ }).click();
  const menu = page.getByRole('menu', { name: '在工作树中新开会话' });
  await expect(menu.getByRole('alert')).toContainText('无法读取工作树列表');
  await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __worktreeReadFails?: boolean }).__worktreeReadFails = false; });
  await menu.getByRole('menuitem', { name: '重试读取' }).click();
  await expect(menu.getByRole('menuitemradio', { name: /feat-other/ })).toBeVisible();
});

test('removing a worktree that a running session still uses names the session', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __ledger: [{ mainCheckout: 'C:/repo', worktreePath: 'C:/work', branch: 'feat-hello', environment: 'prepared' }],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const setup = await openWorktreeSetup(page);
  // The row says who holds the checkout before anything is attempted.
  await expect(setup.getByText('使用中：Codex')).toBeVisible();
  await setup.getByRole('button', { name: /清理 feat-hello/ }).click();
  await expect(setup.getByRole('alert')).toContainText('运行中的会话 Codex');
  await expect(page.getByRole('dialog', { name: '清理这个工作树？' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __cleanups?: unknown[] }).__cleanups ?? [])).toEqual([]);
});
test('the dialog shows the branch it will create and edits it in place', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __projects: [{ id: 'p1', name: 'Shop', path: 'C:/work', available: true, preferredTool: null, lastOpened: 2, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  await dialog.getByRole('button', { name: '工作目录 / 项目' }).click();
  await page.getByRole('option', { name: /Shop/ }).click();
  await dialog.getByRole('radio', { name: '新建工作树' }).click();
  // No field is open, yet the branch the creation would use is on screen.
  await expect(dialog.getByLabel('基点 ref')).toHaveCount(0);
  await expect(dialog.getByLabel('分支名', { exact: true })).toHaveCount(0);
  const branch = dialog.locator('code[data-source]');
  await expect(branch).toBeVisible();
  await expect(branch).toHaveText('shop');
  await expect(branch).toHaveAttribute('data-source', 'proposed');
  // The first task line drives it, and it follows further edits.
  await dialog.getByLabel('初始提示词（可选）').fill('feat: checkout flow');
  await expect(branch).toHaveText('feat-checkout-flow');
  await dialog.getByLabel('初始提示词（可选）').fill('fix: cart total\nsecond line');
  await expect(branch).toHaveText('fix-cart-total');
  // Opening the editor and leaving the proposal unchanged keeps it automatic.
  await dialog.getByRole('button', { name: '修改分支名' }).click();
  await expect(dialog.getByLabel('分支名', { exact: true })).toHaveValue('fix-cart-total');
  await dialog.getByLabel('分支名', { exact: true }).press('Enter');
  await expect(branch).toHaveAttribute('data-source', 'proposed');
  // An explicit name replaces the proposal, because that is what Git receives.
  await dialog.getByRole('button', { name: '修改分支名' }).click();
  await dialog.getByLabel('分支名', { exact: true }).fill('feature/manual');
  await dialog.getByLabel('分支名', { exact: true }).press('Enter');
  await expect(branch).toHaveText('feature/manual');
  await expect(branch).toHaveAttribute('data-source', 'explicit');
  await dialog.getByLabel('初始提示词（可选）').fill('feat: changed again');
  await expect(branch).toHaveText('feature/manual');
  // One click goes back to the generated name.
  await dialog.getByRole('button', { name: '改回自动生成' }).click();
  await expect(branch).toHaveText('feat-changed-again');
  await expect(branch).toHaveAttribute('data-source', 'proposed');
});

test('the worktree menu is fully usable from the keyboard', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __gitContext: { branch: 'main', commit: null, worktree: null, repository: 'repo' },
      __worktrees: [
        { name: 'repo', branch: 'main', path: 'C:/repo', current: false },
        { name: 'work', branch: 'feat-work', path: 'C:/work', current: true },
        { name: 'other', branch: 'feat-other', path: 'C:/other', current: false },
      ],
    });
  });
  await installWorkbenchMock(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const chip = page.getByRole('button', { name: /在工作树中新开会话/ });
  const menu = page.getByRole('menu', { name: '在工作树中新开会话' });
  const repo = menu.getByRole('menuitemradio', { name: /^repo/ });
  const other = menu.getByRole('menuitemradio', { name: /^other/ });
  // No pointer at all: an arrow key opens the menu on its first item.
  await chip.focus();
  await page.keyboard.press('ArrowDown');
  await expect(repo).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(other).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(repo).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(repo).toBeFocused();
  // Escape closes and puts focus back on the chip.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(chip).toBeFocused();
  // Enter activates the focused item exactly like a click.
  await page.keyboard.press('ArrowDown');
  await expect(repo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __launches: Array<Record<string, any>> }).__launches.at(-1))).toMatchObject({
    directory: 'C:/repo',
    worktreeIntent: 'given',
  });
  await expect(menu).toHaveCount(0);
});
