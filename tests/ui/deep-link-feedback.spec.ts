import { expect, test, type Page } from '@playwright/test';
import { installConfigurationWorkspace } from './configuration-workspace-fixture';

const FEEDBACK_LINK = 'cliora://review-feedback?v=1&feedbackId=8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1&reviewId=6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8&sessionId=s1&resultRevision=2&digest=082476955cbba23ba6e82c2eacfff6d59f82c347b088fdb2df0f426ee62c56fc';

function feedbackPreview() {
  return {
    feedbackId: '8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1',
    reviewId: '6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8',
    sessionId: 's1',
    resultRevision: 2,
    worktreePath: 'C:/work/alpha',
    rangeVersion: 'range-7',
    commentCount: 1,
    comments: [{ path: 'src/lib/api.ts', kind: 'add', oldNo: null, newNo: 13, body: '这里要在读取失败时保留上一份结果。' }],
    state: 'prepared',
  };
}

/**
 * 深链交接需要工作台与 Twiglane 命令；草稿拦截需要工具页。"放弃草稿"这一支只有真实切换
 * 路径才走得到，所以这里在工具页夹具之上补一层最小的工作台桩，专门验证接收后的批次不会
 * 因为切页被拒而消失。
 */
async function install(page: Page, feedback: Record<string, unknown>) {
  await installConfigurationWorkspace(page, 'codex');
  await page.addInitScript((preview) => {
    const app = window as any;
    const base = app.__TAURI_INTERNALS__.invoke;
    const callbacks = new Map<number, (event: unknown) => void>();
    const handlers = new Map<string, number[]>();
    let callbackId = 0;
    app.__TAURI_INTERNALS__.transformCallback = (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; };
    app.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    const state = app.feedbackHandoff = {
      feedbackLinks: [] as string[],
      feedbackNext: preview as Record<string, unknown> | null,
      sessions: [{ id: 's1', toolId: 'codex', projectId: null, directory: 'C:/work/alpha', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() - 60_000 }],
      emit: (url: string) => { for (const id of handlers.get('deep-link://new-url') ?? []) callbacks.get(id)?.({ event: 'deep-link://new-url', id: 1, payload: [url] }); },
    };
    app.__emitDeepLink = (url: string) => state.emit(url);
    app.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      if (command === 'plugin:event|listen') { handlers.set(args.event, [...(handlers.get(args.event) ?? []), args.handler]); return args.handler; }
      if (command === 'plugin:event|unlisten') return null;
      if (command === 'plugin:deep-link|get_current') return [];
      // 工作台需要终端适配器；工具页只关心同一份清单里的配置能力。
      if (command === 'list_cli_adapters') {
        const catalog = await base(command, args);
        for (const tool of catalog.registered ?? []) Object.assign(tool, {
          name: 'Codex',
          launchForm: 'terminal',
          launch: { state: 'available', reason: '' },
          nativeConfig: { state: 'available', reason: '' },
          resume: { state: 'available', reason: '' },
          history: { state: 'available', reason: '' },
        });
        return catalog;
      }
      if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
      if (command === 'list_workbench_sessions') return state.sessions.map((item: unknown) => ({ ...(item as object) }));
      if (command === 'replay_workbench_session') return btoa('ready');
      if (command === 'workbench_git_context') return { branch: 'feature/twiglane', commit: null, worktree: null, repository: 'alpha' };
      if (command === 'workbench_code_status') return { sessionId: 's1', worktreePath: 'C:/work/alpha', branch: 'feature/twiglane', headOid: '4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0', uncommittedFiles: 2, state: 'ready', reason: null };
      if (command === 'twiglane_review_state') return null;
      if (command === 'twiglane_feedback_link') {
        state.feedbackLinks.push(String(args.url));
        const next = state.feedbackNext;
        if (!next) throw { code: 'feedback_duplicate', message: '这批审阅意见已经接收过。', action: '在 Twiglane 中重新准备一批新的意见。' };
        state.feedbackNext = null;
        return { ...next };
      }
      if (command === 'twiglane_feedback_dismiss') return true;
      return base(command, args);
    };
  }, feedback);
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '页面' }).getByRole('button', { name, exact: true });

test('a refused page switch keeps a received feedback batch for the next workbench visit', async ({ page }) => {
  await install(page, feedbackPreview());
  await page.goto('/');

  // 工具页里留着未保存的配置：切页要先问，而用户拒绝了。
  await nav(page, '工具').click();
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  await page.getByRole('dialog').getByLabel('配置名称').fill('仍在编辑的配置');

  await page.evaluate((url) => (window as unknown as { __emitDeepLink: (value: string) => void }).__emitDeepLink(url), FEEDBACK_LINK);
  const confirmation = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(nav(page, '工具')).toHaveAttribute('aria-current', 'page');
  // 一次性文件已经被原生消费，链接也只读取了一次。
  expect(await page.evaluate(() => (window as unknown as { feedbackHandoff: { feedbackLinks: string[] } }).feedbackHandoff.feedbackLinks)).toEqual([FEEDBACK_LINK]);

  // 离开工具页之后，这一批仍然在工作台上等着，没有被静默吞掉。
  await nav(page, '工作台').dispatchEvent('click');
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(nav(page, '工作台')).toHaveAttribute('aria-current', 'page');
  const panel = page.getByRole('region', { name: 'Twiglane 审阅意见' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('src/lib/api.ts:13');
  await expect(panel.getByRole('button', { name: '复制意见', exact: true })).toBeVisible();
});
