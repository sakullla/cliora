import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './Button';
import styles from './Switch.module.css';

export type SwitchProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'role' | 'onChange' | 'checked'> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label. Without one, pass `aria-label`. */
  label?: ReactNode;
};

/** An on/off setting: a native checkbox with role="switch" and the shared track styling. */
export function Switch({ checked, onChange, label, className, disabled, ...rest }: SwitchProps) {
  const input = <input {...rest} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} />;
  if (label === undefined) return input;
  return <label className={cx(styles.switch, className)} data-disabled={disabled || undefined}>
    {input}
    <span className={styles.label}>{label}</span>
  </label>;
}
