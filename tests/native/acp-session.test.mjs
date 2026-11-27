import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acpCardAnswerable,
  acpIsLive,
  acpNeedsLogin,
  acpOpenAccesses,
  acpOpenElicitations,
  acpProtocolLoginMethods,
  acpPendingCount,
  acpResumeKey,
  acpRow,
  acpStateKey,
  acpTerminal,
  acpTurnActive,
  acpTurnKey,
  applyAcpEvent,
  applyAcpEvents,
} from '../../src/features/sessions/acpSession.ts';
import { launchInteraction, preferredYoloAvailable } from '../../src/types/native.ts';

function snapshot(overrides = {}) {
  return {
    id: 'a1', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', interaction: 'acp',
    state: 'ready', nativeSessionId: 'native-1', resume: 'none', authError: null, timeline: [], pending: [], grants: [], terminals: [], plan: [], commands: [],
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
    { kind: 'terminal', terminal: { terminalId: 't9', command: 'x', cwd: 'C:/work', output: '', truncated: false, exitStatus: null, released: false, subagent: null } },
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

function terminal(id, overrides = {}) {
  return { terminalId: id, command: 'npm test', cwd: 'C:/work', output: '', truncated: false, exitStatus: null, released: false, subagent: null, ...overrides };
}

function output(seq, terminalId, text, extra = {}) {
  return { sessionId: 'a1', seq, kind: 'terminalOutput', terminalId, text, dropped: 0, truncated: false, exitStatus: null, released: false, ...extra };
}

test('terminal output appends in order, drops exactly what the host dropped and reports exit and release', () => {
  let state = start();
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 2, kind: 'terminal', terminal: terminal('t1') });
  state = applyAcpEvent(state, output(3, 't1', 'hello '));
  state = applyAcpEvent(state, output(4, 't1', 'world'));
  assert.equal(acpTerminal(state.snapshot, 't1').output, 'hello world');
  // The host kept a bounded tail: the view drops the same head after appending.
  state = applyAcpEvent(state, output(5, 't1', '中文!', { dropped: 6, truncated: true }));
  assert.equal(acpTerminal(state.snapshot, 't1').output, 'world中文!');
  assert.equal(acpTerminal(state.snapshot, 't1').truncated, true);
  // A repeated sequence number is not appended twice.
  assert.equal(applyAcpEvent(state, output(5, 't1', '中文!', { dropped: 6, truncated: true })), state);
  state = applyAcpEvent(state, output(6, 't1', '', { exitStatus: { exitCode: 0, signal: null }, truncated: true }));
  assert.deepEqual(acpTerminal(state.snapshot, 't1').exitStatus, { exitCode: 0, signal: null });
  state = applyAcpEvent(state, output(7, 't1', '', { truncated: true, released: true }));
  const released = acpTerminal(state.snapshot, 't1');
  assert.equal(released.released, true);
  assert.deepEqual(released.exitStatus, { exitCode: 0, signal: null }, '释放不抹掉退出码');
  assert.equal(released.output, 'world中文!', '释放后输出仍可读');
  // Output for a terminal the view never saw waits for the next snapshot.
  state = applyAcpEvent(state, output(8, 'ghost', 'x'));
  assert.equal(acpTerminal(state.snapshot, 'ghost'), null);
  assert.equal(state.snapshot.seq, 8);
  // Terminals never enter the timeline.
  assert.equal(state.snapshot.timeline.length, 0);
});

test('an approval card is open only while its request id is pending', () => {
  const access = { kind: 'access', id: 'access-1', accessKind: 'read', path: 'C:/other/a.txt', detail: null, decision: 'pending', requestId: 'access-1-request', diff: null, turnId: 'turn-1', subagent: null };
  let state = start({ state: 'running' });
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 2, kind: 'item', item: access });
  assert.deepEqual(acpOpenAccesses(state.snapshot), [], '没有进入 pending 的卡不可回答');
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 3, kind: 'pending', pending: ['access-1-request'] });
  assert.deepEqual(acpOpenAccesses(state.snapshot).map((item) => item.id), ['access-1']);
  assert.equal(acpPendingCount(state.snapshot), 1, '审批卡计入等你处理');
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 4, kind: 'item', item: { ...access, decision: 'allowed_session', requestId: null } });
  state = applyAcpEvent(state, { sessionId: 'a1', seq: 5, kind: 'pending', pending: [] });
  assert.deepEqual(acpOpenAccesses(state.snapshot), []);
  assert.deepEqual(ids(state), ['access:access-1'], '审批记录原位更新，不重复');
  assert.equal(state.snapshot.timeline[0].decision, 'allowed_session');
});

test('every launch entry point reads YOLO from the interaction the launch will actually get', () => {
  // The terminal has no YOLO arguments, the ACP entry declares the client form.
  const tool = { id: 'cline', launchForm: 'terminal', yoloAvailable: false, acp: { state: 'supported', entry: { executable: 'cline', args: ['--acp'], origin: 'native', yolo: { kind: 'client' } } } };
  const acp = { interaction: 'acp', interactionError: null };
  const terminal = { interaction: 'terminal', interactionError: null };
  assert.equal(launchInteraction(tool, acp), 'acp');
  assert.equal(preferredYoloAvailable(tool, acp), true, '新的本地会话按 ACP 入口的 YOLO 声明');
  assert.equal(preferredYoloAvailable(tool, terminal), false, '终端启动按终端 YOLO 参数');
  // A resume and a remote session run in a terminal, as the backend decides.
  assert.equal(launchInteraction(tool, acp, { resume: true }), 'terminal');
  assert.equal(preferredYoloAvailable(tool, acp, { resume: true }), false);
  assert.equal(preferredYoloAvailable(tool, acp, { remote: true }), false);
  // An unreadable stored preference, a desktop app and a missing tool fall back to the terminal.
  assert.equal(launchInteraction(tool, { interaction: 'acp', interactionError: 'bad' }), 'terminal');
  assert.equal(launchInteraction({ ...tool, launchForm: 'desktop' }, acp), 'terminal');
  assert.equal(preferredYoloAvailable(undefined, acp), false);
  // An ACP entry without a YOLO declaration keeps YOLO off even when the terminal has it.
  const undeclared = { ...tool, yoloAvailable: true, acp: { state: 'supported', entry: { executable: 'cline', args: [], origin: 'native' } } };
  assert.equal(preferredYoloAvailable(undeclared, acp), false);
  assert.equal(preferredYoloAvailable(undeclared, acp, { resume: true }), true);
});

test('an elicitation form is an item in place and counts as pending only while open', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
  const form = (decision, requestId) => ({
    kind: 'elicitation', id: 'elicitation-3', message: '怎么称呼你？', requestedSchema: schema, toolCallId: null,
    decision, requestId, turnId: 'turn-1', subagent: null,
  });
  const begun = applyAcpEvent(start({ state: 'running' }), chunk(2, 'm1', '先问一下'));
  const asked = applyAcpEvents(begun, [
    { sessionId: 'a1', seq: 3, kind: 'item', item: form('pending', 'elicitation-3-request') },
    { sessionId: 'a1', seq: 4, kind: 'pending', pending: ['elicitation-3-request'] },
  ]);
  assert.deepEqual(ids(asked), ['message:m1', 'elicitation:elicitation-3']);
  assert.equal(acpPendingCount(asked.snapshot), 1);
  assert.deepEqual(acpOpenElicitations(asked.snapshot).map((item) => item.id), ['elicitation-3']);
  assert.equal(acpCardAnswerable(asked.snapshot, 'elicitation-3-request'), true);
  // Answered (or withdrawn): replaced in place, no longer open or answerable.
  const answered = applyAcpEvents(asked, [
    { sessionId: 'a1', seq: 5, kind: 'item', item: form('withdrawn', null) },
    { sessionId: 'a1', seq: 6, kind: 'pending', pending: [] },
  ]);
  assert.deepEqual(ids(answered), ['message:m1', 'elicitation:elicitation-3']);
  assert.equal(answered.snapshot.timeline[1].decision, 'withdrawn');
  assert.deepEqual(acpOpenElicitations(answered.snapshot), []);
  assert.equal(acpCardAnswerable(answered.snapshot, 'elicitation-3-request'), false);
  // A replayed older event never reopens it.
  const replayed = applyAcpEvent(answered, { sessionId: 'a1', seq: 3, kind: 'item', item: form('pending', 'elicitation-3-request') });
  assert.equal(replayed.snapshot.timeline[1].decision, 'withdrawn');
});

test('a session waiting for a login offers only protocol methods and reads as waiting', () => {
  const waiting = start({
    state: 'auth_required', nativeSessionId: null, authError: 'Authentication required',
    agent: { ...snapshot().agent, authMethods: [
      { id: 'login', name: '浏览器登录', description: null, type: 'agent' },
      { id: 'tty', name: '终端登录', description: null, type: 'terminal' },
    ] },
  });
  assert.equal(acpNeedsLogin(waiting.snapshot), true);
  assert.equal(acpIsLive(waiting.snapshot), true);
  assert.equal(acpTurnActive(waiting.snapshot), false);
  assert.deepEqual(acpProtocolLoginMethods(waiting.snapshot).map((method) => method.id), ['login']);
  assert.equal(acpStateKey('auth_required'), 'sessions.acpStateLogin');
  const ready = applyAcpEvent(waiting, { sessionId: 'a1', seq: 2, kind: 'snapshot', snapshot: snapshot({ seq: 2 }) });
  assert.equal(acpNeedsLogin(ready.snapshot), false);
  assert.equal(ready.snapshot.authError, null);
});

test('a resume without replay is worded apart from a replayed load', () => {
  assert.equal(acpResumeKey('resumed'), 'sessions.acpResumeResumed');
  assert.equal(acpResumeKey('loaded'), 'sessions.acpResumeLoaded');
  assert.equal(acpResumeKey('none'), null);
});

test('a user message keeps its attachment labels and a chunk-created message has none', () => {
  const labels = [{ type: 'file', name: 'src/main.rs', delivery: 'embedded' }, { type: 'image', name: 'image/png', delivery: null }];
  const sent = applyAcpEvent(start(), {
    sessionId: 'a1', seq: 2, kind: 'item',
    item: { kind: 'message', id: 'turn-2-user', role: 'user', text: '看看', truncated: false, turnId: 'turn-2', subagent: null, attachments: labels },
  });
  assert.deepEqual(sent.snapshot.timeline[0].attachments, labels);
  const replied = applyAcpEvent(sent, chunk(3, 'm9', '好的'));
  assert.equal(replied.snapshot.timeline[1].attachments, undefined);
});
