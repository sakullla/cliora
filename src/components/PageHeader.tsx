import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions, compact = false }: { title: string; subtitle?: string; actions?: ReactNode; compact?: boolean }) {
  return <header className="page-head" data-compact={compact || undefined}><div><h1 tabIndex={-1}>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions}</header>;
}
