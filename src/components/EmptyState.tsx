import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export function EmptyState({ title, detail, action, icon = 'leaf' }: { title: string; detail?: string; action?: ReactNode; icon?: IconName }) {
  return <div className="empty-state"><div className="empty-symbol" aria-hidden="true"><Icon name={icon} size={22} /></div><h2>{title}</h2>{detail && <p>{detail}</p>}{action}</div>;
}
