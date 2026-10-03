import type { UsageMetric } from '../../../types/usage';

export const minimaxUsagePresentation = {
  id: 'minimax',
  metricLabel: (metric: UsageMetric) => metric.label.replace(/^general(?= · |$)/, '文本套餐').replace(/^video(?= · |$)/, '视频额度'),
};
