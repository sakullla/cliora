import type { MaintenanceResult } from '../types/native';
import type { ConfigurationAction, ConfigurationDescriptor, ConfigurationDraft } from '../types/configuration';
import type { RegisteredToolContext } from '../types/native';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AccountCapability, AccountImpact, AccountReapplyRequest, AuthAccount, NativeLoginSnapshot } from '../types/accounts';
import type { AgentSnapshot, AgentRequest, AgentResult, PluginTarget, PluginRequest, PluginSnapshot, PluginResult } from '../types/resources';
import type { ApiError, Bootstrap, CliId, Theme } from '../types/domain';
import type { AdapterCatalog, ApplyComparison, ApplyOutcome, CommonConfig, CommonSaveResult, Connection, ConnectionCheck, ModelDirectory, NativeImport, NativeInspection, NativePreview, NativeProfile, PreservedProfile, RegisteredCommon, RegisteredCommonSaveResult, RegisteredProfile, RegisteredToolWorkspace, Scope, ToolWorkspace } from '../types/native';
import type { LaunchMode, LaunchRequest, LaunchResult, LaunchSettings, Project, TerminalId, TrayStatus } from '../types/launch';
import type { LibraryDraft, LibraryItem, LibraryKind } from '../types/library';
import type { McpDefinition, McpDraft, McpPlacement, McpTargetRequest, McpTargetResult, NativeMcpEntry, RuleTarget, RulePreview, RuleApplyResult, RulePlacement, RuleClientSelection, RuleSyncResult, SkillPackage, SkillImportPreview, SkillInstallation, SkillTargetResult, NativeSkillDocument, NativeSkillEntry, SkillTargetPreview, SkillRecoveryIssue } from '../types/resources';
import type { HistoryDetail, HistoryFilter, HistoryPrice, HistorySession, ScanStatus, UsageReport } from '../types/history';
import type { ConflictPreview, PortableApplyTarget, PortableImportReport, PortableItem, PortablePreview, PortableProjectLink, SyncStatus, WebdavSetup } from '../types/portable';
import type { QueryConfig, UsageCache, UsagePreset, UsageSample, DeleteQueryResult, DraftTestReport, SaveQueryResult, UsageError, UsageQuery, UsageQueryDraft } from '../types/usage';
import i18n from '../i18n';

export const nativeAvailable = isTauri();

function readError(error: unknown): ApiError {
  if (typeof error === 'string') {
    return { code: 'native_error', message: error, action: i18n.t('common.nativeError.checkAndRetry') };
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = error as Partial<ApiError>;
    return {
      code: typeof value.code === 'string' ? value.code : 'native_error',
      message: typeof value.message === 'string' ? value.message : i18n.t('common.nativeError.operationFailed'),
      action: typeof value.action === 'string' ? value.action : i18n.t('common.nativeError.retry'),
      data_directory: typeof value.data_directory === 'string' ? value.data_directory : null,
    };
  }
  return { code: 'native_error', message: i18n.t('common.nativeError.unavailable'), action: i18n.t('common.nativeError.reopen') };
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw readError(error);
  }
}

// Share only overlapping reads. Settled workspace data is always read again so
// external configuration edits and account bindings remain visible.
const workspaceReads = new Map<string, Promise<RegisteredToolWorkspace>>();
const contextReads = new Map<string, Promise<RegisteredToolContext>>();
function readToolContext(toolId: string, scope: Scope, projectPath?: string, fresh = false) {
  const args = { toolId, scope, projectPath: projectPath || null };
  if (fresh) return command<RegisteredToolContext>('get_registered_tool_context', args);
  const key = JSON.stringify(args);
  const existing = contextReads.get(key);
  if (existing) return existing;
  const request = command<RegisteredToolContext>('get_registered_tool_context', args)
    .finally(() => { if (contextReads.get(key) === request) contextReads.delete(key); });
  contextReads.set(key, request);
  return request;
}
function readWorkspace(toolId: string, scope: Scope, projectPath?: string, summary = false, fresh = false) {
  const args = { toolId, scope, projectPath: projectPath || null, summary, fresh };
  if (fresh) return command<RegisteredToolWorkspace>('get_registered_tool_workspace', args);
  const key = JSON.stringify(args);
  const existing = workspaceReads.get(key);
  if (existing) return existing;
  const request = command<RegisteredToolWorkspace>('get_registered_tool_workspace', args)
    .finally(() => { if (workspaceReads.get(key) === request) workspaceReads.delete(key); });
  workspaceReads.set(key, request);
  return request;
}

/** Preserve quota-specific stage and retry metadata instead of reducing to ApiError. */
async function usageCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'stage' in error && 'code' in error && 'message' in error) {
      throw error;
    }
    const failure: UsageError = {
      code: 'storage', stage: 'ipc', message: readError(error).message,
      retryAfterSeconds: null, metricId: null,
    };
    throw failure;
  }
}

/** Feature modules add named wrappers here; components never invoke arbitrary commands. */
export const native = {
  openExternalUrl: (url: string) => command<void>('open_external_url', { url }),
  scanNativeAgents: (target: PluginTarget) => command<AgentSnapshot>('scan_native_agents', { target }),
  operateNativeAgent: (request: AgentRequest) => command<AgentResult>('operate_native_agent', { request }),
  scanNativePlugins: (target: PluginTarget) => command<PluginSnapshot>('scan_native_plugins', { target }),
  previewNativePlugins: (target: PluginTarget) => command<PluginSnapshot | null>('preview_native_plugins', { target }),
  operateNativePlugin: (request: PluginRequest) => command<PluginResult>('operate_native_plugin', { request }),
  accountCapabilities: () => command<AccountCapability[]>('account_capabilities'),
  discoverNativeLogins: (toolId: string) => command<NativeLoginSnapshot>('discover_native_logins', { toolId }),
  adoptNativeCodexAccount: (label: string) => command<AuthAccount>('adopt_native_codex_account', { label }),
  adoptNativeAccount: (toolId: string, label: string) => command<AuthAccount>('adopt_native_account', { toolId, label }),
  listAccounts: () => command<AuthAccount[]>('list_accounts'),
  accountImpact: (id: string) => command<AccountImpact>('account_impact', { id }),
  reapplyAccountProfile: (request: AccountReapplyRequest) => command<ApplyOutcome>('reapply_account_profile', { request }),
  createAccount: (toolId: string, label: string) => command<AuthAccount>('create_account', { toolId, label }),
  renameAccount: (id: string, expectedVersion: number, label: string) => command<AuthAccount>('rename_account', { id, expectedVersion, label }),
  deleteAccount: (id: string, expectedVersion: number) => command<void>('delete_account', { id, expectedVersion }),
  openAccountLoginLink: (id: string, attemptId: string) => command<void>('open_account_login_link', { id, attemptId }),
  startAccountLogin: (id: string, expectedVersion: number, method: 'browser' | 'device') => command<AuthAccount>('start_account_login', { id, expectedVersion, method }),
  cancelAccountLogin: (id: string, attemptId: string) => command<AuthAccount>('cancel_account_login', { id, attemptId }),
  checkAccount: (id: string) => command<AuthAccount>('check_account', { id }),
  logoutAccount: (id: string, expectedVersion: number) => command<AuthAccount>('logout_account', { id, expectedVersion }),
  usagePresets: () => usageCommand<UsagePreset[]>('usage_presets'),
  ensureProfileUsage: (profileId: string, expectedProfileVersion: number) => usageCommand<UsageQuery | null>('ensure_profile_usage', { profileId, expectedProfileVersion }),
  usageBuiltinScript: (config: QueryConfig) => usageCommand<string>('usage_builtin_script', { config }),
  listUsageCache: () => usageCommand<UsageCache[]>('list_usage_cache'),
  listUsageSamples: (queryId: string) => usageCommand<UsageSample[]>('list_usage_samples', { queryId }),
  cancelUsageRefresh: (id: string) => usageCommand<void>('cancel_usage_refresh', { id }),
  refreshUsageQuery: (id: string) => usageCommand<void>('refresh_usage_query', { id }),
  listUsageQueries: () => usageCommand<UsageQuery[]>('list_usage_queries'),
  createUsageTest: () => usageCommand<string>('create_usage_test'),
  cancelUsageTest: (executionId: string) => usageCommand<void>('cancel_usage_test', { executionId }),
  testUsageQuery: (executionId: string, draftRevision: number, draft: UsageQueryDraft) => usageCommand<DraftTestReport>('test_usage_query', { executionId, draftRevision, draft }),
  getUsageQuery: (id: string) => usageCommand<UsageQuery>('get_usage_query', { id }),
  saveUsageQuery: (draft: UsageQueryDraft) => usageCommand<SaveQueryResult>('save_usage_query', { draft }),
  deleteUsageQuery: (id: string, expectedVersion: number) => usageCommand<DeleteQueryResult>('delete_usage_query', { id, expectedVersion }),
  listPortableItems: () => command<PortableItem[]>('list_portable_items'),
  exportPortableBundle: (destination: string, password: string, selected: string[]) => command<number>('export_portable_bundle', { destination, password, selected }),
  previewPortableBundle: (source: string, password: string) => command<PortablePreview>('preview_portable_bundle', { source, password }),
  applyPortableBundle: (previewId: string, selected: string[], projectLinks: PortableProjectLink[], applyTargets: PortableApplyTarget[]) => command<PortableImportReport>('apply_portable_bundle', { previewId, selected, projectLinks, applyTargets }),
  cancelPortablePreview: () => command<void>('cancel_portable_preview'),
  getWebdavStatus: () => command<SyncStatus>('get_webdav_status'),
  configureWebdav: (setup: WebdavSetup) => command<SyncStatus>('configure_webdav', { setup }),
  setWebdavEnabled: (enabled: boolean) => command<SyncStatus>('set_webdav_enabled', { enabled }),
  syncWebdavNow: () => command<SyncStatus>('sync_webdav_now'),
  resolveWebdavConflict: (key: string, chosenVersionId: string | null) => command<SyncStatus>('resolve_webdav_conflict', { key, chosenVersionId }),
  previewWebdavConflict: (key: string) => command<ConflictPreview>('preview_webdav_conflict', { key }),
  cancelHistoryRefresh: () => command<void>('cancel_history_refresh'),
  getHistoryScanProgress: () => command<{ running: boolean; toolId: string; completedSources: number; totalSources: number }>('get_history_scan_progress'),
  refreshHistory: () => command<ScanStatus[]>('refresh_history'),
  listHistorySessions: (filter: HistoryFilter) => command<HistorySession[]>('list_history_sessions', { filter }),
  getHistorySession: (id: string) => command<HistoryDetail>('get_history_session', { id }),
  setHistoryFavorite: (id: string, favorite: boolean) => command<void>('set_history_favorite', { id, favorite }),
  setHistoryProject: (id: string, projectId: string | null) => command<void>('set_history_project', { id, projectId }),
  getUsageReport: (filter: HistoryFilter) => command<UsageReport>('get_usage_report', { filter }),
  listHistoryPrices: () => command<HistoryPrice[]>('list_history_prices'),
  saveHistoryPrice: (price: HistoryPrice) => command<HistoryPrice>('save_history_price', { price }),
  copyHistoryResumeCommand: (id: string, mode: LaunchRequest['mode']) => command<string>('copy_history_resume_command', { id, mode }),
  resumeHistorySession: (id: string, mode: LaunchRequest['mode']) => command<LaunchResult>('resume_history_session', { id, mode }),
  exportHistorySession: (id: string, format: 'markdown' | 'json', destination: string) => command<string>('export_history_session', { id, format, destination }),
  listMcpDefinitions: () => command<McpDefinition[]>('list_mcp_definitions'),
  listMcpPlacements: () => command<McpPlacement[]>('list_mcp_placements'),
  saveMcpDefinition: (draft: McpDraft) => command<McpDefinition>('save_mcp_definition', { draft }),
  deleteMcpDefinition: (id: string, expectedVersion: number) => command<void>('delete_mcp_definition', { id, expectedVersion }),
  removeNativeMcp: (target: McpTargetRequest, name: string) => command<void>('remove_native_mcp', { target, name }),
  listNativeMcp: (target: McpTargetRequest) => command<NativeMcpEntry[]>('list_native_mcp', { target }),
  getManagedMcpEnabled: (definitionId: string, target: McpTargetRequest) => command<boolean | null>('get_managed_mcp_enabled', {definitionId,target}),
  previewMcpTargets: (definitionId: string, targets: McpTargetRequest[]) => command<McpTargetResult[]>('preview_mcp_targets', { definitionId, targets }),
  distributeMcp: (definitionId: string, targets: McpTargetRequest[]) => command<McpTargetResult[]>('distribute_mcp', { definitionId, targets }),
  previewRuleTargets: (ruleId: string, targets: RuleTarget[]) => command<RulePreview[]>('preview_rule_targets', { ruleId, targets }),
  applyRuleTargets: (ruleId: string, expectedVersion: number, targets: RuleTarget[]) => command<RuleApplyResult[]>('apply_rule_targets', { ruleId, expectedVersion, targets }),
  listRulePlacements: () => command<RulePlacement[]>('list_rule_placements'),
  syncRuleClients: (ruleId: string, expectedVersion: number, selection: RuleClientSelection) => command<RuleSyncResult[]>('sync_rule_clients', { ruleId, expectedVersion, selection }),
  listSkillPackages: () => command<SkillPackage[]>('list_skill_packages'),
  setSkillInLibrary: (id: string, inLibrary: boolean) => command<void>('set_skill_in_library', { id, inLibrary }),
  previewSkillLocal: (source: string) => command<SkillImportPreview>('preview_skill_local', { source }),
  importSkillLocal: (source: string, expectedNew: string | null, expectedExisting: string | null) => command<SkillPackage>('import_skill_local', { source, expectedNew, expectedExisting }),
  previewSkillHttpsZip: (source: string, subdirectory: string | null) => command<SkillImportPreview>('preview_skill_https_zip', { source, subdirectory }),
  listSkillZipEntries: (source: string, local: boolean) => command<string[]>('list_skill_zip_entries', { source, local }),
  previewSkillLocalZip: (source: string, subdirectory: string | null) => command<SkillImportPreview>('preview_skill_local_zip', { source, subdirectory }),
  importSkillLocalZip: (source: string, subdirectory: string | null, expectedNew: string | null, expectedExisting: string | null) => command<SkillPackage>('import_skill_local_zip', { source, subdirectory, expectedNew, expectedExisting }),
  importSkillHttpsZip: (source: string, subdirectory: string | null, expectedNew: string | null, expectedExisting: string | null) => command<SkillPackage>('import_skill_https_zip', { source, subdirectory, expectedNew, expectedExisting }),
  listSkillInstallations: (packageId: string) => command<SkillInstallation[]>('list_skill_installations', { packageId }),
  listSkillRecoveryIssues: () => command<SkillRecoveryIssue[]>('list_skill_recovery_issues'),
  scanNativeSkills: (toolId: string, scope: Scope, projectPath: string | null) => command<NativeSkillEntry[]>('scan_native_skills', { toolId, scope, projectPath }),
  readNativeSkill: (toolId: string, scope: Scope, projectPath: string | null, directory: string) => command<NativeSkillDocument>('read_native_skill', { toolId, scope, projectPath, directory }),
  saveNativeSkill: (toolId: string, scope: Scope, projectPath: string | null, directory: string, baseline: string, content: string) => command<void>('save_native_skill', { toolId, scope, projectPath, directory, baseline, content }),
  previewSkillTarget: (packageId: string, toolId: string, scope: Scope, projectPath: string | null) => command<SkillTargetPreview>('preview_skill_target', { packageId, toolId, scope, projectPath }),
  installSkill: (packageId: string, toolId: string, scope: Scope, projectPath: string | null, previewToken: string | null, allowTakeover: boolean) => command<SkillTargetResult>('install_skill', { packageId, toolId, scope, projectPath, previewToken, allowTakeover }),
  removeSkill: (packageId: string, toolId: string, scope: Scope, projectPath: string | null, expectedContextId: string | null = null) => command<SkillTargetResult>('remove_skill', { expectedContextId, packageId, toolId, scope, projectPath }),
  deleteSkillPackage: (packageId: string) => command<void>('delete_skill_package', { packageId }),
  listLibraryItems: (kind: LibraryKind, projectId: string | null, search: string) => command<LibraryItem[]>('list_library_items', { kind, projectId, search }),
  saveLibraryItem: (draft: LibraryDraft) => command<LibraryItem>('save_library_item', { draft }),
  deleteLibraryItem: (id: string, expectedVersion: number) => command<void>('delete_library_item', { id, expectedVersion }),
  getBootstrap: () => command<Bootstrap>('get_bootstrap'),
  listProjects: () => command<Project[]>('list_projects'),
  addProject: (projectPath: string, name?: string, preferredTool?: string) => command<Project>('add_project', { projectPath, name: name || null, preferredTool: preferredTool || null }),
  renameProject: (projectId: string, name: string) => command<Project>('rename_project', { projectId, name }),
  removeProject: (projectId: string) => command<void>('remove_project', { projectId }),
  relinkProject: (projectId: string, projectPath: string) => command<Project>('relink_project', { projectId, projectPath }),
  openProjectDirectory: (projectId: string) => command<void>('open_project_directory', { projectId }),
  setProjectTool: (projectId: string, toolId: string | null) => command<Project>('set_project_tool', { projectId, toolId }),
  setProjectModelOverride: (projectId: string, toolId: string, model: string | null) => command<Project>('set_project_model_override', { projectId, toolId, model }),
  getLaunchSettings: () => command<LaunchSettings>('get_launch_settings'),
  setPreferredTerminal: (terminal: TerminalId) => command<LaunchSettings>('set_preferred_terminal', { terminal }),
  setCustomTerminal: (program: string, args: string[]) => command<LaunchSettings>('set_custom_terminal', { program, args }),
  setDefaultLaunchMode: (target: 'cli' | 'project', mode: LaunchMode) => command<LaunchSettings>('set_default_launch_mode', { target, mode }),
  launchCli: (request: LaunchRequest) => command<LaunchResult>('launch_cli', { request }),
  cliLatestVersion: (toolId: string) => command<string>('cli_latest_version', { toolId }),
  cancelCliMaintenance: (toolId: string) => command<void>('cancel_cli_maintenance', { toolId }),
  maintainRegisteredCli: (toolId: string, action: 'install' | 'upgrade' | 'install_native' | 'uninstall_npm', source?: string) => command<MaintenanceResult>('maintain_registered_cli', { toolId, action, source: source ?? null }),
  getTrayStatus: () => command<TrayStatus>('get_tray_status'),
  quitApp: () => command<void>('quit_app'),
  listCliAdapters: () => command<AdapterCatalog>('list_cli_adapters'),
  setRegisteredManagedTools: (managedIds: string[]) => command<AdapterCatalog>('set_registered_managed_tools', { managedIds }),
  getRegisteredToolWorkspace: readWorkspace,
  getRegisteredToolContext: readToolContext,
  setRegisteredCustomCliPath: (toolId: string, path: string | null) => command<void>('set_registered_custom_cli_path', { toolId, path }),
  saveRegisteredNativeProfile: (profile: RegisteredProfile, expectedVersion: number | null) => command<RegisteredProfile>('save_registered_native_profile', { profile, expectedVersion }),
  saveRegisteredCommonConfig: (common: RegisteredCommon, expectedVersion: number | null) => command<RegisteredCommonSaveResult>('save_registered_common_config', { common, expectedVersion }),
  applyRegisteredNativeProfile: (toolId: string, profileId: string, scope: Scope, projectPath: string | undefined, allowTakeover: boolean) => command<ApplyOutcome>('apply_registered_native_profile', { toolId, profileId, scope, projectPath: projectPath || null, allowTakeover }),
  compareRegisteredApplication: (profileId: string, scope: Scope, projectPath: string) => command<ApplyComparison>('compare_registered_application', {profileId,scope,projectPath:projectPath || null}),
  applyComparedApplication: (comparison: ApplyComparison, scope: Scope, projectPath: string) => command<ApplyOutcome>('apply_compared_application',{comparison,scope,projectPath:projectPath || null}),
  inspectRegisteredNativeDraft: (toolId: string, files: Record<string, string>) => command<NativeInspection>('inspect_registered_native_draft', { toolId, files }),
  prepareRegisteredNativeImport: (toolId: string, files: Record<string, string>) => command<NativeImport>('prepare_registered_native_import', { toolId, files }),
  prepareRegisteredNativeImportFromDisk: (toolId: string, scope: Scope, projectPath: string, roles: string[], files: Record<string, string>) => command<NativeImport>('prepare_registered_native_import_from_disk', { toolId, scope, projectPath: projectPath || null, roles, files }),
  readRegisteredNativeFileForEdit: (toolId: string, scope: Scope, projectPath: string, role: string) => command<string>('read_registered_native_file_for_edit', { toolId, scope, projectPath: projectPath || null, role }),
  listNativeBackups: (toolId: string, scope: Scope, projectPath: string, role: string) => command<{ transactionId: string; path: string; createdAt: number }[]>('list_native_backups', { toolId, scope, projectPath: projectPath || null, role }),
  previewNativeBackup: (toolId: string, scope: Scope, projectPath: string, role: string, transactionId: string) => command<{ transactionId: string; current: string; original: string }>('preview_native_backup', { toolId, scope, projectPath: projectPath || null, role, transactionId }),
  restoreNativeBackup: (toolId: string, scope: Scope, projectPath: string, role: string, transactionId: string, current: string, expectedContextId: string | null = null) => command<ApplyOutcome>('restore_native_backup', { expectedContextId, toolId, scope, projectPath: projectPath || null, role, transactionId, current }),
  saveRegisteredNativeFile: (toolId: string, scope: Scope, projectPath: string, role: string, original: string, edited: string, expectedContextId: string | null = null) => command<ApplyOutcome>('save_registered_native_file', { expectedContextId, toolId, scope, projectPath: projectPath || null, role, original, edited }),
  mergeRegisteredNativeEdits: (toolId: string, role: string, original: string, edited: string, current: string) => command<string>('merge_registered_native_edits', { toolId, role, original, edited, current }),
  previewRegisteredNativeProfile: (profile: RegisteredProfile, scope: Scope) => command<NativePreview>('preview_registered_native_profile', { profile, scope }),
  listPreservedProfiles: (toolId: string) => command<PreservedProfile[]>('list_preserved_profiles', { toolId }),
  setManagedTools: (managedTools: CliId[]) => command<Bootstrap>('set_managed_tools', { managedTools }),
  setToolIcon: (toolId: string, dataUrl: string | null) => command<Bootstrap>('set_tool_icon', { toolId, dataUrl }),
  setTheme: (theme: Theme) => command<Bootstrap>('set_theme', { theme }),
  getToolWorkspace: (tool: CliId, scope: Scope, projectPath?: string) => command<ToolWorkspace>('get_tool_workspace', { tool, scope, projectPath: projectPath || null }),
  setCustomCliPath: (tool: CliId, path: string | null) => command<void>('set_custom_cli_path', { tool, path }),
  saveNativeProfile: (profile: NativeProfile, expectedVersion: number | null) => command<NativeProfile>('save_native_profile', { profile, expectedVersion }),
  deleteNativeProfile: (id: string, expectedVersion: number, expectedRevision: string) => command<void>('delete_native_profile', { id, expectedVersion, expectedRevision }),
  saveCommonConfig: (common: CommonConfig, expectedVersion: number | null) => command<CommonSaveResult>('save_common_config', { common, expectedVersion }),
  applyNativeProfile: (tool: CliId, profileId: string, scope: Scope, projectPath: string | undefined, allowTakeover: boolean) => command<ApplyOutcome>('apply_native_profile', { tool, profileId, scope, projectPath: projectPath || null, allowTakeover }),
  recoverNativeTransactions: () => command<string[]>('recover_native_transactions'),
  getSkillEnabled: (packageId: string, toolId: string, scope: Scope, projectPath: string | null) => command<boolean>('get_skill_enabled', { packageId, toolId, scope, projectPath }),
  setSkillEnabled: (packageId: string, toolId: string, scope: Scope, projectPath: string | null, enabled: boolean, expectedContextId: string | null = null) => command<void>('set_skill_enabled', { expectedContextId, packageId, toolId, scope, projectPath, enabled }),
  getNativeRuleEnabled: (target: RuleTarget) => command<boolean>('get_native_rule_enabled', { target }),
  setNativeRuleEnabled: (target: RuleTarget, enabled: boolean) => command<void>('set_native_rule_enabled', { target, enabled }),
  readNativeRule: (target: RuleTarget) => command<{ contextId: string | null; path: string; text: string; fingerprint: string }>('read_native_rule', { target }),
  saveNativeRule: (target: RuleTarget, original: string, edited: string) => command<ApplyOutcome>('save_native_rule', { target, original, edited }),
  launchCliLogin: (toolId: string) => command<LaunchResult>('launch_cli_login', { toolId }),
  getConnectionSecret: (secretRef: string) => command<string>('get_connection_secret', { secretRef }),
  setConnectionSecret: (secret: string) => command<string>('set_connection_secret', { secret }),
  listProviderModels: (connection: Connection, force: boolean, query = '') => command<ModelDirectory>('list_provider_models', { connection, force, query }),
  testProviderConnection: (tool: CliId, connection: Connection, allowModelRequest: boolean) => command<ConnectionCheck>('test_provider_connection', { tool, connection, allowModelRequest }),
  testRegisteredProviderConnection: (toolId: string, connection: Connection, allowModelRequest: boolean) => command<ConnectionCheck>('test_registered_provider_connection', { toolId, connection, allowModelRequest }),
  inspectNativeDraft: (tool: CliId, files: Record<string, string>) => command<NativeInspection>('inspect_native_draft', { tool, files }),
  prepareNativeImport: (tool: CliId, files: Record<string, string>) => command<NativeImport>('prepare_native_import', { tool, files }),
  prepareNativeImportFromDisk: (tool: CliId, scope: Scope, projectPath: string, roles: string[], files: Record<string, string>) => command<NativeImport>('prepare_native_import_from_disk', { tool, scope, projectPath: projectPath || null, roles, files }),
  readNativeFileForEdit: (tool: CliId, scope: Scope, projectPath: string, role: string) => command<string>('read_native_file_for_edit', { tool, scope, projectPath: projectPath || null, role }),
  setCodexReasoningEffort: (text: string, effort: string | null) => command<string>('set_codex_reasoning_effort', { text, effort }),
  previewNativeProfile: (profile: NativeProfile, scope: Scope) => command<NativePreview>('preview_native_profile', { profile, scope }),
};

export const describeConfiguration = (toolId: string, scope: Scope) => command<ConfigurationDescriptor | null>('describe_configuration', { toolId, scope });
export const openConfigurationDraft = (profile: RegisteredProfile, scope: Scope, sessionId: string) => command<ConfigurationDraft>('open_configuration_draft', { profile, scope, sessionId });
export const editConfigurationDraft = (draft: ConfigurationDraft, action: ConfigurationAction) => command<ConfigurationDraft>('edit_configuration_draft', { draft, action });
export const replaceConfigurationText = (draft: ConfigurationDraft, files: Record<string, string>) => command<ConfigurationDraft>('replace_configuration_text', { draft, files });

// Workspace drafts retain their source/baseline in Rust. Profile/common saves are DB only.
export const beginConfigurationDraft = (request: import('../types/configuration').ConfigurationBeginRequest) => command<ConfigurationDraft>('begin_configuration_draft', { request });
export const updateConfigurationDraft = (draft: ConfigurationDraft, profile: RegisteredProfile) => command<ConfigurationDraft>('update_configuration_draft', { draft, profile });
export const selectConfigurationCredential = (draft: ConfigurationDraft, credential: import('../types/configuration').ConfigurationCredential) => command<ConfigurationDraft>('select_configuration_credential', { draft, credential });
export const setConfigurationDraftSecret = (draft: ConfigurationDraft, secret: string) => command<ConfigurationDraft>('set_configuration_draft_secret', { draft, secret });
export const cancelConfigurationDraft = (sessionId: string) => command<void>('cancel_configuration_draft', { sessionId });
export const cancelConfigurationRequests = (draft: ConfigurationDraft) => command<ConfigurationDraft>('cancel_configuration_requests', { draft });
export const addConfigurationModels = (draft: ConfigurationDraft, ids: string[]) => command<ConfigurationDraft>('add_configuration_models', { draft, ids });
export const listConfigurationModels = (draft: ConfigurationDraft, force = false, query = '') => command<import('../types/configuration').ConfigurationDirectoryResult>('list_configuration_models', { draft, force, query });
export const checkConfigurationConnection = (draft: ConfigurationDraft, allowModelRequest = false) => command<import('../types/configuration').ConfigurationCheckResult>('check_configuration_connection', { draft, allowModelRequest });
export const saveConfigurationDraft = (draft: ConfigurationDraft) => command<import('../types/configuration').ConfigurationSaveResult>('save_configuration_draft', { draft });
export const commonInfluence = (toolId: string) => command<import('../types/configuration').CommonInfluence>('common_influence', { toolId });
export const applyCommonConfiguration = (common: RegisteredCommon, targets: import('../types/configuration').CommonInfluenceTarget[]) => command<import('../types/configuration').CommonApplicationResult[]>('apply_common_configuration', { common, targets });
export const removeConfigurationDraftSecret = (draft: ConfigurationDraft) => command<ConfigurationDraft>('remove_configuration_draft_secret', { draft });
export const revealConfigurationDraftSecret = (draft: ConfigurationDraft) => command<string>('reveal_configuration_draft_secret', { draft });
export const compareConfigurationCurrent = (draft: ConfigurationDraft) => command<import('../types/configuration').ConfigurationCurrentComparison>('compare_configuration_current', { draft });
export const rebaseConfigurationCurrent = (draft: ConfigurationDraft, comparisonId: string, files: Record<string, string>) => command<ConfigurationDraft>('rebase_configuration_current', { draft, comparisonId, files });
export const previewConfigurationBackup = (draft: ConfigurationDraft, role: string, transactionId: string) => command<import('../types/configuration').ConfigurationBackupPreview>('preview_configuration_backup', { draft, role, transactionId });
export const restoreConfigurationBackup = (draft: ConfigurationDraft, role: string, transactionId: string) => command<import('../types/configuration').ConfigurationSaveResult>('restore_configuration_backup', { draft, role, transactionId });
