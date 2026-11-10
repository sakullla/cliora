import { expect, test, type Page } from '@playwright/test';

const BASE = '4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0';
const NEXT = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';

/**
 * The workbench talks to Twiglane only through the four native commands and the
 * deep-link plugin. This harness fakes the OS link layer, keeps the same
 * reviewId rules as the Rust registry (only the latest review of a session is
 * accepted) and records every call the tests assert on.
 */
async function installDesktop(page: Page, options: { sessions?: 'single' | 'pair' | 'remote' } = {}) {
  await page.addInitScript(({ base, pairing }) => {
    type Review = {
      reviewId: string;
      sessionId: string;
      worktreePath: string;
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
    const sessions = (pairing === 'pair'
      ? [
          { id: 's1', toolId: 'claude_code', projectId: null, directory: 'C:/work/alpha', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000 },
          { id: 's2', toolId: 'codex', projectId: null, directory: 'C:/work/beta', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 30_000 },
        ]
      : pairingRemote
        ? [
            { id: 's1', toolId: 'claude_code', projectId: 'remote:p1', directory: '/srv/alpha', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000, connectionState: 'connected' },
          ]
        : [
            { id: 's1', toolId: 'claude_code', projectId: null, directory: 'C:/work/alpha', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000 },
          ]).map((item) => ({ ...item }));
    const harness = {
      reviews: {} as Record<string, Review>,
      latest: {} as Record<string, string>,
      starts: [] as Array<{ sessionId: string; reviewId: string }>,
      links: [] as string[],
      calls: [] as string[],
      sessions,
      headOid: base as string,
      files: 46,
      startFails: false,
      sessionClosed: false,
    };
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const names: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex' };
    Object.assign(window, {
      isTauri: true,
      __harness: harness,
      __emitDeepLink: (url: string) => {
        bridge.handlers[bridge.listens['deep-link://new-url']]?.({ payload: [url] });
      },
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
            ? [{ id: 'p1', targetId: 'r1', name: 'alpha', path: '/srv/alpha', preferredTool: null, updatedAt: 1 }]
            : [];
          if (command === 'list_cli_adapters') return { registered: Object.entries(names).map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } })), managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return harness.sessionClosed ? [] : sessions.map((item) => ({ ...item }));
          if (command === 'launch_cli') throw { code: 'unexpected_launch', message: 'the review link must never start a session' };
          if (command === 'replay_workbench_session') return btoa('ready');
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
              worktreePath: args.sessionId === 's1' ? 'C:/work/alpha' : 'C:/work/beta',
              branch: args.sessionId === 's1' ? 'feature/twiglane' : 'feature/beta',
              headOid: harness.headOid,
              uncommittedFiles: harness.files,
              state: 'ready',
              reason: null,
            };
          }
          if (command === 'twiglane_start_review') {
            if (harness.startFails) throw { code: 'open_failed', message: '系统没有接受打开 Twiglane 的请求。' };
            const reviewId = 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(harness.starts.length + 1).padStart(12, '0');
            const review: Review = {
              reviewId,
              sessionId: args.sessionId,
              worktreePath: args.sessionId === 's1' ? 'C:/work/alpha' : 'C:/work/beta',
              baseline: harness.headOid,
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
            const reviewId = harness.latest[args.sessionId];
            return reviewId ? { ...harness.reviews[reviewId] } : null;
          }
          if (command === 'twiglane_review_link') {
            const url = String(args.url);
            harness.links.push(url);
            const query = new URLSearchParams(url.split('?')[1] ?? '');
            const ignored = (reason: string) => ({ kind: 'ignored', sessionId: null, reviewId: null, outcome: null, headOid: null, worktreeState: null, reason });
            // 同原生解析：只接受 v2，v1 与其他版本在查注册表之前就被丢弃。
            if (query.get('v') !== '2') return ignored('unsupported_version');
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
            if (event === 'accepted') {
              review.status = 'accepted';
              return { kind: 'accepted', sessionId: review.sessionId, reviewId, outcome: null, headOid: null, reason: null };
            }
            if (event === 'rejected') {
              review.status = 'rejected';
              review.reason = query.get('reason');
              return { kind: 'rejected', sessionId: review.sessionId, reviewId, outcome: null, headOid: null, reason: review.reason };
            }
            review.status = 'returned';
            review.outcome = query.get('outcome');
            review.headOid = query.get('headOid');
            review.worktreeState = worktreeState;
            review.meta = meta;
            return { kind: 'returned', sessionId: review.sessionId, reviewId, outcome: review.outcome, headOid: review.headOid, worktreeState, reason: null };
          }
          if (command === 'plugin:deep-link|get_current') return null;
          if (['write_workbench_session', 'resize_workbench_session'].includes(command)) return null;
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return [];
        },
      },
    });
  }, { base: BASE, pairing: options.sessions ?? 'single' });
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

test('a remote session has no local review entry', async ({ page }) => {
  await installDesktop(page, { sessions: 'remote' });
  await openWorkbench(page);
  // 远程会话在 native 层就被拒绝，界面上也不给可误打开本地同名仓库的入口。
  await expect(page.getByRole('tablist', { name: '会话列表' }).getByRole('tab', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /在 Twiglane 中审查/ })).toHaveCount(0);
  const starts = await page.evaluate(() => (window as unknown as { __harness: { starts: unknown[] } }).__harness.starts);
  expect(starts).toHaveLength(0);
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
