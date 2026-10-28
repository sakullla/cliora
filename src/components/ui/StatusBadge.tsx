import { useTranslation } from 'react-i18next';
import { statusTone } from '../../lib/statusTone';
import type { StatusDomain, StatusState } from '../../lib/statusTone';
import { Badge } from './Badge';
import type { BadgeProps } from './Badge';

export type StatusBadgeProps<D extends StatusDomain> = Omit<BadgeProps, 'tone' | 'children'> & {
  domain: D;
  state: StatusState<D>;
};

/** A domain state rendered with the shared tone and label, so it reads the same on every page. */
export function StatusBadge<D extends StatusDomain>({ domain, state, ...rest }: StatusBadgeProps<D>) {
  const { t } = useTranslation();
  const { tone, labelKey } = statusTone(domain, state);
  return <Badge {...rest} tone={tone} data-status={`${domain}.${state}`}>{t(labelKey)}</Badge>;
}
