import type { ReactNode } from 'react';
import { Button, cx } from './Button';
import type { ButtonProps } from './Button';
import styles from './Button.module.css';

export type IconButtonProps = Omit<ButtonProps, 'children' | 'icon' | 'aria-label'> & {
  /** Icon-only controls must name themselves; the name doubles as the tooltip. */
  'aria-label': string;
  icon: ReactNode;
};

export function IconButton({ icon, variant = 'ghost', className, title, ...rest }: IconButtonProps) {
  return <Button {...rest} variant={variant} className={cx(styles.iconButton, className)} title={title ?? rest['aria-label']} icon={icon} />;
}
