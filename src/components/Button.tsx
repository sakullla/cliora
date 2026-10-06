import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'text';
  busy?: boolean;
  children?: ReactNode;
};

export function Button({ variant = 'default', busy = false, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  const classes = [variant === 'text' ? 'text-button' : 'button', variant === 'primary' ? 'primary' : '', className ?? ''].filter(Boolean).join(' ');
  return <button type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>{busy && <span className="spinner" aria-hidden="true" />} {children}</button>;
}
