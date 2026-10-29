import { Children, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { writeClipboard } from '../../lib/clipboard';
import { displayPath } from '../../lib/paths';
import { useFeedback } from '../../lib/toast';
import styles from './DocumentWorkspace.module.css';
import { Button, IconButton, Switch } from '../../components/ui';

export { styles as documentStyles };

export type DocumentWorkspaceProps = {
  /** Accessible name of the page region. */
  label: string;
  /** Accessible name of the list header group (title, actions, search and filters). */
  toolbarLabel?: string;
  /** Short list title shown at the top of the list column. Not a heading. */
  heading?: ReactNode;
  /** Count or summary beside the list title. */
  count?: ReactNode;
  /** Create, import and refresh actions; compact icon buttons fit best. */
  actions?: ReactNode;
  /** Search field under the list title. */
  search?: ReactNode;
  /** Filter controls under the search field. */
  filters?: ReactNode;
  /** Settings and notes pinned under the list. */
  listFooter?: ReactNode;
  /** Accessible name of the list footer group. */
  listFooterLabel?: string;
  /** Failures and notes. They take height above the workbench instead of pushing it. */
  notices?: ReactNode;
  /** List column. The direct child must scroll itself (`min-height: 0`, `overflow: auto`). */
  list?: ReactNode;
  /** Document column. Null keeps the list, and on a wide page shows `placeholder`. */
  document?: ReactNode | null;
  /** Identity of the open document. A change starts the new one at the top instead of keeping the old scroll. */
  documentKey?: string | null;
  placeholder?: ReactNode;
  /** Narrow pages show this above the document. Wide pages hide it. */
  backLabel?: string;
  onBack?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
};

type Shell = { focused: boolean; toggleFocus: () => void };
const ShellContext = createContext<Shell>({ focused: false, toggleFocus: () => {} });

const widthKey = 'cliora:document-list-width';
const focusKey = 'cliora:document-focus';
const minWidth = 240;
const maxWidth = 560;
const defaultWidth = 320;

function storedWidth() {
  try { const value = Number(localStorage.getItem(widthKey)); return Number.isFinite(value) && value >= minWidth && value <= maxWidth ? value : defaultWidth; } catch { return defaultWidth; }
}
function storedFocus() {
  try { return localStorage.getItem(focusKey) === 'true'; } catch { return false; }
}

/**
 * List and document workbench for memory, skills, and agents.
 * One framed surface: the list column carries its own title, actions, search
 * and filters; the document column reads and edits. The divider resizes the
 * list, and focus mode hides it so a long document gets the full width.
 * At 760px and under only one column is visible.
 * Page height is the content area left after the chrome, so the outer page
 * never scrolls the reader away.
 */
export function DocumentWorkspace({ label, toolbarLabel, heading, count, actions, search, filters, listFooter, listFooterLabel, notices, list, document, documentKey, placeholder, backLabel, onBack, onKeyDown }: DocumentWorkspaceProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  const split = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  // The reader, source editor and details each scroll inside the document pane; rewind all of them.
  useLayoutEffect(() => {
    const node = pane.current;
    if (!node) return;
    for (const element of [node, ...node.querySelectorAll<HTMLElement>('*')]) if (element.scrollTop) element.scrollTop = 0;
  }, [documentKey]);
  const [width, setWidth] = useState(storedWidth);
  const [focused, setFocused] = useState(storedFocus);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
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
  useEffect(() => { try { localStorage.setItem(widthKey, String(Math.round(width))); } catch { /* Layout works without storage. */ } }, [width]);
  const toggleFocus = useCallback(() => setFocused(value => {
    const next = !value;
    try { localStorage.setItem(focusKey, String(next)); } catch { /* Layout works without storage. */ }
    return next;
  }), []);

  const clamp = (value: number) => {
    const total = split.current?.clientWidth ?? 1200;
    return Math.round(Math.max(minWidth, Math.min(maxWidth, total * 0.55, value)));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { pointer: event.pointerId, x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    setWidth(clamp(state.width + event.clientX - state.x));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') { event.preventDefault(); setWidth(value => clamp(value - step)); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => clamp(value + step)); }
    else if (event.key === 'Home') { event.preventDefault(); setWidth(clamp(minWidth)); }
    else if (event.key === 'End') { event.preventDefault(); setWidth(clamp(maxWidth)); }
  };

  // Arrow keys walk the rows and open each one, like a mail list. Lists that
  // handle their own keys (memory) prevent the default first.
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(`.${styles.row}:not(:disabled)`)];
    const index = rows.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    if (next === index) return;
    rows[next].focus();
    rows[next].click();
  };

  const view = document ? 'document' : 'list';
  const single = !document && !placeholder;
  const hasHead = heading || count || actions || search || filters;
  return <ShellContext value={{ focused: focused && !!document, toggleFocus }}>
    <section ref={root} className={styles.page} aria-label={label} data-view={view} data-focus={(focused && !!document) || undefined} data-document-shell="" onKeyDown={onKeyDown}>
      {Children.count(notices) > 0 && <div className={styles.notices}>{notices}</div>}
      <div ref={split} className={styles.split} data-single={single || undefined} style={{ '--list-width': `${width}px` } as CSSProperties}>
        <div className={styles.listPane}>
          {hasHead && <div className={styles.listHead} role="group" aria-label={toolbarLabel}>
            {(heading || count || actions) && <div className={styles.listTitle}>
              {heading && <strong>{heading}</strong>}
              {count && <span className={styles.count}>{count}</span>}
              {actions && <span className={styles.listActions}>{actions}</span>}
            </div>}
            {search && <div className={styles.listSearch}>{search}</div>}
            {filters && <div className={styles.listFilters}>{filters}</div>}
          </div>}
          <div className={styles.listBody} onKeyDown={onListKey}>{list}</div>
          {listFooter && <div className={styles.listFoot} role="group" aria-label={listFooterLabel}>{listFooter}</div>}
        </div>
        {!single && <div className={styles.resizer} role="separator" aria-orientation="vertical" aria-label={t('common.document.resize')} title={t('common.document.resize')} aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width} tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={() => setWidth(defaultWidth)} onKeyDown={onSeparatorKey} />}
        {!single && <div ref={pane} className={styles.documentPane}>
          {document ? <>
            {onBack && <Button variant="ghost" size="sm" className={styles.back} icon={<Icon name="arrowLeft" size={14} />} onClick={onBack}>{backLabel}</Button>}
            <div className={styles.documentBody}>{document}</div>
          </> : placeholder}
        </div>}
      </div>
    </section>
  </ShellContext>;
}

function documentElement(): HTMLElement {
  return document.documentElement;
}

/** Hides or restores the list column. Only shown on a wide workbench. */
export function FocusToggle() {
  const { t } = useTranslation();
  const { focused, toggleFocus } = useContext(ShellContext);
  const label = focused ? t('common.document.unfocus') : t('common.document.focus');
  return <IconButton size="sm" className={styles.iconButton} data-focus-toggle="" aria-pressed={focused} aria-label={label} title={label} onClick={toggleFocus} icon={<Icon name={focused ? 'sidebarOpen' : 'sidebarClose'} size={15} />} />;
}

/**
 * Document title bar: title, state badges, tools on the right, and an
 * optional second line for source notes and secondary actions.
 */
export function DocumentHeader({ title, badges, tools, meta, metaActions }: { title: ReactNode; badges?: ReactNode; tools?: ReactNode; meta?: ReactNode; metaActions?: ReactNode }) {
  return <header className={styles.header}>
    <div className={styles.titleRow}>
      <h3 title={typeof title === 'string' ? title : undefined}>{title}</h3>
      {badges && <span className={styles.badges}>{badges}</span>}
      <span className={styles.tools}>{tools}<FocusToggle /></span>
    </div>
    {(meta || metaActions) && <div className={styles.metaRow}>
      {meta && <span className={styles.metaText}>{meta}</span>}
      {metaActions && <span className={styles.metaActions}>{metaActions}</span>}
    </div>}
  </header>;
}

export type DocumentMode = 'read' | 'edit';

/** Reading and source share one surface; switching never discards a draft. */
export function ModeSwitch({ mode, editable, disabled, onChange }: { mode: DocumentMode; editable: boolean; disabled?: boolean; onChange: (mode: DocumentMode) => void }) {
  const { t } = useTranslation();
  return <div className={styles.segmented} role="group" aria-label={t('common.document.modeLabel')}>
    <button type="button" aria-pressed={mode === 'read'} disabled={disabled} onClick={() => { if (mode !== 'read') onChange('read'); }}><Icon name="eye" size={14} />{t('common.document.read')}</button>
    <button type="button" aria-pressed={mode === 'edit'} disabled={disabled} onClick={() => { if (mode !== 'edit') onChange('edit'); }}><Icon name={editable ? 'pencil' : 'terminal'} size={14} />{editable ? t('common.document.edit') : t('common.document.source')}</button>
  </div>;
}

/** Small switch with an accessible name; the label stays visual only. */
export function Toggle({ checked, label, text, disabled, onChange }: { checked: boolean; label: string; text?: string; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <span className={styles.toggle} data-on={checked || undefined}>
    {text && <span aria-hidden="true">{text}</span>}
    <Switch checked={checked} aria-checked={checked} aria-label={label} title={label} disabled={disabled} onChange={onChange} />
  </span>;
}

/** Path row with a copy action, used inside a document details panel. */
export function PathLine({ path, label }: { path: string; label?: string }) {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const shown = displayPath(path);
  return <p className={styles.pathLine}>
    {label && <span className={styles.pathLabel}>{label}</span>}
    <span className={styles.mono} title={shown}>{shown}</span>
    <Button variant="ghost" size="sm" className={styles.ghostButton} onClick={() => { void writeClipboard(shown).then(ok => feedback.setNotice(ok ? t('common.document.pathCopied') : t('common.document.copyFailed'))); }}><Icon name="copy" size={13} />{t('common.document.copyPath')}</Button>
  </p>;
}

/** Footer for drafts: state on the left, discard and save on the right. */
export function DocumentFoot({ dirty, note, children }: { dirty: boolean; note?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return <div className={styles.foot}>
    <span className={styles.footNote} data-dirty={dirty || undefined}>{dirty ? t('common.document.unsaved') : note}</span>
    {children}
  </div>;
}
