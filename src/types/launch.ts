export type LaunchMode = 'normal' | 'yolo';
export type TerminalId = 'auto' | 'windows_terminal' | 'power_shell' | 'mac_terminal' | 'gnome_terminal' | 'konsole' | 'xterm';

export type TerminalOption = { id: TerminalId; label: string; available: boolean };
export type LaunchSettings = { selected: TerminalId; terminals: TerminalOption[]; cliMode?: LaunchMode; projectMode?: LaunchMode };

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

export type LaunchRequest = { toolId: string; projectId: string | null; sessionId: string | null; mode: LaunchMode; directory?: string | null };
export type LaunchResult = { toolId: string; projectId: string | null; mode: LaunchMode; terminal: TerminalId; status: 'terminal_requested' };
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
