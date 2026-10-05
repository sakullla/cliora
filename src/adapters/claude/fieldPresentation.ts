import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
export function claudeFieldPresentation(id: string): FieldPresentation {
  const role = id.split('.')[0];
  const names: Record<string,string> = { default:'ANTHROPIC_MODEL', sonnet:'ANTHROPIC_DEFAULT_SONNET_MODEL', opus:'ANTHROPIC_DEFAULT_OPUS_MODEL', fable:'ANTHROPIC_DEFAULT_FABLE_MODEL', haiku:'ANTHROPIC_DEFAULT_HAIKU_MODEL', subagent:'CLAUDE_CODE_SUBAGENT_MODEL' };
  if (id.endsWith('.longContext')) return { nativeField: `${names[role] ?? role} [1m]`, description: '原生长上下文路由后缀；服务支持范围须以模型和账号能力为准，不承诺实际可用。' };
  if (id.endsWith('.model') || id.endsWith('.name')) return { nativeField: `env.${names[role] ?? role}${id.endsWith('.name') ? '_NAME' : ''}`, description: '此角色的请求模型；未设置时采用原生默认或继承。' };
  return { nativeField: id, description: id.includes('Effort') || id.includes('effort') ? '模型级 effort 优先于默认 effort；合法取值由模型能力提供。' : undefined };
}
