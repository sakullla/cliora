import type { FieldPresentation } from '../../components/configuration/ConfigurationField';
export function codexFieldPresentation(id: string): FieldPresentation {
  const details: Record<string, FieldPresentation> = {
    model_context_window: { description: '当前模型的上下文窗口；未设置时由模型与 Codex 原生能力决定。' },
    model_reasoning_effort: { description: '此模型请求的推理强度；可用档位来自本机模型能力，未核验原生值会保留。' },
    model_reasoning_summary: { description: '是否生成推理摘要。未设置时跟随原生默认。' },
    model_verbosity: { description: '请求回答的详细程度，服务是否采用取决于模型能力。' },
  };
  return { nativeField: id, ...details[id] };
}
