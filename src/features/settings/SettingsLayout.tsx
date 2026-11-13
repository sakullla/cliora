import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
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
  const layout = useRef<HTMLDivElement>(null);
  const latest = useRef({ items, value, onChange });
  latest.current = { items, value, onChange };
  const active = items.find((item) => item.id === value) ?? items[0];

  useLayoutEffect(() => {
    const scroller = layout.current?.closest<HTMLElement>('.content');
    if (scroller) scroller.scrollTop = 0;
  }, [value]);

  useEffect(() => {
    const scroller = layout.current?.closest<HTMLElement>('.content');
    if (!scroller) return;
    let lastWheel = 0;
    let amount = 0;
    let locked = false;
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (!(event.target instanceof Element) || event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const direction = Math.sign(event.deltaY);
      // Nested editors/lists retain their own scrolling, including at their edges.
      for (let node = event.target; node && node !== scroller; node = node.parentElement!) {
        if (node.scrollHeight > node.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
      }
      const now = performance.now();
      if (now - lastWheel > 240) { amount = 0; locked = false; }
      lastWheel = now;
      const atEdge = direction < 0 ? scroller.scrollTop <= 2 : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      if (!atEdge) { amount = 0; return; }
      const { items: categories, value: selected, onChange: select } = latest.current;
      const next = categories.findIndex((item) => item.id === selected) + direction;
      if (next < 0 || next >= categories.length) return;
      event.preventDefault();
      if (locked) return;
      if (Math.sign(amount) !== direction) amount = 0;
      amount += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1);
      if (Math.abs(amount) < 80) return;
      locked = true;
      amount = 0;
      select(categories[next].id);
    };
    scroller.addEventListener('wheel', wheel, { passive: false });
    return () => scroller.removeEventListener('wheel', wheel);
  }, []);

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

  return <div ref={layout} className={styles.layout}>
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
