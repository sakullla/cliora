import type { BusinessWorkspace } from '../types/workspaces';

/** Fired after any project edit inside Cliora; pages holding a project list read it again. */
export const WORKSPACES_CHANGED = 'cliora:business-workspaces-changed';
/** `workspace` is the project as the operation returned it; listeners patch it instead of
 * listing and re-probing every repository. `source` lets the sender skip its own event. */
export type WorkspacesChangedDetail = { source?: string; workspace?: BusinessWorkspace };
export function notifyWorkspacesChanged(detail: WorkspacesChangedDetail = {}) { window.dispatchEvent(new CustomEvent<WorkspacesChangedDetail>(WORKSPACES_CHANGED, { detail })); }
export function changedWorkspace(event: Event) { return (event as CustomEvent<WorkspacesChangedDetail | null>).detail ?? {}; }
/** A focus refresh re-checks every repository directory; with hundreds of them, switching
 * windows back and forth must not repeat that work each time. */
export const FOCUS_REFRESH_INTERVAL = 30_000;
