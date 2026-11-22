import { expect, test, type Page } from '@playwright/test';

const BASE = '4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0';
const NEXT = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';

/**
 * The workbench talks to Twiglane only through the four native commands and the
 * deep-link plugin. This harness fakes the OS link layer, keeps the same
 * reviewId rules as the Rust registry (only the latest review of a session is
 * accepted) and records every call the tests assert on.
 */
async function installDesktop(page: Page, options: { sessions?: 'single' | 'pair' | 'remote'; tool?: 'claude_code' | 'codex'; replay?: string; ended?: boolean; resume?: 'available' | 'unsupported'; remotePath?: string; coldReview?: { reviewId: string; sessionId: string; headOid: string } } = {}) {
  await page.addInitScript(({ base, pairing, tool, replay, ended, resume, remotePath, coldReview }) => {
    type Review = {
      reviewId: string;
      sessionId: string;
      worktreePath: string;
      protocolVersion?: number;
      remoteCheck?: Record<string, unknown>;
      resultRevision?: number;
      baseline: string | null;
      status: string;
      reason: string | null;
      outcome: string | null;
      headOid: string | null;
      worktreeState?: string | null;
      meta?: Record<string, string>;
      createdAt: number;
    };
    const pairingRemote = pairing === 'remote';
    if (pairingRemote) {
      try { localStorage.setItem('cliora:remote-target', 'r1'); } catch { /* storage may be unavailable */ }
    }
    const sessions = (coldReview ? [] : pairing === 'pair'
      ? [
          { id: 's1', toolId: 'claude_code', projectId: null, directory: 'C:/work/alpha', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000 },
          { id: 's2', toolId: 'codex', projectId: null, directory: 'C:/work/beta', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 30_000 },
        ]
      : pairingRemote
        ? [
            { id: 's1', toolId: 'claude_code', projectId: 'remote:p1', directory: remotePath, mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000, connectionState: 'connected' },
          ]
        : [
            { id: 's1', toolId: tool, projectId: null, directory: 'C:/work/alpha', mode: 'normal', running: !ended, exitCode: ended ? 0 : null, startedAt: Date.now() - 60_000 },
          ]).map((item) => ({ ...item }));
    const harness = {
      reviews: {} as Record<string, Review>,
      latest: {} as Record<string, string>,
      starts: [] as Array<{ sessionId: string; reviewId: string }>,
      reviewReads: [] as string[],
      links: [] as string[],
      calls: [] as string[],
      sessions,
      headOid: base as string,
      files: 46,
      startFails: false,
      sessionClosed: false,
      replayText: replay ?? 'ready',
      // feedback-v1：一次接收一个可用预览，发送按 feedbackId 只成功一次。
      feedbackNext: null as Record<string, unknown> | null,
      feedbackStaged: {} as Record<string, Record<string, any>>,
      feedbackLinks: [] as string[],
      feedbackSends: [] as string[],
      // 每次发送请求的目标会话：恢复换了会话 id 之后必须写新 id。
      feedbackTargets: [] as Array<string | null>,
      feedbackDismissed: [] as string[],
      // 写入失败或结果未知：原生会把批次记成 uncertain，此后只允许复制。
      feedbackWriteFails: false,
      // 恢复：旧会话 id 换成新 id，和原生一样不再保留旧 id。
      restoredId: 's1b',
      restoreCalls: [] as string[],
    };
    if (coldReview) {
      harness.reviews[coldReview.reviewId] = {
        reviewId: coldReview.reviewId, sessionId: coldReview.sessionId, worktreePath: remotePath,
        protocolVersion: 1, baseline: base, status: 'accepted', reason: null, outcome: null, headOid: null, createdAt: 1,
      };
      harness.latest[coldReview.sessionId] = coldReview.reviewId;
      harness.headOid = coldReview.headOid;
      harness.files = 0;
    }
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const names: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex' };
    Object.assign(window, {
      isTauri: true,
      __harness: harness,
      __emitDeepLink: (url: string) => {
        bridge.handlers[bridge.listens['deep-link://new-url']]?.({ payload: [url] });
      },
      __setFeedback: (preview: Record<string, unknown> | null) => { harness.feedbackNext = preview; },
      __seedReview: (review: Review) => {
        harness.reviews[review.reviewId] = { ...review };
        harness.latest[review.sessionId] = review.reviewId;
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          harness.calls.push(command);
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: pairingRemote }, tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_remote_targets') return pairingRemote
            ? [{ id: 'r1', name: 'Build box', host: 'build.example', port: 22, user: 'me', authMethod: 'key', identityFile: null, sshConfig: null, defaultPath: null, enabled: true, createdAt: 1, updatedAt: 1 }]
            : [];
          if (command === 'list_remote_projects') return pairingRemote
            ? [{ id: 'p1', targetId: 'r1', name: 'alpha', path: remotePath, preferredTool: null, updatedAt: 1 }]
            : [];
          // resume/history 端口就是「会话横幅能恢复」的依据；resume 为 unsupported 的 CLI（如 cursor 一类的
          // 通用 CLI）只能重启新会话，界面不该提示去点不存在的恢复入口。
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: resume, reason: resume === 'available' ? '' : '这个 CLI 没有可恢复的原会话记录' }, resources: { state: 'available', reason: '' }, history: { state: resume, reason: resume === 'available' ? '' : '这个 CLI 没有可恢复的原会话记录' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return harness.sessionClosed ? [] : sessions.map((item) => ({ ...item }));
          if (command === 'launch_cli') throw { code: 'unexpected_launch', message: 'the review link must never start a session' };
          if (command === 'replay_workbench_session') return btoa(String.fromCharCode(...new TextEncoder().encode(harness.replayText)));
          // feedback-v1 接收只产生预览：这里同步记录它没有启动会话、没有写终端、没有写 Git。
          if (command === 'twiglane_feedback_link') {
            harness.feedbackLinks.push(String(args.url));
            const next = harness.feedbackNext;
            if (!next) throw { code: 'feedback_duplicate', message: '这批审阅意见已经接收过。', action: '在 Twiglane 中重新准备一批新的意见。' };
            harness.feedbackNext = null;
            harness.feedbackStaged[String(next.feedbackId)] = { ...next };
            return { ...next };
          }
          if (command === 'twiglane_feedback_send') {
            harness.feedbackSends.push(String(args.feedbackId));
            harness.feedbackTargets.push(args.sessionId == null ? null : String(args.sessionId));
            const staged = harness.feedbackStaged[String(args.feedbackId)];
            if (!staged) throw { code: 'feedback_unknown', message: '没有找到这批审阅意见的暂存内容。' };
            // 同原生 store：只有 prepared 能被占用，written/uncertain/sending 都直接拒绝。
            if (staged.state !== 'prepared') {
              throw staged.state === 'written'
                ? { code: 'feedback_already_sent', message: '这批审阅意见已经写入过终端一次。' }
                : staged.state === 'uncertain'
                  ? { code: 'feedback_send_uncertain', message: '上次写入的结果未知，这批意见不会再发送。' }
                  : { code: 'feedback_send_in_progress', message: '这批审阅意见正在写入终端。' };
            }
            if (harness.feedbackWriteFails) {
              staged.state = 'uncertain';
              throw { code: 'feedback_write_failed', message: '意见没有写入终端，结果未知。', action: '不要重复发送；复制意见后确认终端是否已收到，需要新一批时在 Twiglane 重新准备。' };
            }
            staged.state = 'written';
            return { feedbackId: staged.feedbackId, sessionId: args.sessionId ?? staged.sessionId, state: 'written' };
          }
          // 恢复：一个已结束的会话换成新 id，原 id 从此不在列表里。
          if (command === 'restore_workbench_sessions' || command === 'restore_workbench_session') {
            const savedId = command === 'restore_workbench_sessions' ? 's1' : String(args.sessionId);
            harness.restoreCalls.push(savedId);
            const restored = harness.restoredId;
            const index = sessions.findIndex((item) => item.id === savedId);
            if (index < 0 || restored === savedId) return { restored: {}, failures: [] };
            const previous = sessions[index];
            sessions.splice(index, 1, { ...previous, id: restored, running: true, exitCode: null });
            return { restored: { [savedId]: restored }, failures: [] };
          }
          if (command === 'twiglane_feedback_dismiss') {
            harness.feedbackDismissed.push(String(args.feedbackId));
            return true;
          }
          if (command === 'workbench_git_context') return args.sessionId === 's1'
            ? { branch: 'feature/twiglane', commit: null, worktree: null, repository: 'alpha' }
            : args.sessionId === 's2'
          ? { branch: 'feature/beta', commit: null, worktree: null, repository: 'beta' }
          : null;
          if (command === 'git_worktrees') return [];
          if (command === 'workbench_code_status') {
            if (args.sessionId !== 's1' && args.sessionId !== 's2') throw { code: 'session_unknown', message: '找不到这个会话' };
            return {
              sessionId: args.sessionId,
              worktreePath: pairingRemote ? remotePath : args.sessionId === 's1' ? 'C:/work/alpha' : 'C:/work/beta',
              branch: args.sessionId === 's1' ? 'feature/twiglane' : 'feature/beta',
              headOid: harness.headOid,
              uncommittedFiles: harness.files,
              state: 'ready',
              reason: null,
            };
          }
          if (command === 'twiglane_start_review') {
            if (harness.startFails) throw { code: pairingRemote ? 'remote_review_restart' : 'open_failed', message: '审查请求失败' };
            const reviewId = 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(harness.starts.length + 1).padStart(12, '0');
            const review: Review = {
              reviewId,
              sessionId: args.sessionId,
              worktreePath: pairingRemote ? remotePath : args.sessionId === 's1' ? 'C:/work/alpha' : 'C:/work/beta',
              protocolVersion: pairingRemote ? 1 : 2,
              baseline: pairingRemote ? null : harness.headOid,
              status: 'opening',
              reason: null,
              outcome: null,
              headOid: null,
              worktreeState: null,
              meta: {},
              createdAt: Date.now(),
            };
            harness.reviews[reviewId] = review;
            harness.latest[args.sessionId] = reviewId;
            harness.starts.push({ sessionId: args.sessionId, reviewId });
            return { ...review };
          }
          if (command === 'twiglane_review_state') {
            harness.reviewReads.push(String(args.sessionId));
            const reviewId = harness.latest[args.sessionId];
            return reviewId ? { ...harness.reviews[reviewId] } : null;
          }
          if (command === 'twiglane_review_link') {
            const url = String(args.url);
            harness.links.push(url);
            const query = new URLSearchParams(url.split('?')[1] ?? '');
            const ignored = (reason: string) => ({ kind: 'ignored', sessionId: null, reviewId: null, outcome: null, headOid: null, worktreeState: null, reason });
            // 同原生解析：只接受 v2，v1 与其他版本在查注册表之前就被丢弃。
            const remote = pairingRemote && (url.startsWith('cliora://remote-review?') || url.startsWith('cliora://remote-review/?')) && query.get('v') === '1';
            if (!remote && query.get('v') !== '2') return ignored('unsupported_version');
            const meta: Record<string, string> = {};
            for (const [key, value] of query) {
              if (!key.startsWith('meta.')) continue;
              if (!/^meta\.[a-z][a-z0-9-]{0,31}\.[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) || !value || value.length > 128) return ignored('malformed_request');
              meta[key.slice(5)] = value;
            }
            const worktreeState = query.get('worktreeState');
            if (query.get('event') === 'returned' && !['clean', 'dirty', 'unknown'].includes(worktreeState ?? '')) return ignored('malformed_request');
            const reviewId = query.get('reviewId') ?? '';
            const review = harness.reviews[reviewId];
            // 同原生注册表：从未见过的 reviewId 是来源失效，被更新 review 取代才是迟到事件。
            if (!review) {
              return { kind: 'ignored', sessionId: null, reviewId: null, outcome: null, headOid: null, reason: 'unknown_review' };
            }
            if (harness.latest[review.sessionId] !== reviewId) {
              return { kind: 'ignored', sessionId: null, reviewId: null, outcome: null, headOid: null, reason: 'superseded_review' };
            }
            const event = query.get('event');
            if (remote && event === 'opening') {
              review.status = 'preparing';
              return { kind:'opening',sessionId:review.sessionId,reviewId,remoteTargetId:'r1' };
            }
            if (event === 'accepted') {
              review.status = 'accepted';
              return { kind: 'accepted', sessionId: review.sessionId, reviewId, outcome: null, headOid: null, reason: null };
            }
            if (event === 'rejected') {
              review.status = 'rejected';
              review.reason = query.get('reason');
              return { kind: 'rejected', sessionId: review.sessionId, reviewId, outcome: null, headOid: null, reason: review.reason };
            }
            if (remote) {
              review.resultRevision = Number(query.get('resultRevision'));
              review.remoteCheck = {sessionId:review.sessionId, worktreePath:review.worktreePath, headOid:harness.headOid, uncommittedFiles:harness.files, sessionBase:review.baseline, state:'ready'};
            }
            review.status = 'returned';
            review.outcome = query.get('outcome');
            review.headOid = query.get('headOid');
            review.worktreeState = worktreeState;
            review.meta = meta;
            return { kind: 'returned', remoteTargetId: remote ? 'r1' : undefined, sessionId: review.sessionId, reviewId, outcome: review.outcome, headOid: review.headOid, worktreeState, reason: null };
          }
          if (command === 'plugin:deep-link|get_current') {
            if (!coldReview) return null;
            const args = new URLSearchParams({ v: '1', event: 'returned', outcome: 'merged', worktreeState: 'clean', resultRevision: '3', ...coldReview });
            return ['cliora://remote-review/?' + args.toString()];
          }
          if (['write_workbench_session', 'resize_workbench_session'].includes(command)) return null;
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  }, { base: BASE, pairing: options.sessions ?? 'single', tool: options.tool ?? 'claude_code', replay: options.replay ?? 'ready', ended: options.ended === true, resume: options.resume ?? 'available', remotePath: options.remotePath ?? '/srv/alpha', coldReview: options.coldReview ?? null });
}

async function openWorkbench(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '会话列表' }).getByRole('tab').first()).toBeVisible();
}

async function openGitMenu(page: Page, label: RegExp) {
  const chip = page.getByRole('region', { name: '当前会话' }).locator('footer').getByLabel(label);
  await chip.click();
  return page.getByRole('menu', { name: '在工作树中新开会话' });
}

test('worktrees are read only for the open menu, including after idle polling and focus', async ({ page }) => {
  await installDesktop(page);
  await page.clock.install();
  await openWorkbench(page);
  const chip = page.getByRole('region', { name: '当前会话' }).locator('footer').getByLabel(/^Git 分支 feature\/twiglane/);
  await expect(chip).toBeVisible();
  const reads = () => page.evaluate(() => (window as unknown as { __harness: { calls: string[] } }).__harness.calls.filter((name) => name === 'git_worktrees').length);
  await page.clock.fastForward(45_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await reads()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __harness: { calls: string[] } }).__harness.calls.filter((name) => name === 'workbench_code_status'))).toEqual([]);
  await chip.click();
  await expect.poll(reads).toBe(1);
  await page.keyboard.press('Escape');
  await page.clock.fastForward(45_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await reads()).toBe(1);
  await chip.click();
  await expect.poll(reads).toBe(2);
});

test('repeated refreshes serialize Git scans and discard the obsolete result', async ({ page }) => {
  await installDesktop(page);
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, any>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    const scans = { started: 0, active: 0, peak: 0, release: () => {} };
    Object.assign(window, { __scans: scans });
    internals.invoke = async (command, args = {}) => {
      if (command !== 'workbench_code_status') return original(command, args);
      scans.started += 1;
      scans.active += 1;
      scans.peak = Math.max(scans.peak, scans.active);
      const result = await original(command, args);
      if (scans.started === 1) await new Promise<void>((resolve) => { scans.release = resolve; });
      scans.active -= 1;
      return result;
    };
  });
  await openWorkbench(page);
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const retry = menu.getByRole('menuitem', { name: '重新读取状态' });
  for (let index = 0; index < 6; index += 1) await retry.click();
  expect(await page.evaluate(() => (window as unknown as { __scans: { started: number } }).__scans.started)).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { __harness: { files: number } }).__harness.files = 99;
    (window as unknown as { __scans: { release: () => void } }).__scans.release();
  });
  await expect(menu).toContainText('99 个未提交文件');
  expect(await page.evaluate(() => {
    const { started, peak } = (window as unknown as { __scans: { started: number; peak: number } }).__scans;
    return { started, peak };
  })).toEqual({ started: 2, peak: 1 });
});

test('a local session can start a review and sees the receipt', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);

  // The entry lives in the existing Git menu, next to the real uncommitted count.
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });
  await expect(group.getByRole('status')).toHaveText('在 Twiglane 审查、提交或合入；Cliora 不会写入仓库。');
  await expect(group).toContainText('feature/twiglane · 4f3c2b1 · 46 个未提交文件');

  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  await expect(group.getByRole('status')).toHaveText('正在等待 Twiglane 确认…');
  const started = await page.evaluate(() => (window as unknown as { __harness: { starts: Array<{ sessionId: string; reviewId: string }> } }).__harness.starts);
  expect(started).toHaveLength(1);
  expect(started[0].sessionId).toBe('s1');

  await page.evaluate((reviewId) => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=accepted&reviewId=' + reviewId + '&sessionId=s1-0000-0000-0000-000000000000',
  ), started[0].reviewId);

  await expect(group.getByRole('status')).toHaveText('Twiglane 已打开这个工作区，可以开始审查。');
  await expect(group.getByRole('menuitem', { name: '在 Twiglane 中审查' })).toBeVisible();
});

test('an unanswered review becomes unknown after ten seconds and a retry uses a new reviewId', async ({ page }) => {
  await page.clock.install();
  await installDesktop(page);
  await openWorkbench(page);
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });

  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  await expect(group.getByRole('status')).toHaveText('正在等待 Twiglane 确认…');

  await page.clock.fastForward(11_000);
  await expect(group.getByRole('status')).toHaveText('打开结果未知，可能未安装或版本不兼容。');
  await expect(group).toContainText('安装或升级 Twiglane 后可以重新发起');
  // A timeout is never treated as success.
  await expect(group.getByRole('status')).not.toHaveText(/已提交|已合入/);

  await group.getByRole('menuitem', { name: '重新发起审查' }).click();
  const started = await page.evaluate(() => (window as unknown as { __harness: { starts: Array<{ reviewId: string }> } }).__harness.starts);
  expect(started).toHaveLength(2);
  expect(started[1].reviewId).not.toBe(started[0].reviewId);
  await expect(group.getByRole('status')).toHaveText('正在等待 Twiglane 确认…');
});

test('a rejected review shows the stable reason instead of a raw Git error', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });
  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  const started = await page.evaluate(() => (window as unknown as { __harness: { starts: Array<{ reviewId: string }> } }).__harness.starts);

  await page.evaluate((reviewId) => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=rejected&reviewId=' + reviewId + '&sessionId=s1-0000-0000-0000-000000000000&reason=not_a_worktree',
  ), started[0].reviewId);

  await expect(group.getByRole('status')).toHaveText('Twiglane 没有打开这个工作区 · 目标不是 Git 工作树根目录。');
});

test('a returned commit is verified even with the Git menu closed', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });
  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  const started = await page.evaluate(() => (window as unknown as { __harness: { starts: Array<{ reviewId: string }> } }).__harness.starts);
  await page.keyboard.press('Escape');

  // Twiglane really committed: the worktree HEAD is now the returned OID and nothing is left over.
  await page.evaluate((oid) => {
    const harness = (window as unknown as { __harness: { headOid: string; files: number } }).__harness;
    harness.headOid = oid;
    harness.files = 0;
  }, NEXT);
  await page.evaluate((reviewId) => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=returned&reviewId=' + reviewId + '&sessionId=s1-0000-0000-0000-000000000000&outcome=committed&headOid=' + '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' + '&worktreeState=clean',
  ), started[0].reviewId);

  // A closed menu must still verify HEAD before announcing the returned result.
  await expect(page.getByText('Twiglane 已提交 1a2b3c4。').first()).toBeVisible();
  await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  await expect(group.getByRole('status')).toHaveText('Twiglane 已提交 1a2b3c4。');
});

test('a returned result that no longer matches HEAD stays unconfirmed and keeps the real status', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });
  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  const started = await page.evaluate(() => (window as unknown as { __harness: { starts: Array<{ reviewId: string }> } }).__harness.starts);

  // 外部 AI 又提交了一次：返回的 OID 已经不是当前 HEAD。
  await page.evaluate(() => { (window as unknown as { __harness: { headOid: string } }).__harness.headOid = '9999999999999999999999999999999999999999'; });
  await page.evaluate((reviewId) => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=returned&reviewId=' + reviewId + '&sessionId=s1-0000-0000-0000-000000000000&outcome=merged&headOid=' + '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' + '&worktreeState=dirty',
  ), started[0].reviewId);

  await expect(group.getByRole('status')).toHaveText('结果未确认：返回的提交与当前 HEAD 不一致。');
  await expect(group).not.toContainText('已合入');
  // 真实读取仍然展示，并给出重试。
  await expect(group).toContainText('9999999');
  await expect(group.getByRole('menuitem', { name: '重新读取状态' })).toBeVisible();
});

test('an unknown status is shown as unknown and can be retried', async ({ page }) => {
  await installDesktop(page);
  await page.addInitScript(() => {
    const harness = (window as unknown as { __harness: { failStatus?: boolean } }).__harness;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, any>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'workbench_code_status') {
        if ((harness as unknown as { failStatus?: boolean }).failStatus === false) return original(command, args);
        throw { code: 'read_failed', message: '这次没有读到 Git 状态' };
      }
      return original(command, args);
    };
  });
  await openWorkbench(page);
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });
  await expect(group).toContainText('状态未知，可以重新读取');

  await page.evaluate(() => { (window as unknown as { __harness: { failStatus?: boolean } }).__harness.failStatus = false; });
  await group.getByRole('menuitem', { name: '重新读取状态' }).click();
  await expect(group).toContainText('46 个未提交文件');
});

test('a returned link selects the original session instead of inventing one', async ({ page }) => {
  await installDesktop(page, { sessions: 'pair' });
  await openWorkbench(page);
  const rail = page.getByRole('tablist', { name: '会话列表' });
  await page.evaluate(() => (window as unknown as { __seedReview: (review: unknown) => void }).__seedReview({
    reviewId: 'cccccccc-dddd-4eee-8fff-000000000001',
    sessionId: 's2',
    worktreePath: 'C:/work/beta',
    baseline: '4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0',
    status: 'accepted',
    reason: null,
    outcome: null,
    headOid: null,
    createdAt: Date.now() - 20_000,
  }));

  await page.evaluate(() => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=returned&reviewId=cccccccc-dddd-4eee-8fff-000000000001&sessionId=s2-0000-0000-0000-000000000000&outcome=reviewed&worktreeState=dirty',
  ));

  await expect(rail.getByRole('tab', { name: /Codex/ })).toHaveAttribute('aria-selected', 'true');
  await expect(rail.getByRole('tab')).toHaveCount(2);
  const menu = await openGitMenu(page, /^Git 分支 feature\/beta/);
  // v2：reviewed 只表示没有提交或合入，真实未提交文件如实显示，不再说“只做了浏览”。
  const status = menu.getByRole('group', { name: '在 Twiglane 中审查' }).getByRole('status');
  await expect(status).toHaveText('这次没有提交或合入；工作区有 46 个未提交文件。');
  await expect(status).not.toHaveText(/只做了浏览|批准/);
});

/** Start a review on s1 and return its reviewId; the menu stays open. */
async function startOnS1(page: Page) {
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });
  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  const starts = await page.evaluate(() => (window as unknown as { __harness: { starts: Array<{ reviewId: string }> } }).__harness.starts);
  return { group, reviewId: starts[starts.length - 1].reviewId };
}

async function emit(page: Page, url: string) {
  await page.evaluate((link) => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(link), url);
}

const S1 = '&sessionId=s1-0000-0000-0000-000000000000';

test('an edit left uncommitted returns to the original session with the real uncommitted count', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const { group, reviewId } = await startOnS1(page);
  await page.evaluate(() => { (window as unknown as { __harness: { files: number } }).__harness.files = 3; });
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed&worktreeState=dirty');

  await expect(group.getByRole('status')).toHaveText('这次没有提交或合入；工作区有 3 个未提交文件。');
  await expect(group).toContainText('3 个未提交文件');
  // 已经复核真实状态，但没有任何会话或 Git 写入。
  const calls = await page.evaluate(() => (window as unknown as { __harness: { calls: string[] } }).__harness.calls);
  expect(calls).toContain('workbench_code_status');
  expect(calls.filter((name) => /^(launch_|commit|stage|push|discard|reset)/.test(name))).toEqual([]);
});

test('a commit with changes left over is confirmed and still shows the remaining files', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const { group, reviewId } = await startOnS1(page);
  await page.evaluate((oid) => {
    const harness = (window as unknown as { __harness: { headOid: string; files: number } }).__harness;
    harness.headOid = oid;
    harness.files = 2;
  }, NEXT);
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=committed&headOid=' + NEXT + '&worktreeState=dirty');
  await expect(group.getByRole('status')).toHaveText('Twiglane 已提交 1a2b3c4；工作区仍有 2 个未提交文件。');
});

test('a worktree claim that disagrees with the real state stays unconfirmed', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const { group, reviewId } = await startOnS1(page);
  // Twiglane 说干净，但真实工作区仍有 46 个未提交文件。
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed&worktreeState=clean');
  await expect(group.getByRole('status')).toHaveText('结果未确认：Twiglane 声明的工作区状态与当前真实状态不一致。');
  await expect(group).toContainText('以重新读取的真实 Git 状态为准');
  await expect(group).toContainText('46 个未提交文件');
});

test('a returned review whose real status cannot be read is unconfirmed, never clean', async ({ page }) => {
  await installDesktop(page);
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, any>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'workbench_code_status' && (window as unknown as { __failStatus?: boolean }).__failStatus) throw { code: 'read_failed', message: 'x' };
      return original(command, args);
    };
  });
  await openWorkbench(page);
  const { group, reviewId } = await startOnS1(page);
  await page.evaluate(() => { (window as unknown as { __failStatus?: boolean }).__failStatus = true; });
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed&worktreeState=clean');
  await expect(group.getByRole('status')).toHaveText('已返回，但这次没有读到真实 Git 状态，结果未确认。');
  await expect(group).not.toContainText('没有未提交文件');
});

test('a read that never reached Git cannot put a returned review in the review list', async ({ page }) => {
  await installDesktop(page);
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, any>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command !== 'workbench_code_status') return original(command, args);
      const flags = window as unknown as { __failStatus?: boolean; __unknownStatus?: boolean };
      if (flags.__failStatus) throw { code: 'read_failed', message: 'x' };
      if (flags.__unknownStatus) {
        // 扩展宿主能回答，但明确说这次没读到 Git：同样不是真实复核。
        return { sessionId: args.sessionId, worktreePath: 'C:/work/alpha', branch: 'feature/twiglane', headOid: null, uncommittedFiles: null, state: 'unknown', reason: 'git_missing' };
      }
      return original(command, args);
    };
  });
  await openWorkbench(page);
  const rail = page.getByRole('complementary', { name: '会话列表' });
  const row = rail.locator('[data-drag-id="s1"]');
  const { group, reviewId } = await startOnS1(page);

  // 读取失败：菜单如实说未确认，侧栏不能把这次读取当成“审阅结果已核对”。
  await page.evaluate(() => { (window as unknown as { __failStatus?: boolean }).__failStatus = true; });
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed&worktreeState=clean');
  await expect(group.getByRole('status')).toHaveText('已返回，但这次没有读到真实 Git 状态，结果未确认。');
  await expect(row).not.toHaveAttribute('data-task', 'readyReview');
  await expect(row).not.toContainText('审阅结果已核对');
  await expect(rail.locator('[data-bucket="review"]')).toHaveCount(0);

  // state=unknown：重试仍然只得到未知，会话不得因此进入待审阅。
  await page.evaluate(() => {
    const flags = window as unknown as { __failStatus?: boolean; __unknownStatus?: boolean };
    flags.__failStatus = false;
    flags.__unknownStatus = true;
  });
  await group.getByRole('menuitem', { name: '重新读取状态' }).click();
  await expect(group.getByRole('status')).toHaveText('已返回，但这次没有读到真实 Git 状态，结果未确认。');
  await expect(row).not.toHaveAttribute('data-task', 'readyReview');
  await expect(row).not.toContainText('审阅结果已核对');
  await expect(rail.locator('[data-bucket="review"]')).toHaveCount(0);
});

test('bounded meta is kept without changing the verdict, and v1 or malformed extensions write nothing', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const { group, reviewId } = await startOnS1(page);
  await emit(page, 'cliora://review?v=2&event=accepted&reviewId=' + reviewId + S1);
  await expect(group.getByRole('status')).toHaveText('Twiglane 已打开这个工作区，可以开始审查。');

  // 版本不匹配与畸形扩展：都被忽略，状态不变，也不弹“已失效”。
  for (const url of [
    'cliora://review?v=1&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed',
    'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed&worktreeState=dirty&meta.X.y=1',
    'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed',
  ]) {
    await emit(page, url);
  }
  await expect(group.getByRole('status')).toHaveText('Twiglane 已打开这个工作区，可以开始审查。');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const state = await page.evaluate((id) => (window as unknown as { __harness: { reviews: Record<string, { status: string }> } }).__harness.reviews[id], reviewId);
  expect(state.status).toBe('accepted');

  // 合法的说明性 meta 被保留，结论仍由真实 Git 状态决定。
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + reviewId + S1 + '&outcome=reviewed&worktreeState=dirty&meta.twiglane.version=0.3.3');
  await expect(group.getByRole('status')).toHaveText('这次没有提交或合入；工作区有 46 个未提交文件。');
  await expect(group).not.toContainText('0.3.3');
  const kept = await page.evaluate((id) => (window as unknown as { __harness: { reviews: Record<string, { meta?: Record<string, string> }> } }).__harness.reviews[id].meta, reviewId);
  expect(kept).toEqual({ 'twiglane.version': '0.3.3' });
});

test('reviewing again after a return uses a new reviewId and the current HEAD, and the late old return is ignored', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const first = await startOnS1(page);
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + first.reviewId + S1 + '&outcome=reviewed&worktreeState=dirty');
  await expect(first.group.getByRole('status')).toHaveText('这次没有提交或合入；工作区有 46 个未提交文件。');

  // 用户在原会话里继续修复并提交了：HEAD 前进。再次审查是一次新的发起。
  await page.evaluate((oid) => { (window as unknown as { __harness: { headOid: string } }).__harness.headOid = oid; }, NEXT);
  await first.group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  const second = await page.evaluate(() => {
    const harness = (window as unknown as { __harness: { starts: Array<{ reviewId: string }>; reviews: Record<string, { baseline: string | null }> } }).__harness;
    const last = harness.starts[harness.starts.length - 1];
    return { reviewId: last.reviewId, count: harness.starts.length, baseline: harness.reviews[last.reviewId].baseline };
  });
  expect(second.count).toBe(2);
  expect(second.reviewId).not.toBe(first.reviewId);
  expect(second.baseline).toBe(NEXT);
  await expect(first.group.getByRole('status')).toHaveText('正在等待 Twiglane 确认…');

  // 旧审查迟到的 returned 不覆盖新审查。
  await emit(page, 'cliora://review?v=2&event=returned&reviewId=' + first.reviewId + S1 + '&outcome=committed&headOid=' + NEXT + '&worktreeState=clean');
  await expect(page.getByRole('alert').first()).toContainText('原 cliora 审查会话已失效');
  await expect(first.group.getByRole('status')).toHaveText('正在等待 Twiglane 确认…');
});

test('a remote session reviews its own worktree, stays pending during installation, and verifies a remote return', async ({ page }) => {
  await installDesktop(page, { sessions: 'remote' });
  await openWorkbench(page);
  await page.getByRole('button', { name: '在 Twiglane 中审查', exact: true }).click();
  const group = page.getByRole('menu', {name:'在 Twiglane 中审查'}).getByRole('group', {name:'在 Twiglane 中审查'});
  await expect(group).toContainText('Build box · /srv/alpha');
  await expect(page.getByRole('menuitem', {name:'新建工作树'})).toHaveCount(0);
  await group.getByRole('menuitem',{name:'在 Twiglane 中审查'}).click();
  await expect(group).toContainText('此会话没有可用的起始基线');
  const id=await page.evaluate(() => (window as unknown as {__harness:{starts:{reviewId:string}[]}}).__harness.starts[0].reviewId);
  const send=(tail:string)=>page.evaluate(url => (window as unknown as {__emitDeepLink:(url:string)=>void}).__emitDeepLink(url), 'cliora://remote-review?v=1&reviewId='+id+'&sessionId=s1&'+tail);
  await send('event=opening');
  await expect(group.getByRole('status')).toHaveText('Twiglane 正在连接远端，或等待确认安装 agent。');
  await send('event=returned&outcome=reviewed&worktreeState=clean&resultRevision=1');
  await expect(page.getByText(/Twiglane 声明的工作区状态与当前真实状态不一致/).first()).toBeVisible();
  await page.evaluate(() => { (window as unknown as {__harness:{startFails:boolean}}).__harness.startFails = true; });
  if (!await group.isVisible()) await page.getByRole('button', {name:'在 Twiglane 中审查', exact:true}).click();
  await group.getByRole('menuitem',{name:'在 Twiglane 中审查'}).click();
  await expect(group.getByRole('alert')).toContainText('请在目标工作树重新开启远端会话');
});

test('a Windows remote review can resend the exact merged URL after an unverified return', async ({ page }) => {
  const repository = 'C:/目录 with spaces/alpha';
  await installDesktop(page, { sessions: 'remote', remotePath: repository });
  await openWorkbench(page);
  await page.getByRole('button', { name: '在 Twiglane 中审查', exact: true }).click();
  const group = page.getByRole('menu', { name: '在 Twiglane 中审查' }).getByRole('group', { name: '在 Twiglane 中审查' });
  await expect(group).toContainText('Build box · ' + repository);
  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  const url = await page.evaluate((oid) => {
    const bridge = window as unknown as {
      __harness: { starts: { reviewId: string }[]; headOid: string; files: number };
    };
    const review = bridge.__harness.starts[0];
    bridge.__harness.headOid = oid;
    return 'cliora://remote-review/?v=1&event=returned&outcome=merged&worktreeState=clean&resultRevision=3&sessionId=s1&reviewId=' + review.reviewId + '&headOid=' + oid;
  }, NEXT);
  const send = () => page.evaluate(value => (window as unknown as {__emitDeepLink: (link: string) => void}).__emitDeepLink(value), url);
  await send();
  await expect(page.getByText(/Twiglane 声明的工作区状态与当前真实状态不一致/).first()).toBeVisible();
  await page.evaluate(() => {
    const bridge = window as unknown as {__harness: { files: number }};
    bridge.__harness.files = 0;
  });
  await send();
  await expect(page.getByText('Twiglane 已合入 ' + NEXT.slice(0, 7) + '。').first()).toBeVisible();
  const repeats = await page.evaluate(value => (window as unknown as {__harness: {links: string[]}}).__harness.links.filter(link => link === value).length, url);
  expect(repeats).toBe(2);
  await expect(page.getByRole('dialog', { name: 'Twiglane 审查结果' })).toHaveCount(0);
});

test('a Windows cold-start return opens the original saved review without a live tab', async ({ page }) => {
  const repository = 'D:/目录 with spaces/alpha';
  const sessionId = '998aaaaa-1111-4222-8333-444444444444';
  await installDesktop(page, {
    sessions: 'remote', remotePath: repository,
    coldReview: { sessionId, reviewId: 'f10ccccc-1111-4222-8333-444444444444', headOid: NEXT },
  });
  await page.goto('/');
  const result = page.getByRole('dialog', { name: 'Twiglane 审查结果' });
  await expect(result.getByRole('status')).toHaveText('Twiglane 已合入 ' + NEXT.slice(0, 7) + '。');
  await expect(result).toContainText('Build box');
  await expect(result.getByText(repository, {exact: true})).toBeVisible();
  await expect(result.getByText(sessionId, {exact: true})).toBeVisible();
  await expect(result.getByText(NEXT, {exact: true})).toBeVisible();
  const reads = await page.evaluate(() => (window as unknown as {
    __harness: { reviewReads: string[]; calls: string[]; sessions: unknown[] };
  }).__harness);
  expect(reads.reviewReads).toEqual([sessionId]);
  expect(reads.sessions).toEqual([]);
  expect(reads.calls.filter(command => /^(launch_|reattach_|restore_workbench)/.test(command))).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(result).toHaveCount(0);
});

/** A review link may only read: it never starts a session and never writes Git. */
const SESSION_OR_GIT_WRITE = /^(launch_cli|launch_|commit|stage|git_commit|git_stage|push|cleanup_worktree|save_worktree_prepare|discard|reset)/;
async function expectNoSessionOrGitWrite(page: Page) {
  const called = await page.evaluate(() => (window as unknown as {
    __harness: { calls: string[]; starts: unknown[]; sessions: unknown[] };
  }).__harness);
  expect(called.calls.filter((name) => SESSION_OR_GIT_WRITE.test(name))).toEqual([]);
  expect(called.starts).toEqual([]);
  expect(called.sessions).toHaveLength(1);
}

test('an unknown reviewId is reported instead of silently ignored', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const rail = page.getByRole('tablist', { name: '会话列表' });
  await expect(rail.getByRole('tab')).toHaveCount(1);

  await page.evaluate(() => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=returned&reviewId=99999999-8888-4777-8666-555555555555&sessionId=s1-0000-0000-0000-000000000000&outcome=reviewed&worktreeState=dirty',
  ));

  // 注册表里没有这个 review：明确说明无法返回，而不是停在原来的会话上假装无事。
  const alert = page.getByRole('alert').first();
  await expect(alert).toContainText('原 cliora 审查会话已失效，无法返回。');
  await expect(alert).toContainText('请在 cliora 中重新发起这次审查');
  await expect(rail.getByRole('tab')).toHaveCount(1);
  await expectNoSessionOrGitWrite(page);
});

test('a returned link for a closed session is reported without starting a replacement', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  await page.evaluate((baseline) => (window as unknown as { __seedReview: (review: unknown) => void }).__seedReview({
    reviewId: 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc',
    sessionId: 's1',
    worktreePath: 'C:/work/alpha',
    baseline,
    status: 'accepted',
    reason: null,
    outcome: null,
    headOid: null,
    createdAt: Date.now() - 30_000,
  }), BASE);
  // 发起审查之后原会话被关掉了：列表里已经没有它。
  await page.evaluate(() => { (window as unknown as { __harness: { sessionClosed: boolean } }).__harness.sessionClosed = true; });

  await page.evaluate(() => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=returned&reviewId=eeeeeeee-ffff-4aaa-8bbb-cccccccccccc&sessionId=s1-0000-0000-0000-000000000000&outcome=committed&headOid=1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d&worktreeState=clean',
  ));

  const alert = page.getByRole('alert').first();
  await expect(alert).toContainText('原 cliora 审查会话已失效，无法返回。');
  // 不创建替代会话，也不发起任何 Git 操作。
  await expectNoSessionOrGitWrite(page);
  const links = await page.evaluate(() => (window as unknown as { __harness: { links: string[] } }).__harness.links);
  expect(links).toHaveLength(1);
  // 没有把这次返回说成提交成功。
  await expect(page.getByText('Twiglane 已提交')).toHaveCount(0);
});

test('a superseded reviewId is reported and never overwrites the newer review', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  await page.evaluate((baseline) => {
    const seed = (window as unknown as { __seedReview: (review: unknown) => void }).__seedReview;
    seed({ reviewId: 'aaaaaaaa-1111-4222-8333-444444444444', sessionId: 's1', worktreePath: 'C:/work/alpha', baseline, status: 'accepted', reason: null, outcome: null, headOid: null, createdAt: Date.now() - 60_000 });
    seed({ reviewId: 'bbbbbbbb-2222-4333-8444-555555555555', sessionId: 's1', worktreePath: 'C:/work/alpha', baseline, status: 'opening', reason: null, outcome: null, headOid: null, createdAt: Date.now() - 1_000 });
  }, BASE);

  // 迟到的 returned 指向被新链接取代的旧 reviewId。
  await page.evaluate(() => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=returned&reviewId=aaaaaaaa-1111-4222-8333-444444444444&sessionId=s1-0000-0000-0000-000000000000&outcome=merged&headOid=1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d&worktreeState=clean',
  ));

  await expect(page.getByRole('alert').first()).toContainText('原 cliora 审查会话已失效，无法返回。');
  await expectNoSessionOrGitWrite(page);
  // 新 review 仍是唯一有效的一条，旧事件没有被当成结果展示。
  const latest = await page.evaluate(() => {
    const harness = (window as unknown as { __harness: { latest: Record<string, string>; reviews: Record<string, { status: string; outcome: string | null }> } }).__harness;
    return harness.reviews[harness.latest.s1];
  });
  expect(latest.status).toBe('opening');
  expect(latest.outcome).toBeNull();
});

test('a verified return drives the shared task state and its own next step', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const row = page.locator('[data-drag-id="s1"]');
  // Nothing is verified yet: a running session with no evidence is not a review.
  await expect(row).toHaveAttribute('data-task', 'unknown');
  const menu = await openGitMenu(page, /^Git 分支 feature\/twiglane/);
  const group = menu.getByRole('group', { name: '在 Twiglane 中审查' });
  await group.getByRole('menuitem', { name: '在 Twiglane 中审查' }).click();
  const started = await page.evaluate(() => (window as unknown as { __harness: { starts: Array<{ reviewId: string }> } }).__harness.starts);
  await page.keyboard.press('Escape');

  // Twiglane really committed: the worktree HEAD is the returned OID and nothing is left over.
  await page.evaluate((oid) => {
    const harness = (window as unknown as { __harness: { headOid: string; files: number } }).__harness;
    harness.headOid = oid;
    harness.files = 0;
  }, NEXT);
  await page.evaluate((reviewId) => (window as unknown as { __emitDeepLink: (url: string) => void }).__emitDeepLink(
    'cliora://review?v=2&event=returned&reviewId=' + reviewId + '&sessionId=s1-0000-0000-0000-000000000000&outcome=committed&headOid=1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d&worktreeState=clean',
  ), started[0].reviewId);
  await expect(page.getByText('Twiglane 已提交 1a2b3c4。').first()).toBeVisible();

  // The rail reads the same verified fact as the title bar and the review group.
  await expect(row).toHaveAttribute('data-task', 'readyReview');
  await expect(row).toHaveAttribute('data-bucket', 'review');
  await expect(page.locator('[data-group="review"]')).toContainText('待审阅');

});

test('the task menu opens this session in Twiglane directly instead of an inline card', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  const row = page.locator('[data-drag-id="s1"]');
  const starts = () => page.evaluate(() => (window as unknown as { __harness: { calls: string[] } }).__harness.calls
    .filter((name) => name === 'twiglane_start_review').length);
  await page.getByRole('region', { name: '当前会话' }).getByRole('button', { name: '更多终端操作' }).click();
  await page.getByRole('menu', { name: '终端操作' }).getByRole('menuitem', { name: '在 Twiglane 中查看改动', exact: true }).click();
  await expect.poll(starts).toBe(1);
  // Nothing is rendered beside or under the row.
  await expect(row.locator('[data-task-detail]')).toHaveCount(0);
  await expect(page.locator('[data-drag-id="s1"] [data-session-id="s1"]')).toHaveAttribute('aria-selected', 'true');
});

// Codex 的输入框与其快捷键脚注落在终端最后几行；适配器只读这部分屏幕。
const CODEZ_COMPOSER = '\r\n'.repeat(20) + '\u203a \r\n? for shortcuts';
const FEEDBACK_LINK = 'cliora://review-feedback?v=1&feedbackId=8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1&reviewId=6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8&sessionId=s1&resultRevision=2&digest=082476955cbba23ba6e82c2eacfff6d59f82c347b088fdb2df0f426ee62c56fc';

function feedbackPreview(overrides: Record<string, unknown> = {}) {
  return {
    feedbackId: '8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1',
    reviewId: '6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8',
    sessionId: 's1',
    resultRevision: 2,
    worktreePath: 'C:/work/alpha',
    rangeVersion: 'range-7',
    commentCount: 2,
    comments: [
      { path: 'src/lib/api.ts', kind: 'add', oldNo: null, newNo: 13, body: '这里要在读取失败时保留上一份结果。' },
      { path: 'src/lib/api.ts', kind: 'add', oldNo: null, newNo: 14, body: '补一句 title 的回退说明。' },
    ],
    state: 'prepared',
    ...overrides,
  };
}

test('a received feedback batch is previewed and written to the terminal only once', async ({ page }) => {
  // Codex's own screen reader reports a composer, so this is the one case that may write.
  await installDesktop(page, { tool: 'codex', replay: CODEZ_COMPOSER });
  await openWorkbench(page);
  await page.evaluate((preview) => (window as unknown as { __setFeedback: (value: unknown) => void }).__setFeedback(preview), feedbackPreview());

  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);

  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  // 预览只显示来源、数量与只读正文，不启动会话也不写 Git。
  await expect(panel).toContainText('来自审查 6f1a2b3c · 第 2 次结果 · 2 条');
  await expect(panel).toContainText('src/lib/api.ts:13');
  await expect(panel).toContainText('这里要在读取失败时保留上一份结果。');
  await expectNoSessionOrGitWrite(page);

  const send = panel.getByRole('button', { name: '发送到终端', exact: true });
  await expect(send).toBeVisible();
  await send.click();
  await page.evaluate(() => { /* 状态在原生侧已经是 written */ });
  await expect(panel).toContainText('已写入终端一次，不代表 Agent 已处理。');
  await expect(panel.getByRole('button', { name: '发送到终端', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('status')).toContainText('已写入终端一次');
  const sends = await page.evaluate(() => (window as unknown as { __harness: { feedbackSends: string[] } }).__harness.feedbackSends);
  expect(sends).toEqual(['8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1']);
  await expectNoSessionOrGitWrite(page);
});

test('without inputReady evidence the batch offers a copy instead of a native send', async ({ page }) => {
  // A CLI with no screen reader keeps the generic unknown interface: no native send.
  await installDesktop(page);
  await openWorkbench(page);
  await page.evaluate((preview) => (window as unknown as { __setFeedback: (value: unknown) => void }).__setFeedback(preview), feedbackPreview());
  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);

  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送到终端', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '复制意见', exact: true })).toBeVisible();
  await expect(panel).toContainText('当前终端界面没有可输入提示框');
  const sends = await page.evaluate(() => (window as unknown as { __harness: { feedbackSends: string[] } }).__harness.feedbackSends);
  expect(sends).toEqual([]);
});

test('cancelling a preview writes nothing and dries the staged batch', async ({ page }) => {
  await installDesktop(page, { tool: 'codex', replay: CODEZ_COMPOSER });
  await openWorkbench(page);
  await page.evaluate((preview) => (window as unknown as { __setFeedback: (value: unknown) => void }).__setFeedback(preview), feedbackPreview());
  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);

  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(panel).toHaveCount(0);

  const state = await page.evaluate(() => (window as unknown as { __harness: { feedbackDismissed: string[]; feedbackSends: string[] } }).__harness);
  expect(state.feedbackDismissed).toEqual(['8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1']);
  expect(state.feedbackSends).toEqual([]);
  await expectNoSessionOrGitWrite(page);
});

test('a rejected or repeated feedback link is reported without opening a preview or a session', async ({ page }) => {
  await installDesktop(page);
  await openWorkbench(page);
  // 同一个 feedbackId 只能暂存一次：原生层已经拒绝，这里不应出现预览。
  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);

  const alert = page.getByRole('alert').first();
  await expect(alert).toContainText('这批审阅意见已经接收过。');
  await expect(page.getByRole('region', { name: 'Twiglane 审阅意见' })).toHaveCount(0);
  await expectNoSessionOrGitWrite(page);
  const links = await page.evaluate(() => (window as unknown as { __harness: { feedbackLinks: string[] } }).__harness.feedbackLinks);
  expect(links).toEqual([FEEDBACK_LINK]);
});

test('an unknown write result keeps the batch copy-only and never sends it again', async ({ page }) => {
  // Codex 报告了可输入提示框，所以这是唯一可能写入的界面；让原生这一次写入失败。
  await installDesktop(page, { tool: 'codex', replay: CODEZ_COMPOSER });
  await openWorkbench(page);
  await page.evaluate((preview) => (window as unknown as { __setFeedback: (value: unknown) => void }).__setFeedback(preview), feedbackPreview());
  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);
  await page.evaluate(() => { (window as unknown as { __harness: { feedbackWriteFails: boolean } }).__harness.feedbackWriteFails = true; });

  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '发送到终端', exact: true }).click();

  // 结果未知不是"没写过"：面板只剩复制入口，重试按钮不再出现。
  await expect(panel).toContainText('上次写入的结果未知');
  await expect(panel.getByRole('button', { name: '发送到终端', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '复制意见', exact: true })).toBeVisible();
  const attempts = await page.evaluate(() => (window as unknown as { __harness: { feedbackSends: string[]; feedbackStaged: Record<string, { state: string }> } }).__harness);
  expect(attempts.feedbackSends).toEqual(['8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1']);
  expect(attempts.feedbackStaged['8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1'].state).toBe('uncertain');

  // 再发一次只会被原生拒绝：同一批意见不会第二次写进终端。
  const second = await page.evaluate(async (id) => {
    const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
    try { await invoke('twiglane_feedback_send', { feedbackId: id, sessionId: 's1' }); return 'sent'; }
    catch (error) { return (error as { code?: string }).code; }
  }, '8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1');
  expect(second).toBe('feedback_send_uncertain');
  await expectNoSessionOrGitWrite(page);
});

test('a restored session keeps the batch preview and sends only after a second confirmation', async ({ page }) => {
  // 会话已经结束：预览仍在，但只能恢复后再确认，或直接复制。
  await installDesktop(page, { tool: 'codex', replay: CODEZ_COMPOSER, ended: true });
  await openWorkbench(page);
  await page.evaluate((preview) => (window as unknown as { __setFeedback: (value: unknown) => void }).__setFeedback(preview), feedbackPreview());
  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);

  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('原会话已经结束');
  await expect(panel.getByRole('button', { name: '发送到终端', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '复制意见', exact: true })).toBeVisible();

  // 恢复用的是会话横幅里真实存在的入口，恢复过程本身不发送。
  await page.getByRole('button', { name: '恢复会话', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('src/lib/api.ts:13');
  let sends = await page.evaluate(() => (window as unknown as { __harness: { feedbackSends: string[] } }).__harness.feedbackSends);
  expect(sends).toEqual([]);

  // 恢复后的新会话有了可输入证据，用户再确认一次才会写入，且写到新会话 id。
  const send = panel.getByRole('button', { name: '发送到终端', exact: true });
  await expect(send).toBeVisible();
  await send.click();
  await expect(panel).toContainText('已写入终端一次');
  const result = await page.evaluate(() => (window as unknown as { __harness: { feedbackSends: string[]; feedbackTargets: Array<string | null>; restoreCalls: string[] } }).__harness);
  expect(result.feedbackSends).toEqual(['8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1']);
  expect(result.feedbackTargets).toEqual(['s1b']);
  expect(result.restoreCalls).toEqual(['s1']);
  await expectNoSessionOrGitWrite(page);
});

test('an ended session whose CLI cannot resume is never pointed at a missing resume button', async ({ page }) => {
  // 这个适配器声明 resume/history 不可用：会话横幅只有「重启会话」，根本没有恢复入口。
  await installDesktop(page, { tool: 'codex', replay: CODEZ_COMPOSER, ended: true, resume: 'unsupported' });
  await openWorkbench(page);
  await page.evaluate((preview) => (window as unknown as { __setFeedback: (value: unknown) => void }).__setFeedback(preview), feedbackPreview());
  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);

  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  // 页面上没有恢复按钮，提示也绝不指向它：只说这批意见只能复制、回原任务继续。
  await expect(page.getByRole('button', { name: '恢复会话', exact: true })).toHaveCount(0);
  await expect(panel).toContainText('原会话已经结束，Codex 不支持从工作台恢复');
  await expect(panel).toContainText('只能复制');
  await expect(panel).not.toContainText('恢复会话');
  await expect(panel.getByRole('button', { name: '发送到终端', exact: true })).toHaveCount(0);

  // 复制入口仍然可用，并且复制不会触发发送、恢复或任何会话写入。
  const copy = panel.getByRole('button', { name: '复制意见', exact: true });
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(page.getByText(/已复制意见|没有复制成功/).first()).toBeVisible();
  const state = await page.evaluate(() => (window as unknown as { __harness: { feedbackSends: string[]; restoreCalls: string[] } }).__harness);
  expect(state.feedbackSends).toEqual([]);
  expect(state.restoreCalls).toEqual([]);
  await expectNoSessionOrGitWrite(page);
});

test('a remote session only offers a copy with the reason, never a native send', async ({ page }) => {
  await installDesktop(page, { sessions: 'remote', tool: 'codex', replay: CODEZ_COMPOSER });
  await openWorkbench(page);
  await page.evaluate((preview) => (window as unknown as { __setFeedback: (value: unknown) => void }).__setFeedback(preview), feedbackPreview({ worktreePath: '/srv/alpha' }));
  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);

  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  // 远程会话不在本机 PTY 里：只说明原因并给复制入口。
  await expect(panel).toContainText('远程会话不在本机终端里');
  await expect(panel.getByRole('button', { name: '发送到终端', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '复制意见', exact: true })).toBeVisible();
  const sends = await page.evaluate(() => (window as unknown as { __harness: { feedbackSends: string[] } }).__harness.feedbackSends);
  expect(sends).toEqual([]);
});

