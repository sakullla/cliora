import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
import i18n from '../../i18n';

export function kimiFieldPresentation(id: string): FieldPresentation {
  return { nativeField: id, ...({
    max_context_size: { unit: 'Token', description: i18n.t('tools.adapters.kimi.fields.max_context_size') },
    max_input_size: { unit: 'Token', description: i18n.t('tools.adapters.kimi.fields.max_input_size') },
    max_output_size: { unit: 'Token', description: i18n.t('tools.adapters.kimi.fields.max_output_size') },
    model: { description: i18n.t('tools.adapters.kimi.fields.model') },
    capabilities: { description: i18n.t('tools.adapters.kimi.fields.capabilities') },
  } as Record<string,FieldPresentation>)[id] };
}
