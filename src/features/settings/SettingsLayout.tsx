import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/Icon';
import styles from './SettingsLayout.module.css';

export type SettingsCategory<T extends string> = { id: T; icon: IconName; label: string; hint: string };

/**
 * Settings categories on the left, one category on the right. The list is a vertical
 * tab list (arrow keys, Home/End); on narrow pages it becomes one scrolling row.
 */
export function SettingsLayout<T extends string>({ items, value, onChange, children }: { items: SettingsCategory<T>[]; value: T; onChange: (value: T) => void; children: ReactNode }) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const active = items.find((item) => item.id === value) ?? items[0];

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.id === value);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    onChange(items[next].id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`[data-category="${items[next].id}"]`)?.focus());
  }

  return <div className={styles.layout}>
    <nav className={styles.nav} aria-label={t('settings.tabs.label')}>
      <div ref={list} className={styles.list} role="tablist" aria-orientation="vertical" aria-label={t('settings.tabs.label')} onKeyDown={move}>
        {items.map((item) => <button key={item.id} type="button" role="tab" id={`settings-tab-${item.id}`} data-category={item.id} aria-selected={item.id === active.id} aria-controls="settings-panel" tabIndex={item.id === active.id ? 0 : -1} className={styles.item} aria-label={item.label} title={item.hint} onClick={() => onChange(item.id)}>
          <span className={styles.glyph} aria-hidden="true"><Icon name={item.icon} size={16} /></span>
          <span className={styles.text}><strong>{item.label}</strong><small>{item.hint}</small></span>
        </button>)}
      </div>
    </nav>
    <section className={styles.panel} role="tabpanel" id="settings-panel" aria-label={active.label}>
      {/* Wide pages already show the label and hint in the list; narrow pages hide the hint there. */}
      <header className={styles.head}>
        <h2 className={styles.title}>{active.label}</h2>
        <p>{active.hint}</p>
      </header>
      {children}
    </section>
  </div>;
}
