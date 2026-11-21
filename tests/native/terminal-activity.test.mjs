import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexTerminalActivity as activity } from '../../src/adapters/codex/terminalActivity.ts';
import { codexTerminalSemantics as semantics } from '../../src/adapters/codex/terminalSemantics.ts';

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
// The task state reads this evidence: it may claim an approval or a composer, never a finished turn.
const composer = ['Worked for 9m 1s', '\u203a Ask Codex to do anything', '', 'gpt-6 \u00b7 cliora', '  ? for shortcuts'];

test('Codex reports its composer as accepting input and claims no attention there', () => {
  const read = semantics({ title: '', lines: composer });
  assert.equal(read?.inputReady, true);
  assert.equal(read?.attention, null);
  // The screen identity changes with the screen, so stale evidence can be told apart.
  assert.notEqual(read?.screenKey, semantics({ title: '', lines: [...composer.slice(0, 1), 'done'] })?.screenKey);
});

test('a numbered approval menu under a question is an approval, not a free-text composer', () => {
  const screen = [
    'Would you like to run the following command?',
    '',
    '  $ rm -rf build',
    '',
    '\u203a 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again',
    '  3. No, and tell Codex what to do differently (esc)',
    '  ? for shortcuts',
  ];
  const read = semantics({ title: '', lines: screen });
  assert.equal(read?.attention, 'approval');
  // A menu consumes keys: the same screen must not also look like a text composer.
  assert.equal(read?.inputReady, false);
});

test('an active turn accepts no input, and unnumbered prose is unknown rather than a menu', () => {
  const busy = semantics({ title: '', lines: ['\u2022 Working (esc to interrupt)', '\u203a ', '? for shortcuts'] });
  assert.equal(busy?.inputReady, false);
  assert.equal(busy?.attention, null);

  // A plan written by the model can be numbered; without a question it is not an approval.
  const plan = semantics({ title: 'project', lines: ['1. Yes, run the tests', '2. No, skip them'] });
  assert.equal(plan, null);
  // An approval-shaped list without the question line is not enough evidence either.
  assert.equal(semantics({ title: '', lines: ['1. Yes', '2. No'] }), null);
  assert.equal(semantics({ title: '', lines: [] }), null);
});
