import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions, compact = false, eyebrow, variant }: { title: string; subtitle?: string; actions?: ReactNode; compact?: boolean; eyebrow?: ReactNode; variant?: 'hero' }) {
  return <header className="page-head" data-compact={compact || undefined} data-variant={variant}><div>{!compact && eyebrow && <span className="page-eyebrow">{eyebrow}</span>}<h1 tabIndex={-1}>{title}</h1>{compact && eyebrow && <span className="page-eyebrow">{eyebrow}</span>}{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="page-head-actions">{actions}</div>}</header>;
}
