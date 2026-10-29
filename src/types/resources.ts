import type { Scope } from './native';

export type PluginTarget = { toolId: string; scope: Scope; projectPath: string | null; contextId: string | null };
export type PluginAction = 'install' | 'update' | 'enable' | 'disable' | 'uninstall';
export type PluginEntry = { id: string; name: string; source: string; version: string | null; scope: string; enabled: boolean | null; state: string; policy: string; readOnly: boolean; root: string | null; resources: { kind: string; path: string; ownerId: string }[] };
export type PluginSnapshot = { target: PluginTarget; capability: { version: string; sources: string; actions: PluginAction[]; project: boolean; detail: string }; entries: PluginEntry[]; baseline: string; detail: string };
export type PluginRequest = { target: PluginTarget; action: PluginAction; source: string; baseline: string; trusted: boolean };
export type PluginResult = { status: string; detail: string; transactionId: string | null; snapshot: PluginSnapshot | null };
/** What a plugin bundles, named per item. `kind` follows the resource kind (agents, skills, commands, hooks, mcp, …). */
export type PluginManifest = { description: string | null; author: string | null; homepage: string | null; license: string | null; keywords: string[]; path: string | null };
export type PluginItem = { kind: string; name: string; description: string | null; path: string; location: string; format: string };
export type PluginContents = { pluginId: string; root: string | null; manifest: PluginManifest; items: PluginItem[]; truncated: boolean };
export type PluginFile = { path: string; content: string; format: string; truncated: boolean };

export type McpTransport = 'stdio' | 'http';
export type McpDefinition = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  inLibrary: boolean;
  version: number;
  readonly updatedAt?: number;
};
export type McpDraft = Omit<McpDefinition, 'id' | 'version' | 'updatedAt'> & { id: string | null; expectedVersion: number | null };
export type McpPlacement = { contextId?: string | null; definitionId: string; toolId: string; scope: Scope; projectPath: string | null; enabled: boolean };
export type McpTargetRequest = { contextId?: string | null; toolId: string; scope: Scope; projectPath: string | null; enabled: boolean; baselineHash?: string | null; previewToken?: string | null; allowReplace?: boolean };
export type McpTargetOperation = 'write' | 'remove';
export type McpDraftTargetRequest = McpTargetRequest & { operation?: McpTargetOperation };
export type McpTargetResult = { contextId?: string | null; toolId: string; scope: Scope; projectPath: string | null; path: string | null; operation: McpTargetOperation; status: 'ready' | 'conflict' | 'unsupported' | 'written' | 'removed' | 'failed'; detail: string; baselineHash: string | null; previewToken: string | null; existing: unknown | null; proposed: unknown | null };
export type McpDraftPreview = { draft: McpDraft; definition: McpDefinition; targets: McpTargetResult[] };
export type McpCommitResult = { definition: McpDefinition; targets: McpTargetResult[] };
export type NativeMcpEntry = Omit<McpDefinition, 'id' | 'version'> & { enabled: boolean; protectedValues: boolean };

export type RuleTarget = { contextId?: string | null; toolId: string; scope: Scope; projectPath: string | null; baselineHash?: string | null };
export type NativeRuleFile = { id: string; path: string; name: string; kind: 'mdc' | 'inert' | 'agents' | string; enabled: boolean; writable: boolean; detail: string; text: string; fingerprint: string };
export type RulePreview = { target: RuleTarget; path: string | null; status: 'ready' | 'unsupported'; detail: string; existing: string; proposed: string; changed: boolean };
export type RuleApplyResult = { target: RuleTarget; path: string | null; status: 'written' | 'failed'; detail: string };
export type RulePlacement = { contextId?: string | null; ruleId: string; toolId: string; scope: Scope; projectPath: string | null; state?: 'current' | 'drifted' | 'unavailable' };
export type RuleClientSelection = { toolIds: string[]; scope: Scope; projectPath: string | null; allowReplace?: boolean };
export type RuleSyncResult = { toolId: string; path: string | null; status: 'written' | 'conflict' | 'failed' | 'unchanged'; detail: string; existing: string; proposed: string };

export type SkillPackage = { id: string; name: string; description: string; compatibility: string | null; source: string; digest: string; fileCount: number; updatedAt: number; inLibrary: boolean };
export type SkillFileChange = { path: string; before: string | null; after: string | null; beforeSize: number | null; afterSize: number | null; beforeDigest: string | null; afterDigest: string | null };
export type SkillImportPreview = { name: string; source: string; digest: string; fileCount: number; compatibility: string | null; existingDigest: string | null; changedFiles: string[]; changes: SkillFileChange[] };
export type SkillInstallation = { contextId?: string | null; packageId: string; toolId: string; scope: Scope; projectPath: string | null; targetPath: string; digest: string; state: 'current' | 'update_available' | 'missing' | 'conflict' | 'unavailable' | 'disabled' };
export type SkillTargetResult = { toolId: string; scope: Scope; projectPath: string | null; path: string | null; status: 'installed' | 'removed' | 'already_current' | 'failed'; detail: string };
export type SkillRecoveryIssue = { contextId?: string | null; operationId: string; toolId: string; scope: Scope; projectPath: string | null; targetPath: string; backupPath: string; detail: string };
// digest is null for document-only inventory (unmanaged/read-only directories),
// as well as failed package reads. Use state to determine readability.
export type NativeSkillEntry = { name: string; path: string; digest: string | null; state: 'managed' | 'external' | 'unreadable' | 'read_only'; detail: string; packageId: string | null; source?: 'writable' | 'read_only' | 'plugin'; pluginName?: string | null; pluginEnabled?: boolean | null };
export type NativeSkillDocument = { name: string; path: string; content: string };
export type SkillTargetPreview = { path: string; status: 'ready' | 'conflict'; detail: string; previewToken: string | null; existingDigest: string | null; packageDigest: string; changes: SkillFileChange[] };

export type AgentEntry = { id: string; name: string; description: string; path: string; format: 'toml' | 'markdown' | 'json'; content: string; enabled: boolean; readOnly: boolean; builtin: boolean; owner: string; detail: string };
export type AgentSnapshot = { target: PluginTarget; capability: { version: string; supported: boolean; format: 'toml' | 'markdown' | 'text'; detail: string; template: string }; entries: AgentEntry[]; baseline: string; detail: string };
export type AgentRequest = { target: PluginTarget; action: 'create' | 'save' | 'enable' | 'disable' | 'delete' | 'restore'; id: string | null; name: string; content: string; baseline: string; transactionId: string | null };
export type AgentResult = { transactionId: string; changedPaths: string[]; restorePath: string; snapshot: AgentSnapshot; detail: string };
