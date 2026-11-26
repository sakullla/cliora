import type { Page } from '@playwright/test';

/**
 * Synthetic native IPC for the ACP conversation surface. Nothing here spawns a CLI,
 * calls a model or reads a real conversation: the host is a plain object the test
 * drives, so the assertions are about Cliora's own wiring only.
 */
type Config = {
  interaction?: 'terminal' | 'acp';
  interactionError?: string | null;
  conversations?: Snapshot[];
  failInteractionSave?: boolean;
  failLaunch?: string | null;
  sessions?: Array<Record<string, unknown>>;
};

type Snapshot = {
  id: string;
  toolId: string;
  projectId: string | null;
  directory: string;
  mode: 'normal' | 'yolo';
  interaction: 'acp';
  state: string;
  nativeSessionId: string | null;
  resume: string;
  messages: Array<{ id: string; role: string; text: string; truncated: boolean }>;
  tools: Array<{ callId: string; title: string; status: string; detail: string }>;
  permissions: Array<{ requestId: string; turnId: string; title: string; detail: string; options: Array<{ optionId: string; name: string; kind: string }> }>;
  diagnostics: string[];
  lastTurnReason: string;
  seq: number;
};

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
            const snapshot = {
              id, toolId: String(request.toolId), projectId: (request.projectId as string | null) ?? null, directory: 'C:/work',
              mode: 'normal', interaction: 'acp' as const, state: 'running', nativeSessionId: 'native-1', resume: 'none',
              messages: [{ id: 'm0', role: 'user', text: 'first prompt', truncated: false }],
              tools: [], permissions: [], diagnostics: [], lastTurnReason: '', seq: 1,
            };
            if (!find(id)) conversations.push(snapshot as Snapshot);
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
    nativeSessionId: 'native-1', resume: 'none', messages: [], tools: [], permissions: [], diagnostics: [], lastTurnReason: '', seq: 1,
    ...overrides,
  } as Snapshot;
}

export async function openWorkbench(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
}

