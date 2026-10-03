import type { QueryProgram, UsageMetric } from '../../types/usage';
import { minimaxUsagePresentation } from './minimax/usage';

type UsagePresentation = { id: string; metricLabel: (metric: UsageMetric) => string };
const registered = new Map<string, UsagePresentation>([minimaxUsagePresentation].map(adapter => [adapter.id, adapter]));

export function usageMetricLabel(program: QueryProgram | undefined, metric: UsageMetric): string {
  const provider = program?.kind === 'builtin' || program?.kind === 'profile_builtin' ? program.provider : undefined;
  return provider ? registered.get(provider)?.metricLabel(metric) ?? metric.label : metric.label;
}
