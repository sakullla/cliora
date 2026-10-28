import type { ComponentPropsWithRef } from 'react';
import { cx } from './Button';
import styles from './Card.module.css';

export type CardProps = ComponentPropsWithRef<'article'> & {
  padding?: 'default' | 'compact' | 'none';
  interactive?: boolean;
  selected?: boolean;
};

/** A bordered surface on the page canvas. Holds at most one `data-variant="primary"` button. */
export function Card({ padding = 'default', interactive = false, selected = false, className, ...rest }: CardProps) {
  return <article {...rest} className={cx(styles.card, className)} data-card="" data-padding={padding} data-interactive={interactive || undefined} data-selected={selected || undefined} />;
}
