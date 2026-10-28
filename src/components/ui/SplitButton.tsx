import type { ReactNode } from 'react';
import { RowMenu } from '../RowMenu';
import { Button, cx } from './Button';
import type { ButtonProps } from './Button';
import styles from './SplitButton.module.css';

export type SplitButtonProps = Omit<ButtonProps, 'children'> & {
  children: ReactNode;
  /** Accessible name of the menu half. */
  menuLabel: string;
  /** `role="menuitem"` buttons; the menu reuses RowMenu's keyboard and placement. */
  menu: ReactNode;
  menuDisabled?: boolean;
};

const chevron = <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>;

/** A main action with a menu of alternatives beside it. */
export function SplitButton({ children, menuLabel, menu, menuDisabled, variant = 'primary', size = 'md', className, ...rest }: SplitButtonProps) {
  return <div className={cx(styles.split, className)} data-split-variant={variant} data-size={size}>
    <Button {...rest} variant={variant} size={size} className={styles.main}>{children}</Button>
    {menuDisabled
      ? <div><button type="button" disabled aria-label={menuLabel} title={menuLabel}>{chevron}</button></div>
      : <RowMenu label={menuLabel} title={menuLabel} icon={chevron} className="">{menu}</RowMenu>}
  </div>;
}
