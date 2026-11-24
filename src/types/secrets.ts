/** A reference is available, confirmed absent, unknown to this device, or unreadable. */
export type PromptSecretStatus = 'available' | 'missing' | 'unknown' | 'unreadable';
export type PromptSecret = {
  id: string;
  alias: string;
  reference: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  status: PromptSecretStatus;
};
export type PromptSecretPage = { items: PromptSecret[]; total: number; matched: number; offset: number; grantCounts: Record<string, number>; directReadIds: string[] };
export type PromptSecretReference = {
  id: string;
  reference: string;
  alias: string | null;
  status: PromptSecretStatus;
};

/** How a registered executor receives the value: an environment variable or stdin. */
export type SecretExecutorChannel = 'env' | 'stdin';
/** A fixed program definition the broker may run. It carries no value and no shell. */
export type SecretExecutor = {
  id: string;
  label: string;
  description: string;
  executable: string;
  args: string[];
  cwd: string | null;
  channel: SecretExecutorChannel;
  envName: string | null;
  digest: string;
  createdAt: number;
  updatedAt: number;
};
export type NewSecretExecutor = {
  label: string;
  description: string;
  executable: string;
  args: string[];
  cwd: string | null;
  channel: SecretExecutorChannel;
  envName: string | null;
};
/** A CLI or MCP installation is the identity a helper authenticates with. */
export type SecretInstallationKind = 'cli' | 'mcp';
export type SecretInstallation = {
  id: string;
  directReadOnly: boolean;
  label: string;
  kind: SecretInstallationKind;
  targetId: string | null;
  revoked: boolean;
  createdAt: number;
  revokedAt: number | null;
};
/** A grant pairs one installation with one secret and one executor. */
export type SecretGrant = {
  installationId: string;
  secretId: string;
  alias: string;
  executorId: string;
  executorLabel: string;
  createdAt: number;
};
export type SecretAuditOperation = 'list' | 'use' | 'read' | 'error';
export type SecretAuditDecision = 'allowed' | 'denied';
/** Audit rows hold identifiers and result codes only, never a value or a script. */
export type SecretAuditEntry = {
  id: number;
  at: number;
  operation: SecretAuditOperation;
  decision: SecretAuditDecision;
  code: string;
  secretId: string | null;
  installationId: string | null;
  executorId: string | null;
};
export type SecretBrokerStatus = {
  running: boolean;
  transport: string;
  error: string | null;
};
/** The non-secret facts a usage description needs. */
export type SecretCliContext = {
  executable: string;
  entry: string;
};
/** The broker sends display metadata for the references that need consent. */
export type PromptSecretApprovalRequest = {
  approvalId: string;
  alias: string;
  aliases?: string[];
  sessionAvailable?: boolean;
  source: string;
  expiresInSeconds: number;
};

/** The target a secret MCP status or distribution call acts on. */
export type SecretMcpTarget = {
  toolId: string;
  scope: 'global' | 'project';
  projectPath?: string | null;
  contextId?: string | null;
};
/** Registry capability: a mapping is confirmed, unverified or absent for this CLI. */
export type SecretMcpCapabilityState = 'supported' | 'unverified' | 'unsupported';
/** The combined availability: a supported adapter, a written entry and a verified protocol. */
export type SecretMcpStateName = 'unsupported' | 'unverified' | 'disabled' | 'enabled';
/** The native entry: `absent`, written and enabled, or written and disabled. */
export type SecretMcpPlacement = 'absent' | 'enabled' | 'disabled';
/** Protocol health. Only `healthy` follows a real initialize plus tools/list. */
export type SecretMcpHealth = 'unknown' | 'healthy' | 'failed';
/**
 * Placement, protocol health and registry capability stay separate: `available`
 * is the only field that claims a working tool, and it requires all three.
 */
export type SecretMcpState = {
  toolId: string;
  scope: 'global' | 'project';
  projectPath: string | null;
  capability: SecretMcpCapabilityState;
  capabilityReason: string;
  state: SecretMcpStateName;
  reason: string;
  installationId: string | null;
  installationLabel: string | null;
  command: string;
  args: string[];
  placement: SecretMcpPlacement;
  health: SecretMcpHealth;
  healthDetail: string;
  canCheck: boolean;
  available: boolean;
  cliFallback: boolean;
};

export type SecretDirectRead = { secretId: string; installationId: string; alias: string };
export type ScriptAccessOptions = { cli: SecretCliContext; installations: SecretInstallation[]; executors: SecretExecutor[]; grants: SecretGrant[]; directReads: SecretDirectRead[]; availablePrograms: string[] };
