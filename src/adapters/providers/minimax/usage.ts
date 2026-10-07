import type { UsageMetric } from '../../../types/usage';
import i18n from '../../../i18n';

export const minimaxUsagePresentation = {
  id: 'minimax',
  metricLabel: (metric: UsageMetric) => metric.label
    .replace(/^general(?= · |$)/, i18n.t('tools.adapters.minimax.metricGeneral'))
    .replace(/^video(?= · |$)/, i18n.t('tools.adapters.minimax.metricVideo')),
};
