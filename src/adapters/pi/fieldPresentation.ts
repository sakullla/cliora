import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
import i18n from '../../i18n';

export function piFieldPresentation(id: string): FieldPresentation {
  return { nativeField: id, ...({
    contextWindow: { unit: 'Token', description: i18n.t('tools.adapters.pi.fields.contextWindow') },
    maxTokens: { unit: 'Token', description: i18n.t('tools.adapters.pi.fields.maxTokens') },
    reasoning: { description: i18n.t('tools.adapters.pi.fields.reasoning') },
    thinkingLevelMap: { description: i18n.t('tools.adapters.pi.fields.thinkingLevelMap') },
  } as Record<string,FieldPresentation>)[id] };
}
