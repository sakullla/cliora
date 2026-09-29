import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ApiError, Bootstrap, CliId, Theme } from '../types/domain';
import type { AdapterCatalog, ApplyOutcome, CommonConfig, CommonSaveResult, Connection, ConnectionCheck, ModelDirectory, NativeImport, NativeInspection, NativePreview, NativeProfile, PreservedProfile, RegisteredCommon, RegisteredCommonSaveResult, RegisteredProfile, RegisteredToolWorkspace, Scope, ToolWorkspace } from '../types/native';
import type { LaunchRequest, LaunchResult, LaunchSettings, Project, TerminalId, TrayStatus } from '../types/launch';

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
  deleteNativeProfile: (id: string, expectedVersion: number) => command<void>('delete_native_profile', { id, expectedVersion }),
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
