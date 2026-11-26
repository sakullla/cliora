import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCommandMarker, applyProgressReport, commandHint, commandStateKey, idleCommandState,
  parseCommandMarker, parseProgressReport,
} from '../../src/features/sessions/terminalCommandState.ts';
import { translationResources } from '../../src/i18n/catalog.ts';

const run = (markers, start = idleCommandState) => markers.reduce((state, marker) => {
  const parsed = parseCommandMarker(marker);
  assert.ok(parsed, `${marker} should parse`);
  return applyCommandMarker(state, parsed);
}, start);

const progress = (reports, start = idleCommandState) => reports.reduce((state, report) => {
  const parsed = parseProgressReport(report);
  assert.ok(parsed, `${report} should parse`);
  return applyProgressReport(state, parsed);
}, start);

test('OSC 133 marks map to prompt, input, executing and a finished exit code', () => {
  assert.deepEqual(parseCommandMarker('A'), { kind: 'prompt' });
  assert.deepEqual(parseCommandMarker('B'), { kind: 'input' });
  assert.deepEqual(parseCommandMarker('C'), { kind: 'executing' });
  assert.deepEqual(parseCommandMarker('D;0'), { kind: 'finished', exitCode: 0 });
  assert.deepEqual(parseCommandMarker('D;1'), { kind: 'finished', exitCode: 1 });
  assert.deepEqual(parseCommandMarker('D;255'), { kind: 'finished', exitCode: 255 });
  // Shell-integration parameters ride along without changing the mark.
  assert.deepEqual(parseCommandMarker('A;cl=m'), { kind: 'prompt' });
  assert.deepEqual(parseCommandMarker('D;2;aid=7'), { kind: 'finished', exitCode: 2 });
});

test('a missing, oversized or malformed exit code is unknown rather than a success', () => {
  for (const payload of ['D', 'D;', 'D; ', 'D;300', 'D;abc', 'D;1x', 'D;-1']) {
    assert.deepEqual(parseCommandMarker(payload), { kind: 'finished', exitCode: null }, payload);
  }
  for (const payload of ['', 'X', 'P;k=i', '$', 'a', 'E;1']) assert.equal(parseCommandMarker(payload), null, payload);
});

test('A then B then C then D;1 records a failed command the next prompt keeps visible', () => {
  const finished = run(['A', 'B', 'C', 'D;1']);
  assert.equal(finished.phase, 'finished');
  assert.equal(finished.finished, true);
  assert.equal(finished.exitCode, 1);
  // A real shell prints A (and usually B) right after D, so the result has to survive them: the
  // failure is the fact the user was promised to read.
  const prompted = run(['A'], finished);
  assert.equal(prompted.phase, 'prompt');
  assert.equal(prompted.finished, true);
  assert.equal(prompted.exitCode, 1);
  const typing = run(['B'], prompted);
  assert.equal(typing.phase, 'input');
  assert.equal(typing.finished, true);
  assert.equal(typing.exitCode, 1);
  // Only the next command retires it.
  const next = run(['C'], typing);
  assert.equal(next.phase, 'running');
  assert.equal(next.finished, false);
  assert.equal(next.exitCode, null);
  assert.notEqual(next, typing);
});

test('a repeated prompt is no change at all', () => {
  const finished = run(['A', 'B', 'C', 'D;1']);
  const prompted = run(['A'], finished);
  assert.equal(run(['A'], prompted), prompted);
  assert.equal(run(['A']), idleCommandState);
});

test('an input line that never executed clears its mark instead of recording a result', () => {
  const abandoned = run(['A', 'B', 'D;0']);
  assert.equal(abandoned.phase, 'prompt');
  assert.equal(abandoned.finished, false);
  assert.equal(abandoned.exitCode, null);
  // An end marker that no start preceded is not a command either.
  assert.deepEqual(run(['D;0']), idleCommandState);
});

test('out-of-order marks never move the cycle backwards or invent a success', () => {
  const running = run(['A', 'B', 'C']);
  // A late B belongs to a prompt the terminal has not seen yet.
  assert.equal(applyCommandMarker(running, { kind: 'input' }).phase, 'running');
  const finished = applyCommandMarker(running, { kind: 'finished', exitCode: 0 });
  assert.equal(finished.phase, 'finished');
  // A repeated end marker adds no fact and keeps the recorded code.
  assert.deepEqual(applyCommandMarker(finished, { kind: 'finished', exitCode: 1 }), finished);
  assert.equal(applyCommandMarker(finished, { kind: 'input' }).phase, 'finished');
});

test('a clean command still records its code without claiming delivery', () => {
  const clean = run(['A', 'B', 'C', 'D;0']);
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.finished, true);
  // The state carries command facts only: nothing here can mark a task delivered or crashed.
  assert.deepEqual(Object.keys(clean).sort(), ['exitCode', 'finished', 'phase', 'progress']);
});

test('OSC 9;4 states map to normal, error, indeterminate and warning, and 0 clears', () => {
  assert.deepEqual(parseProgressReport('4;1;35'), { kind: 'set', progress: { kind: 'normal', percent: 35 } });
  assert.deepEqual(parseProgressReport('4;2;10'), { kind: 'set', progress: { kind: 'error', percent: 10 } });
  assert.deepEqual(parseProgressReport('4;3'), { kind: 'set', progress: { kind: 'indeterminate', percent: null } });
  assert.deepEqual(parseProgressReport('4;4;90'), { kind: 'set', progress: { kind: 'warning', percent: 90 } });
  assert.deepEqual(parseProgressReport('4;0'), { kind: 'clear' });
  const state = progress(['4;1;35', '4;0']);
  assert.equal(state.progress, null);
});

test('unknown states, unknown shapes and out-of-range percentages leave the bar alone', () => {
  for (const payload of ['4;5;10', '4;', '4;1', '4;1;101', '4;1;250', '4;1;abc', '4;1;-5', 'Build finished', '', '4;1;35x']) {
    assert.equal(parseProgressReport(payload), null, payload);
  }
  // OSC 9 is also a notification channel; those bytes are not progress and stay for xterm.
  assert.equal(parseProgressReport('Build finished'), null);
  const good = progress(['4;1;35']);
  for (const payload of ['4;1;250', '4;9', '4;1']) {
    const parsed = parseProgressReport(payload);
    assert.equal(parsed, null);
  }
  // A rejected report keeps the last real one exactly as it was.
  assert.deepEqual(applyProgressReport(good, { kind: 'set', progress: { kind: 'normal', percent: 35 } }), good);
});

test('progress describes the program, so it survives a command ending and its own error', () => {
  const errored = progress(['4;2;40']);
  assert.equal(errored.progress?.kind, 'error');
  assert.equal(errored.phase, 'prompt');
  // A finished command does not clear the program's own bar; only state 0 does.
  const finished = applyCommandMarker(errored, { kind: 'executing' });
  assert.deepEqual(finished.progress, errored.progress);
});

test('an identical state keeps one identity so a repaint publishes nothing new', () => {
  const first = run(['A', 'B', 'C', 'D;1']);
  const repeat = run(['A', 'B', 'C', 'D;1']);
  assert.equal(commandStateKey(first), commandStateKey(repeat));
  assert.notEqual(commandStateKey(first), commandStateKey(progress(['4;1;35'], first)));
  assert.equal(commandStateKey(idleCommandState), commandStateKey(idleCommandState));
});

test('the wording states the command fact and stays quiet on a success or a plain prompt', () => {
  assert.equal(commandHint(idleCommandState), null);
  assert.equal(commandHint(run(['A', 'B', 'C']))?.key, 'sessions.commandRunning');
  assert.equal(commandHint(run(['A', 'B', 'C', 'D;0'])), null);
  const failed = commandHint(run(['A', 'B', 'C', 'D;1']));
  assert.deepEqual(failed, { key: 'sessions.commandExit', params: { code: 1 }, tone: 'failed' });
  assert.equal(commandHint(run(['A', 'B', 'C', 'D']))?.key, 'sessions.commandResultUnknown');
  assert.deepEqual(commandHint(progress(['4;1;35'])), { key: 'sessions.commandProgress', params: { percent: 35 }, tone: 'progress' });
  assert.equal(commandHint(progress(['4;3']))?.key, 'sessions.commandProgressIndeterminate');
  assert.equal(commandHint(progress(['4;4;90']))?.key, 'sessions.commandProgressWarning');
  assert.equal(commandHint(progress(['4;2;10']))?.key, 'sessions.commandProgressError');
  // Progress outranks a finished result: the program is still reporting its own work.
  assert.equal(commandHint(progress(['4;1;60'], run(['A', 'B', 'C', 'D;1'])))?.key, 'sessions.commandProgress');
  // The failure stays worded through the shell's next prompt and input line, then gives way to the
  // command that replaced it.
  const afterPrompt = run(['A', 'B'], run(['A', 'B', 'C', 'D;1']));
  assert.deepEqual(commandHint(afterPrompt), { key: 'sessions.commandExit', params: { code: 1 }, tone: 'failed' });
  assert.equal(commandHint(run(['C'], afterPrompt))?.key, 'sessions.commandRunning');
  // A clean command keeps quiet after its own prompt too.
  assert.equal(commandHint(run(['A', 'B'], run(['A', 'B', 'C', 'D;0']))), null);
});

test('every command wording exists in both languages', () => {
  const keys = ['commandRunning', 'commandExit', 'commandResultUnknown', 'commandProgress', 'commandProgressIndeterminate', 'commandProgressWarning', 'commandProgressError'];
  for (const language of ['zh', 'en']) {
    const sessions = translationResources[language].translation.sessions;
    for (const key of keys) assert.equal(typeof sessions[key], 'string', `${language}.sessions.${key}`);
  }
});
