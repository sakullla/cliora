import type { ReactNode } from 'react';
import { navigateChoices } from '../../lib/choiceNavigation';
import { cx } from './Button';
import styles from './Segmented.module.css';

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  /** Accessible name of the group. */
  label: string;
  value: V;
  options: ReadonlyArray<SegmentedOption<V>>;
  onChange: (value: V) => void;
  size?: 'md' | 'sm';
  className?: string;
}

/**
 * One choice among views of the same data. A single Tab stop; ←/→/Home/End move and select.
 */
export function Segmented<V extends string>({ label, value, options, onChange, size = 'md', className }: SegmentedProps<V>) {
  const selectable = options.some(option => option.value === value && !option.disabled);
  const focusable = selectable ? value : options.find(option => !option.disabled)?.value;
  return <div role="radiogroup" aria-label={label} className={cx(styles.segmented, className)} data-size={size} onKeyDown={navigateChoices}>
    {options.map(option => <button
      key={option.value}
      type="button"
      role="radio"
      aria-checked={option.value === value}
      tabIndex={option.value === focusable ? 0 : -1}
      disabled={option.disabled}
      onClick={() => { if (option.value !== value) onChange(option.value); }}
    >{option.label}</button>)}
  </div>;
}
