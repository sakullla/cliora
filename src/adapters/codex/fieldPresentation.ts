import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
import i18n from '../../i18n';

export function codexFieldPresentation(id: string): FieldPresentation {
  const details: Record<string, FieldPresentation> = {
    model: { label: i18n.t('tools.adapters.codex.labels.model'), placeholder: i18n.t('tools.adapters.codex.fields.modelPlaceholder') },
    model_provider: { label: i18n.t('tools.adapters.codex.labels.provider'), placeholder: i18n.t('tools.adapters.codex.fields.providerPlaceholder') },
    base_url: { label: i18n.t('tools.adapters.codex.labels.address'), placeholder: i18n.t('tools.adapters.codex.fields.addressPlaceholder') },
    model_context_window: { description: i18n.t('tools.adapters.codex.fields.model_context_window') },
    model_reasoning_effort: { description: i18n.t('tools.adapters.codex.fields.model_reasoning_effort') },
    model_reasoning_summary: { description: i18n.t('tools.adapters.codex.fields.model_reasoning_summary') },
    model_verbosity: { description: i18n.t('tools.adapters.codex.fields.model_verbosity') },
  };
  return { nativeField: id, ...details[id] };
}
