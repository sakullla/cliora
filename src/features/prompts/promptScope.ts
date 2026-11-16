import type { TFunction } from 'i18next';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { PromptScope } from '../../types/prompts';
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
export function scopeOptions(workspaces: BusinessWorkspace[], t: TFunction) {
  const repositories = new Map<string, string>();
  for (const project of workspaces) for (const repository of project.repositories) repositories.set(repository.id, `${project.name} / ${repository.name}`);
  return [{ value: 'global', label: t('prompts.global') }, ...workspaces.map(item => ({ value: `workspace:${item.id}`, label: item.name, detail: t('prompts.projectScope') })), ...[...repositories].map(([id, label]) => ({ value: `repository:${id}`, label, detail: t('prompts.repositoryScope') }))];
}
