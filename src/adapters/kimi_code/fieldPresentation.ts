import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
export function kimiFieldPresentation(id: string): FieldPresentation {
  return { nativeField: id, ...({ max_context_size: { unit: 'Token', description: '必填：模型可使用的上下文总容量。目录仅返回 ID 时仍需补齐。' }, max_input_size: { unit: 'Token', description: '可选输入上限，和总上下文/输出上限分别设置。' }, max_output_size: { unit: 'Token', description: '可选最大输出；不是上下文容量。' }, model: { description: '实际发送给服务的模型 ID；配置内 alias 可与它不同。' }, capabilities: { description: '文本是原生默认能力。图片、思考等按模型实际能力声明，不根据模型名字推断。' } } as Record<string,FieldPresentation>)[id] };
}
