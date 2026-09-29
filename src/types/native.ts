import type { CliId } from './domain';

export type Scope = 'global' | 'project';
export type InterfaceFormat = 'openai_completions' | 'openai_responses' | 'anthropic_messages';

export type Installation = { path: string; version: string | null; source: string; status: 'available' | 'probe_failed'; detail: string | null };
export type NativeFile = { role: string; path: string; format: 'toml' | 'json' | 'jsonc'; writable: boolean; reason: string | null; sensitive: boolean };
export type Capability = { state: 'supported' | 'unknown' | 'unsupported'; reason: string; evidence: string };
export type ToolProbe = { tool: CliId; installations: Installation[]; selectedPath: string | null; nativeFiles: NativeFile[]; nativeWrites: Capability; interfaceFormats: InterfaceFormat[]; installUrl: string; upgradeHint: string; dependencies: { name: string; status: 'found' | 'missing' | 'outdated'; detail: string; helpUrl: string }[]; installCommand: string | null; upgradeCommand: string | null; providerPresets: { id: string; label: string; baseUrl: string; interfaceFormat: InterfaceFormat; sourceUrl: string }[] };
export type Connection = { providerId: string; interfaceFormat: InterfaceFormat | string; baseUrl: string; model: string; secretRef: string | null; authEnvVar: string | null };
export type NativeProfile = { id: string; tool: CliId; name: string; version: number; inheritCommon: boolean; files: Record<string, string>; suppressed: Record<string, string[]>; connection: Connection | null; nativeCredentials: Record<string, Record<string, string>> };
export type CommonConfig = { tool: CliId; version: number; files: Record<string, string> };
export type CommonSaveResult = { common: CommonConfig; applications: { scopeKey: string; status: string; detail: string | null }[] };
export type AppliedBinding = { scopeKey: string; tool: CliId; profileId: string; profileVersion: number; managed: Record<string, Record<string, unknown>> };
export type NativeSnapshot = { role: string; text: string | null; fingerprint: string | null; error: string | null };
export type NativePreview = { documents: Record<string, unknown>; sources: Record<string, Record<string, string>> };
export type ToolWorkspace = { probe: ToolProbe; customPath: string | null; profiles: NativeProfile[]; common: CommonConfig | null; binding: AppliedBinding | null; snapshots: NativeSnapshot[]; recoveryNeeded: string[] };
export type ApplyOutcome = { transactionId: string; changedFiles: string[]; status: 'written_for_next_session' | 'already_matching' };
export type ModelDirectory = { models: string[]; status: 'ready' | 'empty' | 'stale' | 'error'; fetchedAt: number | null; error: string | null; source: string };
export type CheckStep = { state: 'passed' | 'partial' | 'failed' | 'skipped'; message: string };
export type ConnectionCheck = { format: CheckStep; connectivity: CheckStep; modelRequest: CheckStep };
export type NativeInspection = { providerId: string | null; model: string | null; connection: Connection | null; reasoningEffort: string | null };
export type NativeImport = { files: Record<string, string>; inspection: NativeInspection; migratedSecret: boolean; nativeCredentials: Record<string, Record<string, string>> };

export function emptyProfile(tool: CliId): NativeProfile {
  return { id: '', tool, name: '', version: 0, inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} };
}
