import type { ConfigurationDescriptor, EditingState } from './configuration';
import type { CliId } from './domain';

export type Scope = 'global' | 'project';
export type MemoryScopeSupport = { global: boolean; project: boolean };
export type MemoryTargetDimension = 'project' | 'account';
export type MemoryOperation = 'list' | 'open' | 'create' | 'edit' | 'delete' | 'master_switch' | 'item_enable';
export type MemoryManagement = {
  scope: MemoryScopeSupport;
  targets: MemoryTargetDimension[];
  operations: MemoryOperation[];
  limitation?: string;
};
export type MemoryTarget = {
  toolId: string;
  scope: Scope;
  projectPath: string | null;
  contextId?: string | null;
  /** Adapter-enumerated store directory; only a store the backend re-enumerates is accepted. */
  storeDirectory?: string | null;
};
export type MemoryEntry = { id: string; path: string; enabled: boolean; fingerprint: string };
export type MemoryList = {
  inUse: boolean;
  detail: string;
  operations: MemoryOperation[];
  limitation: string;
  entries: MemoryEntry[];
};
export type MemoryDocument = {
  id: string;
  path: string;
  text: string;
  fingerprint: string;
  enabled: boolean;
  inUse: boolean;
  detail: string;
};
export type MemorySave = {
  target: MemoryTarget;
  id: string;
  text: string;
  baseline: string;
  confirmExternal: boolean;
};
export type MemoryDelete = { target: MemoryTarget; id: string; baseline: string };
export type MemoryEnable = { target: MemoryTarget; id?: string | null; enabled: boolean };
export type MemoryFailedSource = { label: string; reason: string };
export type MemoryStoreEntry = {
  id: string;
  path: string;
  enabled: boolean;
  fingerprint: string;
  sourceLabel: string;
  target: MemoryTarget;
  inUse: boolean;
  detail: string;
};
/** One listed store, including stores that hold no entry yet. */
export type MemoryStoreSummary = {
  label: string;
  directory: string;
  target: MemoryTarget;
  inUse: boolean;
  detail: string;
  entryCount: number;
};
export type MemoryReadRequest = { target: MemoryTarget; id: string };
export type MemoryReadResult = { document: MemoryDocument | null; error: string | null };
export type MemorySwitchGroup = { id: string; scope: Scope; enabled: boolean | null; detail: string };
export type MemoryAggregate = {
  toolId: string;
  entries: MemoryStoreEntry[];
  failedSources: MemoryFailedSource[];
  stores: MemoryStoreSummary[];
  /** One native switch governs every store of the CLI. */
  switchShared: boolean;
  switchGroups?: MemorySwitchGroup[];
};
export type AdapterFacet = { state: 'available' | 'planned' | 'supported' | 'unsupported'; reason: string };
export type AdapterDescriptor = {
  id: string;
  configuration?: ConfigurationDescriptor | null;
  name: string;
  interfaceFormats: InterfaceFormat[];
  projectModelOverride: boolean;
  yoloAvailable: boolean;
  resumeLatestAvailable?: boolean;
  launchForm: 'terminal' | 'desktop';
  nativeConfig: AdapterFacet;
  launch: AdapterFacet;
  resume: AdapterFacet;
  resources: AdapterFacet;
  history: AdapterFacet;
  login?: { hint: string } | null;
  management?: { accounts: boolean; mcp: boolean; skills: boolean; agents: boolean; plugins: boolean; projectPlugins: boolean; rules?: { global: boolean; project: boolean; globalReason?: string; projectReason?: string; catalog?: boolean }; memory?: MemoryManagement };
};
export type AdapterCatalog = {
  registered: AdapterDescriptor[];
  managedIds: string[];
  preservedUnknown: { id: string; profileCount: number; readOnly: true; reason: string }[];
};
export type PreservedProfile = { id: string; toolId: string; version: number; data: unknown };
export type InterfaceFormat = 'openai_completions' | 'openai_responses' | 'anthropic_messages';

export type Installation = { path: string; version: string | null; source: string; status: 'available' | 'probe_failed'; detail: string | null };
export type NativeFile = { role: string; path: string; format: 'toml' | 'json' | 'jsonc' | 'yaml'; writable: boolean; reason: string | null; sensitive: boolean };
export type Capability = { state: 'supported' | 'unknown' | 'unsupported'; reason: string; evidence: string };
export type ApiKeyWrite = { state: 'writable' | 'scope_denied' | 'unsupported'; reason: string };
export type ProviderAddressWrite = { state: 'configurable' | 'unsupported'; reason: string };
export type ConnectionProjection = 'provider_models' | 'current_model' | 'single_connection';
export type ConnectionPolicy = { apiKey: ApiKeyWrite; providerAddress: ProviderAddressWrite; projection: ConnectionProjection };
export type ModelRecord = { id: string; fields: Record<string, unknown> };
export type MajorUpgradeAction = { label: string; command: string | null; guidance?: string | null };
export type ToolProbe = { latestVersionSupported?: boolean; tool: CliId; installations: Installation[]; selectedPath: string | null; nativeFiles: NativeFile[]; nativeWrites: Capability; interfaceFormats: InterfaceFormat[]; installUrl: string; upgradeHint: string; dependencies: { name: string; status: 'found' | 'missing' | 'outdated'; detail: string; helpUrl: string }[]; installCommand: string | null; upgradeCommand: string | null; majorUpgrade?: MajorUpgradeAction | null; nativeInstallCommand: string | null; npmInstallCommand: string | null; providerPresets: { id: string; label: string; baseUrl: string; interfaceFormat: InterfaceFormat; sourceUrl: string }[]; connectionPolicy: ConnectionPolicy };
export type Connection = { providerId: string; interfaceFormat: InterfaceFormat | string; baseUrl: string; model: string; secretRef: string | null; authEnvVar: string | null; modelRecords?: ModelRecord[] };
export type ProfileAuthentication = { kind: 'native' | 'api_key' | 'rebind_required' } | { kind: 'oauth'; accountId: string };
export type NativeProfile = { editing?: EditingState; authentication?: ProfileAuthentication; id: string; tool: CliId; name: string; version: number; revision?: string; inheritCommon: boolean; files: Record<string, string>; suppressed: Record<string, string[]>; connection: Connection | null; nativeCredentials: Record<string, Record<string, string>> };
export type RegisteredProfile = Omit<NativeProfile, 'tool'> & { tool: string };
export type CommonConfig = { tool: CliId; version: number; revision?: string; files: Record<string, string> };
export type RegisteredCommon = Omit<CommonConfig, 'tool'> & { tool: string };
export type CommonSaveResult = { common: CommonConfig; applications: { scopeKey: string; status: string; detail: string | null }[] };
export type RegisteredCommonSaveResult = Omit<CommonSaveResult, 'common'> & { common: RegisteredCommon };
export type AppliedBinding = { contextId?: string | null; scopeKey: string; tool: string; profileId: string; profileVersion: number; managed: Record<string, Record<string, unknown>>; commonVersion?: number | null; commonRevision?: string | null; appliedProfileAvailable?: boolean; appliedSummary?: AppliedSummary | null };
export type NativeSnapshot = { role: string; text: string | null; fingerprint: string | null; error: string | null };
export type ApplyComparison = {contextId?: string | null;profile:RegisteredProfile;common:RegisteredCommon|null;files:{role:string;format:'json'|'jsonc'|'toml'|'yaml';current:string;proposed:unknown;proposedText:string}[]};
export type NativePreview = { documents: Record<string, unknown>; rendered: Record<string, string>; sources: Record<string, Record<string, string>> };
export type ToolWorkspace = { effectiveContextId: string | null; nativeContextError?: string | null; probe: ToolProbe; customPath: string | null; profiles: NativeProfile[]; common: CommonConfig | null; binding: AppliedBinding | null; snapshots: NativeSnapshot[]; recoveryNeeded: string[] };
export type RegisteredToolWorkspace = Omit<ToolWorkspace, 'probe' | 'profiles' | 'common'> & {
  probe: Omit<ToolProbe, 'tool'> & { tool: string };
  profiles: RegisteredProfile[];
  common: RegisteredCommon | null;
  profileModelSummaries?: Record<string, ModelSummary | null>;
};
export type ModelSummary = { providerId: string | null; model: string };
/** Lightweight scope lookup; does not probe installations or read native documents. */
export type RegisteredToolContext = { effectiveContextId: string | null; nativeContextError: string | null };
export type ApplyOutcome = { transactionId: string; changedFiles: string[]; status: 'written_for_next_session' | 'already_matching' };
export type ModelDirectory = { models: string[]; status: 'ready' | 'empty' | 'stale' | 'error'; fetchedAt: number | null; error: string | null; source: string };
export type CheckStep = { state: 'passed' | 'partial' | 'failed' | 'skipped'; message: string };
export type ConnectionCheck = { format: CheckStep; connectivity: CheckStep; modelRequest: CheckStep };
export type NativeInspection = { providerId: string | null; model: string | null; connection: Connection | null; reasoningEffort: string | null; projectedModels: ModelRecord[] | null };
export type NativeImport = { files: Record<string, string>; inspection: NativeInspection; migratedSecret: boolean; nativeCredentials: Record<string, Record<string, string>> };

export function emptyProfile(tool: CliId): NativeProfile {
  return { id: '', tool, name: '', version: 0, inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} };
}

export type AppliedSummary = { authentication: ProfileAuthentication; providerId: string | null; baseUrl: string | null; model: string | null; contextId: string | null; profileVersion: number; profileRevision: string };

export type MaintenanceResult = { output: string; version: string | null };
export type MaintenanceProgress = { toolId: string; output: string };
