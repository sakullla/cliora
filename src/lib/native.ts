import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ApiError, Bootstrap, CliId, Theme } from '../types/domain';
import type { AdapterCatalog, ApplyOutcome, CommonConfig, CommonSaveResult, Connection, ConnectionCheck, ModelDirectory, NativeImport, NativeInspection, NativePreview, NativeProfile, PreservedProfile, RegisteredCommon, RegisteredCommonSaveResult, RegisteredProfile, RegisteredToolWorkspace, Scope, ToolWorkspace } from '../types/native';
import type { LaunchRequest, LaunchResult, LaunchSettings, Project, TerminalId, TrayStatus } from '../types/launch';
import type { LibraryDraft, LibraryItem, LibraryKind } from '../types/library';
import type { McpDefinition, McpDraft, McpTargetRequest, McpTargetResult, NativeMcpEntry, RuleTarget, RulePreview, RuleApplyResult, SkillPackage, SkillImportPreview, SkillInstallation, SkillTargetResult, NativeSkillEntry, SkillTargetPreview, SkillRecoveryIssue } from '../types/resources';
import type { HistoryDetail, HistoryFilter, HistoryPrice, HistorySession, ScanStatus, UsageSummary } from '../types/history';
import type { ConflictPreview, PortableApplyTarget, PortableImportReport, PortableItem, PortablePreview, PortableProjectLink, SyncStatus, WebdavSetup } from '../types/portable';

export const nativeAvailable = isTauri();

function readError(error: unknown): ApiError {
  if (typeof error === 'string') {
    return { code: 'native_error', message: error, action: '请检查本机状态后重试。' };
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = error as Partial<ApiError>;
    return {
      code: typeof value.code === 'string' ? value.code : 'native_error',
      message: typeof value.message === 'string' ? value.message : '操作失败',
      action: typeof value.action === 'string' ? value.action : '请重试。',
      data_directory: typeof value.data_directory === 'string' ? value.data_directory : null,
    };
  }
  return { code: 'native_error', message: '原生服务暂时不可用', action: '请重新打开桌面应用。' };
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw readError(error);
  }
}

/** Feature modules add named wrappers here; components never invoke arbitrary commands. */
export const native = {
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
  refreshHistory: () => command<ScanStatus[]>('refresh_history'),
  listHistorySessions: (filter: HistoryFilter) => command<HistorySession[]>('list_history_sessions', { filter }),
  getHistorySession: (id: string) => command<HistoryDetail>('get_history_session', { id }),
  setHistoryFavorite: (id: string, favorite: boolean) => command<void>('set_history_favorite', { id, favorite }),
  setHistoryProject: (id: string, projectId: string | null) => command<void>('set_history_project', { id, projectId }),
  getHistoryUsage: (filter: HistoryFilter) => command<UsageSummary>('get_history_usage', { filter }),
  listHistoryPrices: () => command<HistoryPrice[]>('list_history_prices'),
  saveHistoryPrice: (price: HistoryPrice) => command<HistoryPrice>('save_history_price', { price }),
  copyHistoryResumeCommand: (id: string, mode: LaunchRequest['mode']) => command<string>('copy_history_resume_command', { id, mode }),
  resumeHistorySession: (id: string, mode: LaunchRequest['mode']) => command<LaunchResult>('resume_history_session', { id, mode }),
  exportHistorySession: (id: string, format: 'markdown' | 'json', destination: string) => command<string>('export_history_session', { id, format, destination }),
  listMcpDefinitions: () => command<McpDefinition[]>('list_mcp_definitions'),
  saveMcpDefinition: (draft: McpDraft) => command<McpDefinition>('save_mcp_definition', { draft }),
  listNativeMcp: (target: McpTargetRequest) => command<NativeMcpEntry[]>('list_native_mcp', { target }),
  previewMcpTargets: (definitionId: string, targets: McpTargetRequest[]) => command<McpTargetResult[]>('preview_mcp_targets', { definitionId, targets }),
  distributeMcp: (definitionId: string, targets: McpTargetRequest[]) => command<McpTargetResult[]>('distribute_mcp', { definitionId, targets }),
  previewRuleTargets: (ruleId: string, targets: RuleTarget[]) => command<RulePreview[]>('preview_rule_targets', { ruleId, targets }),
  applyRuleTargets: (ruleId: string, expectedVersion: number, targets: RuleTarget[]) => command<RuleApplyResult[]>('apply_rule_targets', { ruleId, expectedVersion, targets }),
  listSkillPackages: () => command<SkillPackage[]>('list_skill_packages'),
  previewSkillLocal: (source: string) => command<SkillImportPreview>('preview_skill_local', { source }),
  importSkillLocal: (source: string, expectedNew: string | null, expectedExisting: string | null) => command<SkillPackage>('import_skill_local', { source, expectedNew, expectedExisting }),
  previewSkillHttpsZip: (source: string, subdirectory: string | null) => command<SkillImportPreview>('preview_skill_https_zip', { source, subdirectory }),
  importSkillHttpsZip: (source: string, subdirectory: string | null, expectedNew: string | null, expectedExisting: string | null) => command<SkillPackage>('import_skill_https_zip', { source, subdirectory, expectedNew, expectedExisting }),
  listSkillInstallations: (packageId: string) => command<SkillInstallation[]>('list_skill_installations', { packageId }),
  listSkillRecoveryIssues: () => command<SkillRecoveryIssue[]>('list_skill_recovery_issues'),
  scanNativeSkills: (toolId: string, scope: Scope, projectPath: string | null) => command<NativeSkillEntry[]>('scan_native_skills', { toolId, scope, projectPath }),
  previewSkillTarget: (packageId: string, toolId: string, scope: Scope, projectPath: string | null) => command<SkillTargetPreview>('preview_skill_target', { packageId, toolId, scope, projectPath }),
  installSkill: (packageId: string, toolId: string, scope: Scope, projectPath: string | null, previewToken: string | null, allowTakeover: boolean) => command<SkillTargetResult>('install_skill', { packageId, toolId, scope, projectPath, previewToken, allowTakeover }),
  removeSkill: (packageId: string, toolId: string, scope: Scope, projectPath: string | null) => command<SkillTargetResult>('remove_skill', { packageId, toolId, scope, projectPath }),
  listLibraryItems: (kind: LibraryKind, projectId: string | null, search: string) => command<LibraryItem[]>('list_library_items', { kind, projectId, search }),
  saveLibraryItem: (draft: LibraryDraft) => command<LibraryItem>('save_library_item', { draft }),
  deleteLibraryItem: (id: string, expectedVersion: number) => command<void>('delete_library_item', { id, expectedVersion }),
  getBootstrap: () => command<Bootstrap>('get_bootstrap'),
  listProjects: () => command<Project[]>('list_projects'),
  addProject: (projectPath: string, name?: string, preferredTool?: string) => command<Project>('add_project', { projectPath, name: name || null, preferredTool: preferredTool || null }),
  relinkProject: (projectId: string, projectPath: string) => command<Project>('relink_project', { projectId, projectPath }),
  openProjectDirectory: (projectId: string) => command<void>('open_project_directory', { projectId }),
  setProjectTool: (projectId: string, toolId: string | null) => command<Project>('set_project_tool', { projectId, toolId }),
  setProjectModelOverride: (projectId: string, toolId: string, model: string | null) => command<Project>('set_project_model_override', { projectId, toolId, model }),
  getLaunchSettings: () => command<LaunchSettings>('get_launch_settings'),
  setPreferredTerminal: (terminal: TerminalId) => command<LaunchSettings>('set_preferred_terminal', { terminal }),
  launchCli: (request: LaunchRequest) => command<LaunchResult>('launch_cli', { request }),
  getTrayStatus: () => command<TrayStatus>('get_tray_status'),
  quitApp: () => command<void>('quit_app'),
  listCliAdapters: () => command<AdapterCatalog>('list_cli_adapters'),
  setRegisteredManagedTools: (managedIds: string[]) => command<AdapterCatalog>('set_registered_managed_tools', { managedIds }),
  getRegisteredToolWorkspace: (toolId: string, scope: Scope, projectPath?: string) => command<RegisteredToolWorkspace>('get_registered_tool_workspace', { toolId, scope, projectPath: projectPath || null }),
  setRegisteredCustomCliPath: (toolId: string, path: string | null) => command<void>('set_registered_custom_cli_path', { toolId, path }),
  saveRegisteredNativeProfile: (profile: RegisteredProfile, expectedVersion: number | null) => command<RegisteredProfile>('save_registered_native_profile', { profile, expectedVersion }),
  saveRegisteredCommonConfig: (common: RegisteredCommon, expectedVersion: number | null) => command<RegisteredCommonSaveResult>('save_registered_common_config', { common, expectedVersion }),
  applyRegisteredNativeProfile: (toolId: string, profileId: string, scope: Scope, projectPath: string | undefined, allowTakeover: boolean) => command<ApplyOutcome>('apply_registered_native_profile', { toolId, profileId, scope, projectPath: projectPath || null, allowTakeover }),
  inspectRegisteredNativeDraft: (toolId: string, files: Record<string, string>) => command<NativeInspection>('inspect_registered_native_draft', { toolId, files }),
  prepareRegisteredNativeImport: (toolId: string, files: Record<string, string>) => command<NativeImport>('prepare_registered_native_import', { toolId, files }),
  prepareRegisteredNativeImportFromDisk: (toolId: string, scope: Scope, projectPath: string, roles: string[], files: Record<string, string>) => command<NativeImport>('prepare_registered_native_import_from_disk', { toolId, scope, projectPath: projectPath || null, roles, files }),
  readRegisteredNativeFileForEdit: (toolId: string, scope: Scope, projectPath: string, role: string) => command<string>('read_registered_native_file_for_edit', { toolId, scope, projectPath: projectPath || null, role }),
  previewRegisteredNativeProfile: (profile: RegisteredProfile, scope: Scope) => command<NativePreview>('preview_registered_native_profile', { profile, scope }),
  listPreservedProfiles: (toolId: string) => command<PreservedProfile[]>('list_preserved_profiles', { toolId }),
  setManagedTools: (managedTools: CliId[]) => command<Bootstrap>('set_managed_tools', { managedTools }),
  setTheme: (theme: Theme) => command<Bootstrap>('set_theme', { theme }),
  getToolWorkspace: (tool: CliId, scope: Scope, projectPath?: string) => command<ToolWorkspace>('get_tool_workspace', { tool, scope, projectPath: projectPath || null }),
  setCustomCliPath: (tool: CliId, path: string | null) => command<void>('set_custom_cli_path', { tool, path }),
  saveNativeProfile: (profile: NativeProfile, expectedVersion: number | null) => command<NativeProfile>('save_native_profile', { profile, expectedVersion }),
  deleteNativeProfile: (id: string, expectedVersion: number, expectedRevision: string) => command<void>('delete_native_profile', { id, expectedVersion, expectedRevision }),
  saveCommonConfig: (common: CommonConfig, expectedVersion: number | null) => command<CommonSaveResult>('save_common_config', { common, expectedVersion }),
  applyNativeProfile: (tool: CliId, profileId: string, scope: Scope, projectPath: string | undefined, allowTakeover: boolean) => command<ApplyOutcome>('apply_native_profile', { tool, profileId, scope, projectPath: projectPath || null, allowTakeover }),
  recoverNativeTransactions: () => command<string[]>('recover_native_transactions'),
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
