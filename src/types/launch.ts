export type LaunchMode = 'normal' | 'yolo';
export type TerminalId = 'auto' | 'workbench' | 'windows_terminal' | 'pwsh' | 'power_shell' | 'cmd' | 'mac_terminal' | 'custom' | 'gnome_terminal' | 'konsole' | 'xterm' | 'desktop';

export type TerminalOption = { id: TerminalId; label: string; available: boolean };
export type CustomTerminal = { program: string; args: string[] };
export type TerminalPreset = { id: string; label: string; program: string; args: string[] };
export type LaunchSettings = { selected: TerminalId; terminals: TerminalOption[]; presets?: TerminalPreset[]; custom?: CustomTerminal | null; cliMode?: LaunchMode; projectMode?: LaunchMode };

export function preferredLaunchMode(settings: LaunchSettings | null, target: 'cli' | 'project', yoloAvailable: boolean): LaunchMode {
  const preferred = target === 'cli' ? settings?.cliMode : settings?.projectMode;
  return preferred === 'yolo' && yoloAvailable ? 'yolo' : 'normal';
}

export type Project = {
  id: string;
  name: string;
  path: string | null;
  available: boolean;
  preferredTool: string | null;
  lastOpened: number;
  modelOverrides: Record<string, string>;
  selectedProfiles: Record<string, string>;
  appliedProfiles: Record<string, string>;
  reapplyProfiles: Record<string, string>;
};

export type RemoteLaunchIntent = { kind: 'new' } | { kind: 'reattach'; remoteSessionId: string };
export type LaunchRequest = { toolId: string; projectId: string | null; sessionId: string | null; mode: LaunchMode; directory?: string | null; initialPrompt?: string | null; resumeLatest?: boolean; remoteIntent?: RemoteLaunchIntent };
export type LaunchResult = { toolId: string; projectId: string | null; mode: LaunchMode; terminal: TerminalId; status: 'terminal_requested' | 'desktop_requested' | 'session_started'; sessionId?: string | null; remoteSessionId?: string | null; warnings?: string[] };
/** Recent session output: a mode prelude plus the retained bytes, ending at stream offset `endOffset`. */
export type WorkbenchReplay = { dataBase64: string; endOffset: number; cols: number; rows: number };
export type WorkbenchTerminalSize = { cols: number; rows: number };
/** `cliora:session-output` payload. `offset` numbers the first byte within the session stream. */
export type WorkbenchOutput = { sessionId: string; dataBase64: string; offset?: number };
export type WorkbenchExit = { sessionId: string; exitCode: number | null; stateRevision?: number };
/** Best-effort Git hint for a local session directory. */
export type WorkbenchGitContext = { branch: string | null; commit: string | null; worktree: string | null; repository: string | null };
export type RemoteSessionEndResult = { outcome: 'confirmed_absent' | 'failed' | 'unknown'; stage: string; exitCode: number | null };
export type WorkbenchSession = { id: string; toolId: string; projectId: string | null; directory: string; mode: LaunchMode; running: boolean; exitCode: number | null; startedAt?: number; connectionState?: 'connecting' | 'connected' | 'disconnected' | 'remote_ended' | 'unknown' | 'closed'; exitReason?: 'running' | 'process_exit' | 'connection_lost' | 'remote_ended' | 'unknown'; reattachable?: boolean; remoteSessionId?: string | null; remoteEndResult?: RemoteSessionEndResult | null; stateRevision?: number };
export type SavedWorkbenchSession = { id: string; toolId: string; projectId: string | null; directory: string; mode: LaunchMode; startedAt: number; stoppedAt: number | null; nativeId: string | null; accountId: string | null; contextId: string | null };
export type WorkbenchRestoreReport = { restored: Record<string, string>; failures: Array<{ session: SavedWorkbenchSession; detail: string }> };
export type TrayStatus = { available: boolean; error: string | null };

export type TrayRepairTarget = {
  page: 'home' | 'connections' | 'settings';
  resourceView?: 'config' | 'mcp' | 'skills' | null;
  toolId: string | null;
  scope: 'global' | 'project' | null;
  projectId: string | null;
  projectPath: string | null;
  profileId: string | null;
  sequence: number;
};

export type RemoteSessionIndexEntry = { remoteSessionId: string; projectId: string; targetId: string; toolId: string; directory: string; mode: LaunchMode; startedAt: number; lastSeenAt: number };
