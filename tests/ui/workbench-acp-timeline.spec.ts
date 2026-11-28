import { expect, test, type Page } from '@playwright/test';
import { agentMessage, installAcpMock, openWorkbench, snapshot, toolCall, toolItem } from './acpMock';

/**
 * The conversation body (T4): rich replies, tool cards, plan and session bar,
 * cards that wait for the person, following new output, and the pane layout in
 * both themes and narrow widths. Everything runs on the synthetic host in
 * acpMock.ts; no CLI or model is involved.
 */

const send = (page: Page, event: Record<string, unknown>) => page.evaluate((value) => (window as any).__acpEvent(value), event);
const panelOf = (page: Page, id = 'a1') => page.locator(`[data-acp="true"][data-pane-session="${id}"]`);
const userMessage = (id: string, text: string) => ({ kind: 'message' as const, id, role: 'user' as const, text, truncated: false, turnId: 'turn-1', subagent: null });

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const page = document.documentElement.scrollWidth - window.innerWidth;
    const panes = [...document.querySelectorAll<HTMLElement>('[data-acp="true"]')].filter((node) => !node.hidden);
    const inner = Math.max(0, ...panes.flatMap((pane) => [...pane.querySelectorAll<HTMLElement>('[data-acp-body], [role="log"]')].map((node) => node.scrollWidth - node.clientWidth)));
    return Math.max(page, inner);
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

test('a user question shows the wire choices and sends only the selected option', async ({ page }) => {
  const question = toolItem('pi-ui-123', { title: '下一步怎么处理？', toolKind: 'other', status: 'pending',
    permission: { requestId: 'select-1', turnId: 'turn-1', userQuestion: true, options: [
      { optionId: 'choice-0', name: '开始研发', kind: 'allow_once' }, { optionId: 'choice-1', name: '仅保存', kind: 'allow_once' },
    ] } });
  await installAcpMock(page, { conversations: [snapshot({ id: 'a1', state: 'waiting_permission', mode: 'yolo', pending: ['select-1'], timeline: [question] as any })] });
  await openWorkbench(page);
  const card = page.locator('[data-card="question"]');
  await expect(card).toContainText('等待回答');
  expect(await page.evaluate(() => (window as any).__acpTest.answers)).toEqual([]);
  await card.getByRole('button', { name: '仅保存' }).click();
  expect(await page.evaluate(() => (window as any).__acpTest.answers)).toEqual([['a1', 'select-1', 'choice-1']]);
});

test('background conversations defer Markdown until selected', async ({ page }) => {
  const conversations = Array.from({ length: 24 }, (_, index) => snapshot({ id: `a${index}`, timeline: [agentMessage('message', `## reply ${index}`)] }));
  await installAcpMock(page, { conversations });
  await openWorkbench(page);
  const rendered = page.locator('[data-role="agent"] h2');
  await expect(rendered).toHaveCount(1);
  await page.locator('[role="tab"][data-session-id="a12"]').click();
  await expect(rendered).toHaveCount(1);
  await expect(rendered).toHaveText('reply 12');
});

test('a reply renders Markdown, copies a code block as its source and keeps HTML and escapes as text', async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { __copied: copied });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  });
  const code = 'const answer: number = 42;\nconsole.log("<b>", answer);';
  const reply = [
    '## 结果', '',
    '| 文件 | 状态 |', '|---|---|', '| a.ts | 已改 |', '',
    '见 [文档](https://example.com/docs)。', '',
    '```ts', code, '```', '',
    '<script>window.__xss = 1</script><img src=x onerror="window.__xss = 2">', '',
    'osc \u001b]0;pwned\u0007 end',
  ].join('\n');
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', timeline: [userMessage('u1', '改一下 a.ts'), agentMessage('m1', reply)] })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const message = panel.locator('[data-item-id="m1"]');
  await expect(message.getByRole('heading', { name: '结果' })).toBeVisible();
  await expect(message.getByRole('table')).toContainText('已改');
  await expect(message.getByRole('link', { name: '文档' })).toBeVisible();
  // The fenced block names its language and highlights statically.
  const block = message.locator('[data-acp-code]');
  await expect(block).toHaveAttribute('data-language', 'ts');
  await expect(block).toContainText('const answer');
  await expect(block.locator('.tok-keyword').first()).toBeVisible();
  await block.getByRole('button', { name: '复制代码' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual([code]);
  // HTML stays literal text: nothing ran, no element was created.
  await expect(message).toContainText('<script>window.__xss = 1</script>');
  await expect(message.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  // An OSC sequence reads as visible control pictures and never acts.
  await expect(message).toContainText('osc \u241b]0;pwned\u2407 end');
  // The whole message copies as it arrived.
  await message.hover();
  await message.getByRole('button', { name: '复制这条消息' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied.at(-1))).toBe(reply);
  // The person's own message is plain text on the right.
  await expect(panel.locator('[data-item-id="u1"]')).toHaveAttribute('data-role', 'user');
});

test('scrolling up stops following, counts new items and returns on "back to latest"', async ({ page }) => {
  const history = Array.from({ length: 40 }, (_, index) => agentMessage(`h${index}`, `第 ${index} 段较长的历史回复，用来撑满对话区域。`.repeat(3)));
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', state: 'running', timeline: history })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const log = panel.getByRole('log');
  await expect(panel.locator('[data-item-id="h39"]')).toBeVisible();
  const distance = () => log.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  await expect.poll(distance).toBeLessThanOrEqual(2);

  // Streaming at the bottom keeps following.
  let seq = 2;
  for (let index = 0; index < 6; index += 1) {
    await send(page, { sessionId: 'a1', seq: seq++, kind: 'chunk', messageId: 'live', role: 'agent', text: `流式片段 ${index}，继续输出更多内容。\n\n`, truncated: false, turnId: 'turn-1', subagent: null });
  }
  await expect(panel.locator('[data-item-id="live"]')).toContainText('流式片段 5');
  await expect.poll(distance).toBeLessThanOrEqual(2);
  await expect(panel.locator('[data-acp-jump]')).toHaveCount(0);

  // A reader who scrolled up is not moved by new output.
  await log.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  const jump = panel.locator('[data-acp-jump]');
  await expect(jump).toBeVisible();
  await send(page, { sessionId: 'a1', seq: seq++, kind: 'chunk', messageId: 'live', role: 'agent', text: '更多。', truncated: false, turnId: 'turn-1', subagent: null });
  for (let index = 0; index < 3; index += 1) {
    await send(page, { sessionId: 'a1', seq: seq++, kind: 'tool', call: toolCall(`n${index}`, { title: `新工具 ${index}`, toolKind: 'read', status: 'in_progress' }) });
  }
  await expect(panel.locator('[data-item-id="tool:n2"]')).toHaveCount(1);
  expect(await log.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(jump).toContainText('回到最新');
  await expect(jump).toContainText('3');

  await jump.click();
  await expect.poll(distance).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);
  // Following again: the next output stays in view.
  await send(page, { sessionId: 'a1', seq: seq++, kind: 'chunk', messageId: 'tail', role: 'agent', text: '最后一段。'.repeat(40), truncated: false, turnId: 'turn-1', subagent: null });
  await expect(panel.locator('[data-item-id="tail"]')).toBeVisible();
  await expect.poll(distance).toBeLessThanOrEqual(2);
  // Reduced motion: the streaming cursor does not blink.
  const cursor = panel.getByRole('img', { name: '正在输出' });
  await expect(cursor).toBeVisible();
  expect(await cursor.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
});

test('every tool kind has its glyph and words, completed calls fold, diffs, terminals and locations work', async ({ page }) => {
  const kinds = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
  const words = ['读取', '编辑', '删除', '移动', '搜索', '执行', '思考', '获取', '切换模式', '其他'];
  const calls = kinds.map((kind, index) => toolItem(`k${index}`, { title: `工具 ${kind}`, toolKind: kind, status: 'in_progress' }));
  // A call without a kind or a title reads as the generic glyph and its call id.
  const bare = { ...toolItem('bare-call', { title: '' }), toolKind: undefined };
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [snapshot({
      id: 'a1', state: 'running', directory: 'C:/work',
      timeline: [...calls, bare as any],
      terminals: [{ terminalId: 'term-1', command: 'npm test', cwd: 'C:/work', output: '\u001b[32mok\u001b[0m 3 passed\n', truncated: false, exitStatus: null, released: false, subagent: null }],
    })],
  });
  await openWorkbench(page);
  const panel = panelOf(page);
  for (const [index, kind] of kinds.entries()) {
    const card = panel.locator(`[data-item-id="tool:k${index}"]`);
    await expect(card).toHaveAttribute('data-tool-kind', kind);
    await expect(card).toContainText(words[index]);
    await expect(card).toContainText('执行中');
    await expect(card.getByRole('button', { name: new RegExp(`工具 ${kind}`) })).toHaveAttribute('aria-expanded', 'true');
  }
  const bareCard = panel.locator('[data-item-id="tool:bare-call"]');
  await expect(bareCard).toHaveAttribute('data-tool-kind', 'other');
  await expect(bareCard).toContainText('bare-call');
  await expect(bareCard).toContainText('等待执行');

  // One call id moves pending → running → completed in one place, title included; completed folds.
  let seq = 2;
  const edit = (extra: Record<string, unknown>) => send(page, { sessionId: 'a1', seq: seq++, kind: 'tool', call: toolCall('k1', { title: '工具 edit', toolKind: 'edit', ...extra }) });
  const diff = { type: 'diff', path: 'src/a.ts', oldText: 'one\ntwo\nthree\n', newText: 'one\n2\nthree\nfour\n', truncated: false };
  await edit({ status: 'pending', content: [diff], locations: [{ path: 'src/a.ts', line: 2 }, { path: 'D:/elsewhere/b.ts', line: null }] });
  const editCard = panel.locator('[data-item-id="tool:k1"]');
  await expect(editCard).toContainText('等待执行');
  await edit({ status: 'in_progress', title: '编辑 a.ts', content: [diff], locations: [{ path: 'src/a.ts', line: 2 }, { path: 'D:/elsewhere/b.ts', line: null }] });
  await expect(editCard).toContainText('编辑 a.ts');
  const diffView = editCard.locator('[data-content="diff"]');
  await expect(diffView).toContainText('修改 src/a.ts');
  await expect(diffView).toContainText('+2');
  await expect(diffView).toContainText('−1');
  await expect(diffView.locator('[data-op="insert"]')).toHaveCount(2);
  await expect(diffView.locator('[data-op="delete"]')).toHaveCount(1);
  // A location inside the directory opens through the host; one outside is only shown.
  await editCard.getByRole('button', { name: /src\/a\.ts:2/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.opens)).toEqual([['a1', 'src/a.ts:2']]);
  await expect(editCard.getByRole('button', { name: /elsewhere/ })).toHaveCount(0);
  await expect(editCard.locator('[data-outside]')).toContainText('D:/elsewhere/b.ts');

  await edit({ status: 'completed', title: '编辑 a.ts', content: [diff], locations: [{ path: 'src/a.ts', line: 2 }] });
  await expect(panel.locator('[data-item-id="tool:k1"]')).toHaveCount(1);
  const toggle = editCard.getByRole('button', { name: /编辑 a\.ts/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(editCard).toContainText('已完成');
  await expect(editCard).toContainText('src/a.ts:2');
  await expect(editCard.locator('[data-content="diff"]')).toHaveCount(0);
  // The keyboard opens a folded card.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(editCard.locator('[data-content="diff"]')).toBeVisible();

  // A failed call stays open and shows what the agent reported.
  await send(page, { sessionId: 'a1', seq: seq++, kind: 'tool', call: toolCall('k2', { title: '工具 delete', toolKind: 'delete', status: 'failed', content: [{ type: 'text', text: '权限不足：无法删除', truncated: false }] }) });
  const failed = panel.locator('[data-item-id="tool:k2"]');
  await expect(failed).toContainText('失败');
  await expect(failed).toContainText('权限不足：无法删除');
  await expect(failed.getByRole('button', { name: /工具 delete/ })).toHaveAttribute('aria-expanded', 'true');

  // An embedded terminal shows its live output without color codes, its exit and a stop.
  await send(page, { sessionId: 'a1', seq: seq++, kind: 'tool', call: toolCall('k5', { title: '工具 execute', toolKind: 'execute', status: 'in_progress', content: [{ type: 'terminal', terminalId: 'term-1' }] }) });
  const terminal = panel.locator('[data-item-id="tool:k5"] [data-content="terminal"]');
  await expect(terminal).toContainText('npm test');
  await expect(terminal).toContainText('ok 3 passed');
  await expect(terminal).not.toContainText('[32m');
  await expect(terminal).toContainText('运行中');
  await terminal.getByRole('button', { name: '终止' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.kills)).toEqual([['a1', 'term-1']]);
  await send(page, { sessionId: 'a1', seq: seq++, kind: 'terminalOutput', terminalId: 'term-1', text: 'stopped\n', dropped: 0, truncated: false, exitStatus: { exitCode: 1, signal: null }, released: false });
  await expect(terminal).toContainText('退出码 1');
  await expect(terminal).toContainText('stopped');
  await expect(terminal.getByRole('button', { name: '终止' })).toHaveCount(0);
});

test('the plan follows its updates and disappears when empty; the title and usage follow the agent', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', state: 'running', timeline: [agentMessage('m1', '开始')] })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  await expect(panel.locator('[data-item-id="m1"]')).toBeVisible();
  await expect(panel.locator('[data-acp-plan]')).toHaveCount(0);
  await expect(panel.locator('[data-acp-usage]')).toHaveCount(0);
  const plan = (statuses: string[]) => statuses.map((status, index) => ({ content: `步骤 ${index + 1}`, priority: index === 0 ? 'high' : 'medium', status }));
  await send(page, { sessionId: 'a1', seq: 2, kind: 'plan', entries: plan(['in_progress', 'pending', 'pending']) });
  const panelPlan = panel.locator('[data-acp-plan]');
  await expect(panelPlan).toContainText('计划 · 0/3');
  await expect(panelPlan.locator('li').nth(0)).toHaveAttribute('data-status', 'in_progress');
  await expect(panelPlan.locator('li').nth(0)).toContainText('进行中');
  await expect(panelPlan.locator('li').nth(0)).toContainText('高优先');
  // Folding an active plan keeps a single-line current step summary in the header.
  await panelPlan.locator('summary').click();
  await expect(panelPlan.locator('summary')).toContainText('当前：步骤 1');
  await panelPlan.locator('summary').click();
  await send(page, { sessionId: 'a1', seq: 3, kind: 'plan', entries: plan(['completed', 'completed', 'in_progress']) });
  await expect(panelPlan).toContainText('计划 · 2/3');
  await expect(panelPlan.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  await expect(panelPlan.locator('li').nth(1)).toContainText('已完成');
  await send(page, { sessionId: 'a1', seq: 4, kind: 'plan', entries: [] });
  await expect(panel.locator('[data-acp-plan]')).toHaveCount(0);

  // A reported title names the stage bar and the rail without repeating in the single-pane ACP bar; usage shows only once reported.
  await send(page, { sessionId: 'a1', seq: 5, kind: 'info', info: { title: '重构工具栏间距', updatedAt: null, usage: { used: 12000, size: 200000, cost: null } } });
  await expect(panel.locator('[data-acp-title]')).toHaveCount(0);
  await expect(panel.locator('[data-acp-usage]')).toContainText('20万');
  await expect(page.locator('[data-session-id="a1"]').first()).toContainText('重构工具栏间距');
  await expect(page.getByRole('heading', { name: /重构工具栏间距/ }).first()).toBeVisible();
});

test('cards wait near their tool, the pending bar locates them, grants revoke and YOLO records stay visible', async ({ page }) => {
  const permission = { requestId: 'r1', turnId: 'turn-1', options: [{ optionId: 'allow', name: '允许一次', kind: 'allow_once' }, { optionId: 'reject', name: '拒绝', kind: 'reject_once' }] };
  const access = { kind: 'access', id: 'access-1', accessKind: 'read', path: 'D:/outside/notes.md', detail: null, decision: 'pending', requestId: 'access-1-request', diff: null, turnId: 'turn-1', subagent: null };
  const history = Array.from({ length: 24 }, (_, index) => agentMessage(`h${index}`, `历史回复 ${index}。`.repeat(6)));
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [snapshot({
      id: 'a1', state: 'waiting_permission', grants: ['write'],
      timeline: [toolItem('c1', { title: '写入 src/a.ts', toolKind: 'edit', permission }), access as any, ...history],
      pending: ['r1', 'access-1-request'],
    })],
  });
  await openWorkbench(page);
  const panel = panelOf(page);
  // The authorization card sits on the tool call that asked.
  await expect(panel.locator('[data-item-id="tool:c1"]').getByRole('group', { name: '写入 src/a.ts' })).toBeAttached();
  // The sidebar counts this conversation as waiting for approval.
  await expect(page.locator('[data-session-id="a1"]').first()).toContainText('等待批准');

  // "2 waiting for you" above the composer brings each card into view, in order.
  const bar = panel.locator('[data-acp-pending]');
  await expect(bar).toContainText('2 项等你处理');
  await bar.getByRole('button', { name: '定位' }).click();
  await expect(panel.locator('[data-item-id="tool:c1"] [data-card="permission"]')).toBeInViewport();
  await expect(panel.locator('[data-item-id="tool:c1"] [data-card="permission"] button').first()).toBeFocused();
  await bar.getByRole('button', { name: '定位' }).click();
  const card = panel.getByRole('group', { name: '需要你的审批：读取会话目录外的文件' });
  await expect(card).toBeInViewport();
  await expect(card).toContainText('D:/outside/notes.md');
  await expect(card.getByRole('button', { name: '允许一次' })).toBeFocused();
  // Keyboard answers the card: Tab to "allow for this session", Enter.
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: '本会话都允许读取' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.accessAnswers)).toEqual([['a1', 'access-1-request', 'session']]);
  await send(page, { sessionId: 'a1', seq: 2, kind: 'item', item: { ...access, decision: 'allowed_session', requestId: null } });
  await send(page, { sessionId: 'a1', seq: 3, kind: 'pending', pending: ['r1'] });
  await expect(card).toHaveCount(0);
  await expect(panel.locator('[data-item-id="access-1"]')).toContainText('已允许（本会话）');
  await expect(bar).toContainText('1 项等你处理');

  // The session grant is a badge that revokes itself.
  const grant = panel.getByRole('button', { name: '撤销本会话的写入放行' });
  await expect(grant).toContainText('本会话已放行写入');
  await grant.click();
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.revokes)).toEqual([['a1', ['write']]]);
  await page.evaluate(() => (window as any).__acpSessionState('a1', { grants: [], pending: ['r1'], seq: 4 }));
  await expect(panel.locator('[data-badge="grant"]')).toHaveCount(0);

  // Answering the last card clears the bar.
  await panel.getByRole('group', { name: '写入 src/a.ts' }).getByRole('button', { name: '允许一次' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.answers)).toEqual([['a1', 'r1', 'allow']]);
  await send(page, { sessionId: 'a1', seq: 5, kind: 'pending', pending: [] });
  await expect(bar).toHaveCount(0);
});

test('a YOLO conversation shows its badge without single-pane duplication and records automatic approvals', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [
      snapshot({
        id: 'a1', mode: 'yolo', state: 'running',
        timeline: [
          { kind: 'access', id: 'access-1', accessKind: 'write', path: 'D:/outside/out.txt', detail: null, decision: 'yolo', requestId: null, diff: null, turnId: 'turn-1', subagent: null } as any,
          { kind: 'notice', id: 'n1', level: 'info', code: 'yolo_allowed', text: '已自动允许：运行 npm test（允许一次）', turnId: 'turn-1' },
          { kind: 'access', id: 'access-2', accessKind: 'write', path: 'C:/work/src/a.ts', detail: null, decision: 'inside', requestId: null, diff: { path: 'src/a.ts', oldText: 'a\n', newText: 'b\n', truncated: false, previousOmitted: false }, turnId: 'turn-1', subagent: null } as any,
        ],
      }),
      snapshot({ id: 'a2', mode: 'normal', timeline: [agentMessage('m2', '普通对话')] }),
    ],
  });
  await page.setViewportSize({ width: 1360, height: 820 });
  await openWorkbench(page);
  const panel = panelOf(page);
  // Single pane: stage bar holds the YOLO chip; AcpSessionBar does not duplicate it.
  await expect(page.getByRole('region', { name: '当前会话' }).locator('header [data-mode="yolo"]')).toBeVisible();
  await expect(panel.locator('[data-badge="yolo"]')).toHaveCount(0);
  await expect(panel.locator('[data-item-id="access-1"]')).toContainText('已自动允许（YOLO）');
  await expect(panel.locator('[data-item-id="access-1"]')).toContainText('D:/outside/out.txt');
  await expect(panel.locator('[data-item-id="n1"]')).toContainText('已自动允许：运行 npm test');
  // A write the host made keeps its diff and says who wrote it.
  const wrote = panel.locator('[data-item-id="access-2"]');
  await expect(wrote).toContainText('Codex 通过 Cliora 写入 src/a.ts');
  await expect(wrote.locator('[data-op="insert"]')).toHaveCount(1);
  await expect(panel.locator('[data-acp-pending]')).toHaveCount(0);
  // Split view: pane-level YOLO badge appears on the ACP bar so side-by-side panes stay distinct.
  await page.getByRole('button', { name: '分屏', exact: true }).first().click();
  await expect(panel.locator('[data-badge="yolo"]')).toContainText('YOLO');
});

for (const theme of ['light', 'dark'] as const) {
  test(`the conversation fits a 720px window and a split in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 720 });
    const busy = snapshot({
      id: 'a1', state: 'waiting_permission', directory: 'C:/work/a-very-long-directory-name-that-keeps-going/and-going-further',
      plan: [{ content: '一个很长的计划条目，'.repeat(6), priority: 'high', status: 'in_progress' }],
      info: { title: '一个很长很长的会话标题，'.repeat(4), updatedAt: null, usage: { used: 120000, size: 200000, cost: { amount: 0.42, currency: 'USD' } } },
      grants: ['read', 'write', 'execute'],
      timeline: [
        userMessage('u1', '请检查 ' + 'very-long-token-without-spaces-'.repeat(8)),
        agentMessage('m1', '```rust\nfn main() { println!("' + 'x'.repeat(240) + '"); }\n```\n\n| a | b |\n|---|---|\n| ' + 'long-cell-'.repeat(20) + ' | 2 |'),
        toolItem('c1', { title: '读取 ' + 'deep/'.repeat(30) + 'file.ts', toolKind: 'read', status: 'in_progress', rawInput: JSON.stringify({ path: 'deep/'.repeat(40) }), locations: [{ path: 'src/' + 'nested/'.repeat(30) + 'a.ts', line: 1 }], content: [{ type: 'diff', path: 'src/' + 'nested/'.repeat(30) + 'a.ts', oldText: 'a\n', newText: 'b'.repeat(300) + '\n', truncated: false }] }),
        { kind: 'access', id: 'access-1', accessKind: 'execute', path: 'D:/' + 'outside/'.repeat(30), detail: 'npm run ' + 'x'.repeat(200), decision: 'pending', requestId: 'access-1-request', diff: null, turnId: 'turn-1', subagent: null } as any,
      ],
      pending: ['access-1-request'],
    });
    await installAcpMock(page, { interaction: 'acp', theme, conversations: [busy, snapshot({ id: 'a2', timeline: [agentMessage('m2', '第二个对话')] })] });
    await openWorkbench(page);
    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    await expect(page.locator(`[data-term-theme="${theme}"]`)).toHaveCount(1);
    await expect(panel.locator('[data-acp-pending]')).toBeVisible();
    await noHorizontalOverflow(page);

    await page.setViewportSize({ width: 1360, height: 820 });
    await page.getByRole('button', { name: '分屏', exact: true }).first().click();
    await expect(panelOf(page, 'a2')).toBeVisible();
    await expect(panel).toBeVisible();
    await noHorizontalOverflow(page);
  });
}

test('consecutive completed lightweight tools fold into a summary group and break out when status or content changes', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [snapshot({
      id: 'a1',
      state: 'running',
      timeline: [
        userMessage('u1', '检查配置并搜索用法'),
        toolItem('g1', { title: '读取 package.json', toolKind: 'read', status: 'completed', locations: [{ path: 'package.json', line: null }] }),
        toolItem('g2', { title: '读取 tsconfig.json', toolKind: 'read', status: 'completed', locations: [{ path: 'tsconfig.json', line: null }] }),
        toolItem('g3', { title: '搜索 AcpTimeline', toolKind: 'search', status: 'completed', content: [{ type: 'text', text: '3 matches', truncated: false }] }),
        agentMessage('m1', '已经看完配置。'),
        toolItem('solo', { title: '读取 README.md', toolKind: 'read', status: 'completed' }),
      ],
    })],
  });
  await openWorkbench(page);
  const panel = panelOf(page);

  // Consecutive completed lightweight tools (>= 2) collapse into one summary group; singleton stays standalone.
  const group = panel.locator('[data-acp-tool-group]');
  await expect(group).toHaveCount(1);
  await expect(group).toContainText('已完成 3 步');
  await expect(group).toContainText('读取 2');
  await expect(group).toContainText('搜索 1');
  await expect(panel.locator('[data-item-id="tool:g1"]')).toHaveCount(0);
  await expect(panel.locator('[data-item-id="tool:solo"]')).toHaveCount(1);

  // Expanding reveals each original tool card in order.
  const toggle = group.locator('button[aria-expanded]').first();
  await expect(toggle).toHaveAccessibleName('展开这 3 条工具步骤');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAccessibleName('收起这 3 条工具步骤');
  await expect(panel.locator('[data-item-id="tool:g1"]')).toBeVisible();
  await expect(panel.locator('[data-item-id="tool:g2"]')).toBeVisible();
  await expect(panel.locator('[data-item-id="tool:g3"]')).toBeVisible();

  // If the middle tool transitions to failed, it breaks out of the group and leaves no 2+ run.
  await send(page, { sessionId: 'a1', seq: 2, kind: 'tool', call: toolCall('g2', { title: '读取 tsconfig.json', toolKind: 'read', status: 'failed', content: [{ type: 'text', text: '读取失败', truncated: false }] }) });
  await expect(panel.locator('[data-acp-tool-group]')).toHaveCount(0);
  await expect(panel.locator('[data-item-id="tool:g2"]')).toContainText('读取失败');
});

test('code wrap toggle, diff copy/line-numbers/incremental expand, thought preview and user message refill work', async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { __copied: copied });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  });
  const manyLines = Array.from({ length: 460 }, (_, index) => `line-${index + 1}`).join('\n') + '\n';
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [snapshot({
      id: 'a1',
      state: 'ready',
      directory: 'C:/work',
      timeline: [
        userMessage('u1', '帮我重构工具栏样式'),
        { kind: 'message', id: 'th1', role: 'thought', text: '先检查现有 token\n再替换像素值', truncated: false, turnId: 'turn-1', subagent: null },
        agentMessage('m1', '```ts\nconst veryLongVariableName = "hello world";\n```'),
        toolItem('d1', {
          title: '更新 src/large.ts',
          toolKind: 'edit',
          status: 'in_progress',
          content: [{ type: 'diff', path: 'src/large.ts', oldText: null, newText: manyLines, truncated: false }],
        }),
      ],
    })],
  });
  await page.setViewportSize({ width: 1360, height: 820 });
  await openWorkbench(page);
  const panel = panelOf(page);

  // Wide viewport centers timeline content within the 860px reading column.
  const innerWidth = await panel.locator('[role="log"] > div').first().evaluate((node) => node.getBoundingClientRect().width);
  expect(innerWidth).toBeLessThanOrEqual(862);

  // Folded thought displays single-line preview and expands cleanly.
  const thought = panel.locator('[data-item-id="th1"]');
  await expect(thought.locator('summary')).toContainText('先检查现有 token');
  await thought.locator('summary').click();
  await expect(thought).toContainText('再替换像素值');

  // Code block wrap toggle flips aria-pressed and data-wrap.
  const codeBlock = panel.locator('[data-acp-code]');
  const wrapBtn = codeBlock.getByRole('button', { name: '自动换行', exact: true });
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'false');
  await wrapBtn.click();
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(codeBlock).toHaveAttribute('data-wrap', 'true');

  // Diff renders line numbers, copies updated text, opens inside-directory path, and expands remaining rows incrementally.
  const diff = panel.locator('[data-item-id="tool:d1"] [data-content="diff"]');
  await expect(diff.locator('[data-op="insert"]')).toHaveCount(400);
  await diff.getByRole('button', { name: '复制修改后内容', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied.at(-1))).toBe(manyLines);
  const showMore = diff.getByRole('button', { name: /展开更多行（剩余 60 行）/ });
  await expect(showMore).toBeVisible();
  await showMore.click();
  await expect(diff.locator('[data-op="insert"]')).toHaveCount(460);
  await expect(showMore).toHaveCount(0);

  // User message refill populates the composer draft without sending; ended conversation hides refill.
  const userMsg = panel.locator('[data-item-id="u1"]');
  await userMsg.hover();
  await userMsg.getByRole('button', { name: '回填到输入框', exact: true }).click();
  const input = panel.getByRole('textbox', { name: '给 Codex 的消息', exact: true });
  await expect(input).toHaveValue('帮我重构工具栏样式');
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => (window as any).__acpTest.prompts)).toEqual([]);

  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'closed', seq: 2 }));
  await expect(userMsg.getByRole('button', { name: '回填到输入框', exact: true })).toHaveCount(0);
});
