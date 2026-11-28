import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TerminalRenderPause } from '../../src/features/sessions/terminalRenderPause.ts';

/** The part of xterm 6.0.0's RenderService the pause wraps: selection redraws reach the renderer directly. */
class RenderService {
  constructor() { this.redraws = []; }
  handleSelectionChanged(start, end, columnSelectMode) { this.redraws.push([start, end, columnSelectMode]); }
}
const terminalWith = (service) => ({ _core: { _renderService: service } });

test('a paused terminal keeps only the latest selection and redraws it once on resume', () => {
  const service = new RenderService();
  const pause = new TerminalRenderPause(terminalWith(service));
  assert.equal(pause.supported, true);
  service.handleSelectionChanged([0, 1], [4, 1], false);
  assert.equal(service.redraws.length, 1);
  pause.pause();
  // Each scrolled line of hidden output queues one of these.
  for (let index = 0; index < 500; index++) service.handleSelectionChanged(undefined, undefined, false);
  service.handleSelectionChanged([2, 3], [5, 7], true);
  assert.equal(service.redraws.length, 1);
  pause.resume();
  assert.deepEqual(service.redraws.slice(1), [[[2, 3], [5, 7], true]]);
  pause.resume();
  assert.equal(service.redraws.length, 2, 'a second resume has nothing left to draw');
  service.handleSelectionChanged(undefined, undefined, false);
  assert.equal(service.redraws.length, 3, 'a visible terminal redraws immediately');
});

test('resuming without a held selection draws nothing', () => {
  const service = new RenderService();
  const pause = new TerminalRenderPause(terminalWith(service));
  pause.pause();
  pause.resume();
  assert.deepEqual(service.redraws, []);
});

test('dispose restores the original method and drops a held selection', () => {
  const service = new RenderService();
  const pause = new TerminalRenderPause(terminalWith(service));
  assert.ok(Object.hasOwn(service, 'handleSelectionChanged'));
  pause.pause();
  service.handleSelectionChanged([0, 0], [1, 0], false);
  pause.dispose();
  assert.equal(Object.hasOwn(service, 'handleSelectionChanged'), false);
  assert.equal(service.handleSelectionChanged, RenderService.prototype.handleSelectionChanged);
  assert.deepEqual(service.redraws, []);
  pause.pause();
  service.handleSelectionChanged([0, 0], [1, 0], false);
  assert.equal(service.redraws.length, 1, 'a disposed pause no longer holds redraws');
});

test('dispose restores an own-property method too', () => {
  const service = new RenderService();
  const own = function (start, end, columnSelectMode) { this.redraws.push(['own', start, end, columnSelectMode]); };
  service.handleSelectionChanged = own;
  const pause = new TerminalRenderPause(terminalWith(service));
  pause.dispose();
  assert.equal(service.handleSelectionChanged, own);
});

test('an xterm build without the service leaves the terminal untouched', () => {
  for (const terminal of [{}, { _core: {} }, { _core: { _renderService: {} } }]) {
    const pause = new TerminalRenderPause(terminal);
    assert.equal(pause.supported, false);
    pause.pause();
    assert.equal(pause.isPaused, false);
    pause.resume();
    pause.dispose();
  }
});

// The wrapper relies on private xterm 6.0.0 internals. A version change must re-check
// that selection redraws still bypass RenderService's visibility pause.
test('the pinned xterm still routes scroll-driven selection redraws past the visibility pause', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../node_modules/@xterm/xterm/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '6.0.0', 'xterm changed: re-verify terminalRenderPause.ts and update this test');
  const lib = readFileSync(new URL('../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url), 'utf8');
  // RenderService forwards a selection redraw without consulting _isPaused ...
  const forward = lib.match(/handleSelectionChanged\((\w+),(\w+),(\w+)\)\{this\._selectionState[^}]*\}/);
  assert.ok(forward, 'RenderService.handleSelectionChanged changed shape');
  assert.doesNotMatch(forward[0], /_isPaused/);
  assert.match(forward[0], /this\._renderer\.value\?\.handleSelectionChanged\(/);
  // ... and every scroll queues one through SelectionService.refresh.
  assert.match(lib, /_selectionService\.refresh\(\),this\._viewport\?\.queueSync\(\)/);
});
