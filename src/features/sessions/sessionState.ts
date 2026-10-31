import type { WorkbenchSession } from '../../types/launch';

/** A local transport exit does not establish that the persistent CLI ended. */
export function remoteSessionMayExist(session: WorkbenchSession): boolean {
  return !!session.projectId?.startsWith('remote:') && session.connectionState !== 'remote_ended';
}

export function sessionConfirmedEnded(session: WorkbenchSession): boolean {
  return !session.running && !remoteSessionMayExist(session);
}
