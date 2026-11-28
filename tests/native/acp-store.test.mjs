import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAcpEvent } from '../../src/features/sessions/acpSession.ts';
import { createAcpStore } from '../../src/features/sessions/acpStore.ts';

function snapshot(id, overrides = {}) {
  return {
    id, toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', interaction: 'acp',
    state: 'ready', nativeSessionId: 'native-1', resume: 'none', authError: null, timeline: [], pending: [], grants: [], terminals: [], plan: [], commands: [],
    config: { modes: null, options: [], models: null }, info: { title: null, updatedAt: null, usage: null },
    agent: {
      protocolVersion: 1, agentInfo: null, promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [],
    },
    diagnostics: [], lastTurnReason: '', seq: 1, ...overrides,
  };
}

function chunk(sessionId, seq, messageId, text) {
  return { sessionId, seq, kind: 'chunk', messageId, role: 'agent', text, truncated: false, turnId: 'turn-1', subagent: null };
}

/** A scheduler the test drives: `frame()` runs the flush the store asked for. */
function manualFrames() {
  let pending = null;
  let requested = 0;
  return {
    schedule(flush) {
      requested += 1;
      pending = flush;
      return () => { if (pending === flush) pending = null; };
    },
    frame() {
      const flush = pending;
      pending = null;
      flush?.();
    },
    get requested() { return requested; },
  };
}

function counter(store, id) {
  const calls = { count: 0 };
  store.subscribe(id, () => { calls.count += 1; });
  return calls;
}

test('events of one frame are folded together, once, exactly as one by one', () => {
  const frames = manualFrames();
  const store = createAcpStore({ schedule: frames.schedule });
  store.register(snapshot('a1', { seq: 1 }));
  const seen = counter(store, 'a1');
  const events = [
    chunk('a1', 2, 'm1', 'he'),
    chunk('a1', 3, 'm1', 'llo'),
    { sessionId: 'a1', seq: 4, kind: 'tool', call: { id: 'tool:c1', callId: 'c1', title: '读', toolKind: 'read', status: 'pending', content: [], locations: [], rawInput: null, turnId: 'turn-1', subagent: null, permission: null } },
    chunk('a1', 3, 'm1', 'llo'),
    chunk('a1', 2, 'm1', 'late'),
    { sessionId: 'a1', seq: 5, kind: 'item', item: { kind: 'turn', id: 'turn-1-end', turnId: 'turn-1', reason: 'end_turn' } },
    chunk('a1', 6, 'm2', '好'),
  ];
  for (const event of events) store.push(event);
  assert.equal(frames.requested, 1, '一帧只排一次');
  assert.equal(store.get('a1').snapshot.seq, 1, '帧到来前不应用');
  assert.equal(seen.count, 0);
  frames.frame();
  assert.equal(seen.count, 1, '一帧只通知一次');
  let expected = applyAcpEvent(undefined, { sessionId: 'a1', seq: 1, kind: 'snapshot', snapshot: snapshot('a1', { seq: 1 }) });
  for (const event of events) expected = applyAcpEvent(expected, event) ?? expected;
  assert.deepEqual(store.get('a1').snapshot, expected.snapshot);
  assert.deepEqual(store.get('a1').snapshot.timeline.map((item) => item.id), ['m1', 'tool:c1', 'turn-1-end', 'm2']);
  assert.equal(store.get('a1').snapshot.timeline[0].text, 'hello');
});

test('only the subscribers of an updated session are notified', () => {
  const frames = manualFrames();
  const store = createAcpStore({ schedule: frames.schedule });
  store.register(snapshot('a1'));
  store.register(snapshot('a2'));
  const one = counter(store, 'a1');
  const two = counter(store, 'a2');
  let summaries = 0;
  store.subscribeSummaries(() => { summaries += 1; });
  const before = store.summaries();
  const quiet = store.get('a2');
  store.push(chunk('a1', 2, 'm1', 'x'));
  store.push(chunk('a1', 3, 'm1', 'y'));
  frames.frame();
  assert.equal(one.count, 1);
  assert.equal(two.count, 0, '未更新的会话不通知');
  assert.equal(store.get('a2'), quiet, '未更新的会话对象不变');
  assert.equal(summaries, 0, '流式输出不改变摘要');
  assert.equal(store.summaries(), before, '摘要引用不变');
  // A repeated event changes nothing and notifies no one.
  store.push(chunk('a1', 3, 'm1', 'y'));
  frames.frame();
  assert.equal(one.count, 1);
  // A state or title change reaches the summary subscribers.
  store.push({ sessionId: 'a2', seq: 2, kind: 'info', info: { title: '修复登录', updatedAt: null, usage: null } });
  store.push({ sessionId: 'a2', seq: 3, kind: 'pending', pending: ['r1'] });
  frames.frame();
  assert.equal(two.count, 1);
  assert.equal(one.count, 1);
  assert.equal(summaries, 1);
  assert.notEqual(store.summaries(), before);
  assert.deepEqual(store.summaries().get('a2'), { id: 'a2', toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', state: 'ready', pendingCount: 1, title: '修复登录' });
  assert.equal(store.summaries().get('a1'), before.get('a1'), '其他会话的摘要对象沿用');
});

test('a register applies the earlier buffered events first and keeps a newer conversation', () => {
  const frames = manualFrames();
  const store = createAcpStore({ schedule: frames.schedule });
  store.register(snapshot('a1', { seq: 1 }));
  store.push(chunk('a1', 5, 'm1', '新'));
  // An older read arrives after the events: the folded newer state stays.
  store.register(snapshot('a1', { seq: 3 }));
  assert.equal(store.get('a1').snapshot.seq, 5);
  assert.equal(store.get('a1').snapshot.timeline[0].text, '新');
  frames.frame();
  assert.equal(store.get('a1').snapshot.seq, 5, '缓冲区已在注册时清空');
  store.register(snapshot('a1', { seq: 9 }));
  assert.equal(store.get('a1').snapshot.seq, 9);
  assert.deepEqual(store.get('a1').snapshot.timeline, []);
});

test('an unknown session is known only through a snapshot', () => {
  const frames = manualFrames();
  const store = createAcpStore({ schedule: frames.schedule });
  store.push(chunk('a9', 2, 'm', 'x'));
  assert.equal(store.known('a9'), false);
  frames.frame();
  assert.equal(store.has('a9'), false, '片段不凭空建立会话');
  store.push({ sessionId: 'a9', seq: 3, kind: 'snapshot', snapshot: snapshot('a9', { seq: 3 }) });
  assert.equal(store.known('a9'), true, '缓冲区中的快照算作已知');
  assert.equal(store.has('a9'), false);
  frames.frame();
  assert.equal(store.has('a9'), true);
  assert.equal(store.summaries().get('a9').id, 'a9');
});

test('a retired session is deleted and never comes back', () => {
  const frames = manualFrames();
  const store = createAcpStore({ schedule: frames.schedule });
  store.register(snapshot('a1'));
  store.register(snapshot('a2'));
  const one = counter(store, 'a1');
  let summaries = 0;
  store.subscribeSummaries(() => { summaries += 1; });
  store.push(chunk('a1', 2, 'm1', '缓冲中'));
  store.retire('a1');
  assert.equal(store.get('a1'), undefined);
  assert.equal(store.has('a1'), false);
  assert.equal(store.summaries().has('a1'), false);
  assert.equal(store.retired('a1'), true);
  assert.equal(one.count, 1, '订阅者得知会话已删除');
  assert.equal(summaries, 1);
  frames.frame();
  assert.equal(store.get('a1'), undefined, '缓冲的事件随会话一起丢弃');
  // A late list read, a late snapshot event or chunk does not put it back.
  store.register(snapshot('a1', { seq: 9 }));
  store.push({ sessionId: 'a1', seq: 10, kind: 'snapshot', snapshot: snapshot('a1', { seq: 10 }) });
  frames.frame();
  assert.equal(store.has('a1'), false);
  assert.deepEqual([...store.summaries().keys()], ['a2']);
  // Retiring what was never held only marks it.
  const quiet = store.summaries();
  store.retire('a7');
  assert.equal(store.summaries(), quiet);
});

test('the default scheduler flushes without a frame', async () => {
  const store = createAcpStore();
  store.register(snapshot('a1'));
  store.push(chunk('a1', 2, 'm1', 'x'));
  // Node has no animation frames: the fallback timer drains the buffer.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(store.get('a1').snapshot.timeline[0].text, 'x');
  store.dispose();
});
