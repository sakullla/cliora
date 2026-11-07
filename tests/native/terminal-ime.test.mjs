import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalIme, imePlacement, inspectImeBridge } from '../../src/features/sessions/terminalIme.ts';

// Frames run only when a test flushes them; no timer decides an outcome here.
let frames = [];
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
const flushFrames = () => { const run = frames; frames = []; run.forEach((callback) => callback()); };

/** Listener store with DOM order: host capture listeners, then textarea listeners. */
class Node {
  constructor() { this.listeners = []; this.dataset = {}; this.style = {}; }
  addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture: capture === true || capture?.capture === true }); }
  removeEventListener(type, fn, capture = false) {
    const flag = capture === true || capture?.capture === true;
    this.listeners = this.listeners.filter((item) => !(item.type === type && item.fn === fn && item.capture === flag));
  }
}

/**
 * The parts of xterm 6.0.0 this bridge touches, wired like CoreBrowserTerminal:
 * keydown/input in capture on the textarea, composition events calling the helper
 * through its property at event time, and the direct insertText sender of _inputEvent.
 */
function fixture({ breakHelper = false } = {}) {
  const host = new Node();
  const textarea = new Node();
  textarea.value = '';
  textarea.isConnected = true;
  textarea.getClientRects = () => [{}];
  const sent = [];
  let focused = true;
  let active = true;
  let keyDownSeen = false;
  const view = { classList: { active: false, add() { this.active = true; }, remove() { this.active = false; } }, style: {}, offsetWidth: 16 };
  const helper = {
    _isComposing: false,
    _isSendingComposition: false,
    _compositionView: view,
    get isComposing() { return this._isComposing; },
    compositionstart() { this._isComposing = true; view.classList.add('active'); },
    compositionupdate() { this.updateCompositionElements(); },
    // xterm's own end would send the textarea range later; the bridge must replace it.
    compositionend() { this._isComposing = false; sent.push(`xterm-end:${textarea.value}`); },
    keydown(event) {
      if (this._isComposing) { this._isComposing = false; sent.push(`xterm-keydown:${textarea.value}`); return true; }
      return event.keyCode !== 229;
    },
    updateCompositionElements() {},
  };
  if (breakHelper) delete helper._isSendingComposition;
  const screen = { clientWidth: 800, clientHeight: 360 };
  const core = {
    _renderService: { dimensions: { css: { cell: { width: 8, height: 18 } } } },
    _syncTextArea() {},
    _compositionHelper: helper,
    coreService: { isCursorHidden: false },
  };
  const cursor = { cursorX: 4, cursorY: 2 };
  const term = {
    _core: core,
    textarea,
    cols: 100,
    rows: 20,
    options: { fontFamily: 'mono', fontSize: 14 },
    element: { querySelector: (selector) => selector === '.xterm-screen' ? screen : selector === '.composition-view' ? view : null },
    buffer: { active: { get cursorX() { return cursor.cursorX; }, get cursorY() { return cursor.cursorY; }, baseY: 0, viewportY: 0 } },
    input: (data) => sent.push(data),
    scrollToBottom() {},
  };
  textarea.addEventListener('keyup', () => { keyDownSeen = false; }, true);
  textarea.addEventListener('keydown', (event) => {
    keyDownSeen = true;
    if (core._compositionHelper.keydown(event) && event.key.length === 1) sent.push(event.key);
  }, true);
  textarea.addEventListener('compositionstart', () => core._compositionHelper.compositionstart());
  textarea.addEventListener('compositionupdate', (event) => core._compositionHelper.compositionupdate(event));
  textarea.addEventListener('compositionend', () => core._compositionHelper.compositionend());
  textarea.addEventListener('input', (event) => {
    if (event.data && event.inputType === 'insertText' && (!event.composed || !keyDownSeen)) sent.push(event.data);
  }, true);

  const ime = createTerminalIme(term, { available: () => active, ownsInput: () => active && focused, host });
  const dispatch = (type, props = {}) => {
    let stopped = false;
    const event = { type, target: textarea, stopImmediatePropagation: () => { stopped = true; }, ...props };
    for (const item of host.listeners.filter((listener) => listener.type === type && listener.capture)) { if (stopped) return; item.fn(event); }
    for (const item of textarea.listeners.filter((listener) => listener.type === type && listener.capture)) { if (stopped) return; item.fn(event); }
    for (const item of textarea.listeners.filter((listener) => listener.type === type && !listener.capture)) { if (stopped) return; item.fn(event); }
  };
  const ev = {
    start: () => dispatch('compositionstart'),
    update: (word) => { textarea.value += word; dispatch('compositionupdate', { data: word }); },
    key: (key, keyCode, extra = {}) => dispatch('keydown', { key, keyCode, ...extra }),
    keyup: (key, keyCode) => dispatch('keyup', { key, keyCode }),
    end: (data) => dispatch('compositionend', { data }),
    insert: (data, composed = true) => dispatch('input', { data, inputType: 'insertText', composed, isComposing: false }),
    blur: () => { focused = false; dispatch('blur'); textarea.value = ''; },
  };
  return { ime, ev, sent, textarea, host, helper, core, cursor, screen, term, view, setActive: (value) => { active = value; }, setFocused: (value) => { focused = value; } };
}

test('same-turn and both reproduced cross-turn commit orders send the word once', () => {
  for (const order of ['same-turn', 'delayed-end', 'delayed-trailing-input']) {
    const { ev, sent } = fixture();
    ev.start();
    ev.update('升级');
    ev.key(' ', 32);
    // delayed-end: the next turn arrives before compositionend; nothing is sent in between.
    if (order === 'delayed-end') assert.deepEqual(sent, [], order);
    ev.end('升级');
    if (order === 'delayed-trailing-input') ev.keyup('Process', 229);
    ev.insert('升级');
    assert.deepEqual(sent, ['升级'], order);
  }
});

test('a word confirmed twice is sent twice, and so is a word confirmed by digit or Enter', () => {
  const { ev, sent } = fixture();
  for (const [key, code] of [[' ', 32], [' ', 32], ['1', 49], ['Enter', 13]]) {
    ev.start();
    ev.update('哈');
    ev.key(key, code);
    ev.end('哈');
    ev.keyup('Process', 229);
    ev.insert('哈');
  }
  assert.deepEqual(sent, ['哈', '哈', '哈', '哈']);
});

test('cancel, English, emoji and Chinese punctuation keep their own paths', () => {
  const { ev, sent, textarea } = fixture();
  ev.start();
  ev.update('sheng');
  ev.key('Escape', 27);
  textarea.value = '';
  ev.end('');
  assert.deepEqual(sent, []);
  ev.key('a', 65);
  assert.deepEqual(sent, ['a']);
  // Emoji panel insertText right after a commit is new input, not the commit's echo.
  ev.start();
  ev.update('好');
  ev.end('好');
  ev.insert('🙂', false);
  assert.deepEqual(sent, ['a', '好', '🙂']);
  ev.insert('🙂', false);
  assert.deepEqual(sent, ['a', '好', '🙂', '🙂']);
});

test('the commit echo is absorbed only before the next keystroke', () => {
  const { ev, sent } = fixture();
  ev.start();
  ev.update('你好');
  ev.end('你好');
  ev.key('Process', 229);
  ev.keyup('Process', 229);
  // A keystroke ended the transaction: an identical insertText now is the user's input.
  ev.insert('你好');
  assert.deepEqual(sent, ['你好', '你好']);
});

test('a commit the textarea shows only at the trailing insertText is still sent once', () => {
  const { ev, sent, textarea } = fixture();
  ev.start();
  textarea.value = '';
  ev.end('升级');
  assert.deepEqual(sent, []);
  textarea.value = '升级';
  ev.insert('升级');
  ev.insert('升级');
  assert.deepEqual(sent, ['升级', '升级']);
});

test('blur or deactivation during a composition never sends it later or elsewhere', () => {
  const blurred = fixture();
  blurred.ev.start();
  blurred.ev.update('shengji');
  blurred.ev.blur();
  blurred.ev.end('shengji');
  assert.deepEqual(blurred.sent, []);
  assert.equal(blurred.helper._isComposing, false);
  assert.equal(blurred.view.classList.active, false);

  const switched = fixture();
  switched.ev.start();
  switched.ev.update('升级');
  switched.setActive(false);
  switched.ime.deactivate();
  switched.ev.end('升级');
  assert.deepEqual(switched.sent, []);
  assert.equal(switched.ime.composing(), false);

  // Focus already moved when the IME ends: the unconfirmed text is dropped.
  const moved = fixture();
  moved.ev.start();
  moved.ev.update('升级');
  moved.setFocused(false);
  moved.ev.end('升级');
  assert.deepEqual(moved.sent, []);
});

test('an incomplete xterm internal surface installs nothing', () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const { ev, sent, host, ime } = fixture({ breakHelper: true });
    assert.equal(ime.status.ok, false);
    assert.equal(host.dataset.imeBridge, 'unsupported');
    assert.match(warnings.join(''), /_isSendingComposition/);
    ev.start();
    ev.update('升级');
    ev.key(' ', 32);
    // Untouched xterm behaviour: no partial patch claims support.
    assert.ok(sent.some((item) => item.startsWith('xterm-keydown')));
  } finally { console.warn = warn; }
  assert.deepEqual(inspectImeBridge(undefined), { ok: false, missing: ['_core'] });
  assert.equal(fixture().host.dataset.imeBridge, 'ready');
});

test('placement rejects zero or hidden layout and clamps a held anchor into a smaller screen', () => {
  const cell = { width: 8, height: 18 };
  assert.equal(imePlacement({ col: 3, row: 2 }, { cols: 80, rows: 20 }, cell, { width: 640, height: 0 }), null);
  assert.equal(imePlacement({ col: 3, row: 2 }, { cols: 80, rows: 20 }, null, { width: 640, height: 360 }), null);
  assert.equal(imePlacement({ col: 3, row: 2 }, { cols: 0, rows: 0 }, cell, { width: 640, height: 360 }), null);
  assert.deepEqual(imePlacement({ col: 3, row: 2 }, { cols: 80, rows: 20 }, cell, { width: 640, height: 360 }), { left: 24, top: 36, width: 8, height: 18 });
  // Anchor from a taller grid: row 19 of a now 5-row screen stays on the last visible row.
  assert.deepEqual(imePlacement({ col: 79, row: 19 }, { cols: 40, rows: 5 }, cell, { width: 320, height: 90 }), { left: 312, top: 72, width: 8, height: 18 });
  // Long pre-edit text near the right edge stays inside the clip.
  assert.deepEqual(imePlacement({ col: 38, row: 0 }, { cols: 40, rows: 5 }, cell, { width: 320, height: 90 }, 64), { left: 256, top: 0, width: 64, height: 18 });
});

test('a hidden or collapsed terminal keeps its last anchor and writes a valid one when it returns', () => {
  const { ime, textarea, screen, cursor } = fixture();
  ime.refresh();
  assert.equal(textarea.style.top, '36px');
  screen.clientHeight = 0;
  cursor.cursorY = 5;
  ime.refresh();
  assert.equal(textarea.style.top, '36px');
  textarea.getClientRects = () => [];
  screen.clientHeight = 360;
  ime.refresh();
  assert.equal(textarea.style.top, '36px');
  textarea.getClientRects = () => [{}];
  ime.schedule();
  flushFrames();
  assert.equal(textarea.style.top, `${5 * 18}px`);
  // The terminal element collapsed while the screen kept its old size: still no anchor.
  const { ime: clipped, textarea: field, term } = fixture();
  term.element.clientWidth = 800;
  term.element.clientHeight = 0;
  clipped.refresh();
  assert.equal(field.style.top, undefined);
  // A partly visible element clamps the anchor into its visible rows.
  term.element.clientHeight = 30;
  clipped.refresh();
  assert.equal(field.style.top, '12px');
});

test('a hidden TUI cursor without a drawn marker keeps the last confirmed input point', () => {
  const { ime, textarea, core, cursor, term } = fixture();
  ime.refresh();
  assert.deepEqual([textarea.style.left, textarea.style.top], ['32px', '36px']);
  core.coreService.isCursorHidden = true;
  cursor.cursorX = 0;
  cursor.cursorY = 0;
  term.buffer.active.getNullCell = () => ({});
  term.buffer.active.getLine = () => ({ getCell: () => ({ isBlink: () => 0, isInverse: () => 0 }) });
  ime.refresh();
  assert.deepEqual([textarea.style.left, textarea.style.top], ['32px', '36px']);
});

test('placement writes only real moves', () => {
  const { ime, textarea } = fixture();
  ime.refresh();
  let writes = 0;
  const style = textarea.style;
  textarea.style = new Proxy(style, { set(target, key, value) { writes += 1; target[key] = value; return true; } });
  for (let index = 0; index < 5; index += 1) { ime.schedule(); flushFrames(); }
  assert.equal(writes, 0);
});

test('native IME report rejects double sends, origin candidates and missing candidate evidence', async () => {
  const { summarizeScenario, SCENARIOS } = await import('../../scripts/verify-ime.mjs');
  assert.ok(SCENARIOS.some((item) => item.id === 'repeat') && SCENARIOS.some((item) => item.id === 'session-switch'));
  const anchor = { left: 500, top: 400, right: 508, bottom: 421 };
  const events = [{ type: 'compositionstart', screenRect: anchor }];
  const basic = { id: 'basic', expected: '升级' };
  const good = summarizeScenario(basic, { events, writes: [{ sessionId: 's1', text: '升级' }], candidates: [{ left: 500, top: 425, right: 800, bottom: 470 }] });
  assert.equal(good.ok, true);
  const doubled = summarizeScenario(basic, { events, writes: [{ sessionId: 's1', text: '升级' }, { sessionId: 's1', text: '升级' }], candidates: [{ left: 500, top: 425, right: 800, bottom: 470 }] });
  assert.equal(doubled.ok, false);
  const corner = summarizeScenario(basic, { events, writes: [{ sessionId: 's1', text: '升级' }], candidates: [{ left: 0, top: 0, right: 300, bottom: 45 }] });
  assert.equal(corner.checks.find((item) => item.name.includes('next to'))?.ok, false);
  const unseen = summarizeScenario(basic, { events, writes: [{ sessionId: 's1', text: '升级' }], candidates: [] });
  assert.equal(unseen.ok, false);
  const leaked = summarizeScenario({ id: 'session-switch', expected: '' }, { events, writes: [{ sessionId: 's2', text: '升级' }], candidates: [{ left: 500, top: 425, right: 800, bottom: 470 }] });
  assert.equal(leaked.ok, false);
});

test('native IME attach refuses any CDP port that is not the test instance', async () => {
  const { checkIsolation, IDENTIFIER } = await import('../../scripts/verify-ime.mjs');
  const app = { ProcessId: 500, ParentProcessId: 1, Name: 'cliora.exe' };
  const browser = (parent, profile, port = 9333) => ({ ProcessId: parent + 1, ParentProcessId: parent, Name: 'msedgewebview2.exe',
    CommandLine: `"msedgewebview2.exe" --embedded-browser-webview=1 --user-data-dir="${profile}" --remote-debugging-port=${port}` });
  const own = 'C:\\Users\\u\\AppData\\Local\\com.cliora.imetest\\EBWebView';
  const user = 'C:\\Users\\u\\AppData\\Local\\com.cliora.desktop\\EBWebView';
  const renderer = { ProcessId: 900, ParentProcessId: 501, Name: 'msedgewebview2.exe', CommandLine: 'msedgewebview2.exe --type=renderer --remote-debugging-port=9333' };
  assert.deepEqual(checkIsolation({ pid: 500, port: 9333, identifier: IDENTIFIER, processes: [app, browser(500, own), renderer] }), []);
  // The user's app opened the port: refused even when --pid names a real Cliora.
  const userApp = { ProcessId: 14696, ParentProcessId: 1, Name: 'cliora.exe' };
  assert.ok(checkIsolation({ pid: 500, port: 9333, identifier: IDENTIFIER, processes: [app, userApp, browser(14696, user)] }).some((item) => /not 500/.test(item)));
  // --pid pointing at the user's app with its profile: refused.
  assert.ok(checkIsolation({ pid: 14696, port: 9333, identifier: IDENTIFIER, processes: [userApp, browser(14696, user)] }).some((item) => /user's profile/.test(item)));
  assert.ok(checkIsolation({ pid: 500, port: 9333, identifier: IDENTIFIER, processes: [app] }).some((item) => /No WebView2/.test(item)));
  assert.ok(checkIsolation({ pid: 500, port: 9333, identifier: IDENTIFIER, processes: [app, browser(500, own, 9222)] }).some((item) => /No WebView2/.test(item)));
  assert.ok(checkIsolation({ pid: 500, port: 9333, identifier: 'com.cliora.desktop', processes: [app, browser(500, user)] }).length > 0);
  assert.ok(checkIsolation({ pid: 500, port: 9333, identifier: IDENTIFIER, processes: [{ ...app, Name: 'notepad.exe' }, browser(500, own)] }).some((item) => /not a Cliora/.test(item)));
});

test('native IME build config isolates identifier and output without touching the shared dist', async () => {
  const { testBuildConfig, IDENTIFIER } = await import('../../scripts/verify-ime.mjs');
  const config = testBuildConfig('C:\\repo\\.vite\\ime-native', 'C:\\repo');
  assert.equal(config.identifier, IDENTIFIER);
  assert.notEqual(config.identifier, 'com.cliora.desktop');
  assert.equal(config.build.frontendDist, '../.vite/ime-native/dist');
  assert.match(config.build.beforeBuildCommand.script, /--outDir \.vite\/ime-native\/dist /);
  assert.doesNotMatch(config.build.beforeBuildCommand.script, /"/);
  assert.throws(() => testBuildConfig('C:\\repo\\my dir', 'C:\\repo'), /spaces/);
});

test('native IME trace records the orders only a real IME can produce', async () => {
  const { traceOrders, SCENARIOS } = await import('../../scripts/verify-ime.mjs');
  for (const id of ['commit-then-key', 'ctrl-c-after', 'ctrl-c-composing']) assert.ok(SCENARIOS.some((item) => item.id === id), id);
  // (a) the commit repeated as insertText after another keydown.
  assert.equal(traceOrders([{ type: 'compositionstart' }, { type: 'compositionend', data: '升级', valueLength: 2 }, { type: 'keydown', keyCode: 229 }, { type: 'input', inputType: 'insertText', data: '升级' }]).repeatAfterKeydown, 1);
  // (b) compositionend data with an empty textarea and no trailing insertText.
  assert.equal(traceOrders([{ type: 'compositionstart' }, { type: 'compositionend', data: '升级', valueLength: 0 }, { type: 'keydown', keyCode: 65 }]).endDataWithoutInsert, 1);
  assert.equal(traceOrders([{ type: 'compositionstart' }, { type: 'compositionend', data: '升级', valueLength: 0 }, { type: 'input', inputType: 'insertText', data: '升级' }]).endDataWithoutInsert, 0);
  // (c) a composition without an end, and non-IME keys seen while it is open.
  const open = traceOrders([{ type: 'compositionstart' }, { type: 'keydown', key: 'c', keyCode: 67, isComposing: false }]);
  assert.equal(open.openWithoutEnd, true);
  assert.deepEqual(open.nonImeKeyWhileComposing, [{ key: 'c', keyCode: 67, isComposing: false }]);
  const clean = traceOrders([{ type: 'compositionstart' }, { type: 'keydown', keyCode: 229 }, { type: 'compositionend', data: '升级', valueLength: 2 }, { type: 'input', inputType: 'insertText', data: '升级' }]);
  assert.deepEqual(clean, { nonImeKeyWhileComposing: [], repeatAfterKeydown: 0, endDataWithoutInsert: 0, openWithoutEnd: false });
});
