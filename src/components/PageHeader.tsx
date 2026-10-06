import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-head"><div><h1 tabIndex={-1}>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions}</header>;
}
