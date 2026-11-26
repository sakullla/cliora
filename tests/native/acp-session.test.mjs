import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACP_NOTICE_LIMIT,
  acpIsLive,
  acpResumeKey,
  acpRow,
  acpStateKey,
  acpTurnActive,
  acpTurnKey,
  applyAcpEvent,
  applyAcpEvents,
} from '../../src/features/sessions/acpSession.ts';

function snapshot(overrides = {}) {
  return {
    id: 'a1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', interaction: 'acp',
    state: 'ready', nativeSessionId: 'native-1', resume: 'none', messages: [], tools: [], permissions: [],
    diagnostics: [], lastTurnReason: '', seq: 1, ...overrides,
  };
}

test('a snapshot replaces the whole conversation and a chunk appends to exactly one message', () => {
  const first = applyAcpEvent(undefined, { sessionId: 'a1', seq: 5, kind: 'snapshot', snapshot: snapshot({ seq: 5 }) });
  assert.equal(first.snapshot.seq, 5);
  const chunk = applyAcpEvent(first, { sessionId: 'a1', seq: 6, kind: 'chunk', messageId: 'm1', role: 'agent', text: 'he', truncated: false });
  const more = applyAcpEvent(chunk, { sessionId: 'a1', seq: 7, kind: 'chunk', messageId: 'm1', role: 'agent', text: 'llo', truncated: false });
  assert.deepEqual(more.snapshot.messages.map((message) => message.text), ['hello']);
  assert.equal(more.snapshot.seq, 7);
});

test('an event already applied, or older than the snapshot, is not replayed', () => {
  const state = applyAcpEvent(undefined, { sessionId: 'a1', seq: 5, kind: 'snapshot', snapshot: snapshot({ seq: 5 }) });
  const once = applyAcpEvent(state, { sessionId: 'a1', seq: 6, kind: 'chunk', messageId: 'm1', role: 'agent', text: 'x', truncated: false });
  // The same event arriving twice (a remount that re-reads, a duplicate delivery).
  const twice = applyAcpEvent(once, { sessionId: 'a1', seq: 6, kind: 'chunk', messageId: 'm1', role: 'agent', text: 'x', truncated: false });
  assert.equal(twice, once);
  assert.equal(twice.snapshot.messages[0].text, 'x');
  // An older event after a newer state is ignored instead of reordering the conversation.
  const stale = applyAcpEvent(twice, { sessionId: 'a1', seq: 5, kind: 'chunk', messageId: 'm1', role: 'agent', text: 'y', truncated: false });
  assert.equal(stale.snapshot.messages[0].text, 'x');
});

test('tool updates merge by call id and keep one entry per call', () => {
  const state = applyAcpEvent(undefined, { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ seq: 1 }) });
  const pending = applyAcpEvent(state, { sessionId: 'a1', seq: 2, kind: 'tool', call: { callId: 'c1', title: 'read_file', status: 'pending', detail: '' } });
  const running = applyAcpEvent(pending, { sessionId: 'a1', seq: 3, kind: 'tool', call: { callId: 'c1', title: 'read_file', status: 'in_progress', detail: 'src/a.ts' } });
  const done = applyAcpEvent(running, { sessionId: 'a1', seq: 4, kind: 'tool', call: { callId: 'c1', title: 'read_file', status: 'completed', detail: 'src/a.ts' } });
  assert.equal(done.snapshot.tools.length, 1);
  assert.equal(done.snapshot.tools[0].status, 'completed');
  assert.equal(done.snapshot.tools[0].detail, 'src/a.ts');
  const other = applyAcpEvent(done, { sessionId: 'a1', seq: 5, kind: 'tool', call: { callId: 'c2', title: 'write_file', status: 'pending', detail: '' } });
  assert.deepEqual(other.snapshot.tools.map((call) => call.callId), ['c1', 'c2']);
});

test('a permission card is bound to its request and disappears only when that request closes', () => {
  const state = applyAcpEvent(undefined, { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ seq: 1, state: 'waiting_permission' }) });
  const card = { requestId: 'r1', turnId: 't1', title: '写入 a.ts', detail: '1 文件', options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] };
  const asked = applyAcpEvent(state, { sessionId: 'a1', seq: 2, kind: 'permission', card });
  const second = applyAcpEvent(asked, { sessionId: 'a1', seq: 3, kind: 'permission', card: { ...card, requestId: 'r2' } });
  assert.deepEqual(second.snapshot.permissions.map((item) => item.requestId), ['r1', 'r2']);
  const closed = applyAcpEvent(second, { sessionId: 'a1', seq: 4, kind: 'permissionClosed', requestId: 'r1', decision: 'allow' });
  assert.deepEqual(closed.snapshot.permissions.map((item) => item.requestId), ['r2']);
});

test('two conversations never share a message, a card or a notice', () => {
  let a = applyAcpEvent(undefined, { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ id: 'a1', seq: 1 }) });
  let b = applyAcpEvent(undefined, { sessionId: 'a2', seq: 1, kind: 'snapshot', snapshot: snapshot({ id: 'a2', seq: 1 }) });
  a = applyAcpEvent(a, { sessionId: 'a1', seq: 2, kind: 'chunk', messageId: 'm-a', role: 'agent', text: 'alpha', truncated: false });
  b = applyAcpEvent(b, { sessionId: 'a2', seq: 2, kind: 'chunk', messageId: 'm-b', role: 'agent', text: 'beta', truncated: false });
  assert.deepEqual(a.snapshot.messages.map((message) => message.text), ['alpha']);
  assert.deepEqual(b.snapshot.messages.map((message) => message.text), ['beta']);
});

test('notices are bounded and never become conversation messages', () => {
  let state = applyAcpEvent(undefined, { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ seq: 1 }) });
  for (let index = 0; index < ACP_NOTICE_LIMIT + 5; index += 1) {
    state = applyAcpEvent(state, { sessionId: 'a1', seq: 2 + index, kind: 'notice', level: 'error', text: `第 ${index} 条` });
  }
  assert.equal(state.notices.length, ACP_NOTICE_LIMIT);
  assert.equal(state.notices[state.notices.length - 1].text, `第 ${ACP_NOTICE_LIMIT + 4} 条`);
  assert.equal(state.snapshot.messages.length, 0);
});

test('a batch folds in order and an unknown session is not invented', () => {
  const folded = applyAcpEvents(undefined, [
    { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ seq: 1 }) },
    { sessionId: 'a1', seq: 2, kind: 'chunk', messageId: 'm1', role: 'agent', text: 'a', truncated: false },
    { sessionId: 'a1', seq: 3, kind: 'chunk', messageId: 'm1', role: 'agent', text: 'b', truncated: false },
  ]);
  assert.equal(folded.snapshot.messages[0].text, 'ab');
  // A chunk with no snapshot behind it is not a conversation: the view reads the host instead.
  assert.equal(applyAcpEvent(undefined, { sessionId: 'a9', seq: 2, kind: 'chunk', messageId: 'm', role: 'agent', text: 'x', truncated: false }), null);
  // A snapshot that names another session is refused rather than filed under the wrong id.
  assert.equal(applyAcpEvent(undefined, { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ id: 'a2' }) }), null);
});

test('the rail row, liveness and the wording tables describe only what the host reported', () => {
  assert.equal(acpIsLive(snapshot({ state: 'running' })), true);
  assert.equal(acpIsLive(snapshot({ state: 'waiting_permission' })), true);
  assert.equal(acpIsLive(snapshot({ state: 'stopping' })), true);
  assert.equal(acpIsLive(snapshot({ state: 'closed' })), false);
  assert.equal(acpIsLive(snapshot({ state: 'failed' })), false);

  assert.equal(acpTurnActive(snapshot({ state: 'stopping' })), true);
  assert.equal(acpTurnActive(snapshot({ state: 'waiting_permission' })), false);
  assert.equal(acpTurnActive(snapshot({ state: 'ready' })), false);

  const live = acpRow(snapshot({ state: 'running' }));
  assert.deepEqual({ id: live.id, toolId: live.toolId, directory: live.directory, running: live.running, exitCode: live.exitCode }, { id: 'a1', toolId: 'codex', directory: 'C:/work', running: true, exitCode: null });
  // An ended conversation reports no exit code: a conversation has no process exit to show.
  assert.equal(acpRow(snapshot({ state: 'closed' })).running, false);
  assert.equal(acpRow(snapshot({ state: 'closed' })).exitCode, null);

  assert.equal(acpTurnKey(''), null);
  assert.equal(acpTurnKey('end_turn'), 'sessions.acpTurnEnd');
  assert.equal(acpTurnKey('limit'), 'sessions.acpTurnLimit');
  assert.equal(acpTurnKey('refusal'), 'sessions.acpTurnRefusal');
  assert.equal(acpTurnKey('cancelled'), 'sessions.acpTurnCancelled');
  assert.equal(acpTurnKey('disconnected'), 'sessions.acpTurnDisconnected');
  assert.equal(acpTurnKey('failed'), 'sessions.acpTurnFailed');
  assert.equal(acpTurnKey('unknown'), 'sessions.acpTurnUnknown');
  assert.equal(acpStateKey('waiting_permission'), 'sessions.acpStateWaiting');
  assert.equal(acpResumeKey('none'), null);
  assert.equal(acpResumeKey('loaded'), 'sessions.acpResumeLoaded');
  assert.equal(acpResumeKey('failed'), 'sessions.acpResumeFailed');
  assert.equal(acpResumeKey('unsupported'), 'sessions.acpResumeUnsupported');
});
