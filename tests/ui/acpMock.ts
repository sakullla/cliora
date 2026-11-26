import type { Page } from '@playwright/test';
import type { AcpSessionSnapshot } from '../../src/types/acp';

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
  entry?: { executable: string; args: string[]; origin: 'native' | 'vendor' | 'bridge'; dependency?: { name: string; installHint: string }; capabilities?: Record<string, boolean> };
};

type Config = {
  interaction?: 'terminal' | 'acp';
  /** Defaults to a verified entry so the existing conversation flows stay unchanged. */
  acp?: AcpDeclaration;
  interactionError?: string | null;
  conversations?: Snapshot[];
  failInteractionSave?: boolean;
  failLaunch?: string | null;
  sessions?: Array<Record<string, unknown>>;
};

/** The host's own snapshot shape: the mock never invents a field the host lacks. */
type Snapshot = AcpSessionSnapshot;

export async function installAcpMock(page: Page, config: Config = {}) {
  await page.addInitScript((config: Config) => {
    const bridge: { handlers: Array<(event: { payload: unknown }) => void>; listens: Record<string, number> } = { handlers: [], listens: {} };
    const conversations: Snapshot[] = (config.conversations ?? []).map((item) => JSON.parse(JSON.stringify(item)));
    const state = {
      interaction: config.interaction ?? 'acp',
      interactionError: config.interactionError ?? null,
      failInteractionSave: config.failInteractionSave ?? false,
      failLaunch: config.failLaunch ?? null,
      conversations,
      interactionSaves: [] as string[],
      launches: [] as Array<Record<string, unknown>>,
      prompts: [] as Array<[string, string]>,
      modes: [] as Array<[string, string]>,
      configs: [] as Array<[string, string, unknown]>,
      failSetting: null as string | null,
      cancels: [] as string[],
      answers: [] as Array<[string, string, string | null]>,
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
      __acpSessionState: (id: string, patch: Record<string, unknown>) => {
        const snapshot = find(id);
        if (snapshot) Object.assign(snapshot, patch);
        emit('cliora:acp-event', { sessionId: id, seq: Number(patch.seq ?? snapshot?.seq ?? 1), kind: 'snapshot', snapshot });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return {
            registered: [{
              id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false,
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
          if (command === 'list_remote_projects') return [];
          if (command === 'list_remote_targets') return [];
          if (command === 'list_remote_sessions') return [];
          if (command === 'list_worktree_ledger') return [];
          if (command === 'list_acp_sessions') return conversations;
          if (command === 'acp_session') return find(args.sessionId) ?? null;
          if (command === 'acp_prompt') { state.prompts.push([args.sessionId, args.text]); return null; }
          if (command === 'acp_cancel') { state.cancels.push(args.sessionId); return null; }
          if (command === 'acp_respond_permission') { state.answers.push([args.sessionId, args.requestId, args.optionId ?? null]); return null; }
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
              mode: 'normal', interaction: 'acp', state: 'running', nativeSessionId: 'native-1', resume: 'none',
              timeline: [{ kind: 'message', id: 'turn-0-user', role: 'user', text: 'first prompt', truncated: false, turnId: 'turn-0', subagent: null }],
              pending: [], plan: [], commands: [], config: { modes: null, options: [], models: null },
              info: { title: null, updatedAt: null, usage: null },
              agent: { protocolVersion: 1, agentInfo: null, promptCapabilities: { image: false, audio: false, embeddedContext: false }, sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [] },
              diagnostics: [], lastTurnReason: '', seq: 1,
            };
            if (!find(id)) conversations.push(snapshot);
            return { toolId: request.toolId, projectId: request.projectId ?? null, mode: 'normal', terminal: 'workbench', interaction: 'acp', status: 'acp_started', sessionId: id };
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
    nativeSessionId: 'native-1', resume: 'none', timeline: [], pending: [], plan: [], commands: [],
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

