import type { TFunction } from 'i18next';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { PromptScope } from '../../types/prompts';
import { shortPath } from '../../lib/paths';
export function scopeValue(scope: PromptScope): string { return scope.kind === 'global' ? 'global' : scope.kind === 'workspace' ? `workspace:${scope.workspaceId}` : scope.kind === 'repository' ? `repository:${scope.repositoryId}` : `unresolved:${scope.legacyProjectId}`; }
export function parseScope(value: string): PromptScope { if (value.startsWith('workspace:')) return { kind: 'workspace', workspaceId: value.slice(10) }; if (value.startsWith('repository:')) return { kind: 'repository', repositoryId: value.slice(11) }; if (value.startsWith('unresolved:')) return { kind: 'unresolved', legacyProjectId: value.slice(11) }; return { kind: 'global' }; }
export function scopeLabel(scope: PromptScope, workspaces: BusinessWorkspace[], t: TFunction): string {
  if (scope.kind === 'global') return t('prompts.global');
  if (scope.kind === 'unresolved') return t('prompts.unresolved');
  if (scope.kind === 'workspace') return workspaces.find(item => item.id === scope.workspaceId)?.name ?? t('prompts.missingProject');
  const project = workspaces.find(item => item.repositories.some(repo => repo.id === scope.repositoryId));
  const repository = project?.repositories.find(item => item.id === scope.repositoryId);
  return repository ? `${project?.name} / ${repository.name}` : t('prompts.missingRepository');
}
/**
 * Scope choices read as a tree: 通用, then each project followed by its own repositories. A repository
 * row shows only its name under the project; search still finds it by the project name, and the
 * closed picker names both.
 */
export function scopeOptions(workspaces: BusinessWorkspace[], t: TFunction) {
  return [
    { value: 'global', label: t('prompts.global'), note: t('prompts.globalNote') },
    ...workspaces.flatMap(project => {
      // Two repositories with one name are told apart by where they live.
      const names = new Map<string, number>();
      for (const repository of project.repositories) names.set(repository.name, (names.get(repository.name) ?? 0) + 1);
      return [
        { value: `workspace:${project.id}`, label: project.name, note: t('prompts.projectScope') },
        ...project.repositories.map(repository => {
          const path = repository.locations.find(location => location.path)?.path;
          const detail = (names.get(repository.name) ?? 0) > 1 && path ? shortPath(path) : undefined;
          return { value: `repository:${repository.id}`, label: repository.name, detail, indent: true, keywords: project.name, triggerLabel: `${project.name} / ${repository.name}` };
        }),
      ];
    }),
  ];
}
/** Badge tone per scope kind, so general/project/repository/unresolved read the same in every prompt view. */
export function scopeTone(scope: PromptScope, workspaces: BusinessWorkspace[]): 'neutral' | 'accent' | 'info' | 'warning' {
  if (scope.kind === 'global') return 'neutral';
  if (scope.kind === 'unresolved') return 'warning';
  // Before project names load, do not flash every scoped prompt as missing.
  if (!workspaces.length) return scope.kind === 'workspace' ? 'accent' : 'info';
  if (scope.kind === 'workspace') return workspaces.some(item => item.id === scope.workspaceId) ? 'accent' : 'warning';
  return workspaces.some(item => item.repositories.some(repo => repo.id === scope.repositoryId)) ? 'info' : 'warning';
}
