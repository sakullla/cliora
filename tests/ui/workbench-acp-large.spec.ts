import { expect, test, type Locator, type Page } from '@playwright/test';
import { installAcpMock, openWorkbench, snapshot } from './acpMock';

/**
 * A long conversation (R13): thousands of entries render only the rows near the
 * viewport, while following, reading back, find, locate, folding and a hidden pane
 * behave as they do in a short one. Everything runs on the synthetic host in
 * acpMock.ts; no CLI or model is involved. The timeline renders a conversation whole up
 * to FULL_RENDER_MAX_SEGMENTS (80) segments; every conversation here is well above that,
 * except the one that grows across it.
 */

const FULL_RENDER_MAX_SEGMENTS = 80;

type Item = Record<string, unknown>;

/** One finished round: prompt, a thought and a command folded into its process, a
 *  Markdown reply and the turn's end. Four segments. */
function round(index: number, extra: { open?: boolean } = {}): Item[] {
  const turnId = `turn-${index}`;
  const message = (id: string, role: string, text: string) => ({ kind: 'message', id, role, text, truncated: false, turnId, subagent: null });
  const items: Item[] = [
    message(`u${index}`, 'user', index === 1 ? '最早的问题：请检查 alpha-marker-first 的配置。' : `第 ${index} 轮：请继续检查模块 ${index} 的样式与测试。`),
    message(`th${index}`, 'thought', `先读模块 ${index} 的样式定义，再跑一次检查。`),
    { kind: 'tool', id: `tool:x${index}`, callId: `x${index}`, title: `npm run check -- module-${index}`, toolKind: 'execute', status: 'completed', content: [], locations: [], rawInput: null, turnId, subagent: null, permission: null },
    message(`a${index}`, 'agent', `### 模块 ${index}\n\n检查通过。改动集中在两处：\n\n- 间距改用令牌相加\n- 删除写死的像素值\n\n下一步可以继续处理模块 ${index + 1}。`),
  ];
  if (!extra.open) items.push({ kind: 'turn', id: `${turnId}-end`, turnId, reason: 'end_turn' });
  return items;
}

function rounds(count: number, from = 1): Item[] {
  return Array.from({ length: count }, (_, index) => round(from + index)).flat();
}

const send = (page: Page, event: Record<string, unknown>) => page.evaluate((value) => (window as any).__acpEvent(value), event);
const panelOf = (page: Page, id = 'a1') => page.locator(`[data-acp="true"][data-pane-session="${id}"]`);
const rowsOf = (panel: Locator) => panel.locator('[role="log"] [data-acp-row]');
const distance = (log: Locator) => log.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);

/** The viewport-relative top of a row, or null when it is not rendered. */
const topOf = (panel: Locator, key: string) => panel.evaluate((node, key) => {
  const row = [...node.querySelectorAll<HTMLElement>('[data-acp-row]')].find((element) => element.dataset.acpRow === key);
  const log = node.querySelector<HTMLElement>('[role="log"]');
  return row && log ? row.getBoundingClientRect().top - log.getBoundingClientRect().top : null;
}, key);

/** Scrolls the timeline to a fraction of its height and waits for it to settle. */
async function scrollToFraction(page: Page, log: Locator, fraction: number) {
  await log.evaluate((node, fraction) => {
    node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction;
    node.dispatchEvent(new Event('scroll'));
  }, fraction);
  // Rows render, are measured and settle; the virtualizer's scrolling state resets.
  await page.waitForTimeout(400);
}

/** The first row whose top is inside the viewport (below its top edge). */
const firstVisibleRow = (panel: Locator) => panel.evaluate((node) => {
  const log = node.querySelector<HTMLElement>('[role="log"]')!;
  const top = log.getBoundingClientRect().top;
  const row = [...node.querySelectorAll<HTMLElement>('[data-acp-row]')].find((element) => element.getBoundingClientRect().top >= top + 4);
  return row?.dataset.acpRow ?? null;
});

test('the rendered rows stay about the same when the conversation doubles, and a hidden pane renders none', async ({ page }) => {
  await installAcpMock(page, {
    conversations: [
      snapshot({ id: 'a1', timeline: rounds(250) as any }),
      snapshot({ id: 'a2', timeline: rounds(500) as any }),
    ],
  });
  await openWorkbench(page);
  const one = panelOf(page, 'a1');
  const two = panelOf(page, 'a2');
  await expect(one.locator('[data-item-id="a250"]')).toBeVisible();
  await expect(one.getByRole('log')).toHaveCount(1);
  await expect.poll(() => distance(one.getByRole('log'))).toBeLessThanOrEqual(2);
  const single = await rowsOf(one).count();
  const singleItems = await one.locator('[role="log"] [data-item-id]').count();
  // A hidden pane renders no rows.
  await expect(rowsOf(two)).toHaveCount(0);

  await page.locator('[data-session-id="a2"]').first().click();
  await expect(two.locator('[data-item-id="a500"]')).toBeVisible();
  await expect.poll(() => distance(two.getByRole('log'))).toBeLessThanOrEqual(2);
  const double = await rowsOf(two).count();
  const doubleItems = await two.locator('[role="log"] [data-item-id]').count();
  await expect(rowsOf(one)).toHaveCount(0);

  // 1000 and 2000 segments: a few dozen rows either way.
  expect(single).toBeLessThan(60);
  expect(double).toBeLessThan(60);
  expect(Math.abs(double - single)).toBeLessThanOrEqual(Math.max(4, single * 0.25));
  expect(Math.abs(doubleItems - singleItems)).toBeLessThanOrEqual(Math.max(6, singleItems * 0.25));
  // The log keeps its role and announces only while following.
  await expect(two.getByRole('log')).toHaveAttribute('aria-live', 'polite');
});

test('finding text in the earliest message jumps to it and highlights it', async ({ page }) => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await installAcpMock(page, { conversations: [snapshot({ id: 'a1', timeline: rounds(300) as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  await expect(panel.locator('[data-item-id="a300"]')).toBeVisible();
  const first = panel.locator('[data-item-id="u1"]');
  await expect(first).toHaveCount(0);

  await page.keyboard.press(`${mod}+Shift+F`);
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('searchbox', { name: '在对话内容中查找…', exact: true }).fill('alpha-marker-first');
  await expect(stage.getByRole('search')).toContainText('1 / 1');
  await expect(first).toHaveAttribute('data-find-hit', 'active');
  await expect(first.locator('mark')).toHaveText('alpha-marker-first');
  await expect(first.locator('mark')).toBeInViewport();
  await expect(panel.locator('[data-acp-jump]')).toBeVisible();
});

test('locating a waiting card at the top that is not rendered brings it into view and the keyboard answers it', async ({ page }) => {
  const access = { kind: 'access', id: 'access-top', accessKind: 'read', path: 'D:/outside/top.md', detail: null, decision: 'pending', requestId: 'access-top-request', diff: null, turnId: 'turn-1', subagent: null, userPath: null };
  const timeline = [...round(1, { open: true }).slice(0, 3), access, ...round(1).slice(3), ...rounds(300, 2)];
  await installAcpMock(page, { conversations: [snapshot({ id: 'a1', state: 'waiting_permission', pending: ['access-top-request'], timeline: timeline as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  await expect(panel.locator('[data-item-id="a301"]')).toBeVisible();
  const card = panel.getByRole('group', { name: '需要你的审批：读取会话目录外的文件' });
  await expect(card).toHaveCount(0);

  await panel.locator('[data-acp-pending]').getByRole('button', { name: '定位' }).click();
  await expect(card).toBeInViewport();
  await expect(card).toContainText('D:/outside/top.md');
  await expect(card.getByRole('button', { name: '允许一次' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: '本会话都允许读取' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__acpTest.accessAnswers)).toEqual([['a1', 'access-top-request', 'session']]);
});

test('reading back is not interrupted by streaming, and "back to latest" follows again', async ({ page }) => {
  await installAcpMock(page, { conversations: [snapshot({ id: 'a1', state: 'running', timeline: [...rounds(300), ...round(301, { open: true }).slice(0, 1)] as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const log = panel.getByRole('log');
  await expect(panel.locator('[data-item-id="u301"]')).toBeVisible();
  await expect.poll(() => distance(log)).toBeLessThanOrEqual(2);

  // Following: streamed text keeps the bottom in view.
  let seq = 2;
  const chunk = (text: string) => send(page, { sessionId: 'a1', seq: seq++, kind: 'chunk', messageId: 'live', role: 'agent', text, truncated: false, turnId: 'turn-301', subagent: null });
  for (let index = 0; index < 4; index += 1) await chunk(`流式片段 ${index}，继续输出更多内容。\n\n`);
  await expect(panel.locator('[data-item-id="live"]')).toContainText('流式片段 3');
  await expect.poll(() => distance(log)).toBeLessThanOrEqual(2);

  // Reading back in the middle: new output moves nothing.
  await scrollToFraction(page, log, 0.4);
  const jump = panel.locator('[data-acp-jump]');
  await expect(jump).toBeVisible();
  const key = await firstVisibleRow(panel);
  expect(key).not.toBeNull();
  const before = await topOf(panel, key!);
  const scrollBefore = await log.evaluate((node) => node.scrollTop);
  for (let index = 0; index < 8; index += 1) await chunk(`阅读期间的输出 ${index}。\n\n`.repeat(3));
  await send(page, { sessionId: 'a1', seq: seq++, kind: 'tool', call: { id: 'tool:late', callId: 'late', title: '新工具', toolKind: 'read', status: 'in_progress', content: [], locations: [], rawInput: null, turnId: 'turn-301', subagent: null, permission: null } });
  await expect(jump).toContainText('1');
  await page.waitForTimeout(200);
  expect(Math.abs((await topOf(panel, key!))! - before!)).toBeLessThanOrEqual(1);
  expect(Math.abs((await log.evaluate((node) => node.scrollTop)) - scrollBefore)).toBeLessThanOrEqual(1);

  await jump.click();
  await expect.poll(() => distance(log)).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);
  await expect(panel.locator('[data-item-id="live"]')).toBeInViewport();
  await chunk('最后一段。'.repeat(30));
  await expect(panel.locator('[data-item-id="live"]')).toContainText('最后一段。');
  await expect.poll(() => distance(log)).toBeLessThanOrEqual(2);
});

test('opening or folding a segment above the viewport keeps the reading position', async ({ page }) => {
  await installAcpMock(page, { conversations: [snapshot({ id: 'a1', timeline: rounds(300) as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const log = panel.getByRole('log');
  await expect(panel.locator('[data-item-id="a300"]')).toBeVisible();
  await scrollToFraction(page, log, 0.5);
  const key = await firstVisibleRow(panel);
  expect(key).not.toBeNull();
  const before = await topOf(panel, key!);

  // A folded process rendered above the viewport (overscan), not visible to the reader.
  const above = await panel.evaluate((node) => {
    const log = node.querySelector<HTMLElement>('[role="log"]')!;
    const top = log.getBoundingClientRect().top;
    const processes = [...node.querySelectorAll<HTMLElement>('[data-acp-process]')].filter((element) => element.getBoundingClientRect().bottom < top);
    return processes.at(-1)?.dataset.acpProcess ?? null;
  });
  expect(above).not.toBeNull();
  const toggle = panel.locator(`[data-acp-process="${above}"] > button[aria-expanded]`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.evaluate((node: HTMLElement) => node.click());
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(200);
  expect(Math.abs((await topOf(panel, key!))! - before!)).toBeLessThanOrEqual(1);
  await toggle.evaluate((node: HTMLElement) => node.click());
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(200);
  expect(Math.abs((await topOf(panel, key!))! - before!)).toBeLessThanOrEqual(1);
});

test('a hidden pane comes back at the same reading position with the same segments open', async ({ page }) => {
  await installAcpMock(page, {
    conversations: [
      snapshot({ id: 'a1', timeline: rounds(300) as any }),
      snapshot({ id: 'a2', timeline: rounds(3) as any }),
    ],
  });
  await openWorkbench(page);
  const panel = panelOf(page);
  const log = panel.getByRole('log');
  await expect(panel.locator('[data-item-id="a300"]')).toBeVisible();
  await scrollToFraction(page, log, 0.3);

  // Open a process and a thought inside it that the reader can see.
  const process = await panel.evaluate((node) => {
    const log = node.querySelector<HTMLElement>('[role="log"]')!;
    const box = log.getBoundingClientRect();
    const visible = [...node.querySelectorAll<HTMLElement>('[data-acp-process]')].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= box.top + 4 && rect.bottom <= box.bottom - 40;
    });
    return visible?.dataset.acpProcess ?? null;
  });
  expect(process).not.toBeNull();
  const section = panel.locator(`[data-acp-process="${process}"]`);
  await section.locator(':scope > button[aria-expanded]').click();
  await expect(section.locator(':scope > button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');
  const thought = section.locator('[data-step="thought"]');
  await thought.locator('button[aria-expanded]').click();
  await expect(thought).toHaveAttribute('data-open', 'true');
  await page.waitForTimeout(300);
  const key = await firstVisibleRow(panel);
  const before = await topOf(panel, key!);

  await page.locator('[data-session-id="a2"]').first().click();
  await expect(panelOf(page, 'a2')).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(rowsOf(panel)).toHaveCount(0);

  await page.locator('[data-session-id="a1"]').first().click();
  await expect(panel).toBeVisible();
  await expect(section.locator(':scope > button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');
  await expect(thought).toHaveAttribute('data-open', 'true');
  await expect.poll(async () => Math.abs(((await topOf(panel, key!)) ?? 1e6) - before!)).toBeLessThanOrEqual(2);
  await expect(panel.locator('[data-acp-jump]')).toBeVisible();
});

test('growing past the full-render limit keeps the reading position and what was open', async ({ page }) => {
  // 19 finished rounds (76 segments), then a running one: prompt, process and reply (79).
  const timeline = [...rounds(19), ...round(20, { open: true })];
  await installAcpMock(page, { conversations: [snapshot({ id: 'a1', state: 'running', timeline: timeline as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const log = panel.getByRole('log');
  await expect(panel.locator('[data-item-id="a20"]')).toBeVisible();
  await expect(rowsOf(panel)).toHaveCount(FULL_RENDER_MAX_SEGMENTS - 1);

  await scrollToFraction(page, log, 0.45);
  const process = await panel.evaluate((node) => {
    const log = node.querySelector<HTMLElement>('[role="log"]')!;
    const box = log.getBoundingClientRect();
    const visible = [...node.querySelectorAll<HTMLElement>('[data-acp-process]')].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= box.top + 4 && rect.bottom <= box.bottom - 40;
    });
    return visible?.dataset.acpProcess ?? null;
  });
  expect(process).not.toBeNull();
  const toggle = panel.locator(`[data-acp-process="${process}"] > button[aria-expanded]`);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(300);
  const key = await firstVisibleRow(panel);
  const before = await topOf(panel, key!);

  // The turn ends and two more rounds arrive: 79 → 87 segments.
  let seq = 2;
  const item = (value: Item) => send(page, { sessionId: 'a1', seq: seq++, kind: 'item', item: value });
  await item({ kind: 'turn', id: 'turn-20-end', turnId: 'turn-20', reason: 'end_turn' });
  for (const value of [...round(21), ...round(22).slice(0, 3)]) await item(value);
  await expect(panel.locator('[data-item-id="u22"]')).toHaveCount(0);
  await expect.poll(() => rowsOf(panel).count()).toBeLessThan(FULL_RENDER_MAX_SEGMENTS);
  await page.waitForTimeout(200);
  expect(Math.abs((await topOf(panel, key!))! - before!)).toBeLessThanOrEqual(1);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Back to latest reaches the new rounds.
  await panel.locator('[data-acp-jump]').click();
  await expect(panel.locator('[data-item-id="u22"]')).toBeInViewport();
});
