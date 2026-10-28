import type { ComponentPropsWithoutRef } from 'react';
import type { Tone } from '../../lib/statusTone';
import { cx } from './Button';
import styles from './Badge.module.css';

export type BadgeProps = ComponentPropsWithoutRef<'span'> & {
  tone?: Tone;
  /** Leading dot in the tone color, for states that read as a light. */
  dot?: boolean;
};

export function Badge({ tone = 'neutral', dot = false, className, children, ...rest }: BadgeProps) {
  return <span {...rest} className={cx(styles.badge, className)} data-tone={tone}>
    {dot && <span className={styles.dot} aria-hidden="true" />}
    <span className={styles.label}>{children}</span>
  </span>;
}
