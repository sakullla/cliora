import { expect, test, type Page } from '@playwright/test';
import { installReviewDesktop, REVIEW_SESSION_A, REVIEW_SESSION_B } from '../../scripts/capture-review-fixtures.mjs';

async function startReview(page: Page, sessionId: string) {
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.locator('footer').getByLabel(/^Git 分支/).click();
  const group = page.getByRole('menu', { name: '在工作树中新开会话' }).getByRole('group', { name: '在 Twiglane 中审查' });
  await group.getByRole('menuitem', { name: '在 Twiglane 中审查', exact: true }).click();
  const url = await page.evaluate(() => (window as any).__reviewFixture.outgoing.at(-1));
  await page.keyboard.press('Escape');
  return new URL(url);
}
async function deliver(page: Page, review: URL, extra: Record<string, string>) {
  const params = new URLSearchParams({ v: '3', reviewId: review.searchParams.get('reviewId')!, sessionId: review.searchParams.get('sessionId')!, ...extra });
  await expect.poll(() => page.evaluate(url => (window as any).__emitReviewLink(url), 'cliora://review?' + params.toString())).toBe(true);
}

test('project prompts preserve a draft and reviews return to each original project/repository/session', async ({ page }) => {
  await installReviewDesktop(page); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.locator(`[data-session-id="${REVIEW_SESSION_A}"]`).click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('button', { name: '快捷输入', exact: true }).click();
  const pane = stage.getByRole('region', { name: '多行输入与提示词投递' });
  const draft = pane.getByRole('textbox', { name: /编写多行内容/ }); await draft.fill('A 保留草稿');
  await pane.getByRole('button', { name: '查找提示词', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '查找提示词' });
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('项目 B 发布');
  await expect(picker.getByText('没有匹配的提示词', { exact: true })).toBeVisible();
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('API 回归');
  await picker.getByRole('button', { name: 'API 回归', exact: true }).click();
  await expect(picker.locator('pre')).toHaveText('API-specific-body');
  await picker.getByRole('button', { name: '插入草稿', exact: true }).click();
  await expect(draft).toHaveValue('A 保留草稿\nAPI-specific-body');
  const a = await startReview(page, REVIEW_SESSION_A);
  const b = await startReview(page, REVIEW_SESSION_B);
  expect(a.searchParams.get('workspaceId')).not.toBe(b.searchParams.get('workspaceId'));
  expect(a.searchParams.get('repositoryId')).not.toBe(b.searchParams.get('repositoryId'));
  expect(a.searchParams.get('worktreePath')).toBe('/work/commerce/team-0/api');
  expect(a.searchParams.has('repositories')).toBe(false);
  await deliver(page, a, { event: 'returned', outcome: 'reviewed', worktreeState: 'dirty', resultRevision: '2' });
  await expect(page.locator(`[data-session-id="${REVIEW_SESSION_A}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(draft).toHaveValue('A 保留草稿\nAPI-specific-body');
  const states = await page.evaluate(() => (window as any).__reviewFixture);
  expect(states.reviews[states.latest[REVIEW_SESSION_A]].resultRevision).toBe(2);
  expect(states.reviews[states.latest[REVIEW_SESSION_B]].status).toBe('opening');
  await deliver(page, a, { event: 'returned', outcome: 'reviewed', worktreeState: 'clean', resultRevision: '1' });
  await deliver(page, a, { event: 'accepted' });
  await expect.poll(() => page.evaluate(() => (window as any).__reviewFixture.ignored)).toEqual(['duplicate_result', 'late_receipt']);
  expect(await page.evaluate(() => (window as any).__reviewCalls.filter((call: any) => call.command === 'write_workbench_session').length)).toBe(0);
});

test('a new v3 result revision forces another Git read and a wrong checkout stays unconfirmed', async ({ page }) => {
  await installReviewDesktop(page); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const source = await startReview(page, REVIEW_SESSION_A);
  await deliver(page, source, { event: 'returned', outcome: 'reviewed', worktreeState: 'dirty', resultRevision: '1' });
  await page.getByRole('region', { name: '当前会话' }).locator('footer').getByLabel(/^Git 分支/).click();
  const status = page.getByRole('menu', { name: '在工作树中新开会话' }).getByRole('group', { name: '在 Twiglane 中审查' }).getByRole('status');
  await expect(status).toContainText('2 个未提交');
  await page.evaluate((id) => { (window as any).__reviewFixture.statuses[id].worktreePath = '/work/commerce/team-0/API'; }, REVIEW_SESSION_A);
  await deliver(page, source, { event: 'returned', outcome: 'reviewed', worktreeState: 'dirty', resultRevision: '2' });
  await expect(status).toContainText('未确认');
});
