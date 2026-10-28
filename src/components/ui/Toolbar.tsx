import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';
import { cx } from './Button';
import type { ButtonProps } from './Button';
import styles from './Toolbar.module.css';

export type ToolbarProps = Omit<ComponentPropsWithoutRef<'div'>, 'title' | 'children'> & {
  title?: ReactNode;
  /** Heading level of the title; defaults to h2. */
  titleAs?: 'h2' | 'h3' | 'h4';
  count?: ReactNode;
  /** Secondary and ghost actions. */
  actions?: ReactNode;
  /** The single primary action of this toolbar. */
  primary?: ReactElement<ButtonProps>;
  children?: ReactNode;
};

/**
 * Title, count, secondary actions and exactly one primary slot. Keeping the primary in its
 * own slot is what holds a toolbar to one `data-variant="primary"` button.
 */
export function Toolbar({ title, titleAs: Heading = 'h2', count, actions, primary, className, children, ...rest }: ToolbarProps) {
  return <div {...rest} role={rest.role ?? 'toolbar'} className={cx(styles.toolbar, className)} data-toolbar="">
    {(title || count !== undefined) && <div className={styles.heading}>
      {title && <Heading className={styles.title}>{title}</Heading>}
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </div>}
    {children}
    {actions && <div className={styles.actions}>{actions}</div>}
    {primary && <div className={styles.primary}>{primary}</div>}
  </div>;
}
