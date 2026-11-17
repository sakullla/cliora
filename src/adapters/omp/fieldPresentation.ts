import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
import i18n from '../../i18n';

export function ompFieldPresentation(id: string): FieldPresentation {
  return { nativeField: id, ...({
    contextWindow: { unit: 'Token', description: i18n.t('tools.adapters.omp.fields.contextWindow') },
    maxTokens: { unit: 'Token', description: i18n.t('tools.adapters.omp.fields.maxTokens') },
    reasoning: { description: i18n.t('tools.adapters.omp.fields.reasoning') },
    input: { description: i18n.t('tools.adapters.omp.fields.input') },
    thinkingLevelMap: { description: i18n.t('tools.adapters.omp.fields.thinkingLevelMap') },
    cost: { description: i18n.t('tools.adapters.omp.fields.cost') },
    retry: { description: i18n.t('tools.adapters.omp.fields.retry') },
    'modelRoles.default': { description: i18n.t('tools.adapters.omp.fields.roleDefault') },
    'modelRoles.smol': { description: i18n.t('tools.adapters.omp.fields.roleSmol') },
    'modelRoles.slow': { description: i18n.t('tools.adapters.omp.fields.roleSlow') },
    'modelRoles.plan': { description: i18n.t('tools.adapters.omp.fields.rolePlan') },
  } as Record<string, FieldPresentation>)[id] };
}
