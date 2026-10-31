import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Exercise the installed renderer and the application's lifecycle helper directly.
// The normal application intentionally uses DOM rendering under webdriver.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

async function installRenderer(page: Page) {
  await page.setContent('<div id="host" style="width:600px;height:200px"></div>');
  await page.addStyleTag({ path: path.resolve('node_modules/@xterm/xterm/css/xterm.css') });
  for (const file of ['@xterm/xterm/lib/xterm.js', '@xterm/addon-webgl/lib/addon-webgl.js']) {
    await page.addScriptTag({ path: path.resolve('node_modules', file) });
  }
  const helper = ts.transpileModule(readFileSync('src/features/sessions/terminalWebgl.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await page.addScriptTag({ content: `{ const exports = {}; ${helper}; window.TerminalWebglLifecycle = exports.TerminalWebglLifecycle; }` });
  await page.evaluate(() => {
    const w = window as any;
    const set = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    w.__blinkIntervals = new Set<number>();
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = set(handler, timeout, ...args);
      if (timeout === 600) w.__blinkIntervals.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = (id?: number) => { w.__blinkIntervals.delete(id); clear(id); };
    w.__closed = [];
    w.__input = '';
    w.__open = (blink = true, focused = true) => {
      const terminal = new w.Terminal({ cursorBlink: blink, cols: 60, rows: 8 });
      terminal.open(document.getElementById('host'));
      if (focused) terminal.focus();
      terminal.onData((text: string) => { w.__input += text; });
      const lifecycle = new w.TerminalWebglLifecycle(terminal, () => new w.WebglAddon.WebglAddon());
      w.__current = { terminal, lifecycle };
      return lifecycle.activate();
    };
    w.__close = () => {
      const { terminal, lifecycle } = w.__current;
      lifecycle.dispose();
      w.__closed.push(new WeakRef(terminal));
      delete w.__current;
      // Match the application's deferred terminal disposal protection.
      setTimeout(() => { terminal.dispose(); document.getElementById('host')!.replaceChildren(); }, 0);
    };
  });
}

async function assertClosedCollected(page: Page) {
  await page.waitForTimeout(100);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.detach();
  expect(await page.evaluate(() => {
    const w = window as any;
    return { intervals: w.__blinkIntervals.size, terminals: w.__closed.filter((ref: WeakRef<object>) => ref.deref()).length };
  })).toEqual({ intervals: 0, terminals: 0 });
}

test('real WebGL cleanup releases closed terminals across three cycles', async ({ page }) => {
  await installRenderer(page);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    expect(await page.evaluate(() => (window as any).__open())).toBe(true);
    await expect(page.locator('.xterm-screen canvas:not(.xterm-link-layer)')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__blinkIntervals.size)).toBe(1);
    await page.evaluate(() => (window as any).__close());
    await assertClosedCollected(page);
  }
});

test('real WebGL cleanup also pauses a CLI DECSET 12 cursor override', async ({ page }) => {
  await installRenderer(page);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    expect(await page.evaluate(() => (window as any).__open(false))).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => (window as any).__current.terminal.write('\x1b[?12h', resolve)));
    await expect.poll(() => page.evaluate(() => (window as any).__blinkIntervals.size)).toBe(1);
    await page.evaluate(() => (window as any).__close());
    await assertClosedCollected(page);
  }
});

test('inactive renderer release preserves content and restores the user blinking preference', async ({ page }) => {
  await installRenderer(page);
  expect(await page.evaluate(() => (window as any).__open())).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => (window as any).__current.terminal.write('preserved output\r\n', resolve)));
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await expect.poll(() => page.evaluate(() => (window as any).__blinkIntervals.size)).toBe(1);
    const inactive = await page.evaluate(() => {
      const w = window as any;
      w.__current.lifecycle.release(false);
      return { blink: w.__current.terminal.options.cursorBlink, intervals: w.__blinkIntervals.size };
    });
    expect(inactive).toEqual({ blink: false, intervals: 0 });
    await expect(page.locator('.xterm-rows')).toContainText('preserved output');
    expect(await page.evaluate(() => {
      const { terminal, lifecycle } = (window as any).__current;
      terminal.options.cursorBlink = true;
      const activated = lifecycle.activate();
      terminal.focus();
      return activated;
    })).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__current.terminal.options.cursorBlink)).toBe(true);
  await page.evaluate(() => (window as any).__close());
  await assertClosedCollected(page);
});

test('actual WebGL context loss falls back to DOM without retaining cursor timers', async ({ page }) => {
  await installRenderer(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  expect(await page.evaluate(() => (window as any).__open())).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => (window as any).__current.terminal.write('\x1b[?12h', resolve)));
  await expect.poll(() => page.evaluate(() => (window as any).__blinkIntervals.size)).toBe(1);
  const lost = await page.locator('.xterm-screen canvas:not(.xterm-link-layer)').evaluate(canvas => {
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    extension?.loseContext();
    return !!extension;
  });
  expect(lost).toBe(true);
  await expect(page.locator('.xterm-screen canvas')).toHaveCount(0, { timeout: 6000 });
  expect(await page.evaluate(() => ({ blink: (window as any).__current.terminal.options.cursorBlink, intervals: (window as any).__blinkIntervals.size }))).toEqual({ blink: true, intervals: 0 });
  expect(await page.evaluate(() => document.activeElement === (window as any).__current.terminal.textarea)).toBe(true);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('after-loss');
  await expect.poll(() => page.evaluate(() => (window as any).__input)).toBe('after-loss');
  await page.evaluate(() => (window as any).__close());
  await assertClosedCollected(page);
  expect(errors).toEqual([]);
});

test('failed real WebGL activation retains DOM input and releases all three closed terminals', async ({ page }) => {
  await installRenderer(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const activated = await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: unknown[]) {
        return kind === 'webgl2' ? null : original.call(this, kind as any, ...args);
      } as typeof original;
      try { return (window as any).__open(); }
      finally { HTMLCanvasElement.prototype.getContext = original; }
    });
    expect(activated).toBe(false);
    await expect(page.locator('.xterm-screen canvas')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__current.terminal.options.cursorBlink)).toBe(true);
    expect(await page.evaluate(() => document.activeElement === (window as any).__current.terminal.textarea)).toBe(true);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`fallback-${cycle}`);
    await expect.poll(() => page.evaluate(() => (window as any).__input)).toContain(`fallback-${cycle}`);
    await page.evaluate(() => {
      const { terminal, lifecycle } = (window as any).__current;
      lifecycle.release(false);
      terminal.options.cursorBlink = true;
      lifecycle.activate(); // Failed activation remains DOM; no repeated partial renderer.
    });
    await page.evaluate(() => (window as any).__close());
    await assertClosedCollected(page);
  }
  expect(errors).toEqual([]);
});

for (const [blink, focused] of [[false, true], [true, false]]) {
  test(`real WebGL respects blink=${blink} focused=${focused}`, async ({ page }) => {
    await installRenderer(page);
    expect(await page.evaluate(([blink, focused]) => (window as any).__open(blink, focused), [blink, focused])).toBe(true);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as any).__blinkIntervals.size)).toBe(0);
    expect(await page.evaluate(() => (window as any).__current.terminal.options.cursorBlink)).toBe(blink);
    await page.evaluate(() => (window as any).__close());
    await assertClosedCollected(page);
  });
}
