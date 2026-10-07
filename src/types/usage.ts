/** Remote quota data. Local history estimates remain in types/history.ts. */
export type UsageErrorCode = 'network' | 'timeout' | 'cancelled' | 'authentication'
  | 'permission' | 'rate_limit' | 'business' | 'parse' | 'script' | 'result_contract'
  | 'resource_limit' | 'invalid_configuration' | 'version_conflict' | 'not_found'
  | 'storage' | 'credential';
export type UsageStage = 'configuration' | 'credential' | 'launch' | 'ipc' | 'http'
  | 'script' | 'validation' | 'storage';

export interface UsageError {
  code: UsageErrorCode;
  stage: UsageStage;
  message: string;
  retryAfterSeconds: number | null;
  metricId: string | null;
  scriptLine?: number;
}

export type UsageSubject = 'account' | 'plan' | 'key' | 'extra';
export interface QueryIdentity {
  accountId: string | null;
  contextId: string | null;
  profileId: string | null;
  subject: UsageSubject;
  subjectId: string | null;
}

export type QueryProgram = { kind: 'builtin'; provider: string; templateVersion: number }
  | { kind: 'profile_builtin'; provider: string; templateVersion: number; profileVersion: number }
  | { kind: 'official'; tool: string; adapterVersion: number }
  | { kind: 'javascript'; source: string };

export interface QueryTarget {
  origin: string;
  allowPrivateNetwork: boolean;
}

export type QueryParameter = null | boolean | number | string | QueryParameter[]
  | { [key: string]: QueryParameter };

export interface QueryConfig {
  schemaVersion: 1;
  label: string;
  site: string;
  identity: QueryIdentity;
  program: QueryProgram;
  /** Non-secret parameters only. Use named credential bindings for secrets. */
  parameters: Record<string, QueryParameter>;
  targets: QueryTarget[];
  enabled: boolean;
  /** Zero means manual refresh. Nonzero intervals must be at least 60 seconds. */
  refreshIntervalSeconds: number;
}

export interface CredentialBinding {
  name: string;
  secretRef: string;
  revision: number;
  allowedOrigins: string[];
}

/** Bundled catalog metadata. Listing/copying a preset never queries or reads secrets. */
export interface PresetCredential {
  name: string;
  label: string;
  instructions: string;
  allowedOrigins: string[];
}
export interface UsagePreset {
  id: string;
  label: string;
  description: string;
  config: QueryConfig;
  credentials: PresetCredential[];
}

export interface CredentialDraft {
  name: string;
  allowedOrigins: string[];
  value: { kind: 'keep' } | { kind: 'replace'; secret: string };
}

export interface UsageQueryDraft {
  id: string | null;
  expectedVersion: number | null;
  config: QueryConfig;
  credentials: CredentialDraft[];
}

export interface UsageQuery {
  id: string;
  version: number;
  generation: number;
  config: QueryConfig;
  credentials: CredentialBinding[];
}

export interface SaveQueryResult {
  query: UsageQuery;
  credentialCleanupPending: boolean;
}
export interface DeleteQueryResult { credentialCleanupPending: boolean }

export type UsageUnit = { kind: 'tokens' | 'requests' | 'credits' }
  | { kind: 'currency'; code: string } | { kind: 'custom'; label: string };

export interface UsageWindow {
  durationSeconds: number | null;
  /** RFC 3339, including an explicit timezone offset. */
  resetsAt: string | null;
  recovery: 'fixed' | 'rolling' | 'unknown';
}

export interface UsageMetric {
  id: string;
  label: string;
  subject: UsageSubject;
  subjectId: string | null;
  unit: UsageUnit;
  used: number | null;
  remaining: number | null;
  total: number | null;
  /** Percent used, supplied by the source; can exceed 100. */
  sourcePercent: number | null;
  unlimited: boolean;
  /** Entitlement/key expiry, independent of window reset; null can mean unknown. */
  expiresAt: string | null;
  neverExpires: boolean;
  window: UsageWindow | null;
  missingReason: string | null;
}

export interface UsageResult {
  schemaVersion: 1;
  status: 'success' | 'partial' | 'failed';
  metrics: UsageMetric[];
  errors: UsageError[];
}

export type UsageExecution = {
  kind: 'saved'; queryId: string; generation: number; identity: QueryIdentity;
} | { kind: 'draft'; executionId: string; draftRevision: number };

/** Host-owned identity/source/timestamps, never accepted from script output. */
export interface UsageSnapshot {
  execution: UsageExecution;
  source: string;
  attemptedAt: string;
  measuredAt: string | null;
  result: UsageResult;
}

/** Testing never writes the query, credential store, or successful-result cache. */
export interface DraftTestReport {
  execution: Extract<UsageExecution, { kind: 'draft' }>;
  result: UsageResult | null;
  error: UsageError | null;
  elapsedMs: number;
  stage: UsageStage;
  preview: string;
  requestOrigins: string[];
}

/** One sampled reading of a successful automatic refresh; local only, never synced. */
export interface UsageSample {
  queryId: string;
  /** Unix seconds when the host measured the reading. */
  measuredAt: number;
  snapshot: UsageSnapshot;
}

export interface UsageCache {
  queryId: string;
  generation: number;
  success: UsageSnapshot | null;
  attemptedAt: string | null;
  errors: UsageError[];
  nextAllowedAt: number;
  nextAutoAt: number;
  failures: number;
  authPaused: boolean;
  refreshing: boolean;
}
