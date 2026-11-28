import type { Page } from '@playwright/test';
import type { AcpNativeSession, AcpSessionSnapshot } from '../../src/types/acp';

/**
 * Synthetic native IPC for the ACP conversation surface. Nothing here spawns a CLI,
 * calls a model or reads a real conversation: the host is a plain object the test
 * drives, so the assertions are about Cliora's own wiring only.
 */
/** The one tool's ACP declaration, exactly as the registry publishes it. The UI must
 *  follow this field, not the tool id, so a test can declare any of the three states. */
type AcpDeclaration = {
  state: 'supported' | 'unverified' | 'unsupported';
  evidence?: 'interactive' | 'handshake' | 'documented' | 'none';
  reason?: string;
  entry?: { executable: string; args: string[]; origin: 'native' | 'vendor' | 'bridge'; dependency?: { name: string; installHint: string; installer?: 'npm' | 'pipx' }; capabilities?: Record<string, boolean>; yolo?: { kind: 'client' } | { kind: 'args'; args: string[] } | { kind: 'mode'; modeId: string } };
};

type Config = {
  interaction?: 'terminal' | 'acp';
  /** Defaults to a verified entry so the existing conversation flows stay unchanged. */
  acp?: AcpDeclaration;
  interactionError?: string | null;
  conversations?: Snapshot[];
  remoteHost?: boolean;
  failInteractionSave?: boolean;
  failLaunch?: string | null;
  sessions?: Array<Record<string, unknown>>;
  /** The terminal launch's own YOLO arguments; defaults to available. */
  yoloAvailable?: boolean;
  /** acp_authenticate rejects with this reason. */
  failAuth?: string | null;
  /** acp_list_files answers from these relative paths (substring match). */
  files?: string[];
  /** acp_read_image answers: a path maps to its image or to a refusal reason; any
   *  other path is refused. */
  images?: Record<string, { name?: string; mimeType: string; dataBase64: string; size?: number } | string>;
  /** acp_native_sessions answers these pages in order (cursor `page-N`). */
  nativeSessions?: AcpNativeSession[][];
  /** acp_native_sessions rejects with this reason (an agent without session/list). */
  nativeSessionsError?: string | null;
  /** The app theme the bootstrap reports; the terminal theme follows it. */
  theme?: 'light' | 'dark';
};

/** The host's own snapshot shape: the mock never invents a field the host lacks. */
type Snapshot = AcpSessionSnapshot;

export async function installAcpMock(page: Page, config: Config = {}) {
  await page.addInitScript((config: Config) => {
    if (config.remoteHost) localStorage.setItem('cliora:remote-target', 'ssh-fixture');
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const conversations: Snapshot[] = (config.conversations ?? []).map((item) => JSON.parse(JSON.stringify(item)));
    const state = {
      interaction: config.interaction ?? 'acp',
      interactionError: config.interactionError ?? null,
      failInteractionSave: config.failInteractionSave ?? false,
      failLaunch: config.failLaunch ?? null,
      conversations,
      installedOn: [] as string[],
      interactionSaves: [] as string[],
      launches: [] as Array<Record<string, unknown>>,
      prompts: [] as Array<[string, string]>,
      attachments: [] as Array<[string, unknown[]]>,
      authentications: [] as Array<[string, string]>,
      failAuth: config.failAuth ?? null,
      elicitationAnswers: [] as Array<[string, string, string, unknown]>,
      fileQueries: [] as Array<[string, string, number]>,
      imageReads: [] as Array<[string, string]>,
      /** acp_read_image waits for window.__acpReleaseImage() while set. */
      holdImage: false,
      /** acp_list_files waits for window.__acpReleaseFiles() while set. */
      holdFiles: false,
      historyQueries: [] as Array<[string, string | null]>,
      deletions: [] as Array<[string, string]>,
      modes: [] as Array<[string, string]>,
      configs: [] as Array<[string, string, unknown]>,
      failSetting: null as string | null,
      /** acp_prompt rejects with this reason while set (tests set it at run time). */
      failPrompt: null as string | null,
      /** acp_prompt waits for window.__acpReleasePrompt(reason?) while set. */
      holdPrompt: false,
      cancels: [] as string[],
      answers: [] as Array<[string, string, string | null]>,
      accessAnswers: [] as Array<[string, string, string]>,
      revokes: [] as Array<[string, string[]]>,
      kills: [] as Array<[string, string]>,
      opens: [] as Array<[string, string]>,
      closes: [] as string[],
      sessions: (config.sessions ?? []) as Array<Record<string, unknown>>,
    };
    const emit = (name: string, payload: unknown) => {
      const index = bridge.listens[name];
      if (index === undefined) return;
      bridge.handlers[index]?.({ payload });
    };
    // Published on the descriptor exactly like the registry does, entry included.
    const acpDeclaration = (): Record<string, unknown> => {
      const declared = config.acp ?? { state: 'supported' as const, evidence: 'interactive' as const, reason: '' };
      return {
        state: declared.state,
        evidence: declared.evidence ?? (declared.state === 'unsupported' ? 'none' : 'handshake'),
        reason: declared.reason ?? '',
        ...(declared.entry ? { entry: { capabilities: { session: true, authorization: true, cancel: true, resume: false }, args: [], origin: 'native', executable: 'codex-acp', ...declared.entry } } : {}),
      };
    };
    const settings = () => ({
      selected: 'workbench',
      terminals: [{ id: 'workbench', label: '工作台', available: true }, { id: 'windows_terminal', label: 'Windows Terminal', available: true }],
      cliMode: 'normal' as const,
      projectMode: 'normal' as const,
      interaction: state.interaction,
      interactionError: state.interactionError,
      presets: [],
    });
    const find = (id: string) => conversations.find((item) => item.id === id);
    Object.assign(window, {
      isTauri: true,
      __acpTest: state,
      __acpEvent: (event: Record<string, unknown>) => emit('cliora:acp-event', event),
      /** A native (desktop) drop: the webview delivers paths at a physical position. */
      __acpDrop: (paths: string[], position: { x: number; y: number }) => emit('tauri://drag-drop', { type: 'drop', paths, position }),
      __acpSessionState: (id: string, patch: Record<string, unknown>) => {
        const snapshot = find(id);
        if (snapshot) Object.assign(snapshot, patch);
        emit('cliora:acp-event', { sessionId: id, seq: Number(patch.seq ?? snapshot?.seq ?? 1), kind: 'snapshot', snapshot });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: config.theme ?? 'light', remote_ssh_enabled: !!config.remoteHost }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return {
            registered: [{
              id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: config.yoloAvailable ?? true, resumeLatestAvailable: false, projectModelOverride: false,
              launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' },
              resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
              acp: acpDeclaration(),
            }],
            managedIds: ['codex'],
            preservedUnknown: [],
          };
          if (command === 'get_launch_settings') return settings();
          if (command === 'set_launch_interaction') {
            state.interactionSaves.push(args.mode);
            if (state.failInteractionSave) throw { message: '启动方式写入失败' };
            state.interaction = args.mode;
            state.interactionError = null;
            return settings();
          }
          if (command === 'set_preferred_terminal') return settings();
          if (command === 'get_tray_status') return { available: true, error: null };
          if (command === 'list_workbench_sessions') return state.sessions;
          if (command === 'list_workbench_restore_sessions') return [];
          if (command === 'list_projects') return [];
          if (command === 'list_business_workspaces' || command === 'list_workspace_session_contexts') return [];
          if (command === 'list_remote_projects') return config.remoteHost ? [{ id: 'folder', targetId: 'ssh-fixture', name: 'repo', path: '/srv/repo', updatedAt: 1 }] : [];
          if (command === 'list_remote_targets') return config.remoteHost ? [{ id: 'ssh-fixture', name: 'SSH fixture', host: 'example.test', user: 'fixture', port: 22, authMethod: 'key', enabled: true, defaultPath: '/srv/repo', updatedAt: 1 }] : [];
          if (command === 'acp_dependency_installed') return state.installedOn.includes(args.targetId ?? 'local');
          if ((command === 'maintain_registered_cli' || command === 'maintain_remote_cli') && args.action === 'install_acp') {
            state.installedOn.push(command === 'maintain_remote_cli' ? args.targetId : 'local');
            return { output: 'installed', version: null };
          }
          if (command === 'list_remote_sessions') return [];
          if (command === 'list_worktree_ledger') return [];
          if (command === 'list_acp_sessions') return conversations;
          if (command === 'acp_session') return find(args.sessionId) ?? null;
          if (command === 'acp_prompt') {
            if (state.failPrompt) throw { message: state.failPrompt };
            // A prompt whose attachment waits for an approval card: it answers only when
            // the test releases it (with a reason to reject, as a stop or a denial does).
            if (state.holdPrompt) {
              return new Promise((resolve, reject) => {
                (window as any).__acpReleasePrompt = (reason?: string) => {
                  state.holdPrompt = false;
                  if (reason) { reject({ message: reason }); return; }
                  state.prompts.push([args.sessionId, args.text]); state.attachments.push([args.sessionId, args.attachments ?? []]);
                  resolve(null);
                };
              });
            }
            state.prompts.push([args.sessionId, args.text]); state.attachments.push([args.sessionId, args.attachments ?? []]); return null;
          }
          if (command === 'acp_authenticate') {
            state.authentications.push([args.sessionId, args.methodId]);
            if (state.failAuth) throw { message: state.failAuth };
            return null;
          }
          if (command === 'acp_respond_elicitation') { state.elicitationAnswers.push([args.sessionId, args.requestId, args.action, args.content ?? null]); return null; }
          if (command === 'acp_list_files') {
            state.fileQueries.push([args.sessionId, args.query ?? '', args.limit ?? 50]);
            const query = String(args.query ?? '').toLowerCase();
            const files = (config.files ?? []).filter((path) => path.toLowerCase().includes(query)).slice(0, Number(args.limit ?? 50));
            const answer = { files, truncated: false, source: 'git' };
            if (state.holdFiles) return new Promise((resolve) => { (window as any).__acpReleaseFiles = () => { state.holdFiles = false; resolve(answer); }; });
            return answer;
          }
          if (command === 'acp_read_image') {
            state.imageReads.push([args.sessionId, args.path]);
            const known = (config.images ?? {})[args.path];
            const answer = () => {
              if (known === undefined) throw { message: '文件不存在' };
              if (typeof known === 'string') throw { message: known };
              const name = known.name ?? String(args.path).split(/[\\/]/).pop();
              return { name, mimeType: known.mimeType, dataBase64: known.dataBase64, size: known.size ?? Math.floor(known.dataBase64.length * 3 / 4) };
            };
            if (state.holdImage) {
              return new Promise((resolve, reject) => {
                (window as any).__acpReleaseImage = () => { state.holdImage = false; try { resolve(answer()); } catch (error) { reject(error); } };
              });
            }
            return answer();
          }
          if (command === 'acp_native_sessions') {
            state.historyQueries.push([args.sessionId, args.cursor ?? null]);
            if (config.nativeSessionsError) throw { message: config.nativeSessionsError };
            const pages = config.nativeSessions ?? [[]];
            const index = args.cursor ? Number(String(args.cursor).replace('page-', '')) : 0;
            return { sessions: pages[index] ?? [], nextCursor: index + 1 < pages.length ? `page-${index + 1}` : null };
          }
          if (command === 'acp_delete_native_session') { state.deletions.push([args.sessionId, args.nativeId]); return null; }
          if (command === 'acp_cancel') { state.cancels.push(args.sessionId); return null; }
          if (command === 'acp_respond_permission') { state.answers.push([args.sessionId, args.requestId, args.optionId ?? null]); return null; }
          if (command === 'acp_respond_access') { state.accessAnswers.push([args.sessionId, args.accessId, args.decision]); return null; }
          if (command === 'acp_revoke_grants') { state.revokes.push([args.sessionId, args.kinds]); return null; }
          if (command === 'acp_kill_terminal') { state.kills.push([args.sessionId, args.terminalId]); return null; }
          if (command === 'open_workbench_path') { state.opens.push([args.sessionId, args.path]); return null; }
          if (command === 'acp_set_mode') {
            state.modes.push([args.sessionId, args.modeId]);
            if (state.failSetting) throw { message: state.failSetting };
            return null;
          }
          if (command === 'acp_set_config') {
            state.configs.push([args.sessionId, args.configId, args.value]);
            if (state.failSetting) throw { message: state.failSetting };
            return null;
          }
          if (command === 'acp_close') {
            state.closes.push(args.sessionId);
            const index = conversations.findIndex((item) => item.id === args.sessionId);
            if (index >= 0) conversations.splice(index, 1);
            return null;
          }
          if (command === 'launch_cli') {
            const request = args.request as Record<string, unknown>;
            state.launches.push(request);
            if (state.failLaunch && request.interaction !== 'terminal') throw new Error(state.failLaunch as string);
            if (request.interaction === 'terminal') {
              const id = 't1';
              state.sessions.unshift({ id, toolId: request.toolId, projectId: request.projectId ?? null, directory: 'C:/work', mode: request.mode ?? 'normal', running: true, exitCode: null, startedAt: Date.now() });
              return { toolId: request.toolId, projectId: request.projectId ?? null, mode: request.mode ?? 'normal', terminal: 'workbench', interaction: 'terminal', status: 'session_started', sessionId: id };
            }
            const id = 'a1';
            const snapshot: Snapshot = {
              id, toolId: String(request.toolId), projectId: (request.projectId as string | null) ?? null, directory: 'C:/work',
              mode: request.mode === 'yolo' ? 'yolo' : 'normal', interaction: 'acp', state: 'running', nativeSessionId: (request.resumeNativeId as string | null) ?? 'native-1', resume: request.resumeNativeId ? 'resumed' : 'none', authError: null,
              timeline: [{ kind: 'message', id: 'turn-0-user', role: 'user', text: 'first prompt', truncated: false, turnId: 'turn-0', subagent: null }],
              pending: [], grants: [], terminals: [], plan: [], commands: [], config: { modes: null, options: [], models: null },
              info: { title: null, updatedAt: null, usage: null },
              agent: { protocolVersion: 1, agentInfo: null, promptCapabilities: { image: false, audio: false, embeddedContext: false }, sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [] },
              diagnostics: [], lastTurnReason: '', seq: 1,
            };
            if (!find(id)) conversations.push(snapshot);
            return { toolId: request.toolId, projectId: request.projectId ?? null, mode: snapshot.mode, terminal: 'workbench', interaction: 'acp', status: 'acp_started', sessionId: id };
          }
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          return null;
        },
      },
    });
  }, config);
}

export function snapshot(overrides: Partial<Snapshot> & { id: string }): Snapshot {
  return {
    toolId: 'codex', projectId: null, directory: 'C:/work', mode: 'normal', interaction: 'acp', state: 'ready',
    nativeSessionId: 'native-1', resume: 'none', authError: null, timeline: [], pending: [], grants: [], terminals: [], plan: [], commands: [],
    config: { modes: null, options: [], models: null }, info: { title: null, updatedAt: null, usage: null },
    agent: { protocolVersion: 1, agentInfo: null, promptCapabilities: { image: false, audio: false, embeddedContext: false }, sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [] },
    diagnostics: [], lastTurnReason: '', seq: 1,
    ...overrides,
  };
}

/** One agent reply as a timeline message. */
export function agentMessage(id: string, text: string, extra: Record<string, unknown> = {}) {
  return { kind: 'message' as const, id, role: 'agent' as const, text, truncated: false, turnId: 'turn-1', subagent: null, ...extra };
}

/** One tool call as the host publishes it, merged in place by its id. */
export function toolCall(callId: string, extra: Record<string, unknown> = {}) {
  return { id: `tool:${callId}`, callId, title: callId, toolKind: 'other', status: 'pending', content: [], locations: [], rawInput: null, turnId: 'turn-1', subagent: null, permission: null, ...extra };
}

export async function openWorkbench(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
}

/** One tool call as a timeline entry of a snapshot. */
export function toolItem(callId: string, extra: Record<string, unknown> = {}) {
  return { kind: 'tool' as const, ...toolCall(callId, extra) };
}
