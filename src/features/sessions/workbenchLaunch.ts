import { native, nativeAvailable } from '../../lib/native';
import type { LaunchMode, LaunchRequest, LaunchResult } from '../../types/launch';

export type WorkbenchRetry =
  | { kind: 'launch'; request: LaunchRequest }
  | { kind: 'resume'; id: string; mode: LaunchMode };
export type WorkbenchFailure = { detail: string; retry: WorkbenchRetry };
export type RemoteWorkbenchIntent = { token: number; toolId?: string; targetId?: string; quickLaunch?: boolean; chooseDirectory?: boolean };

/** The id of the session a launch really opened, whichever host owns it: a workbench
 *  terminal or an ACP conversation. A desktop or external terminal launch returns null. */
export function workbenchSessionId(result: LaunchResult): string | null {
  if (result.status !== 'session_started' && result.status !== 'acp_started') return null;
  return result.sessionId ?? null;
}

/** A conversation is not a PTY session: it publishes its own snapshot. */
export function isAcpLaunch(result: LaunchResult): boolean {
  return result.status === 'acp_started' || result.interaction === 'acp';
}

/** Desktop launches never become workbench sessions. */
export async function failedInWorkbench(desktop = false): Promise<boolean> {
  if (desktop || !nativeAvailable) return false;
  try { return (await native.getLaunchSettings()).selected === 'workbench'; }
  catch { return false; }
}
