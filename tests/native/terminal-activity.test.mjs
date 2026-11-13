import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexTerminalActivity as activity } from '../../src/adapters/codex/terminalActivity.ts';

test('Codex prompt and shortcut footer remain idle across welcome animation and completion redraws', () => {
  for (const title of ['', 'cliora', '⠋ previous task']) {
    assert.equal(activity({ title, lines: ['Worked for 9m 1s', '› Ask Codex to do anything', '', 'gpt-6 · cliora', '  ? for shortcuts'] }), false);
  }
});

test('an active turn stays active during a silent tool even though its composer is visible', () => {
  assert.equal(activity({ title: '', lines: ['• Working (esc to interrupt)', '› ', '? for shortcuts'] }), true);
  assert.equal(activity({ title: '⠋ project', lines: [] }), true);
});

test('custom titles and transcript prose are unknown instead of guessed as busy or idle', () => {
  for (const title of ['Working on the idle bug', 'Review complete', 'project', '']) {
    assert.equal(activity({ title, lines: ['The answer contains ? for shortcuts but no composer.'] }), null);
  }
  assert.equal(activity({ title: '✓ project', lines: [] }), false);
});
