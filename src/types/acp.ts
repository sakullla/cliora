// ACP conversation contract. Every type here mirrors a serialized Rust type in
// src-tauri/src/acp (same name, camelCase fields); tests/native/acp-contract.test.mjs
// fails when the two drift apart.

/** Who a message comes from. 'session' is a message another session sent, as a
 *  subagent's transcript reports it. */
export type AcpRole = 'user' | 'agent' | 'thought' | 'session';

/** One retained message. A chunk event carries only the text just appended; the
 *  snapshot holds the accumulated message. */
export type AcpMessage = {
  id: string;
  role: AcpRole;
  text: string;
  /** Output past the retained budget was dropped, not silently shortened. */
  truncated: boolean;
  turnId: string;
  /** The child session this message belongs to; null for the conversation's own. */
  subagent: string | null;
  /** What the user attached to a prompt, as labels only; absent when nothing was attached. */
  attachments?: AcpAttachmentLabel[];
};

/** One attachment of a user prompt as the timeline shows it. Image data and file
 *  contents never enter the snapshot. */
export type AcpAttachmentLabel = {
  type: 'image' | 'file';
  /** A file's path relative to the session directory (or as given), or an image's media type. */
  name: string;
  /** How a file reached the agent: its text embedded, or a link; null for an image. */
  delivery: 'embedded' | 'link' | null;
};

/** One attachment sent with acp_prompt. An image is accepted only when the agent
 *  declared promptCapabilities.image (at most 8, 5 MiB each, PNG/JPEG/GIF/WebP); a
 *  file is absolute or relative to the session directory, and one outside it waits
 *  for an approval card. */
export type AcpAttachment =
  | { type: 'image'; mimeType: string; dataBase64: string }
  | { type: 'file'; path: string };

/** One field of an elicitation form: the restricted JSON Schema primitives. */
export type AcpElicitationField = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  default?: unknown;
  /** string: plain choices; titled choices use oneOf/anyOf with const. */
  enum?: string[];
  oneOf?: Array<{ const: string; title?: string }>;
  anyOf?: Array<{ const: string; title?: string }>;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** array (multi-select): the allowed items. */
  items?: { type?: 'string'; enum?: string[]; oneOf?: Array<{ const: string; title?: string }>; anyOf?: Array<{ const: string; title?: string }> };
  minItems?: number;
  maxItems?: number;
};

/** The flat object schema an elicitation form asks for. */
export type AcpElicitationSchema = {
  type?: 'object';
  properties: Record<string, AcpElicitationField>;
  required?: string[];
};

/** How an elicitation form was decided. 'withdrawn': a stop, the end of the turn
 *  that asked, or the end of the session took it away and the agent got a cancel. */
export type AcpElicitationDecision = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'withdrawn';

/** A structured question the agent asked (form mode). The answer is never retained. */
export type AcpElicitation = {
  id: string;
  message: string;
  requestedSchema: AcpElicitationSchema;
  /** The tool call this question belongs to, when the agent named one. */
  toolCallId: string | null;
  decision: AcpElicitationDecision;
  /** The id to answer with acp_respond_elicitation while pending; null once decided. */
  requestId: string | null;
  turnId: string;
  subagent: string | null;
};

/** One piece of tool output, as the protocol typed it. An image keeps only its type. */
export type AcpToolContent =
  | { type: 'text'; text: string; truncated: boolean }
  | { type: 'diff'; path: string; oldText: string | null; newText: string; truncated: boolean }
  | { type: 'terminal'; terminalId: string }
  | { type: 'image'; mimeType: string }
  | { type: 'session'; sessionId: string };

export type AcpToolLocation = {
  path: string;
  line: number | null;
};

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  /** The protocol's own option kind, kept as the agent sent it; 'unknown' when the agent sent none. */
  kind: string;
};

/** An open authorization request on the tool call it asks about. It is valid only
 *  while its request id is in the snapshot's pending list. */
export type AcpPermissionRequest = {
  userQuestion?: boolean;
  requestId: string;
  turnId: string;
  options: AcpPermissionOption[];
};

export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

/** One tool call, merged in place by its call id within its session. */
export type AcpToolCall = {
  id: string;
  callId: string;
  title: string;
  /** Named apart from the timeline item's own `kind` tag. */
  toolKind: AcpToolKind;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content: AcpToolContent[];
  locations: AcpToolLocation[];
  /** A bounded JSON summary of the tool input. */
  rawInput: string | null;
  turnId: string;
  subagent: string | null;
  permission: AcpPermissionRequest | null;
};

/** A host notice. `code` is stable ('trimmed' marks dropped history); empty for free text. */
export type AcpNotice = {
  id: string;
  level: 'info' | 'warning' | 'error';
  code: string;
  text: string;
  turnId: string;
};

export type AcpTurnReason = 'end_turn' | 'limit' | 'refusal' | 'cancelled' | 'disconnected' | 'failed' | 'unknown';

/** The end of one turn and why it ended. */
export type AcpTurnEnd = {
  id: string;
  turnId: string;
  reason: AcpTurnReason;
};

/** A child session the agent announced. */
export type AcpSubagent = {
  id: string;
  sessionId: string;
  parent: string | null;
  title: string | null;
  description: string | null;
  state: string | null;
  stopReason: string | null;
  summary: string;
  turnId: string;
};

/** What an out-of-directory access does. */
export type AcpAccessKind = 'read' | 'write' | 'execute';

/** How an access was decided. 'pending' is a card waiting for the user;
 *  'granted' came from an earlier "allow for this session", 'yolo' from the
 *  session's YOLO mode, 'inside' from the session directory itself. */
export type AcpAccessDecision = 'pending' | 'allowed_once' | 'allowed_session' | 'granted' | 'yolo' | 'inside' | 'denied' | 'withdrawn';

/** A file change the host made for the agent. */
export type AcpFileDiff = {
  path: string;
  /** Null for a new file or when the previous content could not be kept. */
  oldText: string | null;
  newText: string;
  truncated: boolean;
  /** The file existed but its previous content was too large or not text. */
  previousOmitted: boolean;
};

/** One file or command access the host served for the agent: an approval card
 *  while pending, then the record of its decision. */
export type AcpAccess = {
  id: string;
  /** Named apart from the timeline item's own `kind` tag. */
  accessKind: AcpAccessKind;
  /** The file, or a command's working directory. */
  path: string;
  /** The command line of an execute access. */
  detail: string | null;
  decision: AcpAccessDecision;
  /** The id to answer with acp_respond_access while pending; null once decided. */
  requestId: string | null;
  diff: AcpFileDiff | null;
  turnId: string;
  subagent: string | null;
  /** Set only for a card the user's own action raised (a dropped image): the path
   *  as the user gave it. It belongs to no turn, never holds the session in
   *  waiting_permission, and is answered only once or denied. */
  userPath: string | null;
};

/** One ordered timeline entry. Its place is fixed when it first appears. */
export type AcpTimelineItem =
  | ({ kind: 'message' } & AcpMessage)
  | ({ kind: 'tool' } & AcpToolCall)
  | ({ kind: 'notice' } & AcpNotice)
  | ({ kind: 'turn' } & AcpTurnEnd)
  | ({ kind: 'subagent' } & AcpSubagent)
  | ({ kind: 'access' } & AcpAccess)
  | ({ kind: 'elicitation' } & AcpElicitation);

/** How a terminal's command ended. */
export type AcpTerminalExit = {
  exitCode: number | null;
  signal: string | null;
};

/** One terminal the agent created, with its bounded output tail. */
export type AcpTerminal = {
  terminalId: string;
  command: string;
  cwd: string;
  output: string;
  /** Older output was dropped to stay within the byte limit. */
  truncated: boolean;
  /** Null while the command runs. */
  exitStatus: AcpTerminalExit | null;
  /** Released by the agent or ended with the session; output stays visible. */
  released: boolean;
  subagent: string | null;
  /** The agent ran the command itself and reported it on its tool call; read-only, cannot be stopped. */
  agentOwned: boolean;
};

export type AcpPlanEntry = {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
};

export type AcpAvailableCommand = {
  name: string;
  description: string;
  hint: string | null;
};

export type AcpMode = {
  id: string;
  name: string;
  description: string | null;
};

export type AcpModes = {
  currentModeId: string;
  availableModes: AcpMode[];
};

export type AcpConfigChoice = {
  value: string;
  name: string;
  description: string | null;
  group: string | null;
};

/** One configuration selector: a select holds a string, a boolean holds true or false. */
export type AcpConfigOption = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  type: 'select' | 'boolean';
  currentValue: string | boolean;
  options: AcpConfigChoice[];
};

export type AcpModel = {
  modelId: string;
  name: string;
  description: string | null;
};

export type AcpModels = {
  currentModelId: string;
  availableModels: AcpModel[];
};

/** Session settings as the agent declared them. */
export type AcpSessionConfig = {
  modes: AcpModes | null;
  options: AcpConfigOption[];
  models: AcpModels | null;
};

/** The configuration id that addresses the legacy model selector. */
export const ACP_LEGACY_MODEL_CONFIG = '_model';

export type AcpCost = {
  amount: number;
  currency: string;
};

export type AcpUsage = {
  used: number;
  size: number;
  cost: AcpCost | null;
};

export type AcpSessionInfo = {
  title: string | null;
  updatedAt: string | null;
  /** Null until the agent actually reports usage. */
  usage: AcpUsage | null;
};

export type AcpImplementation = {
  name: string;
  title: string | null;
  version: string | null;
};

export type AcpPromptCapabilities = {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
};

export type AcpSessionCapabilities = {
  list: boolean;
  resume: boolean;
  delete: boolean;
  close: boolean;
};

export type AcpAuthMethod = {
  id: string;
  name: string;
  description: string | null;
  type: string;
};

/** What the agent declared during initialize. */
export type AcpAgentDescriptor = {
  protocolVersion: number | null;
  agentInfo: AcpImplementation | null;
  promptCapabilities: AcpPromptCapabilities;
  sessionCapabilities: AcpSessionCapabilities;
  loadSession: boolean;
  authMethods: AcpAuthMethod[];
};

/** 'auth_required' waits for the user to log in with one of agent.authMethods. */
export type AcpSessionState = 'starting' | 'auth_required' | 'ready' | 'running' | 'stopping' | 'waiting_permission' | 'closed' | 'failed';

/** Full state of one conversation, for a view that mounts later. */
export type AcpSessionSnapshot = {
  id: string;
  toolId: string;
  projectId: string | null;
  directory: string;
  mode: 'normal' | 'yolo';
  interaction: 'acp';
  /** 'stopping' is a turn the user stopped that has not reported its own result yet. */
  state: AcpSessionState;
  nativeSessionId: string | null;
  /** 'loaded' replayed history through session/load; 'resumed' continued it through
   *  session/resume without a replay. */
  resume: 'none' | 'unsupported' | 'loaded' | 'resumed' | 'failed';
  /** Why the session still needs a login: the agent's answer or the last failed
   *  login. Null once logged in. */
  authError: string | null;
  /** Everything the conversation produced, in arrival order. */
  timeline: AcpTimelineItem[];
  /** Request ids still waiting for the user's answer: authorization cards,
   *  out-of-directory approval cards and elicitation forms. */
  pending: string[];
  /** Categories the user allowed for the rest of this session. YOLO is the
   *  session's mode, not a grant. */
  grants: AcpAccessKind[];
  /** Terminals the agent created. */
  terminals: AcpTerminal[];
  /** Ids of terminal records the host dropped past its retention bound while a
   *  tool call still names them: their output was omitted, not empty. */
  omittedTerminalIds: string[];
  plan: AcpPlanEntry[];
  commands: AcpAvailableCommand[];
  config: AcpSessionConfig;
  info: AcpSessionInfo;
  agent: AcpAgentDescriptor;
  /** Bounded, redacted standard-error lines; never a protocol body. */
  diagnostics: string[];
  /** The reason the last turn ended. Empty means no turn has ended yet; 'unknown'
   *  means the agent ended the turn without a reason this host recognizes. */
  lastTurnReason: '' | AcpTurnReason;
  seq: number;
};

/** One ordered event. The session id scopes it, so two panels never mix. */
export type AcpUpdate =
  | { kind: 'snapshot'; snapshot: AcpSessionSnapshot }
  | { kind: 'chunk'; messageId: string; role: AcpRole; text: string; truncated: boolean; turnId: string; subagent: string | null }
  | { kind: 'tool'; call: AcpToolCall }
  | { kind: 'item'; item: AcpTimelineItem }
  | { kind: 'plan'; entries: AcpPlanEntry[] }
  | { kind: 'commands'; commands: AcpAvailableCommand[] }
  | { kind: 'config'; config: AcpSessionConfig }
  | { kind: 'info'; info: AcpSessionInfo }
  | { kind: 'pending'; pending: string[] }
  | { kind: 'terminal'; terminal: AcpTerminal }
  | { kind: 'terminalOutput'; terminalId: string; text: string; dropped: number; truncated: boolean; exitStatus: AcpTerminalExit | null; released: boolean };

export type AcpEvent = { sessionId: string; seq: number } & AcpUpdate;

/** Files inside the session directory for `@` references. */
export type AcpFileList = {
  /** Relative paths with `/` separators, best matches first. */
  files: string[];
  /** The directory holds more files than were indexed. */
  truncated: boolean;
  source: 'git' | 'walk';
};

/** An image file dropped on the composer, read by the host for its preview and
 *  sent like a pasted image. */
export type AcpImageFile = {
  name: string;
  mimeType: string;
  dataBase64: string;
  size: number;
};

/** One session in the agent's own history. */
export type AcpNativeSession = {
  /** What LaunchRequest.resumeNativeId continues. */
  nativeId: string;
  title: string | null;
  updatedAt: string | null;
  cwd: string | null;
  /** The conversation the list was asked from. */
  current: boolean;
};

/** One page of the agent's session history; nextCursor is null on the last page. */
export type AcpNativeSessionPage = {
  sessions: AcpNativeSession[];
  nextCursor: string | null;
};
