import { expect, test as base, type Browser, type BrowserContext, type CDPSession, type Page, type TestInfo } from '@playwright/test';

// Shared page (T8 / R15). This fixture relies on Playwright's private fixtures
// (_contextFactory, _combinedContextOptions) and on the runner applying project options
// to browser.newContext(); @playwright/test is pinned to 1.63.0, so re-check this file on
// every upgrade. Shared contexts skip the per-test video setup: run with
// PLAYWRIGHT_SHARED_PAGE=0 when collecting traces or videos.
//
// Opening a page costs a renderer process and a cold load,
// about twice the CPU of navigating an existing page again. The suite is CPU-bound, so
// files that import `test` from here run each test on one page per worker instead of a
// new context and page. Every test stays an independent test with the same title and
// assertions; only the page underneath is reused.
//
// After each shared test the fixture removes what the test added: init scripts and
// bindings (page and context), routes, listeners, local and session storage, cookies,
// IndexedDB and cache storage of the app origin, viewport and media emulation. It then
// leaves the page on about:blank. It cannot undo granted permissions, the clock, a held
// key, extra pages, downloads or a changed default timeout, so files or tests that use
// those stay on the default fixture: annotate a test with `freshPage('reason')`, or
// keep the file on '@playwright/test'.
//
// Each shared test checks the reset before it starts and fails when anything leaked:
// a sentinel init script, binding and route added by the previous test must be gone,
// the page must be the only one and on about:blank, viewport and media must match the
// project defaults, no listener or cookie may remain, and the first document the test
// loads must see empty local and session storage.
//
// PLAYWRIGHT_SHARED_PAGE=0 turns this off: every test gets a new context and page,
// exactly as with '@playwright/test', to rule out cross-test pollution.

export const sharedPageEnabled = process.env.PLAYWRIGHT_SHARED_PAGE !== '0';

const FRESH_PAGE = 'fresh-page';
const SENTINEL_GLOBAL = '__clioraSharedPageSentinel';
const SENTINEL_BINDING = '__clioraSharedPageSentinelBinding';
const STORAGE_BINDING = '__clioraSharedPageStorage';
const SENTINEL_ROUTE = '/__cliora-shared-page-sentinel';

/** Marks a test that must not run on the shared page; the description records why. */
export function freshPage(reason: string) {
  return { annotation: { type: FRESH_PAGE, description: reason } };
}

type Disposable = { dispose(): Promise<void> };
type ContextFactory = () => Promise<{ context: BrowserContext; close: () => Promise<void> }>;
type StorageSample = { origin: string; local: number; session: number };
type Expected = {
  viewport: { width: number; height: number } | null; colorScheme: string; reducedMotion: string;
  forcedColors: string; contrast: string;
};
type Shared = {
  key: string; context: BrowserContext; page: Page; cdp: CDPSession;
  // Added by the running test; removed in its teardown.
  disposables: Disposable[]; emulated: boolean; origins: Set<string>;
  listeners: Map<string | symbol, Function[]>; sentinels: boolean;
};

// One per worker process. Dropped whenever the page or its context is closed; a failed
// test restarts the worker, which also starts over.
let shared: Shared | undefined;

function sharesPage(testInfo: TestInfo) {
  return !testInfo.annotations.some((annotation) => annotation.type === FRESH_PAGE);
}

function track<T extends object>(target: T, names: string[], state: () => Shared | undefined) {
  for (const name of names) {
    const original = (target as Record<string, Function>)[name].bind(target);
    (target as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const disposable = await original(...args) as Disposable;
      state()?.disposables.push(disposable);
      return disposable;
    };
  }
}

function listenerSnapshot(page: Page) {
  const emitter = page as unknown as { eventNames(): Array<string | symbol>; listeners(name: string | symbol): Function[] };
  return new Map(emitter.eventNames().map((name) => [name, [...emitter.listeners(name)]]));
}

async function openShared(browser: Browser, key: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const state: Shared = { key, context, page, cdp, disposables: [], emulated: false, origins: new Set(), listeners: new Map(), sentinels: false };
  track(page, ['addInitScript', 'exposeBinding', 'exposeFunction'], () => shared);
  track(context, ['addInitScript', 'exposeBinding', 'exposeFunction'], () => shared);
  const emulateMedia = page.emulateMedia.bind(page);
  page.emulateMedia = async (...args) => { state.emulated = true; return emulateMedia(...args); };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && /^https?:/.test(frame.url())) state.origins.add(new URL(frame.url()).origin);
  });
  state.listeners = listenerSnapshot(page);
  return state;
}

async function verifyReset(state: Shared, expected: Expected, origin: string | undefined) {
  const { page, context } = state;
  const leaks: string[] = [];
  if (context.pages().length !== 1) leaks.push(`${context.pages().length} pages are open`);
  if (page.url() !== 'about:blank') leaks.push(`the page is on ${page.url()}`);
  const listeners = listenerSnapshot(page);
  for (const [name, list] of listeners) {
    const kept = state.listeners.get(name) ?? [];
    if (list.some((listener) => !kept.includes(listener))) leaks.push(`a ${String(name)} listener remains`);
  }
  if (JSON.stringify(page.viewportSize()) !== JSON.stringify(expected.viewport)) leaks.push(`viewport is ${JSON.stringify(page.viewportSize())}`);
  const routeUrl = state.sentinels && origin ? `${origin}${SENTINEL_ROUTE}` : '';
  const found = await page.evaluate(({ names, routeUrl }) => {
    const media = {
      width: innerWidth, height: innerHeight,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forced: matchMedia('(forced-colors: active)').matches,
      more: matchMedia('(prefers-contrast: more)').matches,
    };
    const globals = names.filter((name) => name in window);
    if (!routeUrl) return Promise.resolve({ media, globals, route: 'unchecked' });
    // about:blank has an opaque origin, so an unrouted request fails CORS; only the
    // sentinel route answers, with Access-Control-Allow-Origin.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    return fetch(routeUrl, { signal: abort.signal, cache: 'no-store' })
      .then((response) => response.text(), () => (abort.signal.aborted ? 'timeout' : 'blocked'))
      .then((route) => { clearTimeout(timer); return { media, globals, route }; });
  }, { names: [SENTINEL_GLOBAL, SENTINEL_BINDING, STORAGE_BINDING], routeUrl });
  if (expected.viewport && (found.media.width !== expected.viewport.width || found.media.height !== expected.viewport.height)) {
    leaks.push(`the window is ${found.media.width}x${found.media.height}`);
  }
  if (found.media.dark !== (expected.colorScheme === 'dark')) leaks.push('prefers-color-scheme was not reset');
  if (found.media.reduce !== (expected.reducedMotion === 'reduce')) leaks.push('prefers-reduced-motion was not reset');
  if (found.media.forced !== (expected.forcedColors === 'active')) leaks.push('forced-colors was not reset');
  if (found.media.more !== (expected.contrast === 'more')) leaks.push('prefers-contrast was not reset');
  for (const name of found.globals) leaks.push(`${name} from the previous test is still installed`);
  if (found.route !== 'blocked' && found.route !== 'unchecked') leaks.push(`the previous test's route still answers (${found.route})`);
  const cookies = await context.cookies();
  if (cookies.length) leaks.push(`${cookies.length} cookies remain`);
  if (leaks.length) throw new Error(`Shared page was not reset after the previous test: ${leaks.join('; ')}. Rerun with PLAYWRIGHT_SHARED_PAGE=0 to compare.`);
}

async function reset(state: Shared, expected: Expected, origin: string | undefined) {
  const { page, context, cdp } = state;
  // Sentinels go in as the test's own additions, so the next test can see whether they survived.
  await page.addInitScript((name) => { (window as unknown as Record<string, boolean>)[name] = true; }, SENTINEL_GLOBAL);
  await page.exposeBinding(SENTINEL_BINDING, () => undefined);
  if (origin) await page.route(`${origin}${SENTINEL_ROUTE}`, (route) => route.fulfill({ body: 'leaked', headers: { 'access-control-allow-origin': '*' } }));
  state.sentinels = true;

  for (const disposable of state.disposables.splice(0).reverse()) await disposable.dispose();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  for (const [name, list] of listenerSnapshot(page)) {
    const kept = state.listeners.get(name) ?? [];
    for (const listener of list) if (!kept.includes(listener)) page.off(name as 'load', listener as () => void);
  }
  // Session storage lives in the tab, so clear it in the document; the origin clear
  // below also catches anything written while the page unloads.
  if (/^https?:/.test(page.url())) await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); }).catch(() => undefined);
  await page.goto('about:blank');
  for (const visited of state.origins) {
    await cdp.send('Storage.clearDataForOrigin', { origin: visited, storageTypes: 'all' });
  }
  state.origins.clear();
  await context.clearCookies();
  if (JSON.stringify(page.viewportSize()) !== JSON.stringify(expected.viewport) && expected.viewport) await page.setViewportSize(expected.viewport);
  if (state.emulated) {
    await page.emulateMedia({
      media: null, colorScheme: expected.colorScheme as 'light', reducedMotion: expected.reducedMotion as 'reduce',
      forcedColors: expected.forcedColors as 'none', contrast: expected.contrast as 'no-preference',
    });
    state.emulated = false;
  }
  // Park the pointer outside the viewport so nothing on the next page starts hovered.
  await page.mouse.move(-1, -1);
}

const sharedTest = base.extend({
  context: async ({ browser, _contextFactory, _combinedContextOptions }: {
    browser: Browser; _contextFactory: ContextFactory; _combinedContextOptions: Record<string, unknown>;
  }, use: (context: BrowserContext) => Promise<void>, testInfo: TestInfo) => {
    if (!sharesPage(testInfo)) {
      const { context, close } = await _contextFactory();
      await use(context);
      await close();
      return;
    }
    const key = JSON.stringify(_combinedContextOptions);
    if (shared && (shared.key !== key || shared.page.isClosed())) {
      await shared.context.close();
      shared = undefined;
    }
    shared ??= await openShared(browser, key);
    await use(shared.context);
  },
  page: async ({ context, viewport, colorScheme, reducedMotion, forcedColors, contrast, baseURL }: {
    context: BrowserContext; viewport: { width: number; height: number } | null; colorScheme: string | null | undefined;
    reducedMotion: string | null | undefined; forcedColors: string | null | undefined; contrast: string | null | undefined;
    baseURL: string | undefined;
  }, use: (page: Page) => Promise<void>, testInfo: TestInfo) => {
    if (!sharesPage(testInfo)) {
      await use(await context.newPage());
      return;
    }
    const state = shared!;
    const origin = baseURL ? new URL(baseURL).origin : undefined;
    const expected: Expected = {
      viewport, colorScheme: colorScheme ?? 'light', reducedMotion: reducedMotion ?? 'no-preference',
      forcedColors: forcedColors ?? 'none', contrast: contrast ?? 'no-preference',
    };
    await verifyReset(state, expected, origin);
    const { page } = state;

    // The first document the test loads must start with empty storage. The binding keeps
    // the sample across later navigations; this init script runs before the test's own.
    const samples: StorageSample[] = [];
    await page.exposeBinding(STORAGE_BINDING, (_source, sample: StorageSample) => { samples.push(sample); });
    await page.addInitScript((binding) => {
      if (!/^https?:/.test(location.protocol)) return;
      const report = (window as unknown as Record<string, (sample: unknown) => void>)[binding];
      report({ origin: location.origin, local: localStorage.length, session: sessionStorage.length });
    }, STORAGE_BINDING);

    await use(page);

    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed || page.isClosed() || context.pages().length !== 1) {
      // A failed test, a closed page or a page the test opened is not put back; the next
      // shared test starts over (a failure also restarts the worker).
      await context.close();
      shared = undefined;
      return;
    }
    await reset(state, expected, origin);
    const first = samples[0];
    if (first && (first.local || first.session)) {
      throw new Error(`Shared page storage was not cleared before this test: ${first.origin} had ${first.local} localStorage and ${first.session} sessionStorage entries on the first load.`);
    }
  },
} as unknown as Parameters<typeof base.extend>[0]) as unknown as typeof base;

export const test: typeof base = sharedPageEnabled ? sharedTest : base;
export { expect };
