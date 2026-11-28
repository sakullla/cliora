import { expect, test, type Page } from '@playwright/test';
import { agentMessage, installAcpMock, openWorkbench, snapshot, toolCall } from './acpMock';

test('the settings row picks ACP independently of the terminal and keeps the stored value on failure', async ({ page }) => {
  await installAcpMock(page, { interaction: 'terminal' });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '终端与启动', exact: true }).click();
  const region = page.getByRole('region', { name: '终端与启动模式' });
  const group = region.getByRole('radiogroup', { name: '启动方式' });
  await expect(group.getByRole('radio', { name: '终端', exact: true })).toHaveAttribute('aria-checked', 'true');
  // The terminal type, the modes and the start mode are separate fields.
  await expect(region.getByRole('button', { name: '启动终端', exact: true })).toHaveAttribute('data-value', 'workbench');
  await expect(region.getByRole('radiogroup')).toHaveCount(3);

  await group.getByRole('radio', { name: 'ACP 对话', exact: true }).click();
  await expect(group.getByRole('radio', { name: 'ACP 对话', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(region.getByRole('status')).toHaveText('终端设置已保存。');
  expect(await page.evaluate(() => (window as any).__acpTest.interactionSaves)).toEqual(['acp']);
  // Switching the start mode must not rewrite the chosen terminal.
  await expect(region.getByRole('button', { name: '启动终端', exact: true })).toHaveAttribute('data-value', 'workbench');

  // A failed write states the real reason and keeps the value that is really stored.
  await page.evaluate(() => { (window as any).__acpTest.failInteractionSave = true; });
  await group.getByRole('radio', { name: '终端', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('启动方式写入失败');
  await expect(group.getByRole('radio', { name: 'ACP 对话', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => { (window as any).__acpTest.failInteractionSave = false; });
  await region.getByRole('button', { name: '重试', exact: true }).click();
  await expect(group.getByRole('radio', { name: '终端', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(region.getByRole('alert')).toHaveCount(0);
});

test('a stored value that cannot be recognized reads as the terminal and says so', async ({ page }) => {
  await installAcpMock(page, { interaction: 'terminal', interactionError: '启动方式取值无法识别' });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '终端与启动', exact: true }).click();
  const region = page.getByRole('region', { name: '终端与启动模式' });
  await expect(region.getByRole('radiogroup', { name: '启动方式' }).getByRole('radio', { name: '终端', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(region.getByRole('alert')).toContainText('保存的启动方式无法识别');
  // Reading a row never rewrites the stored value on its own.
  expect(await page.evaluate(() => (window as any).__acpTest.interactionSaves)).toEqual([]);
});

test('a launch opens a conversation, streams one reply, merges its tool call and answers one card', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp' });
  await openWorkbench(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  // The dialog says how this launch will talk to the CLI and where, before it starts.
  await expect(dialog.locator('[data-acp-launch]')).toContainText('ACP 对话 · Codex');
  await expect(dialog.locator('[data-acp-launch]')).toContainText('工作目录');
  await dialog.locator('[data-dialog-save]').click();

  const panel = page.locator('[data-acp="true"][data-pane-session="a1"]');
  await expect(panel).toBeVisible();
  // Single-pane view keeps the directory in the workbench stage bar without repeating it in the pane.
  await expect(page.getByRole('region', { name: '当前会话' }).locator('header')).toContainText('work');
  await expect(panel.locator('[data-acp-body]')).not.toContainText('C:/work');
  await expect(panel).toContainText('first prompt');
  // The launch's own first prompt was submitted natively: nothing is sent again.
  expect(await page.evaluate(() => (window as any).__acpTest.prompts)).toEqual([]);
  // A conversation never renders an xterm.
  await expect(panel.locator('.xterm')).toHaveCount(0);

  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 2, kind: 'chunk', messageId: 'm1', role: 'agent', text: '正在', truncated: false }));
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 3, kind: 'chunk', messageId: 'm1', role: 'agent', text: '读取文件', truncated: false }));
  await expect(panel.locator('[data-role="agent"]')).toContainText('正在读取文件');

  // A repeated sequence number never duplicates a reply.
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 3, kind: 'chunk', messageId: 'm1', role: 'agent', text: '读取文件', truncated: false }));
  await expect(panel.locator('[data-role="agent"]')).toHaveCount(1);

  // Tool updates merge by their call id: one card that ends completed.
  const send = (event: Record<string, unknown>) => page.evaluate((value) => (window as any).__acpEvent(value), event);
  await send({ sessionId: 'a1', seq: 4, kind: 'tool', call: toolCall('c1', { title: 'read_file', toolKind: 'read', status: 'in_progress', locations: [{ path: 'src/a.ts', line: null }] }) });
  await send({ sessionId: 'a1', seq: 5, kind: 'tool', call: toolCall('c1', { title: 'read_file', toolKind: 'read', status: 'completed', locations: [{ path: 'src/a.ts', line: null }] }) });
  const tool = panel.locator('[data-status]').filter({ hasText: 'read_file' });
  await expect(tool).toHaveCount(1);
  await expect(tool).toHaveAttribute('data-status', 'completed');
  await expect(tool).toContainText('已完成');
  await expect(tool).toContainText('src/a.ts');

  // An authorization card sits on the tool call that asked and answers exactly its
  // own request, once.
  const permission = { requestId: 'r1', turnId: 'turn-1', options: [{ optionId: 'allow', name: '允许一次', kind: 'allow_once' }, { optionId: 'reject', name: '拒绝', kind: 'reject_once' }] };
  await send({ sessionId: 'a1', seq: 6, kind: 'tool', call: toolCall('c2', { title: '写入 src/a.ts', toolKind: 'edit', permission }) });
  await send({ sessionId: 'a1', seq: 7, kind: 'pending', pending: ['r1'] });
  const card = panel.getByRole('group', { name: '写入 src/a.ts' });
  await expect(card).toBeVisible();
  await expect(panel.locator('[data-item-id="tool:c2"]').getByRole('group', { name: '写入 src/a.ts' })).toBeVisible();
  await card.getByRole('button', { name: '允许一次', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__acpTest.answers)).toEqual([['a1', 'r1', 'allow']]);
  await send({ sessionId: 'a1', seq: 8, kind: 'tool', call: toolCall('c2', { title: '写入 src/a.ts', toolKind: 'edit' }) });
  await send({ sessionId: 'a1', seq: 9, kind: 'pending', pending: [] });
  await expect(panel.getByRole('group', { name: '写入 src/a.ts' })).toHaveCount(0);

  // Stopping reports its own state until the turn answers.
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'running', seq: 10 }));
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__acpTest.cancels)).toEqual(['a1']);
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'stopping', seq: 11 }));
  await expect(panel.getByRole('button', { name: '正在停止…', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'ready', lastTurnReason: 'cancelled', seq: 12 }));
  // The end of the turn is a timeline entry, in its place after the turn's output.
  await send({ sessionId: 'a1', seq: 13, kind: 'item', item: { kind: 'turn', id: 'turn-1-end', turnId: 'turn-1', reason: 'cancelled' } });
  // A stop reads as a quiet mark at the end of the turn, not a rule with a sentence.
  await expect(panel.locator('[data-reason="cancelled"]')).toHaveText('已停止');
  await expect(panel.getByText('本轮已停止。')).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toBeEnabled();

  // ACP mode removes duplicate top-bar quick-input and interrupt buttons; Ctrl/Cmd+Shift+M focuses the ACP composer directly.
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage.getByRole('button', { name: '快捷输入', exact: true })).toHaveCount(0);
  await expect(stage.getByRole('button', { name: /发送中断/ })).toHaveCount(0);
  await stage.locator('header').click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+M`);
  const composer = panel.getByRole('textbox', { name: '给 Codex 的消息', exact: true });
  await expect(composer).toBeFocused();
  await expect(page.getByRole('textbox', { name: /编写多行内容/ })).toHaveCount(0);
  await composer.fill('继续，先跑一次单测');
  await composer.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.prompts)).toEqual([['a1', '继续，先跑一次单测']]);
});

test('a failed ACP start shows its reason and can start a terminal in the same directory', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', failLaunch: '无法以 ACP 对话启动：缺少 ACP 桥接（安装 acp-bridge 后重试）' });
  await openWorkbench(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-dialog-save]').click();
  // The dialog also carries the prompt picker's own read warning, so match the launch banner.
  await expect(dialog.locator('[role="alert"]').filter({ hasText: '缺少 ACP 桥接' })).toBeVisible();
  const fallback = dialog.getByRole('button', { name: '改用终端在此目录启动', exact: true });
  await expect(fallback).toBeVisible();
  await fallback.click();
  const launches = await page.evaluate(() => (window as any).__acpTest.launches);
  expect(launches[launches.length - 1]).toMatchObject({ toolId: 'codex', interaction: 'terminal', sessionId: null });
  await expect(dialog).toHaveCount(0);
  // The explicit terminal start produced a terminal session, not a conversation.
  await expect(page.locator('[data-acp="true"]')).toHaveCount(0);
  await expect(page.locator('[data-pane-session="t1"]').first()).toBeVisible();
});

test('a tool that declares no ACP entry is not offered as a conversation and keeps the terminal', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    acp: { state: 'unsupported', evidence: 'none', reason: '这个工具没有声明 ACP 入口（缺少 acp-bridge）' },
  });
  await openWorkbench(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const summary = dialog.locator('[data-acp-launch]');
  // The dialog says what it will not do, with the adapter's own reason.
  await expect(summary).toHaveAttribute('data-acp-state', 'unsupported');
  await expect(summary).toContainText('这个工具没有声明 ACP 入口');
  await expect(summary).not.toContainText('ACP 对话 · Codex');
  await expect(summary).not.toContainText('工作目录');
  // An unavailable conversation is not confirmed: no launch is sent at all.
  await expect(dialog.locator('[data-dialog-save]')).toBeDisabled();
  await dialog.locator('textarea').fill('跑一次单测');
  await dialog.locator('textarea').press('Control+Enter');
  expect(await page.evaluate(() => (window as any).__acpTest.launches)).toEqual([]);
  // The terminal stays available from the same dialog.
  await summary.getByRole('button', { name: '改用终端启动', exact: true }).click();
  const launches = await page.evaluate(() => (window as any).__acpTest.launches);
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ toolId: 'codex', interaction: 'terminal', sessionId: null, initialPrompt: '跑一次单测' });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-acp="true"]')).toHaveCount(0);
});

test('a declared but unverified ACP entry may be tried and is never described as verified', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    acp: { state: 'unverified', evidence: 'handshake', reason: '入口已声明，尚未完成真实会话验证', entry: { executable: 'codex-acp', args: [], origin: 'bridge', dependency: { name: 'acp-bridge', installHint: '安装 acp-bridge 后重试' } } },
  });
  await openWorkbench(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const summary = dialog.locator('[data-acp-launch]');
  await expect(summary).toHaveAttribute('data-acp-state', 'unverified');
  // The stored mode still applies: the launch is a conversation, and the dialog says so.
  await expect(summary).toContainText('ACP 对话 · Codex');
  await expect(summary.locator('[data-acp-unverified]')).toContainText('尚未完成真实会话验证');
  // The entry's own missing dependency is named instead of hidden.
  await expect(summary.locator('[data-acp-dependency]')).toContainText('acp-bridge');
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  await expect(summary.getByRole('button', { name: '改用终端启动', exact: true })).toHaveCount(0);
  await dialog.locator('[data-dialog-save]').click();
  expect((await page.evaluate(() => (window as any).__acpTest.launches)).at(-1)).toMatchObject({ interaction: 'acp' });
  await expect(page.locator('[data-acp="true"][data-pane-session="a1"]')).toBeVisible();
});

for (const remoteHost of [false, true]) {
  test(`confirm bridge installation on the selected ${remoteHost ? 'SSH' : 'local'} host before starting ACP`, async ({ page }) => {
    const host = remoteHost ? 'SSH fixture' : '本机';
    await installAcpMock(page, { interaction: 'acp', remoteHost, acp: { state: 'unverified', entry: {
      executable: 'test-acp', args: [], origin: 'bridge', dependency: { name: 'test-bridge', installer: 'npm', installHint: '' },
    } } });
    await openWorkbench(page);
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
    const start = page.getByRole('dialog', { name: '新建工作台会话' }).locator('[data-dialog-save]');
    const confirmation = page.getByRole('dialog', { name: '安装 ACP 组件' });
    await start.click();
    await expect(confirmation).toContainText(host);
    await confirmation.getByRole('button', { name: '取消' }).click();
    expect(await page.evaluate(() => (window as any).__acpTest.installedOn)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__acpTest.launches)).toEqual([]);
    await start.click();
    await confirmation.getByRole('button', { name: '安装并继续' }).click();
    await expect(page.locator('[data-pane-session="a1"]')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__acpTest.installedOn)).toEqual([remoteHost ? 'ssh-fixture' : 'local']);
    const launches = await page.evaluate(() => (window as any).__acpTest.launches);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ interaction: 'acp', projectId: remoteHost ? 'remote:folder' : null });
    if (remoteHost) await expect(page.locator('[data-acp-attach-file]')).toHaveCount(0);
  });
}

test('the settings row states that ACP availability depends on the chosen tool', async ({ page }) => {
  await installAcpMock(page, { interaction: 'terminal', acp: { state: 'unverified', evidence: 'documented', reason: '入口尚未验证' } });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '终端与启动', exact: true }).click();
  const region = page.getByRole('region', { name: '终端与启动模式' });
  const group = region.getByRole('radiogroup', { name: '启动方式' });
  // The global row is never disabled by one tool's declaration, but it explains itself.
  await expect(region.locator('[data-acp-capability]')).toHaveCount(0);
  await group.getByRole('radio', { name: 'ACP 对话', exact: true }).click();
  await expect(group.getByRole('radio', { name: 'ACP 对话', exact: true })).toHaveAttribute('aria-checked', 'true');
  const note = region.locator('[data-acp-capability]');
  await expect(note).toContainText('可用性取决于所选工具');
  await expect(note).toContainText('1 款工具可用 ACP 入口');
  await expect(note).toContainText('尚未完成真实会话验证');
});

test('two conversations keep their own messages when the workbench switches between them', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [
      snapshot({ id: 'a1', directory: 'C:/alpha', timeline: [agentMessage('a1m', 'alpha 的回答')] }),
      snapshot({ id: 'a2', directory: 'C:/beta', timeline: [agentMessage('a2m', 'beta 的回答')] }),
    ],
  });
  await openWorkbench(page);
  const first = page.locator('[data-acp="true"][data-pane-session="a1"]');
  const second = page.locator('[data-acp="true"][data-pane-session="a2"]');
  await expect(first).toBeVisible();
  await expect(first).toContainText('alpha 的回答');
  await expect(first).not.toContainText('beta 的回答');

  await page.locator('[data-session-id="a2"]').first().click();
  await expect(second).toBeVisible();
  await expect(second).toContainText('beta 的回答');
  await expect(second).not.toContainText('alpha 的回答');
  await expect(first).toBeHidden();

  // A late chunk for the other conversation reaches only that conversation's view.
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 2, kind: 'chunk', messageId: 'a1m', role: 'agent', text: '（补充）', truncated: false }));
  await expect(second).not.toContainText('（补充）');
  await page.locator('[data-session-id="a1"]').first().click();
  await expect(first).toContainText('alpha 的回答（补充）');
});

test('a narrow window keeps the conversation composer usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 700 });
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [snapshot({ id: 'a1', directory: 'C:/work/a-long-directory-name', timeline: [agentMessage('m1', '窄窗口里的回答')] })],
  });
  await openWorkbench(page);
  const panel = page.locator('[data-acp="true"][data-pane-session="a1"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('textbox')).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
test('replies and tool calls read in arrival order and a tool update stays in its place', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', state: 'running' })] });
  await openWorkbench(page);
  const panel = page.locator('[data-acp="true"][data-pane-session="a1"]');
  await expect(panel).toBeVisible();
  const send = (event: Record<string, unknown>) => page.evaluate((value) => (window as any).__acpEvent(value), event);
  await send({ sessionId: 'a1', seq: 2, kind: 'chunk', messageId: 'r1', role: 'agent', text: '先读 a.ts。', truncated: false, turnId: 'turn-1', subagent: null });
  await send({ sessionId: 'a1', seq: 3, kind: 'tool', call: toolCall('A', { title: '读取 a.ts', toolKind: 'read', status: 'in_progress' }) });
  await send({ sessionId: 'a1', seq: 4, kind: 'chunk', messageId: 'r2', role: 'agent', text: '读完了，接着改。', truncated: false, turnId: 'turn-1', subagent: null });
  await send({ sessionId: 'a1', seq: 5, kind: 'tool', call: toolCall('A', { title: '读取 a.ts', toolKind: 'read', status: 'completed' }) });
  await send({ sessionId: 'a1', seq: 6, kind: 'tool', call: toolCall('B', { title: '编辑 a.ts', toolKind: 'edit', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b', truncated: false }] }) });
  // A late chunk for the first reply merges where that reply stands.
  await send({ sessionId: 'a1', seq: 7, kind: 'chunk', messageId: 'r1', role: 'agent', text: '（补充）', truncated: false, turnId: 'turn-1', subagent: null });

  const order = panel.locator('[role="log"] [data-item-id]');
  await expect(order).toHaveCount(4);
  expect(await order.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-item-id')))).toEqual(['r1', 'tool:A', 'r2', 'tool:B']);
  await expect(order.nth(0)).toContainText('先读 a.ts。（补充）');
  await expect(order.nth(1)).toHaveAttribute('data-status', 'completed');
  await expect(order.nth(3)).toContainText('修改 src/a.ts');
  await expect(panel.locator('[data-item-id="tool:A"]')).toHaveCount(1);
});

test('a conversation can start in YOLO when its entry declares the client form', async ({ page }) => {
  // The terminal launch has no YOLO arguments here: the conversation follows its own
  // ACP declaration instead of the terminal's.
  await installAcpMock(page, {
    interaction: 'acp',
    yoloAvailable: false,
    acp: { state: 'supported', evidence: 'interactive', reason: '', entry: { executable: 'codex-acp', args: [], origin: 'native', yolo: { kind: 'client' } } },
  });
  await openWorkbench(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const yolo = dialog.locator('[data-yolo-route]');
  await expect(yolo).toHaveAttribute('data-yolo-route', 'acp');
  await expect(yolo).toBeEnabled();
  await expect(yolo).toContainText('由 Cliora 自动批准');
  await yolo.click();
  await expect(yolo).toHaveAttribute('aria-checked', 'true');
  await dialog.locator('[data-dialog-save]').click();
  const launches = await page.evaluate(() => (window as any).__acpTest.launches);
  expect(launches.at(-1)).toMatchObject({ toolId: 'codex', interaction: 'acp', mode: 'yolo', sessionId: null });
  await expect(page.locator('[data-acp="true"][data-pane-session="a1"]')).toBeVisible();
});

test('an ACP entry without a YOLO declaration keeps YOLO unavailable and says why', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    yoloAvailable: true,
    acp: { state: 'unverified', evidence: 'handshake', reason: '', entry: { executable: 'codex-acp', args: [], origin: 'native' } },
  });
  await openWorkbench(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const yolo = dialog.locator('[data-yolo-route]');
  await expect(yolo).toBeDisabled();
  await expect(yolo).toContainText('没有声明 YOLO 方式');
  await dialog.locator('[data-dialog-save]').click();
  const launches = await page.evaluate(() => (window as any).__acpTest.launches);
  expect(launches.at(-1)).toMatchObject({ interaction: 'acp', mode: 'normal' });
});

test('Ctrl+Shift+F searches ACP conversations, toggles case, auto-expands folded items, updates live and returns focus', async ({ page }) => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [snapshot({
      id: 'a1',
      state: 'ready',
      timeline: [
        { kind: 'message', id: 'u1', role: 'user', text: 'Alpha token overview', truncated: false, turnId: 'turn-1', subagent: null },
        { kind: 'message', id: 'th1', role: 'thought', text: 'Inspect alpha thinking details', truncated: false, turnId: 'turn-1', subagent: null },
        { kind: 'tool', ...toolCall('r1', { title: '读取 README.md', toolKind: 'read', status: 'completed', content: [{ type: 'text', text: 'plain docs', truncated: false }] }) },
        { kind: 'tool', ...toolCall('r2', { title: '搜索配置', toolKind: 'search', status: 'completed', content: [{ type: 'text', text: 'ALPHA group hit', truncated: false }] }) },
        { kind: 'tool', ...toolCall('e1', { title: '修改 config.ts', toolKind: 'edit', status: 'completed', content: [{ type: 'diff', path: 'src/config.ts', oldText: 'old\n', newText: 'alpha diff\n', truncated: false }] }) },
      ] as any,
    })],
  });
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  const panel = page.locator('[data-acp="true"][data-pane-session="a1"]');
  await expect(panel).toBeVisible();
  // The ended turn's thought and tool calls start folded inside its work process.
  const work = panel.locator('[data-acp-process]');
  await expect(work).toHaveCount(1);
  await expect(work.locator(':scope > button[aria-expanded]')).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('[data-item-id="th1"]')).toHaveCount(0);
  await expect(panel.locator('[data-item-id="tool:r2"]')).toHaveCount(0);

  await page.keyboard.press(`${mod}+Shift+F`);
  const search = stage.getByRole('searchbox', { name: '在对话内容中查找…', exact: true });
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill('alpha');
  await expect(stage.getByRole('search')).toContainText('1 / 4');
  await expect(panel.locator('[data-item-id="u1"]')).toHaveAttribute('data-find-hit', 'active');

  // Case sensitivity filters down to exact lowercase 'alpha' occurrences.
  const caseToggle = stage.getByRole('button', { name: '区分大小写', exact: true });
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(stage.getByRole('search')).toContainText('1 / 2');
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(stage.getByRole('search')).toContainText('1 / 4');

  // Stepping into the folded process opens it and each step it lands on: the thought,
  // a lookup and the edit.
  await search.press('Enter');
  await expect(stage.getByRole('search')).toContainText('2 / 4');
  await expect(work.locator(':scope > button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('[data-item-id="th1"]')).toHaveAttribute('data-find-hit', 'active');
  await expect(panel.locator('[data-item-id="th1"] button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('[data-item-id="th1"] mark')).toHaveText('alpha');

  await search.press('Enter');
  await expect(stage.getByRole('search')).toContainText('3 / 4');
  const groupedCard = panel.locator('[data-item-id="tool:r2"]');
  await expect(groupedCard).toBeVisible();
  await expect(groupedCard).toHaveAttribute('data-find-hit', 'active');
  await expect(groupedCard.locator('mark').first()).toContainText('ALPHA');

  await search.press('Enter');
  await expect(stage.getByRole('search')).toContainText('4 / 4');
  const editCard = panel.locator('[data-item-id="tool:e1"]');
  await expect(editCard).toHaveAttribute('data-find-hit', 'active');
  await expect(editCard.locator('[data-content="diff"]')).toBeVisible();

  // Streaming output updates the live match total while find remains open.
  await page.evaluate(() => (window as any).__acpEvent({
    sessionId: 'a1', seq: 2, kind: 'chunk', messageId: 'm-live', role: 'agent', text: 'streamed alpha result', truncated: false, turnId: 'turn-2', subagent: null,
  }));
  await expect(stage.getByRole('search')).toContainText('4 / 5');

  // Escape closes find, clears highlights and restores focus to the ACP composer.
  await search.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(panel.locator('mark')).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: '给 Codex 的消息', exact: true })).toBeFocused();
});

test('split ACP panes dim unfocused body, tell panes apart by their heads without a strip, and keep terminal controls intact', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    sessions: [{ id: 't1', toolId: 'codex', projectId: null, directory: 'C:/term', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() }],
    conversations: [
      snapshot({ id: 'a1', mode: 'normal', info: { title: '主对话', updatedAt: null, usage: null }, timeline: [agentMessage('m1', '第一个对话')] }),
      snapshot({ id: 'a2', mode: 'yolo', info: { title: '分屏 YOLO 对话', updatedAt: null, usage: null }, timeline: [agentMessage('m2', '第二个对话')] }),
    ],
  });
  await page.setViewportSize({ width: 1360, height: 820 });
  await openWorkbench(page);
  const stage = page.getByRole('region', { name: '当前会话' });
  const first = page.locator('[data-acp="true"][data-pane-session="a1"]');
  const second = page.locator('[data-acp="true"][data-pane-session="a2"]');

  // Single-pane ACP hides duplicate quick-input/interrupt controls; the title lives in the stage bar only.
  await page.locator('[data-session-id="a1"]').first().click();
  await expect(first).toBeVisible();
  await expect(stage.getByRole('button', { name: '查找对话内容', exact: true })).toBeVisible();
  await expect(stage.getByRole('button', { name: '快捷输入', exact: true })).toHaveCount(0);
  await expect(stage.locator('header')).toContainText('主对话');
  await expect(first.locator('[data-acp-body]')).not.toContainText('主对话');

  // Switch to YOLO conversation a2 in single pane: YOLO is on the stage bar, not repeated in the pane.
  await page.locator('[data-session-id="a2"]').first().click();
  await expect(second).toBeVisible();
  await expect(stage.locator('header [data-mode="yolo"]')).toBeVisible();
  await expect(second.locator('[data-badge="yolo"]')).toHaveCount(0);
  await expect(second.locator('[data-acp-body]')).not.toContainText('YOLO');

  // Enter split view with a1 and a2 side by side: unfocused ACP body dims to 0.8; each pane's
  // shared head names its own conversation, so no strip is added inside either pane.
  await page.locator('[data-session-id="a1"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '与 Codex 并排显示', exact: true }).click();
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(first).toHaveAttribute('data-focused', 'true');
  await expect(second).not.toHaveAttribute('data-focused', 'true');
  const firstHead = first.locator('[class*="paneHead"]');
  const secondHead = second.locator('[class*="paneHead"]');
  await expect(firstHead).toContainText('主对话');
  await expect(firstHead).not.toContainText('分屏 YOLO 对话');
  await expect(secondHead).toContainText('分屏 YOLO 对话');
  await expect(secondHead).not.toContainText('主对话');
  await expect(first.locator('[data-acp-body]')).not.toContainText('主对话');
  await expect(second.locator('[data-badge="yolo"]')).toHaveCount(0);
  await expect(stage.locator('header [data-mode="yolo"]')).toHaveCount(0);
  const firstOpacity = await first.locator('[data-acp-body]').evaluate((node) => Number(getComputedStyle(node).opacity));
  const secondOpacity = await second.locator('[data-acp-body]').evaluate((node) => Number(getComputedStyle(node).opacity));
  expect(firstOpacity).toBeGreaterThan(0.95);
  expect(secondOpacity).toBeLessThan(0.9);

  // Clicking the other ACP pane flips focus and dimming.
  await second.locator('[data-acp-body]').click();
  await expect(second).toHaveAttribute('data-focused', 'true');
  await expect(first).not.toHaveAttribute('data-focused', 'true');
  // The YOLO state stays visible on the shared stage bar once that pane is in front.
  await expect(stage.locator('header [data-mode="yolo"]')).toBeVisible();

  // Exit split and switch to a terminal session: terminal toolbar controls remain intact.
  await stage.getByRole('button', { name: '分屏', exact: true }).click();
  await page.locator('[data-session-id="t1"]').first().click();
  await expect(stage.getByRole('button', { name: '快捷输入', exact: true })).toBeVisible();
  await expect(stage.getByRole('button', { name: /发送中断/ })).toBeVisible();
  await expect(stage.getByRole('button', { name: '查找输出', exact: true })).toBeVisible();
});

/** The screenshot's session: the pi ACP adapter with one diagnostic, usage reported,
 *  and the same two choices declared three ways (modes that are thinking levels, the
 *  legacy model list and the config options). */
function piSession(overrides: Partial<ReturnType<typeof snapshot>> = {}) {
  const choice = (value: string, name: string) => ({ value, name, description: null, group: null });
  return snapshot({
    id: 'a1',
    info: { title: null, updatedAt: null, usage: { used: 132000, size: 500000, cost: null } },
    agent: {
      protocolVersion: 1, agentInfo: { name: 'pi-acp', title: 'pi ACP adapter', version: '0.0.35' },
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [],
    },
    config: {
      modes: { currentModeId: 'high', availableModes: [{ id: 'low', name: 'Thinking: low', description: null }, { id: 'high', name: 'Thinking: high', description: null }] },
      models: { currentModelId: 'claude-sonnet', availableModels: [{ modelId: 'claude-sonnet', name: 'claude-sonnet', description: null }, { modelId: 'claude-opus', name: 'claude-opus', description: null }] },
      options: [
        { id: 'model', name: 'Model', description: null, category: 'model', type: 'select', currentValue: 'claude-sonnet', options: [choice('claude-sonnet', 'claude-sonnet'), choice('claude-opus', 'claude-opus')] },
        { id: 'thinking', name: 'Thinking', description: null, category: 'thought_level', type: 'select', currentValue: 'high', options: [choice('low', 'low'), choice('high', 'high')] },
      ],
    },
    commands: [{ name: 'requirement', description: '整理需求', hint: null }],
    diagnostics: ['[pi-acp] warning: extension x failed to load (redacted)'],
    timeline: [
      agentMessage('m0', '## Context\n\n- AGENTS.md\n\n## Extensions\n\n- review', { turnId: '' }),
      { kind: 'message', id: 'u1', role: 'user', text: 'hi', truncated: false, turnId: 'turn-1', subagent: null },
      agentMessage('m1', 'Hello! What would you like to work on?'),
      { kind: 'turn', id: 'turn-1-end', turnId: 'turn-1', reason: 'end_turn' },
    ] as any,
    ...overrides,
  });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

const paneOf = (page: Page, id = 'a1') => page.locator(`[data-acp="true"][data-pane-session="${id}"]`);

test('the pane opens straight onto the timeline: one row of icon actions, value-only settings, usage in the card and diagnostics in the pane menu', async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { __copied: copied });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  });
  await page.setViewportSize({ width: 1360, height: 820 });
  await installAcpMock(page, { interaction: 'acp', conversations: [piSession()] });
  await openWorkbench(page);
  const panel = paneOf(page);
  const body = panel.locator('[data-acp-body]');
  const timeline = panel.getByRole('log');
  await expect(panel.locator('[data-item-id="m1"]')).toBeVisible();

  // Nothing above the timeline: no adapter label, no usage strip, no clock button.
  await expect(panel.locator('[data-acp-bar]')).toHaveCount(0);
  await expect(body).not.toContainText('pi ACP adapter');
  await expect(body).not.toContainText('0.0.35');
  await expect(panel.getByRole('button', { name: '历史会话…', exact: true })).toHaveCount(0);
  const bodyTop = (await body.boundingBox())!.y;
  const logTop = (await timeline.boundingBox())!.y;
  expect(logTop - bodyTop).toBeLessThanOrEqual(12);
  // A running conversation keeps its diagnostics out of the conversation.
  await expect(panel.locator('[data-acp-diagnostics]')).toHaveCount(0);
  await expect(body).not.toContainText('诊断信息');

  // The input card: the input and one row of actions, no standing explanation.
  const composer = panel.locator('[data-acp-composer]');
  const actions = panel.locator('[data-acp-actions]');
  // One row: every control sits within a row no taller than one control plus its padding.
  const row = (await actions.boundingBox())!;
  expect(row.height).toBeLessThanOrEqual(44);
  for (const control of await actions.locator('button:visible, select:visible, [role="meter"]').all()) {
    const box = (await control.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(row.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height + 1);
  }
  await expect(composer).not.toContainText('Enter');
  await expect(composer).not.toContainText('本轮进行中');
  await expect(actions.getByRole('button', { name: '提示词库', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: '引用文件', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: '附加图片', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: '发送', exact: true })).toHaveAttribute('title', /Enter 发送/);
  await expect(panel.getByRole('textbox', { name: '给 Codex 的消息', exact: true })).toHaveAttribute('placeholder', '输入消息；/ 使用命令，@ 引用文件，可粘贴图片');

  // Two settings, each showing only its value; the names are their labels.
  await expect(composer.getByRole('combobox')).toHaveCount(2);
  const model = composer.getByRole('combobox', { name: '模型', exact: true });
  const thinking = composer.getByRole('combobox', { name: '思考强度', exact: true });
  await expect(model).toHaveValue('claude-sonnet');
  await expect(thinking).toHaveValue('high');
  await expect(model).toHaveAttribute('title', /模型：claude-sonnet/);
  await expect(composer).not.toContainText('模式');
  await expect(composer).not.toContainText('Model');
  await expect(composer).not.toContainText('Thinking');
  await model.selectOption('claude-opus');
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.configs)).toEqual([['a1', 'model', 'claude-opus']]);
  expect(await page.evaluate(() => (window as any).__acpTest.modes)).toEqual([]);

  // Usage sits in the card in K/M/B, without a warning.
  const usage = actions.locator('[data-acp-usage]');
  await expect(usage).toHaveText(/^132K \/ 500K/);
  await expect(usage).toHaveAttribute('data-level', 'normal');
  await expect(usage).toHaveAttribute('aria-valuetext', '上下文 132,000 / 500,000（26%）');

  // The pane menu holds history and the diagnostics; the dialog copies the full text and
  // gives the keyboard back to the menu button.
  const stage = page.getByRole('region', { name: '当前会话' });
  const more = stage.getByRole('button', { name: '更多终端操作', exact: true });
  await more.click();
  await expect(page.getByRole('menuitem', { name: '历史会话…', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '诊断信息（1 条）', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 的诊断信息' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('pi ACP adapter 0.0.35');
  await expect(dialog.locator('pre')).toHaveText('[pi-acp] warning: extension x failed to load (redacted)');
  await dialog.getByRole('button', { name: '复制诊断信息', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied.at(-1))).toBe('[pi-acp] warning: extension x failed to load (redacted)');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();

  // A conversation without diagnostics has no such entry.
  await page.evaluate(() => (window as any).__acpSessionState('a1', { diagnostics: [], seq: 2 }));
  await expect(panel.locator('[data-acp-state]')).toHaveAttribute('data-acp-state', 'ready');
  await expect.poll(async () => {
    await more.click();
    const visible = await page.getByRole('menuitem', { name: '历史会话…', exact: true }).isVisible();
    const diagnostics = await page.getByRole('menuitem', { name: /诊断信息/ }).count();
    await page.keyboard.press('Escape');
    return visible && diagnostics === 0;
  }).toBe(true);

  // A 720px window keeps the card on one line without overflow; the settings fold.
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(panel.locator('[data-acp-settings]')).toHaveAttribute('data-acp-settings', 'menu');
  await expect(usage).toHaveText(/^26%/);
  await noHorizontalOverflow(page);
});

test('usage reads in K/M/B, warns from 80% and shows only what was used without a size', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', timeline: [agentMessage('m1', '开始')] })] });
  await page.setViewportSize({ width: 1360, height: 820 });
  await openWorkbench(page);
  const panel = paneOf(page);
  await expect(panel.locator('[data-item-id="m1"]')).toBeVisible();
  const usage = panel.locator('[data-acp-actions] [data-acp-usage]');
  // Not reported: nothing, not even a placeholder.
  await expect(panel.locator('[data-acp-usage]')).toHaveCount(0);
  const info = (used: number, size: number, seq: number, cost: unknown = null) => page.evaluate((event) => (window as any).__acpEvent(event),
    { sessionId: 'a1', seq, kind: 'info', info: { title: null, updatedAt: null, usage: { used, size, cost } } });

  // The color once the reduced-motion reset's 0.01ms transition has run.
  const settledColor = () => usage.evaluate((node) => new Promise<string>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(getComputedStyle(node).color)))));
  await info(1200000, 2000000, 2);
  await expect(usage).toHaveText(/^1\.2M \/ 2M/);
  await expect(usage).toHaveAttribute('data-level', 'normal');
  await expect(usage).not.toHaveAttribute('aria-valuetext', /接近上限/);
  const normal = await settledColor();

  await info(425000, 500000, 3, { amount: 0.42, currency: 'USD' });
  await expect(usage).toHaveAttribute('data-level', 'high');
  await expect(usage).toHaveText(/^425K \/ 500K/);
  await expect(usage).toHaveAttribute('aria-valuetext', '上下文 425,000 / 500,000（85%） · 费用 0.42 USD · 接近上限');
  const tip = usage.locator('[data-acp-usage-tip]');
  await expect(tip).toBeHidden();
  await usage.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('接近上限');
  // The warning is a color as well as words.
  expect(await settledColor()).not.toBe(normal);

  // An unknown size: only what was used, and no ring share.
  await info(12000, 0, 5);
  await expect(usage).toHaveText(/^12K/);
  await expect(usage).not.toContainText('/');
  await expect(usage.locator('svg')).toHaveCount(0);
  await expect(usage).toHaveAttribute('data-level', 'normal');
  // Usage is never shown above the conversation.
  await expect(panel.locator('[data-acp-usage]')).toHaveCount(1);
});

test('a session grant is a shield in the input card that revokes itself, and a refused revoke says why', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', grants: ['write'], timeline: [agentMessage('m1', '已写入')] })] });
  await openWorkbench(page);
  const panel = paneOf(page);
  const actions = panel.locator('[data-acp-actions]');
  const shield = actions.getByRole('button', { name: '撤销本会话的写入放行', exact: true });
  await expect(shield).toBeVisible();
  await expect(shield).toHaveAttribute('data-grant', 'write');
  await expect(shield).toHaveAttribute('title', /本会话已放行写入/);

  // Refused: the shield stays and the reason is in the action row.
  await page.evaluate(() => { (window as any).__acpTest.failRevoke = 'host 拒绝撤销'; });
  await shield.click();
  await expect(actions.getByRole('alert')).toHaveText('撤销没有完成：host 拒绝撤销');
  await expect(shield).toBeEnabled();

  await page.evaluate(() => { (window as any).__acpTest.failRevoke = null; });
  await shield.click();
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.revokes)).toEqual([['a1', ['write']], ['a1', ['write']]]);
  await expect(actions.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as any).__acpSessionState('a1', { grants: [], seq: 2 }));
  await expect(panel.locator('[data-badge="grant"]')).toHaveCount(0);
  // Without grants the shield takes no room at all.
  await expect(actions.locator('[data-acp-grants]')).toHaveCount(0);
});

test('a mouse click on the timeline draws no ring and the keyboard gets a thin one', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [piSession()] });
  await page.setViewportSize({ width: 1360, height: 820 });
  await openWorkbench(page);
  const panel = paneOf(page);
  const timeline = panel.getByRole('log');
  await expect(panel.locator('[data-item-id="m1"]')).toBeVisible();
  const outline = () => timeline.evaluate((node) => { const style = getComputedStyle(node); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });

  // The reduced-motion reset gives every property a 0.01ms transition, so the settled style is polled.
  const box = (await timeline.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await expect(timeline).toBeFocused();
  await expect.poll(async () => (await outline()).style).toBe('none');

  // From inside the timeline, Shift+Tab lands on it by keyboard: a thin line, not a thick ring.
  await page.keyboard.press('Tab');
  await expect(timeline).not.toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(timeline).toBeFocused();
  await expect.poll(outline).toEqual({ style: 'solid', width: 1 });

  // A select clicked with the mouse gets no thick ring or halo either (the browser counts a
  // select as keyboard-focused, so at most a thin line).
  const thinking = panel.getByRole('combobox', { name: '思考强度', exact: true });
  await thinking.click();
  await expect(thinking).toBeFocused();
  const ring = () => thinking.evaluate((node) => { const style = getComputedStyle(node); return { thin: style.outlineStyle === 'none' || parseFloat(style.outlineWidth) <= 1, shadow: style.boxShadow }; });
  await expect.poll(ring).toEqual({ thin: true, shadow: 'none' });
});

test('two conversations side by side stay apart without a strip and fit a split', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [
      piSession({ info: { title: '整理需求', updatedAt: null, usage: { used: 132000, size: 500000, cost: null } }, grants: ['write', 'execute'] }),
      snapshot({ id: 'a2', info: { title: '修复终端', updatedAt: null, usage: { used: 450000, size: 500000, cost: null } }, timeline: [agentMessage('n1', '第二个对话')] }),
    ],
  });
  await page.setViewportSize({ width: 1360, height: 820 });
  await openWorkbench(page);
  await expect(paneOf(page).locator('[data-item-id="m1"]')).toBeVisible();
  await page.getByRole('button', { name: '分屏', exact: true }).first().click();
  const first = paneOf(page);
  const second = paneOf(page, 'a2');
  await expect(second).toBeVisible();
  await expect(first.locator('[class*="paneHead"]')).toContainText('整理需求');
  await expect(second.locator('[class*="paneHead"]')).toContainText('修复终端');
  for (const pane of [first, second]) {
    await expect(pane.locator('[data-acp-bar]')).toHaveCount(0);
    await expect(pane.locator('[data-acp-actions] [data-acp-usage]')).toBeVisible();
    // A narrow pane keeps the ring and the share only.
    await expect(pane.locator('[data-acp-usage]')).toHaveText(/^\d+%/);
  }
  await expect(second.locator('[data-acp-usage]')).toHaveAttribute('data-level', 'high');
  await expect(first.locator('[data-acp-settings]')).toHaveAttribute('data-acp-settings', 'menu');
  await noHorizontalOverflow(page);
});
