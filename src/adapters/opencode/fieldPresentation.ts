import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
export function openCodeFieldPresentation(id: string): FieldPresentation {
  return { nativeField: id, ...({ 'limit.context': { unit: 'Token', description: '输入与输出共同受此上下文窗口限制。' }, 'limit.output': { unit: 'Token', description: '单次最大输出；不会替代上下文窗口。' }, reasoning: { description: '模型的推理能力声明；具体推理变体在 variants 中配置。' }, options: { description: '此模型的原生请求选项，已有未知选项会保留。' } } as Record<string,FieldPresentation>)[id] };
}
