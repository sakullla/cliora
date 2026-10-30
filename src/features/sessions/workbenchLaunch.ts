import { native, nativeAvailable } from '../../lib/native';
import type { LaunchMode, LaunchRequest, LaunchResult } from '../../types/launch';

export type WorkbenchRetry =
  | { kind: 'launch'; request: LaunchRequest }
  | { kind: 'resume'; id: string; mode: LaunchMode };
export type WorkbenchFailure = { detail: string; retry: WorkbenchRetry };
export type RemoteWorkbenchIntent = { token: number; toolId?: string; targetId?: string; quickLaunch?: boolean; chooseDirectory?: boolean };

export function workbenchSessionId(result: LaunchResult): string | null {
  return result.status === 'session_started' && result.sessionId ? result.sessionId : null;
}

/** Desktop launches never become workbench sessions. */
export async function failedInWorkbench(desktop = false): Promise<boolean> {
  if (desktop || !nativeAvailable) return false;
  try { return (await native.getLaunchSettings()).selected === 'workbench'; }
  catch { return false; }
}
