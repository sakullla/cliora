export type RemoteTarget = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authMethod: 'key' | 'password';
  identityFile?: string | null;
  sshConfig?: string | null;
  defaultPath?: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type RemoteProject = {
  id: string;
  targetId: string;
  name: string;
  path: string;
  preferredTool?: string | null;
  updatedAt: number;
};

export type RemoteProbe = {
  targetId: string;
  stage: string;
  reachable: boolean;
  identity?: string | null;
  system?: string | null;
  home?: string | null;
  detail?: string | null;
};

export type RemoteCliProbe = {
  targetId: string;
  toolId: string;
  executable: string;
  installed: boolean;
  version?: string | null;
  detail?: string | null;
};
import type { RegisteredCommon, RegisteredProfile } from './native';


export type RemoteToolStore = {
  profiles: RegisteredProfile[];
  common: RegisteredCommon | null;
  currentFiles: Record<string, string>;
};

export type RemoteOperationKind = 'read' | 'write';
export type RemotePriority = 'interactive' | 'background';
export type RemoteOperationRequest = {
  requestId: string;
  cancelToken: string;
  targetId: string;
  targetRevision: number | null;
  kind: RemoteOperationKind;
  priority: RemotePriority;
  deadlineUnixMs: number;
  refresh?: boolean;
};
export type RemoteFailure = {
  code: string;
  stage: string;
  reason: string;
  message: string;
  action: string;
  requestId: string | null;
  targetId: string | null;
  targetRevision: number | null;
  outcome: 'failed' | 'unknown';
  retryable: boolean;
  exitCode: number | null;
};
