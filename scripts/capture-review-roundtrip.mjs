/** Drive both real frontend implementations through synthetic IPC and scheme delivery.
 * Screenshots prove browser interaction/layout only. No native Git or system scheme claim.
 * Start Cliora Vite at 14736 and Twiglane preview:ui at 1430 before running.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { installReviewDesktop, REVIEW_SESSION_A, REVIEW_SESSION_B } from './capture-review-fixtures.mjs';
import { settleCapture, previousCaptureCleanup } from './capture-ready.mjs';
const argv = process.argv.slice(2);
const value = (flag, fallback) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
const out = path.resolve(value('--out', 'docs/verification/ui-review-roundtrip'));
const clioraUrl = value('--cliora', 'http://127.0.0.1:14736');
const twiglaneUrl = value('--twiglane', 'http://127.0.0.1:1430');
const themeOption = value('--theme', argv.includes('--full') ? 'all' : 'light');
if (!['all', 'light', 'dark'].includes(themeOption)) throw new Error('--theme accepts all, light or dark');
const themes = themeOption === 'all' ? ['light', 'dark'] : [themeOption];
const curated = !argv.includes('--full');
const representative = new Set(['cliora-repository-prompt', 'twiglane-source-manager', 'cliora-returned-original-session', 'cliora-feedback-preview', 'cliora-feedback-written']);
fs.mkdirSync(out, { recursive: true });
const prune = previousCaptureCleanup(out, 'manifest.json');
const report = { kind: 'two-frontends-synthetic-ipc-and-scheme', nativePlatform: 'unverified', realGit: false, systemScheme: false, input: { projects: 2, repositoryMembers: 49, prompts: 124, reviewSources: 2, viewport: '1360x900' }, captures: [], observations: [], pageErrors: [] };
const browser = await chromium.launch();
try {
  for (const theme of themes) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const cliora = await context.newPage(); const twiglane = await context.newPage();
    for (const [name, page] of [['cliora', cliora], ['twiglane', twiglane]]) page.on('pageerror', error => report.pageErrors.push({ name, theme, message: error.message }));
    await installReviewDesktop(cliora, theme);
    await twiglane.addInitScript(theme => localStorage.setItem('preview-theme', theme), theme);
    await Promise.all([cliora.goto(clioraUrl), twiglane.goto(twiglaneUrl + '/?cliora=external')]);
    await twiglane.locator('.welcome-recent button').first().waitFor();
    const sources = twiglane.getByRole('button', { name: '选择 Cliora 审查来源', exact: true });
    const shot = async (page, name) => {
      if (name.startsWith('twiglane-')) {
        await expect(page.locator('.history-task-row[aria-pressed="true"]')).toBeVisible();
        await expect(page.locator('.task-detail .file-list .file-row').first()).toBeVisible();
        await expect(page.locator('.task-detail')).not.toHaveAttribute('aria-busy', 'true');
      }
      await settleCapture(page);
      const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
      if (overflow > 1) throw new Error(`${name}: horizontal overflow ${overflow}`);
      if (curated && !representative.has(name)) return;
      const file = `${theme}-${name}.png`; await page.screenshot({ path: path.join(out, file) });
      const bytes = fs.readFileSync(path.join(out, file));
      report.captures.push({ file, theme, horizontalOverflow: overflow, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    };
    await cliora.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    await cliora.locator(`[data-session-id="${REVIEW_SESSION_A}"]`).click();
    const stage = cliora.getByRole('region', { name: '当前会话' });
    await stage.getByRole('button', { name: '快捷输入', exact: true }).click();
    const pane = stage.getByRole('region', { name: '多行输入与提示词投递' });
    await pane.getByRole('textbox', { name: /编写多行内容/ }).fill('A 原始草稿');
    await pane.getByRole('button', { name: '查找提示词', exact: true }).click();
    const picker = cliora.getByRole('dialog', { name: '查找提示词' });
    await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('API 回归');
    await picker.getByRole('button', { name: 'API 回归', exact: true }).click();
    await expect(picker.locator('pre')).toHaveText('API-specific-body');
    await shot(cliora, 'cliora-repository-prompt');
    await picker.getByRole('button', { name: '插入草稿', exact: true }).click();
    const sendReview = async sessionId => {
      await cliora.locator(`[data-session-id="${sessionId}"]`).click();
      await stage.locator('footer').getByLabel(/^Git 分支/).click();
      await cliora.getByRole('menu', { name: '在工作树中新开会话' }).getByRole('menuitem', { name: '在 Twiglane 中审查', exact: true }).click();
      const url = await cliora.evaluate(() => window.__reviewFixture.outgoing.at(-1));
      await cliora.keyboard.press('Escape');
      await twiglane.evaluate(url => window.dispatchEvent(new CustomEvent('twiglane-preview-deep-link', { detail: [url] })), url);
      const id = new URL(url).searchParams.get('reviewId');
      await expect(sources).toHaveAttribute('data-value', id);
      await expect(twiglane.locator('.project-context-path')).toContainText(new URL(url).searchParams.get('worktreePath'));
      await expect.poll(() => twiglane.evaluate(() => window.__clioraPreviewEvidence.receipts.length)).toBeGreaterThan(0);
      const receipt = await twiglane.evaluate(() => window.__clioraPreviewEvidence.receipts.at(-1));
      await cliora.evaluate(url => window.__emitReviewLink(url), receipt);
      return { url, id };
    };
    const a = await sendReview(REVIEW_SESSION_A);
    await shot(twiglane, 'twiglane-source-a');
    const b = await sendReview(REVIEW_SESSION_B);
    await shot(twiglane, 'twiglane-source-b');
    const manager = twiglane.getByRole('button', { name: '管理审查来源（2）', exact: true });
    await manager.click();
    const sourceList = twiglane.getByRole('dialog', { name: '管理审查来源' });
    await expect(sourceList.locator('[data-review-source-id]')).toHaveCount(2);
    await sourceList.locator(`[data-review-source-id="${a.id}"] .review-source-switch`).click();
    await expect(sources).toHaveAttribute('data-value', a.id);
    await expect(twiglane.locator('.project-context-path')).toContainText('/work/commerce/team-0/api');
    await shot(twiglane, 'twiglane-switchback-a');
    await manager.click();
    await shot(twiglane, 'twiglane-source-manager');
    await manager.click();
    await twiglane.getByRole('button', { name: /返回 cliora/ }).click();
    await expect.poll(() => twiglane.evaluate(() => window.__clioraPreviewEvidence.returns.length)).toBe(1);
    const returned = await twiglane.evaluate(() => window.__clioraPreviewEvidence.returns[0]);
    const returnParams = new URL(returned.url).searchParams;
    console.log(JSON.stringify({ phase: 'return-delivery', theme, expectedReviewId: a.id, actualReviewId: returnParams.get('reviewId'), actualSessionId: returnParams.get('sessionId'), version: returnParams.get('v'), resultRevision: returnParams.get('resultRevision') }));
    expect(returnParams.get('reviewId')).toBe(a.id);
    expect(returnParams.get('sessionId')).toBe(REVIEW_SESSION_A);
    expect(returnParams.get('v')).toBe('3');
    expect(returnParams.get('resultRevision')).toBe('1');
    await cliora.evaluate(({ returned, sessionId }) => {
      window.__reviewFixture.statuses[sessionId].uncommittedFiles = returned.uncommitted;
      window.__emitReviewLink(returned.url);
    }, { returned, sessionId: REVIEW_SESSION_A });
    try { await expect(cliora.locator(`[data-session-id="${REVIEW_SESSION_A}"]`)).toHaveAttribute('aria-selected', 'true'); }
    catch (error) {
      console.log(JSON.stringify(await cliora.evaluate(() => ({ phase: 'cliora-return-diagnostic', bridge: window.__reviewBridge, incoming: window.__reviewFixture.incoming, latest: window.__reviewFixture.latest, states: Object.values(window.__reviewFixture.reviews).map(review => ({ reviewId: review.reviewId, sessionId: review.sessionId, status: review.status, resultRevision: review.resultRevision })), activeSession: document.querySelector('[data-session-id][aria-selected="true"]')?.getAttribute('data-session-id'), path: location.pathname })), null, 2));
      throw error;
    }
    await expect(pane.getByRole('textbox', { name: /编写多行内容/ })).toHaveValue('A 原始草稿\nAPI-specific-body');
    await stage.locator('footer').getByLabel(/^Git 分支/).click();
    await expect(cliora.getByRole('menu', { name: '在工作树中新开会话' }).getByRole('group', { name: '在 Twiglane 中审查' }).getByRole('status')).toContainText('未提交');
    await shot(cliora, 'cliora-returned-original-session');
    const results = await cliora.evaluate(() => {
      const state = window.__reviewFixture;
      return window.__reviewSessions.map(session => ({ sessionId: session.id, review: state.reviews[state.latest[session.id]] }));
    });
    if (results[0].review.status !== 'returned' || results[1].review.status !== 'accepted') throw new Error('Independent source results were not retained');
    report.observations.push({ theme, sourceA: a.id, sourceB: b.id, baselineA: new URL(a.url).searchParams.get('baseline'), baselineB: new URL(b.url).searchParams.get('baseline'), returnedSession: results[0].sessionId, bStatus: results[1].review.status, originalDraftRetained: true, promptNotSent: await cliora.evaluate(() => !window.__reviewCalls.some(call => call.command === 'write_workbench_session')) });
    // feedback-v1：接收只生成预览，用户确认后原生侧写入一次；浏览器只证明交互与布局。
    await cliora.evaluate(({ sessionId }) => window.__setReviewFeedback({
      feedbackId: '8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1',
      reviewId: '6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8',
      sessionId,
      resultRevision: 2,
      worktreePath: '/work/commerce/team-0/api',
      rangeVersion: 'range-7',
      commentCount: 2,
      comments: [
        { path: 'src/lib/api.ts', kind: 'add', oldNo: null, newNo: 13, body: '这里要在读取失败时保留上一份结果，不要显示零改动。' },
        { path: 'src/lib/api.ts', kind: 'add', oldNo: null, newNo: 14, body: '这个分支缺少 title 的回退说明，请在恢复入口里补一句。' },
      ],
      state: 'prepared',
    }), { sessionId: REVIEW_SESSION_A });
    await cliora.evaluate(({ sessionId }) => window.__emitReviewLink('cliora://review-feedback?v=1&feedbackId=8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1&reviewId=6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8&sessionId=' + sessionId + '&resultRevision=2&digest=082476955cbba23ba6e82c2eacfff6d59f82c347b088fdb2df0f426ee62c56fc'), { sessionId: REVIEW_SESSION_A });
    const feedbackPanel = cliora.getByRole('region', { name: 'Twiglane 审阅意见' });
    await expect(feedbackPanel).toBeVisible();
    await expect(feedbackPanel).toContainText('来自审查');
    await expect(feedbackPanel).toContainText('src/lib/api.ts:13');
    await shot(cliora, 'cliora-feedback-preview');
    await feedbackPanel.getByRole('button', { name: '发送到终端', exact: true }).click();
    await expect(feedbackPanel).toContainText('已写入终端一次，不代表 Agent 已处理。');
    await shot(cliora, 'cliora-feedback-written');
    report.observations.push({ theme, feedback: await cliora.evaluate(() => window.__feedbackCalls) });
    await context.close();
  }
  if (report.pageErrors.length) throw new Error(JSON.stringify(report.pageErrors));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>双端审查浏览器交互</title><p>合成 IPC / scheme；不是原生平台验收。</p>' + report.captures.map(capture => `<figure><figcaption>${capture.file}</figcaption><img style="max-width:100%" src="${capture.file}"></figure>`).join(''));
  fs.writeFileSync(path.join(out, 'README.md'), '# 双端审查浏览器捕获\n\n合成 IPC 和链接投递，不代表真实 Git、macOS WebView 或系统 scheme 已通过。\n\n两项目、49 个仓库成员、124 条提示词、两个独立来源；A → B → A → 原 Cliora 会话，草稿保留且没有自动发送；随后接收一批 feedback-v1 意见，只读预览后确认写入一次。详见 manifest.json。\n');
  prune(report.captures.map(capture => capture.file));
  console.log(JSON.stringify({ out, captures: report.captures.length, pageErrors: report.pageErrors.length, observations: report.observations }, null, 2));
} finally { await browser.close(); }
