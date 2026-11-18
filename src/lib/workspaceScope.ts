import type { BusinessWorkspace } from '../types/workspaces';

export type InferredWorkspaceScope = { workspaceId: string; repositoryId: string };

/** Compare local directories the way the host does: separators and a trailing slash never matter, case only on Windows paths. */
export function directoryKey(path: string): string {
  const flat = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[a-z]:\//i.test(flat) || flat.startsWith('//') ? flat.toLowerCase() : flat;
}

/**
 * The business project a local session belongs to when no explicit binding was saved — for example a
 * conversation continued from 记录, or one restored after an update that predates the binding.
 *
 * Exact checkout paths (a member location or one of its worktrees) win, then the native directory
 * project the location was launched through, then the deepest member that contains the directory.
 * An ambiguous match (two projects claim the same checkout) returns null rather than guessing.
 */
export function inferWorkspaceScope(session: { directory?: string | null; projectId?: string | null }, workspaces: readonly BusinessWorkspace[]): InferredWorkspaceScope | null {
  const directory = session.directory ? directoryKey(session.directory) : null;
  const exact: InferredWorkspaceScope[] = [];
  const byProject: InferredWorkspaceScope[] = [];
  let deepest: { scope: InferredWorkspaceScope; depth: number; ambiguous: boolean } | null = null;
  for (const workspace of workspaces) {
    for (const repository of workspace.repositories) {
      for (const location of repository.locations) {
        if (location.targetId) continue;
        const scope = { workspaceId: workspace.id, repositoryId: repository.id };
        const paths = [location.path, ...location.worktrees.map((tree) => tree.path)].filter((path): path is string => !!path).map(directoryKey);
        if (directory && paths.includes(directory)) exact.push(scope);
        if (session.projectId && location.projectId === session.projectId) byProject.push(scope);
        if (!directory) continue;
        for (const path of paths) {
          if (!directory.startsWith(path + '/')) continue;
          if (!deepest || path.length > deepest.depth) deepest = { scope, depth: path.length, ambiguous: false };
          else if (path.length === deepest.depth && !sameScope(deepest.scope, scope)) deepest.ambiguous = true;
        }
      }
    }
  }
  const unique = (list: InferredWorkspaceScope[]) => list.length > 0 && list.every((item) => sameScope(item, list[0])) ? list[0] : null;
  if (exact.length) return unique(exact);
  if (byProject.length) return unique(byProject);
  return deepest && !deepest.ambiguous ? deepest.scope : null;
}

function sameScope(a: InferredWorkspaceScope, b: InferredWorkspaceScope): boolean {
  return a.workspaceId === b.workspaceId && a.repositoryId === b.repositoryId;
}
