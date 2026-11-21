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
export type SecretAuditOperation = 'list' | 'use' | 'read' | 'approve' | 'decline' | 'error';
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
/** A read approval. The window only learns the alias, the source and the wait. */
export type PromptSecretApprovalRequest = {
  approvalId: string;
  alias: string;
  source: string;
  expiresInSeconds: number;
};
