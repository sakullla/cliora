import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUPABLE_TOOL_KINDS,
  groupTimelineItems,
  isGroupableTool,
  summarizeToolGroupKinds,
  toolGroupIdByItem,
} from '../../src/features/sessions/acp/timelineModel.ts';
import {
  searchAcpTimeline,
  splitMatchRuns,
} from '../../src/features/sessions/acp/acpSearch.ts';
import { acpSettings, composerPlaceholder, settingLabel } from '../../src/features/sessions/acp/composerModel.ts';
import { formatTokens, usageLevel } from '../../src/features/sessions/acp/acpView.ts';

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

  // Grouped tools carry the stable toolGroup id; standalone items do not.
  const g1Matches = insensitive.filter((match) => match.itemId === 'tool:g1');
  assert.equal(g1Matches.length, 4); // title, rawInput, text, location
  assert.deepEqual(g1Matches.map((m) => m.occurrence), [0, 1, 2, 3]);
  assert.ok(g1Matches.every((m) => m.groupId === 'tool-group:tool:g1'));

  const g2Matches = insensitive.filter((match) => match.itemId === 'tool:g2');
  assert.equal(g2Matches.length, 1);
  assert.equal(g2Matches[0].groupId, 'tool-group:tool:g1');

  const editMatches = insensitive.filter((match) => match.itemId === 'tool:edit-1');
  // diff path (1) + removed oldAlpha (1) + unchanged shared alpha once + newAlpha (1) + terminal command (1) + ANSI-stripped terminal output (1) = 6
  assert.equal(editMatches.length, 6);
  assert.ok(editMatches.every((m) => m.groupId === undefined));

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
  assert.deepEqual(upperOnly, [{ itemId: 'tool:g2', occurrence: 0, groupId: 'tool-group:tool:g1' }]);

  const titleCase = searchAcpTimeline(snapshot, 'Alpha', true);
  assert.deepEqual(
    titleCase.map((m) => m.itemId),
    ['m-user', 'tool:edit-1', 'tool:edit-1', 'notice-1', 'sub-1', 'elic-1'],
  );
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
