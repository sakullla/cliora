import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
import i18n from '../../i18n';

export function claudeFieldPresentation(id: string): FieldPresentation {
  const role = id.split('.')[0];
  const names: Record<string,string> = { default:'ANTHROPIC_MODEL', sonnet:'ANTHROPIC_DEFAULT_SONNET_MODEL', opus:'ANTHROPIC_DEFAULT_OPUS_MODEL', fable:'ANTHROPIC_DEFAULT_FABLE_MODEL', haiku:'ANTHROPIC_DEFAULT_HAIKU_MODEL', subagent:'CLAUDE_CODE_SUBAGENT_MODEL' };
  if (id.endsWith('.longContext')) return { nativeField: `${names[role] ?? role} [1m]`, description: i18n.t('tools.adapters.claude.fields.longContext') };
  if (id.endsWith('.model') || id.endsWith('.name')) return { nativeField: `env.${names[role] ?? role}${id.endsWith('.name') ? '_NAME' : ''}`, description: i18n.t('tools.adapters.claude.fields.model') };
  return { nativeField: id, description: id.includes('Effort') || id.includes('effort') ? i18n.t('tools.adapters.claude.fields.effort') : undefined };
}
