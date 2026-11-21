/** Browser-only review/source model shared by the UI regression and capture tool.
 * This intentionally simulates IPC and scheme delivery, never native acceptance.
 */
import { installWorkspaceFixtures } from './capture-workspace-fixtures.mjs';
import { installPromptFixtureBridge, installRichPromptFixtures } from './capture-prompt-fixtures.mjs';

export const REVIEW_SESSION_A = '0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0';
export const REVIEW_SESSION_B = '2c3d4e5f-6071-4283-94a5-b6c7d8e9f0a1';

export async function installReviewDesktop(page, theme = 'light') {
  await page.addInitScript(({ theme, sessionA, sessionB }) => {
    const listeners = new Map(); const callbacks = []; let nextListenerId = 1;
    const bridge = { listens: [], unlistens: [], emits: [], active: [] }; window.__reviewBridge = bridge;
    const unregister = (event, id) => {
      if (listeners.get(id)?.event === event) listeners.delete(id);
      bridge.active = [...listeners.entries()].map(([eventId, listener]) => ({ eventId, ...listener }));
    };
    const sessions = [
      { id: sessionA, toolId: 'codex', projectId: null, directory: '/work/commerce/team-0/api', running: true, mode: 'normal', exitCode: null },
      { id: sessionB, toolId: 'codex', projectId: null, directory: '/work/payments/api', running: true, mode: 'normal', exitCode: null },
    ];
    Object.assign(window, { isTauri: true, __reviewSessions: sessions, __reviewCalls: [], __feedbackCalls: [], __reviewFeedback: null, __reviewFeedbackPending: null, __setReviewFeedback: preview => { window.__reviewFeedbackPending = preview; }, __emitReviewLink: url => {
      const active = [...listeners.entries()].filter(([, listener]) => listener.event === 'deep-link://new-url');
      const params = new URL(url).searchParams;
      bridge.emits.push({ listeners: active.map(([eventId, listener]) => ({ eventId, handler: listener.handler })), event: params.get('event'), reviewId: params.get('reviewId') });
      for (const [eventId, listener] of active) callbacks[listener.handler]?.({ event: listener.event, id: eventId, payload: [url] });
      return active.length > 0;
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: unregister }, __TAURI_INTERNALS__: {
      transformCallback: callback => { callbacks.push(callback); return callbacks.length - 1; },
      invoke: async (command, args = {}) => {
        window.__reviewCalls.push({ command, args });
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', launchForm: 'terminal', interfaceFormats: [], nativeConfig: { state: 'supported', reason: '' }, launch: { state: 'supported', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], worktreeLaunch: 'direct' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'list_workbench_sessions') return structuredClone(sessions);
        // A Codex composer at the bottom of the screen: the one interface that may receive a send.
        if (command === 'replay_workbench_session') return btoa('\r\n'.repeat(20) + '> \r\n? for shortcuts');
        if (command === 'plugin:event|listen') {
          const eventId = nextListenerId++; listeners.set(eventId, { event: args.event, handler: args.handler });
          bridge.listens.push({ event: args.event, handler: args.handler, eventId });
          bridge.active = [...listeners.entries()].map(([eventId, listener]) => ({ eventId, ...listener }));
          return eventId;
        }
        if (command === 'plugin:event|unlisten') { bridge.unlistens.push(args); unregister(args.event, args.eventId); return null; }
        if (command === 'workbench_git_context') return { branch: args.sessionId === sessionA ? 'feature/api' : 'main', commit: 'a'.repeat(40), worktree: null, repository: args.sessionId === sessionA ? 'api' : 'payment-api' };
        if (command === 'git_worktrees') return [];
        if (command.startsWith('list_')) return [];
        return null;
      },
    } });
  }, { theme, sessionA: REVIEW_SESSION_A, sessionB: REVIEW_SESSION_B });
  await page.addInitScript(installWorkspaceFixtures);
  await page.addInitScript(installPromptFixtureBridge);
  await page.addInitScript(installRichPromptFixtures);
  await page.addInitScript(() => {
    const workspace = window.__workspaceFixture;
    const workspaceIds = ['11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444'];
    const repositoryIds = {};
    const oldWorkspaceIds = {};
    workspace.workspaces.forEach((project, index) => {
      oldWorkspaceIds[project.id] = workspaceIds[index]; project.id = workspaceIds[index];
      project.repositories.forEach((repo, repoIndex) => {
        const id = `${index ? '66666666' : '22222222'}-2222-4222-8222-${String(repoIndex).padStart(12, '0')}`;
        repositoryIds[repo.id] = id; repo.id = id;
      });
    });
    for (const doc of window.__promptFixture.documents.local) {
      if (doc.scope.workspaceId) doc.scope.workspaceId = oldWorkspaceIds[doc.scope.workspaceId];
      if (doc.scope.repositoryId) doc.scope.repositoryId = repositoryIds[doc.scope.repositoryId];
    }
    workspace.contexts = window.__reviewSessions.map((session, index) => ({ sessionId: session.id, workspaceId: workspaceIds[index], repositoryId: workspace.workspaces[index].repositories[0].id, hostId: 'local', directory: session.directory }));
    const original = window.__TAURI_INTERNALS__.invoke;
    const fixture = window.__reviewFixture = { outgoing: [], reviews: {}, latest: {}, statuses: {}, ignored: [], incoming: [] };
    for (const session of window.__reviewSessions) fixture.statuses[session.id] = { sessionId: session.id, worktreePath: session.directory, branch: 'main', headOid: 'a'.repeat(40), uncommittedFiles: 2, state: 'ready', reason: null };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'workbench_code_status') return structuredClone(fixture.statuses[args.sessionId]);
      if (command === 'twiglane_review_state') return structuredClone(fixture.reviews[fixture.latest[args.sessionId]] ?? null);
      if (command === 'twiglane_start_review') {
        const context = workspace.contexts.find(item => item.sessionId === args.sessionId);
        const session = window.__reviewSessions.find(item => item.id === args.sessionId);
        const project = workspace.workspaces.find(item => item.id === context.workspaceId);
        const review = { protocolVersion: 3, resultRevision: 0, reviewId: crypto.randomUUID(), sessionId: session.id, worktreePath: session.directory, baseline: 'a'.repeat(40), workspaceId: context.workspaceId, repositoryId: context.repositoryId, workspaceName: project.name, status: 'opening', reason: null, outcome: null, headOid: null, worktreeState: null, meta: {}, createdAt: Date.now() };
        fixture.reviews[review.reviewId] = review; fixture.latest[review.sessionId] = review.reviewId;
        const params = new URLSearchParams({ v: '3', reviewId: review.reviewId, sessionId: review.sessionId, worktreePath: review.worktreePath, baseline: review.baseline, workspaceId: review.workspaceId, repositoryId: review.repositoryId, workspaceName: review.workspaceName });
        fixture.outgoing.push('twiglane://review?' + params.toString().replace(/\+/g, '%20'));
        return structuredClone(review);
      }
      if (command === 'twiglane_review_link') {
        const params = new URL(args.url).searchParams; const id = params.get('reviewId'); const sessionId = params.get('sessionId');
        const review = fixture.reviews[id]; const event = params.get('event'); const revision = Number(params.get('resultRevision'));
        const ignored = reason => { fixture.ignored.push(reason); fixture.incoming.push({ reviewId: id, sessionId, event, kind: 'ignored', reason }); return { kind: 'ignored', reason }; };
        if (!review || review.sessionId !== sessionId) return ignored('unknown_review');
        if (fixture.latest[sessionId] !== id) return ignored('superseded_review');
        if (params.get('v') !== String(review.protocolVersion)) return ignored('source_version_mismatch');
        if (event === 'returned' && (!Number.isSafeInteger(revision) || revision <= review.resultRevision)) return ignored('duplicate_result');
        if (event !== 'returned' && review.status === 'returned') return ignored('late_receipt');
        Object.assign(review, { status: event, reason: params.get('reason'), outcome: params.get('outcome'), headOid: params.get('headOid'), worktreeState: params.get('worktreeState'), resultRevision: event === 'returned' ? revision : review.resultRevision });
        fixture.incoming.push({ reviewId: id, sessionId, event, kind: event, revision: review.resultRevision });
        return { kind: event, reviewId: id, sessionId, outcome: review.outcome, headOid: review.headOid, worktreeState: review.worktreeState, reason: review.reason };
      }
      // feedback-v1：接收只产生预览，发送由用户确认后记录一次。
      if (command === 'twiglane_feedback_link') {
        const preview = window.__reviewFeedbackPending;
        window.__feedbackCalls.push({ command, url: args.url });
        if (!preview) throw { code: 'feedback_invalid', message: '审阅意见文件的结构不符合协议。', action: '在 Twiglane 中重新准备送回原任务。' };
        window.__reviewFeedbackPending = null;
        window.__reviewFeedback = { ...preview };
        return structuredClone(window.__reviewFeedback);
      }
      if (command === 'twiglane_feedback_send') {
        const preview = window.__reviewFeedback;
        window.__feedbackCalls.push({ command, feedbackId: args.feedbackId });
        if (!preview || preview.state !== 'prepared') throw { code: 'feedback_already_sent', message: '这批审阅意见已经写入过终端一次。' };
        window.__reviewFeedback = { ...preview, state: 'written' };
        return { feedbackId: preview.feedbackId, sessionId: preview.sessionId, state: 'written' };
      }
      if (command === 'twiglane_feedback_dismiss') {
        window.__feedbackCalls.push({ command, feedbackId: args.feedbackId });
        return true;
      }
      return original(command, args);
    };
  });
}
