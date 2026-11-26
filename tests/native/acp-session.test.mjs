import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acpCardAnswerable,
  acpIsLive,
  acpPendingCount,
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
    state: 'ready', nativeSessionId: 'native-1', resume: 'none', timeline: [], pending: [], plan: [], commands: [],
    config: { modes: null, options: [], models: null }, info: { title: null, updatedAt: null, usage: null },
    agent: {
      protocolVersion: 1, agentInfo: null, promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [],
    },
    diagnostics: [], lastTurnReason: '', seq: 1, ...overrides,
  };
}

function chunk(seq, messageId, text, extra = {}) {
  return { sessionId: 'a1', seq, kind: 'chunk', messageId, role: 'agent', text, truncated: false, turnId: 'turn-1', subagent: null, ...extra };
}

function tool(id, overrides = {}) {
  return {
    id: `tool:${id}`, callId: id, title: id, toolKind: 'other', status: 'pending', content: [], locations: [], rawInput: null,
    turnId: 'turn-1', subagent: null, permission: null, ...overrides,
  };
}

function start(overrides = {}) {
  return applyAcpEvent(undefined, { sessionId: 'a1', seq: overrides.seq ?? 1, kind: 'snapshot', snapshot: snapshot(overrides) });
}

const ids = (state) => state.snapshot.timeline.map((item) => `${item.kind}:${item.id}`);

test('a snapshot replaces the whole conversation and a chunk appends to exactly one message', () => {
  const first = start({ seq: 5 });
  assert.equal(first.snapshot.seq, 5);
  const one = applyAcpEvent(first, chunk(6, 'm1', 'he'));
  const two = applyAcpEvent(one, chunk(7, 'm1', 'llo'));
  assert.equal(two.snapshot.timeline.length, 1);
  assert.equal(two.snapshot.timeline[0].kind, 'message');
  assert.equal(two.snapshot.timeline[0].text, 'hello');
  assert.equal(two.snapshot.timeline[0].turnId, 'turn-1');
  assert.equal(two.snapshot.seq, 7);
  // A later snapshot is the truth: it replaces whatever the view folded.
  const replaced = applyAcpEvent(two, { sessionId: 'a1', seq: 8, kind: 'snapshot', snapshot: snapshot({ seq: 8 }) });
  assert.deepEqual(replaced.snapshot.timeline, []);
});

test('an event already applied, or older than the snapshot, is not replayed', () => {
  const state = start({ seq: 5 });
  const once = applyAcpEvent(state, chunk(6, 'm1', 'x'));
  const twice = applyAcpEvent(once, chunk(6, 'm1', 'x'));
  assert.equal(twice, once);
  assert.equal(twice.snapshot.timeline[0].text, 'x');
  const stale = applyAcpEvent(twice, chunk(5, 'm1', 'y'));
  assert.equal(stale.snapshot.timeline[0].text, 'x');
  // Every kind obeys the same rule.
  for (const event of [
    { kind: 'tool', call: tool('c1') },
    { kind: 'item', item: { kind: 'notice', id: 'n1', level: 'info', code: '', text: 'x', turnId: '' } },
    { kind: 'plan', entries: [{ content: 'x', priority: 'low', status: 'pending' }] },
    { kind: 'commands', commands: [{ name: 'x', description: '', hint: null }] },
    { kind: 'config', config: { modes: { currentModeId: 'x', availableModes: [] }, options: [], models: null } },
    { kind: 'info', info: { title: 'x', updatedAt: null, usage: null } },
    { kind: 'pending', pending: ['r1'] },
  ]) {
    assert.equal(applyAcpEvent(once, { sessionId: 'a1', seq: 6, ...event }), once, `${event.kind} 的重复序号必须忽略`);
  }
});

test('replies and tools keep their arrival order and a tool update merges in place', () => {
  let state = start();
  state = applyAcpEvents(state, [
    chunk(2, 'reply-1', '先读文件。'),
    { sessionId: 'a1', seq: 3, kind: 'tool', call: tool('A', { title: '读取', toolKind: 'read', status: 'in_progress' }) },
    chunk(4, 'reply-2', '接着改。'),
    { sessionId: 'a1', seq: 5, kind: 'tool', call: tool('A', { title: '读取', toolKind: 'read', status: 'completed', content: [{ type: 'text', text: '内容', truncated: false }] }) },
    { sessionId: 'a1', seq: 6, kind: 'tool', call: tool('B', { toolKind: 'edit' }) },
  ]);
  assert.deepEqual(ids(state), ['message:reply-1', 'tool:tool:A', 'message:reply-2', 'tool:tool:B']);
  const merged = state.snapshot.timeline[1];
  assert.equal(merged.status, 'completed');
  assert.equal(merged.toolKind, 'read');
  assert.deepEqual(merged.content, [{ type: 'text', text: '内容', truncated: false }]);
  // A chunk for a message that already stands merges where it stands.
  state = applyAcpEvent(state, chunk(7, 'reply-1', '（补充）'));
  assert.deepEqual(ids(state), ['message:reply-1', 'tool:tool:A', 'message:reply-2', 'tool:tool:B']);
  assert.equal(state.snapshot.timeline[0].text, '先读文件。（补充）');
});

test('a generic item is inserted once and replaced in place', () => {
  let state = start();
  state = applyAcpEvent(state, chunk(2, 'm1', 'a'));
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 3, kind: 'item', item: { kind: 'subagent', id: 'subagent:c1', sessionId: 'c1', parent: null, title: '排查', description: null, state: 'running', stopReason: null, summary: '', turnId: 'turn-1' } });
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 4, kind: 'item', item: { kind: 'turn', id: 'turn-1-end', turnId: 'turn-1', reason: 'end_turn' } });
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 5, kind: 'item', item: { kind: 'subagent', id: 'subagent:c1', sessionId: 'c1', parent: null, title: '排查', description: null, state: 'idle', stopReason: 'end_turn', summary: '完成', turnId: 'turn-1' } });
  assert.deepEqual(ids(state), ['message:m1', 'subagent:subagent:c1', 'turn:turn-1-end']);
  assert.equal(state.snapshot.timeline[1].state, 'idle');
  // A malformed item is not filed anywhere.
  assert.equal(applyAcpEvent(state, { sessionId: 'a1', seq: 6, kind: 'item', item: { kind: 'notice' } }), state);
});

test('plan, commands, config and info replace their own field', () => {
  let state = start();
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 2, kind: 'plan', entries: [{ content: '读', priority: 'high', status: 'completed' }, { content: '改', priority: 'medium', status: 'in_progress' }] });
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 3, kind: 'plan', entries: [{ content: '只剩一步', priority: 'low', status: 'pending' }] });
  assert.deepEqual(state.snapshot.plan.map((entry) => entry.content), ['只剩一步']);
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 4, kind: 'plan', entries: [] });
  assert.deepEqual(state.snapshot.plan, []);
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 5, kind: 'commands', commands: [{ name: 'review', description: '审查', hint: null }] });
  assert.equal(state.snapshot.commands[0].name, 'review');
  const config = { modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: '编码', description: null }] }, options: [], models: null };
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 6, kind: 'config', config });
  assert.equal(state.snapshot.config.modes.currentModeId, 'code');
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 7, kind: 'info', info: { title: '修复登录', updatedAt: null, usage: { used: 10, size: 100, cost: null } } });
  assert.equal(state.snapshot.info.title, '修复登录');
  assert.equal(state.snapshot.info.usage.used, 10);
  assert.equal(state.snapshot.timeline.length, 0, '这些字段都不进入时间线');
});

test('pending decides which cards are answerable and what asks for attention', () => {
  const card = { requestId: 'r1', turnId: 'turn-1', options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] };
  let state = start({ state: 'running' });
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 2, kind: 'tool', call: tool('w', { title: '写入 a.ts', permission: card }) });
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 3, kind: 'pending', pending: ['r1'] });
  assert.equal(acpCardAnswerable(state.snapshot, 'r1'), true);
  assert.equal(acpPendingCount(state.snapshot), 1);
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 4, kind: 'pending', pending: [] });
  assert.equal(acpCardAnswerable(state.snapshot, 'r1'), false, '撤回后的卡不可再回答');
  assert.equal(acpPendingCount(state.snapshot), 0);
  // A closed conversation asks nothing even if a stale id lingers.
  const closed = start({ state: 'closed', pending: ['r9'] });
  assert.equal(acpPendingCount(closed.snapshot), 0);
  assert.equal(acpCardAnswerable(closed.snapshot, 'r9'), false);
});

test('two conversations never share a message, a card or a notice', () => {
  let a = applyAcpEvent(undefined, { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ id: 'a1', seq: 1 }) });
  let b = applyAcpEvent(undefined, { sessionId: 'a2', seq: 1, kind: 'snapshot', snapshot: snapshot({ id: 'a2', seq: 1 }) });
  a = applyAcpEvent(a, chunk(2, 'm-a', 'alpha'));
  b = applyAcpEvent(b, { ...chunk(2, 'm-b', 'beta'), sessionId: 'a2' });
  assert.deepEqual(a.snapshot.timeline.map((item) => item.text), ['alpha']);
  assert.deepEqual(b.snapshot.timeline.map((item) => item.text), ['beta']);
});

test('a batch folds in order and an unknown session is not invented', () => {
  const folded = applyAcpEvents(undefined, [
    { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot({ seq: 1 }) },
    chunk(2, 'm1', 'a'),
    chunk(3, 'm1', 'b'),
  ]);
  assert.equal(folded.snapshot.timeline[0].text, 'ab');
  assert.equal(applyAcpEvent(undefined, { ...chunk(2, 'm', 'x'), sessionId: 'a9' }), null);
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
