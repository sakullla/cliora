import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ApiError, Bootstrap, CliId, Theme } from '../types/domain';
import type { ApplyOutcome, CommonConfig, CommonSaveResult, Connection, ConnectionCheck, ModelDirectory, NativeImport, NativeInspection, NativePreview, NativeProfile, Scope, ToolWorkspace } from '../types/native';

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
  inspectNativeDraft: (tool: CliId, files: Record<string, string>) => command<NativeInspection>('inspect_native_draft', { tool, files }),
  prepareNativeImport: (tool: CliId, files: Record<string, string>) => command<NativeImport>('prepare_native_import', { tool, files }),
  setCodexReasoningEffort: (text: string, effort: string | null) => command<string>('set_codex_reasoning_effort', { text, effort }),
  previewNativeProfile: (profile: NativeProfile, scope: Scope) => command<NativePreview>('preview_native_profile', { profile, scope }),
};
