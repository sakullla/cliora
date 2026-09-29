import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ApiError, Bootstrap, CliId, Theme } from '../types/domain';

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
};
