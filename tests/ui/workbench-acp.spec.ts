import { expect, test } from '@playwright/test';
import { installAcpMock, openWorkbench, snapshot } from './acpMock';

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
  await expect(panel).toContainText('C:/work');
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
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 4, kind: 'tool', call: { callId: 'c1', title: 'read_file', status: 'in_progress', detail: 'src/a.ts' } }));
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 5, kind: 'tool', call: { callId: 'c1', title: 'read_file', status: 'completed', detail: 'src/a.ts' } }));
  const tool = panel.locator('[data-status]').filter({ hasText: 'read_file' });
  await expect(tool).toHaveCount(1);
  await expect(tool).toHaveAttribute('data-status', 'completed');
  await expect(tool).toContainText('已完成');

  // An authorization card answers exactly its own request, once.
  await page.evaluate(() => (window as any).__acpEvent({
    sessionId: 'a1', seq: 6, kind: 'permission',
    card: { requestId: 'r1', turnId: 'turn-1', title: '写入 src/a.ts', detail: '1 个文件', options: [{ optionId: 'allow', name: '允许一次', kind: 'allow_once' }, { optionId: 'reject', name: '拒绝', kind: 'reject_once' }] },
  }));
  const card = panel.getByRole('group', { name: '写入 src/a.ts' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '允许一次', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__acpTest.answers)).toEqual([['a1', 'r1', 'allow']]);
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 7, kind: 'permissionClosed', requestId: 'r1', decision: 'allow' }));
  await expect(panel.getByRole('group', { name: '写入 src/a.ts' })).toHaveCount(0);

  // Stopping reports its own state until the turn answers.
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'running', seq: 8 }));
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__acpTest.cancels)).toEqual(['a1']);
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'stopping', seq: 9 }));
  await expect(panel.getByRole('button', { name: '正在停止…', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'ready', lastTurnReason: 'cancelled', seq: 10 }));
  await expect(panel.getByText('本轮已停止。')).toBeVisible();
  await expect(panel.getByRole('textbox')).toBeEnabled();

  // The shared quick-input composer routes to the conversation instead of a PTY write.
  await page.getByRole('button', { name: '快捷输入', exact: true }).click();
  const composer = page.getByRole('textbox', { name: /给 Codex 的消息|提示词/ }).last();
  await composer.fill('继续，先跑一次单测');
  await composer.press('Control+Enter');
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

test('two conversations keep their own messages when the workbench switches between them', async ({ page }) => {
  await installAcpMock(page, {
    interaction: 'acp',
    conversations: [
      snapshot({ id: 'a1', directory: 'C:/alpha', messages: [{ id: 'a1m', role: 'agent', text: 'alpha 的回答', truncated: false }] }),
      snapshot({ id: 'a2', directory: 'C:/beta', messages: [{ id: 'a2m', role: 'agent', text: 'beta 的回答', truncated: false }] }),
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
    conversations: [snapshot({ id: 'a1', directory: 'C:/work/a-long-directory-name', messages: [{ id: 'm1', role: 'agent', text: '窄窗口里的回答', truncated: false }] })],
  });
  await openWorkbench(page);
  const panel = page.locator('[data-acp="true"][data-pane-session="a1"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('textbox')).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});