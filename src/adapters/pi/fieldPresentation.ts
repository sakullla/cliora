import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
export function piFieldPresentation(id: string): FieldPresentation {
  return { nativeField: id, ...({ contextWindow: { unit: 'Token', description: '模型可使用的上下文总窗口。' }, maxTokens: { unit: 'Token', description: '单次请求的最大输出，和上下文窗口分别设置。' }, reasoning: { description: '声明模型是否支持推理；此标记不自动产生合法推理档位。' }, thinkingLevelMap: { description: '原生思考档位映射。只填写已核验的模型/协议取值。' } } as Record<string,FieldPresentation>)[id] };
}
