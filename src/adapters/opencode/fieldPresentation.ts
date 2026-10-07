import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
import i18n from '../../i18n';

export function openCodeFieldPresentation(id: string): FieldPresentation {
  return { nativeField: id, ...({
    'limit.context': { unit: 'Token', description: i18n.t('tools.adapters.opencode.fields.limitContext') },
    'limit.output': { unit: 'Token', description: i18n.t('tools.adapters.opencode.fields.limitOutput') },
    reasoning: { description: i18n.t('tools.adapters.opencode.fields.reasoning') },
    options: { description: i18n.t('tools.adapters.opencode.fields.options') },
  } as Record<string,FieldPresentation>)[id] };
}
