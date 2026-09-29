import type { Scope } from './native';

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
  version: number;
};
export type McpDraft = Omit<McpDefinition, 'id' | 'version'> & { id: string | null; expectedVersion: number | null };
export type McpTargetRequest = { toolId: string; scope: Scope; projectPath: string | null; enabled: boolean; baselineHash?: string | null; previewToken?: string | null; allowReplace?: boolean };
export type McpTargetResult = { toolId: string; scope: Scope; projectPath: string | null; path: string | null; status: 'ready' | 'conflict' | 'unsupported' | 'written' | 'failed'; detail: string; baselineHash: string | null; previewToken: string | null; existing: unknown | null; proposed: unknown | null };
export type NativeMcpEntry = Omit<McpDefinition, 'id' | 'version'> & { enabled: boolean; protectedValues: boolean };

export type RuleTarget = { toolId: string; scope: Scope; projectPath: string | null; baselineHash?: string | null };
export type RulePreview = { target: RuleTarget; path: string | null; status: 'ready' | 'unsupported'; detail: string; existing: string; proposed: string; changed: boolean };
export type RuleApplyResult = { target: RuleTarget; path: string | null; status: 'written' | 'failed'; detail: string };

export type SkillPackage = { id: string; name: string; description: string; compatibility: string | null; source: string; digest: string; fileCount: number; updatedAt: number };
export type SkillFileChange = { path: string; before: string | null; after: string | null; beforeSize: number | null; afterSize: number | null; beforeDigest: string | null; afterDigest: string | null };
export type SkillImportPreview = { name: string; source: string; digest: string; fileCount: number; compatibility: string | null; existingDigest: string | null; changedFiles: string[]; changes: SkillFileChange[] };
export type SkillInstallation = { packageId: string; toolId: string; scope: Scope; projectPath: string | null; targetPath: string; digest: string; state: 'current' | 'update_available' | 'missing' | 'conflict' | 'unavailable' };
export type SkillTargetResult = { toolId: string; scope: Scope; projectPath: string | null; path: string | null; status: 'installed' | 'removed' | 'already_current' | 'failed'; detail: string };
export type SkillRecoveryIssue = { operationId: string; toolId: string; scope: Scope; projectPath: string | null; targetPath: string; backupPath: string; detail: string };
export type NativeSkillEntry = { name: string; path: string; digest: string | null; state: 'managed' | 'external' | 'unreadable'; detail: string; packageId: string | null };
export type SkillTargetPreview = { path: string; status: 'ready' | 'conflict'; detail: string; previewToken: string | null; existingDigest: string | null; packageDigest: string; changes: SkillFileChange[] };
