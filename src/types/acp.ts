/** One retained conversation message. A chunk event carries only the text just
 *  appended; the snapshot holds the accumulated message. */
export type AcpMessage = {
  id: string;
  role: 'user' | 'agent' | 'thought';
  text: string;
  /** Output past the retained budget was dropped, not silently shortened. */
  truncated: boolean;
};

/** One tool call, merged by its call id. */
export type AcpToolCall = {
  callId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  detail: string;
};

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  /** The protocol's own option kind, kept as the agent sent it. */
  kind: string;
};

/** A pending authorization card. It is valid only while its request, its
 *  session and the connection that asked for it are alive. */
export type AcpPermissionCard = {
  requestId: string;
  turnId: string;
  title: string;
  detail: string;
  options: AcpPermissionOption[];
};

/** Full state of one conversation, for a view that mounts later. */
export type AcpSessionSnapshot = {
  id: string;
  toolId: string;
  projectId: string | null;
  directory: string;
  mode: 'normal' | 'yolo';
  interaction: 'acp';
  /** 'stopping' is a turn the user stopped that has not reported its own result yet. */
  state: 'starting' | 'ready' | 'running' | 'stopping' | 'waiting_permission' | 'closed' | 'failed';
  nativeSessionId: string | null;
  resume: 'none' | 'unsupported' | 'loaded' | 'failed';
  messages: AcpMessage[];
  tools: AcpToolCall[];
  permissions: AcpPermissionCard[];
  /** Bounded, redacted standard-error lines; never a protocol body. */
  diagnostics: string[];
  /** The reason the last turn ended. Empty means no turn has ended yet; 'unknown'
   *  means the agent ended the turn without a reason this host recognizes. */
  lastTurnReason: '' | 'end_turn' | 'limit' | 'refusal' | 'cancelled' | 'disconnected' | 'failed' | 'unknown';
  seq: number;
};

/** One ordered event. The session id scopes it, so two panels never mix. */
export type AcpEvent = {
  sessionId: string;
  seq: number;
  kind: 'snapshot' | 'chunk' | 'tool' | 'permission' | 'permissionClosed' | 'notice';
  snapshot?: AcpSessionSnapshot;
  messageId?: string;
  role?: 'user' | 'agent' | 'thought';
  text?: string;
  truncated?: boolean;
  call?: AcpToolCall;
  card?: AcpPermissionCard;
  requestId?: string;
  decision?: string;
  level?: 'info' | 'warning' | 'error';
};
