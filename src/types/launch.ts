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

export type LaunchRequest = { toolId: string; projectId: string | null; sessionId: string | null; mode: LaunchMode; directory?: string | null; initialPrompt?: string | null; resumeLatest?: boolean };
export type LaunchResult = { toolId: string; projectId: string | null; mode: LaunchMode; terminal: TerminalId; status: 'terminal_requested' | 'desktop_requested' | 'session_started'; sessionId?: string | null; remoteSessionId?: string | null };
/** Recent session output: a mode prelude plus the retained bytes, ending at stream offset `endOffset`. */
export type WorkbenchReplay = { dataBase64: string; endOffset: number };
/** `cliora:session-output` payload. `offset` numbers the first byte within the session stream. */
export type WorkbenchOutput = { sessionId: string; dataBase64: string; offset?: number };
export type WorkbenchSession = { id: string; toolId: string; projectId: string | null; directory: string; mode: LaunchMode; running: boolean; exitCode: number | null; startedAt?: number; connectionState?: 'connected' | 'disconnected' | 'closed'; exitReason?: 'running' | 'process_exit' | 'connection_lost'; reattachable?: boolean; remoteSessionId?: string | null };
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
