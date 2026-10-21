import { Children, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import styles from './DocumentWorkspace.module.css';

export type DocumentWorkspaceProps = {
  /** Accessible name of the page region. */
  label: string;
  /** Accessible name of the compact toolbar, when `toolbar` is set. */
  toolbarLabel?: string;
  /** Search, filters, and create actions. Stays put while the columns scroll. */
  toolbar?: ReactNode;
  /** Failures and notes. They take height inside the page instead of pushing it. */
  notices?: ReactNode;
  /** List column. The direct child must scroll itself (`min-height: 0`, `overflow: auto`). */
  list?: ReactNode;
  /** Document column. Null keeps the list, and on a wide page shows `placeholder`. */
  document?: ReactNode | null;
  placeholder?: ReactNode;
  /** Narrow pages show this above the document. Wide pages hide it. */
  backLabel?: string;
  onBack?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
};

/**
 * List and document shell for memory, skills, and agents.
 * Above 760px the columns sit side by side and scroll on their own.
 * At 760px and under only one column is visible.
 * Page height is the content area left after the toolbar, with no 380px floor,
 * so the outer page does not scroll the reader away.
 */
export function DocumentWorkspace({ label, toolbarLabel, toolbar, notices, list, document, placeholder, backLabel, onBack, onKeyDown }: DocumentWorkspaceProps) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const section = root.current;
    if (!section) return;
    const scroller = section.closest<HTMLElement>('.content') ?? documentElement();
    let frame = 0;
    const update = () => {
      frame = 0;
      const scrollerTop = scroller === documentElement() ? 0 : scroller.getBoundingClientRect().top;
      const inner = section.closest<HTMLElement>('.content-inner');
      const pad = inner ? Number.parseFloat(getComputedStyle(inner).paddingBottom) || 0 : 0;
      const top = section.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
      const height = Math.max(0, Math.round(scroller.clientHeight - top - pad));
      const next = `${height}px`;
      if (section.style.height !== next) section.style.height = next;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (section.parentElement) observer.observe(section.parentElement);
    window.addEventListener('resize', schedule);
    return () => { if (frame) cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); };
  }, []);

  const view = document ? 'document' : 'list';
  return <section ref={root} className={styles.page} aria-label={label} data-view={view} data-document-shell="" onKeyDown={onKeyDown}>
    {toolbar && <div className={styles.toolbar} role="group" aria-label={toolbarLabel}>{toolbar}</div>}
    {Children.count(notices) > 0 && <div className={styles.notices}>{notices}</div>}
    <div className={styles.split}>
      <div className={styles.listPane}>{list}</div>
      <div className={styles.documentPane}>
        {document ? <>
          {onBack && <button type="button" className={styles.back} onClick={onBack}><Icon name="arrowLeft" size={14} />{backLabel}</button>}
          <div className={styles.documentBody}>{document}</div>
        </> : placeholder}
      </div>
    </div>
  </section>;
}

function documentElement(): HTMLElement {
  return document.documentElement;
}
