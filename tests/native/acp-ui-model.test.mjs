import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUPABLE_TOOL_KINDS,
  agentHeadIds,
  buildSegments,
  createSegmentBuilder,
  groupIdByItem,
  stepSummaryShown,
  groupTimelineItems,
  isGroupableTool,
  segmentKey,
  segmentOptions,
  summarizeToolGroupKinds,
  toolGroupIdByItem,
} from '../../src/features/sessions/acp/timelineModel.ts';
import {
  searchAcpTimeline,
  splitMatchRuns,
} from '../../src/features/sessions/acp/acpSearch.ts';
import { acpSettings, composerPlaceholder, settingLabel } from '../../src/features/sessions/acp/composerModel.ts';
import { formatTokens, usageLevel } from '../../src/features/sessions/acp/acpView.ts';
import { toolBodyPropsEqual, toolBodySnapshotEqual } from '../../src/features/sessions/acp/acpRenderCache.ts';

function toolItem(id, overrides = {}) {
  return {
    kind: 'tool',
    id: `tool:${id}`,
    callId: id,
    title: `Tool ${id}`,
    toolKind: 'read',
    status: 'completed',
    content: [],
    locations: [],
    rawInput: null,
    turnId: 'turn-1',
    subagent: null,
    permission: null,
    ...overrides,
  };
}

function messageItem(id, text, overrides = {}) {
  return {
    kind: 'message',
    id,
    role: 'agent',
    text,
    truncated: false,
    turnId: 'turn-1',
    subagent: null,
    ...overrides,
  };
}

function makeSnapshot(timeline, extra = {}) {
  return {
    id: 'acp-1',
    toolId: 'codex',
    projectId: null,
    directory: '/work/repo',
    mode: 'normal',
    interaction: 'acp',
    state: 'ready',
    nativeSessionId: 'native-1',
    resume: 'none',
    authError: null,
    timeline,
    pending: [],
    grants: [],
    terminals: [],
    plan: [],
    commands: [],
    config: { modes: null, options: [], models: null },
    info: { title: null, updatedAt: null, usage: null },
    agent: {
      protocolVersion: 1,
      agentInfo: null,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { list: false, resume: false, delete: false, close: false },
      loadSession: false,
      authMethods: [],
    },
    diagnostics: [],
    lastTurnReason: '',
    seq: 1,
    ...extra,
  };
}

test('isGroupableTool allows only completed lightweight tools without diff, terminal, or permission', () => {
  assert.deepEqual([...GROUPABLE_TOOL_KINDS].sort(), ['fetch', 'other', 'read', 'search', 'think']);

  for (const toolKind of ['read', 'search', 'fetch', 'think', 'other']) {
    assert.equal(
      isGroupableTool(toolItem(toolKind, {
        toolKind,
        content: [
          { type: 'text', text: 'ok', truncated: false },
          { type: 'image', mimeType: 'image/png' },
          { type: 'session', sessionId: 'child-1' },
        ],
      })),
      true,
      `${toolKind} completed lightweight tool should be groupable`,
    );
  }

  for (const toolKind of ['edit', 'delete', 'move', 'execute', 'switch_mode']) {
    assert.equal(isGroupableTool(toolItem(toolKind, { toolKind })), false, `${toolKind} must never be grouped`);
  }

  for (const status of ['pending', 'in_progress', 'failed']) {
    assert.equal(isGroupableTool(toolItem(status, { status })), false, `${status} tool must never be grouped`);
  }

  assert.equal(
    isGroupableTool(toolItem('with-diff', {
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b', truncated: false }],
    })),
    false,
  );
  assert.equal(
    isGroupableTool(toolItem('with-term', {
      content: [{ type: 'terminal', terminalId: 'term-1' }],
    })),
    false,
  );
  assert.equal(
    isGroupableTool(toolItem('with-perm', {
      permission: { requestId: 'req-1', turnId: 'turn-1', options: [{ optionId: 'o1', name: 'Allow', kind: 'allow_once' }] },
    })),
    false,
  );
});

test('groupTimelineItems collapses consecutive >= 2 lightweight tools in the same turn and subagent, keeping singletons standalone', () => {
  assert.deepEqual(groupTimelineItems([]), []);

  const m1 = messageItem('m1', 'Checking files');
  const solo = toolItem('solo', { toolKind: 'read' });
  const m2 = messageItem('m2', 'Continuing');
  const r1 = toolItem('r1', { toolKind: 'read' });
  const s1 = toolItem('s1', { toolKind: 'search' });
  const r2 = toolItem('r2', { toolKind: 'read' });
  const f1 = toolItem('f1', { toolKind: 'fetch' });
  const m3 = messageItem('m3', 'Done');

  const segments = groupTimelineItems([m1, solo, m2, r1, s1, r2, f1, m3]);
  assert.equal(segments.length, 5);
  assert.equal(segments[0].kind, 'item');
  assert.equal(segments[1].kind, 'item');
  assert.equal(segments[1].item.id, 'tool:solo');
  assert.equal(segments[2].kind, 'item');
  assert.equal(segments[3].kind, 'toolGroup');
  assert.equal(segments[3].id, 'tool-group:tool:r1');
  assert.equal(segments[3].turnId, 'turn-1');
  assert.equal(segments[3].subagent, null);
  assert.deepEqual(segments[3].items.map((item) => item.id), ['tool:r1', 'tool:s1', 'tool:r2', 'tool:f1']);
  assert.deepEqual(segments[3].kindCounts, [
    { kind: 'read', count: 2 },
    { kind: 'search', count: 1 },
    { kind: 'fetch', count: 1 },
  ]);
  assert.equal(segments[4].kind, 'item');

  // Appending another completed lightweight tool keeps the group id stable.
  const t1 = toolItem('t1', { toolKind: 'think' });
  const extended = groupTimelineItems([m1, solo, m2, r1, s1, r2, f1, t1, m3]);
  assert.equal(extended[3].kind, 'toolGroup');
  assert.equal(extended[3].id, 'tool-group:tool:r1');
  assert.equal(extended[3].items.length, 5);

  const byItem = toolGroupIdByItem(segments);
  assert.equal(byItem.get('tool:solo'), undefined);
  assert.equal(byItem.get('tool:r1'), 'tool-group:tool:r1');
  assert.equal(byItem.get('tool:f1'), 'tool-group:tool:r1');
  assert.deepEqual(summarizeToolGroupKinds([r1, s1, r2]), [
    { kind: 'read', count: 2 },
    { kind: 'search', count: 1 },
  ]);
});

test('groupTimelineItems splits on turn boundaries, subagent boundaries, and non-groupable tools', () => {
  const a1 = toolItem('a1', { turnId: 'turn-1', subagent: null });
  const a2 = toolItem('a2', { turnId: 'turn-2', subagent: null });
  const crossTurn = groupTimelineItems([a1, a2]);
  assert.deepEqual(crossTurn.map((seg) => seg.kind), ['item', 'item']);

  const subNull = toolItem('sn', { turnId: 'turn-1', subagent: null });
  const sub1a = toolItem('s1a', { turnId: 'turn-1', subagent: 'child-1', toolKind: 'search' });
  const sub1b = toolItem('s1b', { turnId: 'turn-1', subagent: 'child-1', toolKind: 'read' });
  const sub2 = toolItem('s2', { turnId: 'turn-1', subagent: 'child-2', toolKind: 'read' });
  const bySubagent = groupTimelineItems([subNull, sub1a, sub1b, sub2]);
  assert.equal(bySubagent.length, 3);
  assert.equal(bySubagent[0].kind, 'item');
  assert.equal(bySubagent[1].kind, 'toolGroup');
  assert.equal(bySubagent[1].subagent, 'child-1');
  assert.deepEqual(bySubagent[1].items.map((item) => item.id), ['tool:s1a', 'tool:s1b']);
  assert.equal(bySubagent[2].kind, 'item');

  // Interrupting tools (in_progress, failed, edit, diff, terminal, permission) break runs and stay standalone.
  const r1 = toolItem('r1');
  const r2 = toolItem('r2');
  const edit = toolItem('e1', { toolKind: 'edit' });
  const r3 = toolItem('r3');
  const running = toolItem('run', { status: 'in_progress' });
  const r4 = toolItem('r4');
  const r5 = toolItem('r5');
  const split = groupTimelineItems([r1, r2, edit, r3, running, r4, r5]);
  assert.deepEqual(
    split.map((seg) => (seg.kind === 'toolGroup' ? `group:${seg.items.length}` : `item:${seg.item.id}`)),
    ['group:2', 'item:tool:e1', 'item:tool:r3', 'item:tool:run', 'group:2'],
  );

  // If a middle tool in a 3-tool run later gains a diff, it immediately detaches and leaves two singletons.
  const promoted = groupTimelineItems([
    toolItem('p1'),
    toolItem('p2', { content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y', truncated: false }] }),
    toolItem('p3'),
  ]);
  assert.deepEqual(promoted.map((seg) => seg.kind), ['item', 'item', 'item']);
});

test('searchAcpTimeline searches all visible timeline items in order with case sensitivity and groupId', () => {
  const timeline = [
    messageItem('m-user', 'Find Alpha in project', {
      role: 'user',
      attachments: [{ type: 'file', name: 'alpha-notes.md', delivery: 'embedded' }],
    }),
    messageItem('m-thought', 'Thinking about alpha strategy', { role: 'thought' }),
    toolItem('g1', {
      title: 'Read alpha config',
      toolKind: 'read',
      rawInput: '{"path":"alpha.json"}',
      content: [{ type: 'text', text: 'alpha value here', truncated: false }],
      locations: [{ path: 'src/alpha.ts', line: 12 }],
    }),
    toolItem('g2', {
      title: 'Search ALPHA references',
      toolKind: 'search',
      content: [{ type: 'text', text: 'second grouped hit', truncated: false }],
    }),
    toolItem('edit-1', {
      title: 'Update file',
      toolKind: 'edit',
      content: [
        {
          type: 'diff',
          path: 'src/alpha-diff.ts',
          oldText: 'const shared = "alpha";\nconst oldAlpha = 1;',
          newText: 'const shared = "alpha";\nconst newAlpha = 2;',
          truncated: false,
        },
        { type: 'terminal', terminalId: 'term-1' },
      ],
    }),
    {
      kind: 'access',
      id: 'acc-1',
      accessKind: 'execute',
      path: '/outside/alpha-dir',
      detail: 'run alpha-check --verbose',
      decision: 'allowed_once',
      requestId: null,
      diff: {
        path: '/outside/alpha-dir',
        oldText: 'before alpha',
        newText: 'after beta',
        truncated: false,
        previousOmitted: false,
      },
      turnId: 'turn-1',
      subagent: null,
      userPath: null,
    },
    {
      kind: 'notice',
      id: 'notice-1',
      level: 'info',
      code: '',
      text: 'Notice about Alpha rate limit',
      turnId: 'turn-1',
    },
    {
      kind: 'subagent',
      id: 'sub-1',
      sessionId: 'child-1',
      parent: null,
      title: 'Subtask alpha',
      description: 'Inspect alpha module',
      state: 'idle',
      stopReason: 'end_turn',
      summary: 'Alpha looks clean',
      turnId: 'turn-1',
    },
    {
      kind: 'elicitation',
      id: 'elic-1',
      message: 'Confirm alpha environment?',
      requestedSchema: {
        type: 'object',
        properties: {
          env: { type: 'string', title: 'Alpha target', description: 'Pick environment' },
        },
      },
      toolCallId: null,
      decision: 'pending',
      requestId: 'req-elic',
      turnId: 'turn-1',
      subagent: null,
    },
    { kind: 'turn', id: 'turn-end-1', turnId: 'turn-1', reason: 'end_turn' },
  ];

  const snapshot = makeSnapshot(timeline, {
    pending: ['req-elic'],
    terminals: [
      {
        terminalId: 'term-1',
        command: 'echo alpha',
        cwd: '/work/repo',
        output: '\u001b[32malpha\u001b[0m terminal output\r\n',
        truncated: false,
        exitStatus: { exitCode: 0, signal: null },
        released: false,
        subagent: null,
      },
    ],
  });

  // Empty or whitespace query yields no matches.
  assert.deepEqual(searchAcpTimeline(snapshot, '', false), []);
  assert.deepEqual(searchAcpTimeline(snapshot, '   ', false), []);

  // Case-insensitive search covers every item in timeline order.
  const insensitive = searchAcpTimeline(snapshot, 'alpha', false);
  const itemsMatched = [...new Set(insensitive.map((match) => match.itemId))];
  assert.deepEqual(itemsMatched, [
    'm-user',
    'm-thought',
    'tool:g1',
    'tool:g2',
    'tool:edit-1',
    'acc-1',
    'notice-1',
    'sub-1',
    'elic-1',
  ]);

  // The turn's thought and tool calls up to its last call form its work process: each
  // match inside carries the process id; the prompt and later items do not.
  const processId = 'process:m-thought';
  const thoughtMatches = insensitive.filter((match) => match.itemId === 'm-thought');
  assert.ok(thoughtMatches.length > 0 && thoughtMatches.every((m) => m.groupId === processId));

  const g1Matches = insensitive.filter((match) => match.itemId === 'tool:g1');
  assert.equal(g1Matches.length, 4); // title, rawInput, text, location
  assert.deepEqual(g1Matches.map((m) => m.occurrence), [0, 1, 2, 3]);
  assert.ok(g1Matches.every((m) => m.groupId === processId));

  const g2Matches = insensitive.filter((match) => match.itemId === 'tool:g2');
  assert.equal(g2Matches.length, 1);
  assert.equal(g2Matches[0].groupId, processId);

  const editMatches = insensitive.filter((match) => match.itemId === 'tool:edit-1');
  // diff path (1) + removed oldAlpha (1) + unchanged shared alpha once + newAlpha (1) + terminal command (1) + ANSI-stripped terminal output (1) = 6
  assert.equal(editMatches.length, 6);
  assert.ok(editMatches.every((m) => m.groupId === processId));
  assert.ok(insensitive.filter((m) => ['acc-1', 'notice-1', 'sub-1', 'elic-1'].includes(m.itemId)).every((m) => m.groupId === undefined));

  // Without a prompt there is no round: consecutive completed lightweight tools still
  // fold into a tool group, and the edit stays standalone.
  const noRound = searchAcpTimeline(makeSnapshot(timeline.slice(1), { pending: snapshot.pending, terminals: snapshot.terminals }), 'alpha', false);
  assert.ok(noRound.filter((m) => m.itemId === 'tool:g1' || m.itemId === 'tool:g2').every((m) => m.groupId === 'tool-group:tool:g1'));
  assert.ok(noRound.filter((m) => m.itemId === 'tool:edit-1' || m.itemId === 'm-thought').every((m) => m.groupId === undefined));

  const userMatches = insensitive.filter((match) => match.itemId === 'm-user');
  assert.equal(userMatches.length, 2); // message text + attachment name
  assert.ok(userMatches.every((m) => m.groupId === undefined));

  const accessMatches = insensitive.filter((match) => match.itemId === 'acc-1');
  // path (1) + detail (1) + diff oldText removed line (1); diff.path equals access.path so not double-counted
  assert.equal(accessMatches.length, 3);

  const elicMatches = insensitive.filter((match) => match.itemId === 'elic-1');
  assert.equal(elicMatches.length, 2); // message + field title

  // Case-sensitive search narrows strictly to exact case.
  const upperOnly = searchAcpTimeline(snapshot, 'ALPHA', true);
  assert.deepEqual(upperOnly, [{ itemId: 'tool:g2', occurrence: 0, groupId: processId }]);

  const titleCase = searchAcpTimeline(snapshot, 'Alpha', true);
  assert.deepEqual(
    titleCase.map((m) => m.itemId),
    ['m-user', 'tool:edit-1', 'tool:edit-1', 'notice-1', 'sub-1', 'elic-1'],
  );
});

const user = (id, turnId = 'turn-1') => messageItem(id, `prompt ${id}`, { role: 'user', turnId });
const thought = (id, text = `thinking ${id}`, extra = {}) => messageItem(id, text, { role: 'thought', ...extra });
const notice = (id, level = 'info', turnId = 'turn-1') => ({ kind: 'notice', id, level, code: '', text: `notice ${id}`, turnId });
const turnEnd = (turnId, reason = 'end_turn') => ({ kind: 'turn', id: `${turnId}-end`, turnId, reason });
const accessItem = (id, decision = 'allowed_once', requestId = null) => ({ kind: 'access', id, accessKind: 'read', path: '/outside/a', detail: null, decision, requestId, diff: null, turnId: 'turn-1', subagent: null, userPath: null });
const shape = (segments) => segments.map((segment) => segment.kind === 'item'
  ? segment.item.id
  : `${segment.kind}[${segment.items.map((item) => item.id).join(',')}]`);
const flatten = (segments) => segments.flatMap((segment) => segment.kind === 'item' ? [segment.item.id] : segment.items.map((item) => item.id));

test('buildSegments folds startup messages only before a first prompt', () => {
  const s1 = messageItem('s1', '# Context\n- a', { turnId: '' });
  const s2 = thought('s2', 'loading', { turnId: '' });
  const subStart = messageItem('sub-s', 'child', { turnId: '', subagent: 'child-1' });
  const segments = buildSegments([s1, s2, subStart, user('u1'), messageItem('m1', 'hi')]);
  assert.deepEqual(shape(segments), ['startup[s1,s2]', 'sub-s', 'u1', 'm1']);
  assert.equal(segments[0].id, 'startup:s1');
  // A history without any prompt reads as ordinary replies.
  assert.deepEqual(shape(buildSegments([s1, s2])), ['s1', 's2']);
  // Only the agent's own messages outside any turn fold.
  assert.deepEqual(shape(buildSegments([messageItem('t1', 'in a turn'), s1, user('u1')])), ['t1', 'startup[s1]', 'u1']);
});

test('buildSegments makes the work up to the last tool call a process and leaves the reply after it', () => {
  const timeline = [
    user('u1'),
    thought('th1'),
    toolItem('x1', { toolKind: 'execute' }),
    messageItem('note', 'Now I will add R13.'),
    toolItem('r1', { toolKind: 'read' }),
    thought('th2'),
    messageItem('reply', 'Done.'),
    turnEnd('turn-1'),
  ];
  const segments = buildSegments(timeline);
  assert.deepEqual(shape(segments), ['u1', 'process[th1,tool:x1,note,tool:r1]', 'th2', 'reply', 'turn-1-end']);
  const process = segments[1];
  assert.equal(process.id, 'process:th1');
  assert.equal(process.ended, true);
  assert.equal(process.interrupted, false);
  assert.equal(process.reason, 'end_turn');
  assert.equal(process.tail, true);
  assert.equal(process.activity, null);
  assert.deepEqual(process.summary, { steps: 3, kinds: [{ kind: 'execute', count: 1 }, { kind: 'read', count: 1 }, { kind: 'thought', count: 1 }], failed: 0, files: 0 });
  assert.deepEqual(flatten(segments), timeline.map((item) => item.id));

  // A turn without any tool call has no process.
  const plain = [user('u1'), thought('th1'), messageItem('m1', 'hello'), turnEnd('turn-1')];
  assert.deepEqual(shape(buildSegments(plain)), ['u1', 'th1', 'm1', 'turn-1-end']);
  // Items of another turn, a subagent's, or without a prompt never join a process.
  const other = [user('u1'), toolItem('a', { turnId: 'turn-0' }), toolItem('b', { subagent: 'child' }), toolItem('c', { subagent: 'child' })];
  assert.deepEqual(shape(buildSegments(other)), ['u1', 'tool:a', 'toolGroup[tool:b,tool:c]']);
});

test('buildSegments splits a process at cards, subagents and errors, keeping every item in order', () => {
  const permission = { requestId: 'perm-1', turnId: 'turn-1', options: [] };
  const timeline = [
    user('u1'),
    toolItem('t1'),
    accessItem('acc'),
    toolItem('t2'),
    notice('n-err', 'error'),
    toolItem('t3'),
    { kind: 'subagent', id: 'sub', sessionId: 'child', parent: null, title: null, description: null, state: null, stopReason: null, summary: '', turnId: 'turn-1' },
    toolItem('t4'),
    { kind: 'elicitation', id: 'elic', message: 'q', requestedSchema: { properties: {} }, toolCallId: null, decision: 'accepted', requestId: null, turnId: 'turn-1', subagent: null },
    toolItem('t5'),
    notice('n-info'),
    toolItem('ask', { toolKind: 'edit', status: 'pending', permission }),
    toolItem('t6'),
    messageItem('reply', 'ok'),
  ];
  const segments = buildSegments(timeline, { pending: ['perm-1'] });
  assert.deepEqual(shape(segments), [
    'u1', 'process[tool:t1]', 'acc', 'process[tool:t2]', 'n-err', 'process[tool:t3]', 'sub',
    'process[tool:t4]', 'elic', 'process[tool:t5,n-info]', 'tool:ask', 'process[tool:t6]', 'reply',
  ]);
  assert.deepEqual(flatten(segments), timeline.map((item) => item.id));
  // Only the last process of the turn carries its tail.
  assert.deepEqual(segments.filter((s) => s.kind === 'process').map((s) => s.tail), [false, false, false, false, false, true]);
  // Once nothing waits, the answered call rejoins its process.
  assert.deepEqual(shape(buildSegments(timeline)).slice(-2), ['process[tool:t5,n-info,tool:ask,tool:t6]', 'reply']);
});

test('buildSegments counts steps, failures and changed files', () => {
  const timeline = [
    user('u1'),
    ...Array.from({ length: 5 }, (_, index) => thought(`th${index}`)),
    ...Array.from({ length: 6 }, (_, index) => toolItem(`x${index}`, { toolKind: 'execute', status: index === 2 ? 'failed' : 'completed' })),
    toolItem('r1', { toolKind: 'read', locations: [{ path: 'src/read-only.ts', line: 1 }] }),
    toolItem('e1', { toolKind: 'edit', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b', truncated: false }] }),
    toolItem('e2', { toolKind: 'edit', locations: [{ path: 'src/a.ts', line: 3 }, { path: 'src/b.ts', line: null }] }),
    toolItem('d1', { toolKind: 'delete', locations: [{ path: 'src/c.ts', line: null }] }),
    toolItem('w1', { toolKind: 'mystery' }),
  ];
  const [, process] = buildSegments(timeline);
  assert.equal(process.kind, 'process');
  assert.deepEqual(process.summary, {
    steps: 16,
    kinds: [{ kind: 'execute', count: 6 }, { kind: 'read', count: 1 }, { kind: 'edit', count: 2 }, { kind: 'delete', count: 1 }, { kind: 'other', count: 1 }, { kind: 'thought', count: 5 }],
    failed: 1,
    files: 3,
  });
});

test('buildSegments tells a running, waiting, replying, stopped and interrupted turn apart', () => {
  const running = [user('u1'), thought('th1'), toolItem('x1', { toolKind: 'execute', status: 'in_progress', title: 'npm test' })];
  const [, open] = buildSegments(running, { turnOpen: true });
  assert.equal(open.ended, false);
  assert.deepEqual(open.activity, { kind: 'running', title: 'npm test' });
  // Without a turn in flight the same round has ended, with its last call cut short.
  const [, cut] = buildSegments(running);
  assert.equal(cut.ended, true);
  assert.equal(cut.interrupted, true);
  assert.equal(cut.activity, null);

  const thinking = [user('u1'), toolItem('r1'), thought('th2')];
  assert.deepEqual(buildSegments(thinking, { turnOpen: true })[1].activity, { kind: 'thinking' });
  const replying = [user('u1'), toolItem('r1'), thought('th2'), messageItem('m1', 'answer')];
  assert.deepEqual(buildSegments(replying, { turnOpen: true })[1].activity, { kind: 'replying' });
  const waiting = [user('u1'), toolItem('r1'), accessItem('acc', 'pending', 'req-1')];
  assert.deepEqual(buildSegments(waiting, { turnOpen: true, pending: ['req-1'] })[1].activity, { kind: 'waiting' });
  const working = [user('u1'), toolItem('r1')];
  assert.deepEqual(buildSegments(working, { turnOpen: true })[1].activity, { kind: 'working' });

  const stopped = [user('u1'), toolItem('r1'), turnEnd('turn-1', 'cancelled')];
  const [, stop] = buildSegments(stopped, { turnOpen: true });
  assert.equal(stop.ended, true);
  assert.equal(stop.interrupted, true);
  assert.equal(stop.reason, 'cancelled');
  const failed = [user('u1'), toolItem('r1'), turnEnd('turn-1', 'failed')];
  assert.equal(buildSegments(failed)[1].interrupted, false);
  // A later prompt ends the earlier round even without its turn entry.
  const replay = [user('u1', ''), toolItem('r1', { turnId: '', status: 'in_progress' }), user('u2', ''), toolItem('r2', { turnId: '' })];
  const replayed = buildSegments(replay, { turnOpen: true }).filter((s) => s.kind === 'process');
  assert.deepEqual(replayed.map((s) => [s.ended, s.interrupted]), [[true, true], [false, false]]);
});

test('agentHeadIds names the first agent content of each round once', () => {
  const timeline = [
    messageItem('s1', 'boot', { turnId: '' }),
    user('u1'),
    thought('th1'),
    messageItem('m1', 'hi there'),
    turnEnd('turn-1'),
    user('u2', 'turn-2'),
    toolItem('t1', { turnId: 'turn-2' }),
    messageItem('m2', 'reply', { turnId: 'turn-2' }),
    user('u3', 'turn-3'),
    messageItem('m3', 'third', { turnId: 'turn-3' }),
    messageItem('m4', 'more', { turnId: 'turn-3' }),
    messageItem('sub', 'child says', { turnId: 'turn-3', subagent: 'child' }),
  ];
  const segments = buildSegments(timeline);
  assert.deepEqual([...agentHeadIds(segments)], ['th1', 'process:tool:t1', 'm3']);
  assert.deepEqual([...agentHeadIds(buildSegments([messageItem('a', 'x'), messageItem('b', 'y')]))], ['a']);
  assert.deepEqual(segments.map(segmentKey).slice(0, 2), ['startup:s1', 'u1']);
});

test('groupIdByItem covers startup, process and tool group members', () => {
  const timeline = [
    messageItem('s1', 'boot', { turnId: '' }),
    user('u1'),
    thought('th1'),
    toolItem('x1', { toolKind: 'execute' }),
    toolItem('c1', { subagent: 'child' }),
    toolItem('c2', { subagent: 'child' }),
  ];
  const byItem = groupIdByItem(buildSegments(timeline));
  assert.deepEqual(Object.fromEntries(byItem), {
    s1: 'startup:s1',
    th1: 'process:th1',
    'tool:x1': 'process:th1',
    'tool:c1': 'tool-group:tool:c1',
    'tool:c2': 'tool-group:tool:c1',
  });
});

/** A seeded stream of host updates: prompts, thoughts and replies that grow chunk by
 *  chunk, tool calls merged in place, cards that wait, subagents and turn ends. Every
 *  update replaces only the item objects it changes, as the host reducer does. */
function syntheticStream(seed, steps) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const frames = [];
  let timeline = [];
  let turn = 0;
  let open = false;
  let pending = [];
  let counter = 0;
  const replace = (index, item) => { timeline = timeline.map((current, at) => (at === index ? item : current)); };
  for (let step = 0; step < steps; step += 1) {
    const roll = random();
    const turnId = `turn-${turn}`;
    if (!open || roll < 0.06) {
      if (open) timeline = [...timeline, turnEnd(turnId, random() < 0.2 ? 'cancelled' : 'end_turn')];
      turn += 1;
      open = true;
      pending = [];
      timeline = [...timeline, user(`u${turn}`, `turn-${turn}`)];
    } else if (roll < 0.3) {
      const last = timeline[timeline.length - 1];
      if (last.kind === 'message' && last.role !== 'user') replace(timeline.length - 1, { ...last, text: last.text + ' more' });
      else timeline = [...timeline, messageItem(`m${counter++}`, 'reply', { turnId, role: random() < 0.5 ? 'thought' : 'agent' })];
    } else if (roll < 0.55) {
      const asks = random() < 0.15;
      const id = `c${counter++}`;
      const permission = asks ? { requestId: `req-${id}`, turnId, options: [] } : null;
      if (asks) pending = [...pending, `req-${id}`];
      timeline = [...timeline, toolItem(id, { turnId, toolKind: random() < 0.5 ? 'read' : 'execute', status: random() < 0.5 ? 'completed' : 'in_progress', permission })];
    } else if (roll < 0.7) {
      const index = timeline.findLastIndex((item) => item.kind === 'tool' && item.status === 'in_progress');
      if (index >= 0) replace(index, { ...timeline[index], status: random() < 0.2 ? 'failed' : 'completed' });
    } else if (roll < 0.78 && pending.length) {
      pending = pending.slice(1);
    } else if (roll < 0.84) {
      timeline = [...timeline, toolItem(`s${counter++}`, { turnId, subagent: 'child' })];
    } else if (roll < 0.9) {
      timeline = [...timeline, notice(`n${counter++}`, random() < 0.3 ? 'error' : 'info', turnId)];
    } else if (roll < 0.94) {
      timeline = [...timeline, accessItem(`acc${counter++}`, 'allowed_once')];
    } else {
      open = false;
      timeline = [...timeline, turnEnd(turnId)];
    }
    frames.push({ timeline, options: { turnOpen: open, pending } });
  }
  return frames;
}

test('createSegmentBuilder always equals buildSegments while a conversation grows', () => {
  for (const seed of [1, 7, 42, 2026]) {
    const build = createSegmentBuilder();
    for (const [index, frame] of syntheticStream(seed, 400).entries()) {
      assert.deepEqual(build(frame.timeline, frame.options), buildSegments(frame.timeline, frame.options), `seed ${seed} step ${index}`);
    }
  }
});

test('createSegmentBuilder reuses the segments a change did not touch', () => {
  const build = createSegmentBuilder();
  const history = [
    user('u1', 'turn-1'), thought('th1'), toolItem('x1', { toolKind: 'execute' }), messageItem('r1', 'done'), turnEnd('turn-1'),
    user('u2', 'turn-2'), toolItem('x2', { turnId: 'turn-2', toolKind: 'execute' }), messageItem('r2', 'ok', { turnId: 'turn-2' }), turnEnd('turn-2'),
    user('u3', 'turn-3'), thought('th3', 'go', { turnId: 'turn-3' }), toolItem('x3', { turnId: 'turn-3', status: 'in_progress' }),
  ];
  const options = { turnOpen: true, pending: [] };
  const first = build(history, options);
  assert.equal(build(history, options), first, '同一时间线返回同一结果');
  assert.equal(build([...history], options), first, '条目对象都未变时结果数组也不变');

  // A streamed reply in the last round: only that round's segments are new.
  const streamed = [...history, messageItem('r3', 'par', { turnId: 'turn-3' })];
  const second = build(streamed, options);
  const grown = [...history, messageItem('r3', 'partial', { turnId: 'turn-3' })];
  const third = build(grown, options);
  assert.deepEqual(third, buildSegments(grown, options));
  const keys = third.map(segmentKey);
  for (const key of ['u1', 'process:th1', 'r1', 'turn-1-end', 'u2', 'process:tool:x2', 'r2', 'u3', 'process:th3']) {
    assert.equal(third[keys.indexOf(key)], second[keys.indexOf(key)], `${key} 沿用旧对象`);
  }
  assert.notEqual(third[keys.indexOf('r3')], second[keys.indexOf('r3')], '变化的消息是新对象');
  assert.equal(third[keys.indexOf('u1')], first[0], '前面的轮次一直沿用最初的对象');

  // The running call completes: its process is new, the rounds before keep theirs.
  const completed = grown.map((item) => (item.id === 'tool:x3' ? { ...item, status: 'completed' } : item));
  const fourth = build(completed, options);
  assert.notEqual(fourth[keys.indexOf('process:th3')], third[keys.indexOf('process:th3')]);
  assert.equal(fourth[keys.indexOf('process:tool:x2')], third[keys.indexOf('process:tool:x2')]);

  // A snapshot brings new objects for everything: the result is rebuilt, still equal.
  const replayed = JSON.parse(JSON.stringify(completed));
  const fifth = build(replayed, options);
  assert.deepEqual(fifth, buildSegments(replayed, options));
  assert.notEqual(fifth[0], fourth[0]);
});

test('stepSummaryShown drops a summary the step title already says', () => {
  const diff = { type: 'diff', path: 'docs/a.md', oldText: 'a', newText: 'b', truncated: false };
  assert.equal(stepSummaryShown(toolItem('e1', { title: '编辑 docs/a.md', content: [diff] }), 'docs/a.md'), '');
  assert.equal(stepSummaryShown(toolItem('r1', { title: '读取 docs/a.md', locations: [{ path: 'docs/a.md', line: 186 }] }), 'docs/a.md:186'), '');
  assert.equal(stepSummaryShown(toolItem('r2', { title: 'read_file', locations: [{ path: 'docs/a.md', line: 186 }] }), 'docs/a.md:186'), 'docs/a.md:186');
  assert.equal(stepSummaryShown(toolItem('r3', { title: '', callId: 'docs/a.md' }), 'docs/a.md'), '');
  assert.equal(stepSummaryShown(toolItem('r4', { title: 'x' }), ''), '');
});

test('segmentOptions reads a running turn and only live pending requests', () => {
  assert.deepEqual(segmentOptions({ state: 'running', pending: ['a'] }), { turnOpen: true, pending: ['a'] });
  assert.deepEqual(segmentOptions({ state: 'waiting_permission', pending: ['a'] }), { turnOpen: true, pending: ['a'] });
  assert.deepEqual(segmentOptions({ state: 'ready', pending: [] }), { turnOpen: false, pending: [] });
  assert.deepEqual(segmentOptions({ state: 'closed', pending: ['a'] }), { turnOpen: false, pending: [] });
});

test('searchAcpTimeline never indexes the id of a terminal whose record is missing', () => {
  const call = toolItem('bash-1', { title: 'Run', toolKind: 'execute', content: [{ type: 'terminal', terminalId: 'toolu_secret_id' }] });
  assert.deepEqual(searchAcpTimeline(makeSnapshot([call]), 'toolu_secret', false), []);
  const withRecord = makeSnapshot([call], { terminals: [{ terminalId: 'toolu_secret_id', command: 'ls', cwd: '/', output: 'toolu_secret printed\n', truncated: false, exitStatus: null, released: false, subagent: null, agentOwned: true }] });
  assert.deepEqual(searchAcpTimeline(withRecord, 'toolu_secret', false), [{ itemId: 'tool:bash-1', occurrence: 0 }]);
});

test('searchAcpTimeline skips picture labels (media types the bubble never shows) and still finds file names', () => {
  const user = messageItem('u1', '看这张 png 图', {
    role: 'user',
    attachments: [
      { type: 'image', name: 'image/png', delivery: null },
      { type: 'image', name: 'image/jpeg', delivery: null },
      { type: 'file', name: 'docs/logo.png', delivery: 'link' },
    ],
  });
  const snapshot = makeSnapshot([user]);
  // The text and the file name: two hits, none from the picture labels.
  assert.deepEqual(searchAcpTimeline(snapshot, 'png', false), [
    { itemId: 'u1', occurrence: 0 },
    { itemId: 'u1', occurrence: 1 },
  ]);
  assert.deepEqual(searchAcpTimeline(snapshot, 'image/', false), []);
  assert.deepEqual(searchAcpTimeline(snapshot, 'jpeg', false), []);
  assert.deepEqual(searchAcpTimeline(snapshot, 'logo', false), [{ itemId: 'u1', occurrence: 0 }]);
});

test('searchAcpTimeline handles non-overlapping occurrences and splitMatchRuns preserves original casing safely', () => {
  const snapshot = makeSnapshot([messageItem('m1', 'aaaa and Alpha/ALPHA')]);
  const overlaps = searchAcpTimeline(snapshot, 'aa', false);
  assert.deepEqual(overlaps, [
    { itemId: 'm1', occurrence: 0 },
    { itemId: 'm1', occurrence: 1 },
  ]);

  assert.deepEqual(splitMatchRuns('Hello Alpha and ALPHA!', 'alpha', false), [
    { text: 'Hello ', hit: false },
    { text: 'Alpha', hit: true },
    { text: ' and ', hit: false },
    { text: 'ALPHA', hit: true },
    { text: '!', hit: false },
  ]);
  assert.deepEqual(splitMatchRuns('Hello Alpha and ALPHA!', 'ALPHA', true), [
    { text: 'Hello Alpha and ', hit: false },
    { text: 'ALPHA', hit: true },
    { text: '!', hit: false },
  ]);
  assert.deepEqual(splitMatchRuns('plain text', '   ', false), [{ text: 'plain text', hit: false }]);
  assert.deepEqual(splitMatchRuns('', 'alpha', false), []);
});

test('searchAcpTimeline ignores hidden schema fields, non-answerable permission options, and trimmed notice raw text', () => {
  const decidedElic = {
    kind: 'elicitation',
    id: 'elic-decided',
    message: 'Visible message',
    requestedSchema: {
      type: 'object',
      properties: {
        secretField: { type: 'string', title: 'HiddenNeedleTitle', description: 'HiddenNeedleDesc' },
      },
    },
    toolCallId: null,
    decision: 'accepted',
    requestId: null,
    turnId: 'turn-1',
    subagent: null,
  };
  const stalePermTool = toolItem('stale-perm', {
    title: 'Run check',
    permission: {
      requestId: 'req-old',
      turnId: 'turn-1',
      options: [{ optionId: 'o1', name: 'HiddenNeedleOption', kind: 'allow_once' }],
    },
  });
  const trimmedNotice = {
    kind: 'notice',
    id: 'notice-trimmed',
    level: 'info',
    code: 'trimmed',
    text: 'HiddenNeedleTrimmedRaw',
    turnId: 'turn-1',
  };
  const liveSnapshot = makeSnapshot([decidedElic, stalePermTool, trimmedNotice], { pending: [] });
  assert.deepEqual(searchAcpTimeline(liveSnapshot, 'HiddenNeedle', false), []);

  // When the permission request is actually pending in a live session, its option name IS searchable.
  const activePermSnapshot = makeSnapshot([stalePermTool], { pending: ['req-old'], state: 'waiting_permission' });
  assert.deepEqual(searchAcpTimeline(activePermSnapshot, 'HiddenNeedleOption', false), [
    { itemId: 'tool:stale-perm', occurrence: 0 },
  ]);

  // Once the session closes, stale pending permissions are no longer answerable/visible.
  const closedPermSnapshot = makeSnapshot([stalePermTool], { pending: ['req-old'], state: 'closed' });
  assert.deepEqual(searchAcpTimeline(closedPermSnapshot, 'HiddenNeedleOption', false), []);
});

const settingLabels = { mode: '模式', model: '模型', thought: '思考强度' };
const choice = (value, name = value) => ({ value, name, description: null, group: null });

test('acpSettings uses only configOptions when the agent declares them, named by category', () => {
  // The pi adapter: modes that are really thinking levels, the legacy model list and
  // the config options for the same two choices.
  const config = {
    modes: { currentModeId: 'high', availableModes: [{ id: 'low', name: 'Thinking: low', description: null }, { id: 'high', name: 'Thinking: high', description: null }] },
    models: { currentModelId: 'sonnet', availableModels: [{ modelId: 'sonnet', name: 'Sonnet', description: null }, { modelId: 'opus', name: 'Opus', description: null }] },
    options: [
      { id: 'thinking', name: 'Thinking', description: null, category: 'thought_level', type: 'select', currentValue: 'high', options: [choice('low', 'Low'), choice('high', 'High')] },
      { id: 'model', name: 'Model', description: 'The model', category: 'model', type: 'select', currentValue: 'sonnet', options: [choice('sonnet', 'Sonnet'), choice('opus', 'Opus')] },
    ],
  };
  const settings = acpSettings(config, '_model', settingLabels);
  assert.deepEqual(settings.map((setting) => setting.name), ['模型', '思考强度']);
  assert.deepEqual(settings.map((setting) => setting.target), [{ kind: 'config', configId: 'model' }, { kind: 'config', configId: 'thinking' }]);
  assert.equal(settingLabel(settings[0], settings[0].value), 'Sonnet');
  assert.equal(settingLabel(settings[1], settings[1].value), 'High');

  // Another category keeps the agent's own name; an option without choices is no selector.
  const other = acpSettings({ modes: null, models: null, options: [
    { id: 'tone', name: 'Tone', description: null, category: null, type: 'select', currentValue: 'calm', options: [choice('calm')] },
    { id: 'empty', name: 'Empty', description: null, category: 'model', type: 'select', currentValue: '', options: [] },
  ] }, '_model', settingLabels);
  assert.deepEqual(other.map((setting) => setting.name), ['Tone']);
});

test('acpSettings falls back to modes and the legacy models without config options', () => {
  const modesOnly = acpSettings({ modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: '提问', description: null }] }, models: null, options: [] }, '_model', settingLabels);
  assert.equal(modesOnly.length, 1);
  assert.equal(modesOnly[0].name, '模式');
  assert.deepEqual(modesOnly[0].target, { kind: 'mode' });

  const legacy = acpSettings({
    modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: '提问', description: null }] },
    models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'M1', description: null }] },
    // An option with nothing to choose does not count as declaring options.
    options: [{ id: 'empty', name: 'Empty', description: null, category: 'model', type: 'select', currentValue: '', options: [] }],
  }, '_model', settingLabels);
  assert.deepEqual(legacy.map((setting) => setting.name), ['模式', '模型']);
  assert.deepEqual(legacy[1].target, { kind: 'config', configId: '_model' });
  assert.deepEqual(acpSettings(null, '_model', settingLabels), []);
});

test('composerPlaceholder names only what the agent and the session offer', () => {
  const labels = { base: '输入消息', command: '/ 使用命令', file: '@ 引用文件', image: '可粘贴图片', lead: '；', separator: '，' };
  assert.equal(composerPlaceholder({ commands: false, files: false, image: false }, labels), '输入消息');
  const plain = composerPlaceholder({ commands: false, files: true, image: false }, labels);
  assert.equal(plain, '输入消息；@ 引用文件');
  assert.ok(!plain.includes('/'));
  assert.ok(!plain.includes('图片'));
  assert.equal(composerPlaceholder({ commands: true, files: true, image: true }, labels), '输入消息；/ 使用命令，@ 引用文件，可粘贴图片');
  assert.equal(composerPlaceholder({ commands: true, files: false, image: false }, labels), '输入消息；/ 使用命令');
});

test('formatTokens uses K/M/B in every language and usageLevel marks 80% and above', () => {
  assert.equal(formatTokens(132000), '132K');
  assert.equal(formatTokens(500000), '500K');
  assert.equal(formatTokens(1200000), '1.2M');
  assert.equal(formatTokens(2000000), '2M');
  assert.equal(formatTokens(2e9), '2B');
  assert.equal(formatTokens(950), '950');
  assert.deepEqual(usageLevel(132000, 500000), { ratio: 0.264, high: false });
  assert.equal(usageLevel(399999, 500000).high, false);
  assert.equal(usageLevel(400000, 500000).high, true);
  assert.equal(usageLevel(425000, 500000).high, true);
  assert.deepEqual(usageLevel(12000, 0), { ratio: null, high: false });
});

test('toolBodySnapshotEqual ignores output streaming into another call and sees its own terminal', () => {
  const terminal = (terminalId, output) => ({ terminalId, command: 'npm run build', cwd: 'C:/p', output, truncated: false, exitStatus: null, released: false, subagent: null, agentOwned: false });
  const own = terminal('term-own', 'a\n');
  const other = terminal('term-other', 'x\n');
  const base = { state: 'running', directory: 'C:/p', terminals: [own, other], omittedTerminalIds: [] };
  const edit = toolItem('e1', { toolKind: 'edit', content: [{ type: 'diff', path: 'a.css', oldText: 'a', newText: 'b', truncated: false }] });
  const run = toolItem('r1', { toolKind: 'execute', content: [{ type: 'terminal', terminalId: 'term-own' }] });
  // Output for another terminal: a new snapshot, the same body for both calls.
  const otherOutput = { ...base, terminals: [own, terminal('term-other', 'x\ny\n')] };
  assert.equal(toolBodySnapshotEqual(edit, base, otherOutput), true);
  assert.equal(toolBodySnapshotEqual(run, base, otherOutput), true);
  // Output for the call's own terminal, its omission, liveness and directory redraw it.
  const ownOutput = { ...base, terminals: [terminal('term-own', 'a\nb\n'), other] };
  assert.equal(toolBodySnapshotEqual(run, base, ownOutput), false);
  assert.equal(toolBodySnapshotEqual(edit, base, ownOutput), true);
  assert.equal(toolBodySnapshotEqual(run, base, { ...base, terminals: [other], omittedTerminalIds: ['term-own'] }), false);
  assert.equal(toolBodySnapshotEqual(edit, base, { ...base, state: 'closed' }), false);
  assert.equal(toolBodySnapshotEqual(edit, base, { ...base, directory: 'C:/q' }), false);
  // Every other prop compares by identity.
  const props = { id: 'b', call: edit, snapshot: base, searchQuery: '', forceOpen: false };
  assert.equal(toolBodyPropsEqual(props, { ...props, snapshot: otherOutput }), true);
  assert.equal(toolBodyPropsEqual(props, { ...props, searchQuery: 'a' }), false);
  assert.equal(toolBodyPropsEqual(props, { ...props, call: { ...edit } }), false);
});
