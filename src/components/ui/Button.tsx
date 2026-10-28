import type { ComponentPropsWithRef, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and shows a spinner in place of the icon. */
  loading?: boolean;
  icon?: ReactNode;
};

export function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}

/**
 * The shared button. `data-variant` is the semantic hook for "one primary action per
 * toolbar or card" checks; style it through the variant, not through extra classes.
 */
export function Button({ variant = 'secondary', size = 'md', loading = false, icon, className, disabled, type = 'button', children, ...rest }: ButtonProps) {
  return <button {...rest} type={type} className={cx(styles.button, className)} data-variant={variant} data-size={size} disabled={disabled || loading} aria-busy={loading || undefined}>
    {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
    {children}
  </button>;
}
