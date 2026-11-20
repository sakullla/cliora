import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { highlightRuns } from '../../components/CommandPalette';
import { Icon, type IconName } from '../../components/Icon';
import { ToastHost } from '../../components/Toast';
import { ToolIcon } from '../../components/ToolIcon';
import { Badge, Button, IconButton } from '../../components/ui';
import { isEditableTarget, searchShortcutHint, withMod } from '../../lib/shortcut';
import type { ApiError } from '../../types/domain';
import { filterSettingsSearchEntries, type SettingsSearchEntry } from './settingsSearch';
import styles from './SettingsLayout.module.css';

export type SettingsCategory<T extends string> = { id: T; icon: IconName; label: string; hint: string };

/** Panes register their in-panel sub-view's Escape handling here; the modal walks
 *  the top of the stack before clearing search or closing. */
const SubViewEscapeContext = createContext<((handler: () => boolean) => () => void) | null>(null);

/**
 * A second-level view inside one settings category: back button + title, rendered
 * in place of the category's main view instead of stacking another dialog.
 */
export function SettingsSubView({ title, hint, onBack, backDisabled = false, children }: {
  title: string;
  hint?: string;
  onBack: () => void;
  backDisabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const register = useContext(SubViewEscapeContext);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const disabledRef = useRef(backDisabled);
  disabledRef.current = backDisabled;
  useEffect(() => register?.(() => {
    // While a save is in flight Escape neither leaves the view nor closes settings.
    if (disabledRef.current) return true;
    onBackRef.current();
    return true;
  }), [register]);
  return <div className={styles.subView} role="region" aria-labelledby={titleId}>
    <header className={styles.subHead}>
      <IconButton
        className={styles.backBtn}
        aria-label={t('settings.subView.back')}
        title={t('settings.subView.backEsc')}
        disabled={backDisabled}
        onClick={() => onBackRef.current()}
        icon={<Icon name="arrowLeft" size={16} />}
      />
      <div className={styles.subCopy}>
        <h2 id={titleId}>{title}</h2>
        {hint && <p>{hint}</p>}
      </div>
    </header>
    {children}
  </div>;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return <>{highlightRuns(text, query).map((run, idx) => run.hit ? <mark key={idx} className={styles.mark}>{run.text}</mark> : run.text)}</>;
}

/**
 * Centered modal settings workspace: single-layer category navigation on the left
 * (collapsing to a horizontal pill bar on narrow screens), cross-category instant search,
 * and an independent scrollable panel on the right without wheel-edge category hijacking.
 */
export function SettingsModal<T extends string>({
  open,
  onClose,
  items,
  value,
  onChange,
  searchEntries = [],
  onSelectSearchResult,
  anchorRequest,
  error,
  onDismissError,
  previewBanner,
  onSubViewEscape,
  closeDisabled = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  items: SettingsCategory<T>[];
  value: T;
  onChange: (value: T) => void;
  searchEntries?: ReadonlyArray<SettingsSearchEntry>;
  onSelectSearchResult?: (entry: SettingsSearchEntry) => void;
  anchorRequest?: { anchor?: string; token: number } | null;
  error?: ApiError | null;
  onDismissError?: () => void;
  previewBanner?: string | null;
  onSubViewEscape?: () => boolean;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const flashTargetRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [flashAnchor, setFlashAnchor] = useState<string | null>(null);
  const [navFade, setNavFade] = useState({ left: false, right: false });
  const subViewHandlers = useRef<Array<() => boolean>>([]);
  const clearFlashTarget = useCallback(() => {
    if (flashTargetRef.current) {
      flashTargetRef.current.removeAttribute('data-flash-anchor');
      flashTargetRef.current = null;
    }
  }, []);
  const updateNavFade = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth > 2;
    const left = overflow && el.scrollLeft > 2;
    const right = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setNavFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  const registerSubViewEscape = useCallback((handler: () => boolean) => {
    subViewHandlers.current.push(handler);
    return () => { subViewHandlers.current = subViewHandlers.current.filter((item) => item !== handler); };
  }, []);
  const escapeSubView = useCallback(() => {
    const handler = subViewHandlers.current[subViewHandlers.current.length - 1];
    return handler?.() ?? false;
  }, []);

  const active = items.find((item) => item.id === value) ?? items[0];
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const results = useMemo(() => filterSettingsSearchEntries(searchEntries, trimmedQuery), [searchEntries, trimmedQuery]);
  const safeIndex = results.length ? Math.min(activeIndex, results.length - 1) : 0;

  useLayoutEffect(() => {
    const element = dialogRef.current;
    if (!element || !open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) {
      element.showModal();
      element.focus({ preventScroll: true });
    }
    return () => {
      if (element.open) element.close();
      const target = returnFocus.current;
      if (target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
      setFlashAnchor(null);
      clearFlashTarget();
    }
  }, [open, clearFlashTarget]);

  useEffect(() => {
    if (!open) return;
    const el = navRef.current;
    const raf = requestAnimationFrame(updateNavFade);
    window.addEventListener('resize', updateNavFade);
    let observer: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateNavFade);
      observer.observe(el);
      if (listRef.current) observer.observe(listRef.current);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', updateNavFade);
      observer?.disconnect();
    };
  }, [open, items.length, updateNavFade]);

  useLayoutEffect(() => {
    if (!open || isSearching) return;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [open, value, isSearching]);

  useEffect(() => {
    if (!open || !anchorRequest?.anchor) return;
    const anchor = anchorRequest.anchor;
    let raf = 0;
    let observer: MutationObserver | null = null;
    let timeout = 0;
    const applyTarget = () => {
      const target = dialogRef.current?.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`);
      if (!target) return false;
      target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      clearFlashTarget();
      target.setAttribute('data-flash-anchor', 'true');
      flashTargetRef.current = target;
      setFlashAnchor(anchor);
      observer?.disconnect();
      observer = null;
      if (timeout) {
        window.clearTimeout(timeout);
        timeout = 0;
      }
      return true;
    };
    raf = requestAnimationFrame(() => {
      if (applyTarget()) return;
      const root = scrollerRef.current ?? dialogRef.current;
      if (!root || typeof MutationObserver === 'undefined') return;
      observer = new MutationObserver(() => {
        applyTarget();
      });
      observer.observe(root, { childList: true, subtree: true });
      timeout = window.setTimeout(() => {
        observer?.disconnect();
        observer = null;
      }, 2500);
    });
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      if (timeout) window.clearTimeout(timeout);
    };
  }, [open, value, anchorRequest, clearFlashTarget]);

  useEffect(() => {
    if (!flashAnchor) {
      clearFlashTarget();
      return;
    }
    const timer = window.setTimeout(() => {
      setFlashAnchor(null);
      clearFlashTarget();
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [flashAnchor, clearFlashTarget]);

  useEffect(() => clearFlashTarget, [clearFlashTarget]);

  function hasOtherOpenDialog() {
    return [...document.querySelectorAll('dialog[open]')].some((node) => node !== dialogRef.current);
  }

  function requestClose() {
    if (closeDisabled) return;
    if (escapeSubView()) return;
    if (onSubViewEscape?.()) return;
    if (query) {
      setQuery('');
      setActiveIndex(0);
      return;
    }
    onClose();
  }

  function selectCategory(next: T) {
    if (query) {
      setQuery('');
      setActiveIndex(0);
    }
    onChange(next);
  }

  function pickSearchResult(entry: SettingsSearchEntry) {
    setQuery('');
    setActiveIndex(0);
    onSelectSearchResult?.(entry);
  }

  function moveTabs(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.id === value);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    selectCategory(items[next].id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-category="${items[next].id}"]`)?.focus());
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      if (closeDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (escapeSubView() || onSubViewEscape?.()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (query) {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        setActiveIndex(0);
        return;
      }
      return;
    }
    if (withMod(event) && event.key.toLowerCase() === 's') {
      const saveButton = dialogRef.current?.querySelector<HTMLButtonElement>('[data-dialog-save]:not(:disabled)');
      if (saveButton) {
        event.preventDefault();
        if (!event.repeat) saveButton.click();
      }
      return;
    }
    const findShortcut = withMod(event) && event.key.toLowerCase() === 'f';
    const slashShortcut = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event.target);
    if (findShortcut) {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (slashShortcut) {
      event.preventDefault();
      const pageSearch = [...(scrollerRef.current?.querySelectorAll<HTMLInputElement>('input[data-page-search]') ?? [])]
        .find((node) => node.getClientRects().length > 0);
      const target = pageSearch ?? searchRef.current;
      target?.focus();
      target?.select();
    }
  }

  if (!open) return null;

  return <dialog
    ref={dialogRef}
    tabIndex={-1}
    className={styles.modal}
    data-settings-modal="true"
    aria-labelledby={titleId}
    data-flash-anchor={flashAnchor ?? undefined}
    onCancel={(event) => {
      event.preventDefault();
      requestClose();
    }}
    onMouseDown={(event) => {
      if (event.target === dialogRef.current && !closeDisabled && !hasOtherOpenDialog()) onClose();
    }}
    onKeyDown={handleDialogKeyDown}
  >
    <ToastHost>
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.railTop}>
          <div className={styles.brandRow}>
            <span className={styles.brandBadge} aria-hidden="true"><Icon name="sliders" size={15} /></span>
            <h1 id={titleId} className={styles.modalTitle}>{t('common.pages.settings.title')}</h1>
          </div>
          <button
            type="button"
            className={`${styles.closeBtn} ${styles.mobileClose}`}
            disabled={closeDisabled}
            onClick={onClose}
            aria-label={t('common.dialog.close')}
            title={t('common.dialog.closeEsc')}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className={styles.searchBox} data-field-frame="">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            title={searchShortcutHint()}
            aria-label={t('settings.search.label')}
            placeholder={t('settings.search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (closeDisabled) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (escapeSubView() || onSubViewEscape?.()) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (query) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                  setActiveIndex(0);
                  return;
                }
                return;
              }
              if (!results.length) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((idx) => (idx + 1) % results.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((idx) => (idx - 1 + results.length) % results.length);
              } else if (event.key === 'Enter' && results[safeIndex]) {
                event.preventDefault();
                pickSearchResult(results[safeIndex]);
              }
            }}
          />
          {query && <button
            type="button"
            className={styles.searchClear}
            aria-label={t('common.search.clear')}
            title={t('common.search.clear')}
            onClick={() => {
              setQuery('');
              setActiveIndex(0);
              searchRef.current?.focus();
            }}
          >
            <Icon name="close" size={13} />
          </button>}
        </div>

        <div
          className={styles.navWrap}
          data-fade-left={navFade.left ? 'true' : undefined}
          data-fade-right={navFade.right ? 'true' : undefined}
        >
          <nav ref={navRef} className={styles.nav} aria-label={t('settings.tabs.label')} onScroll={updateNavFade}>
            <div
              ref={listRef}
              className={styles.list}
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('settings.tabs.label')}
              onKeyDown={moveTabs}
            >
              {items.map((item) => {
                const selected = !isSearching && item.id === active.id;
                return <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${item.id}`}
                  data-category={item.id}
                  aria-selected={selected}
                  aria-controls="settings-panel"
                  tabIndex={item.id === active.id ? 0 : -1}
                  className={styles.item}
                  aria-label={item.label}
                  title={item.hint}
                  onClick={() => selectCategory(item.id)}
                >
                  <span className={styles.glyph} aria-hidden="true"><Icon name={item.icon} size={16} /></span>
                  <span className={styles.text}>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                </button>;
              })}
            </div>
          </nav>
        </div>
      </aside>

      <div className={styles.stage}>
        <header className={styles.stageHead}>
          <div className={styles.stageCopy}>
            <span className={styles.stageTitle}>{isSearching ? t('settings.search.resultsLabel') : active.label}</span>
            <p className={styles.stageHint}>
              {isSearching ? t('settings.search.resultCount', { count: results.length }) : active.hint}
            </p>
          </div>
          <IconButton
            size="sm"
            className={styles.desktopClose}
            disabled={closeDisabled}
            onClick={onClose}
            aria-label={t('common.dialog.close')}
            title={t('common.dialog.closeEsc')}
            icon={<Icon name="close" size={16} />}
          />
        </header>

        <div ref={scrollerRef} className={styles.body}>
          {previewBanner && <div className="environment-banner" role="status">
            <span className="banner-icon"><Icon name="info" size={16} /></span>
            <span>{previewBanner}</span>
          </div>}
          {error && <div className="error-banner" role="alert">
            <span className="banner-icon"><Icon name="alert" size={16} /></span>
            <div className="error-copy">
              <strong>{error.message}</strong>
              {error.action && <span>{error.action}</span>}
              {error.data_directory && <code>{error.data_directory}</code>}
            </div>
            {onDismissError && <button type="button" onClick={onDismissError} aria-label={t('common.dismissError')}><Icon name="close" size={14} /></button>}
          </div>}

          {isSearching && <div className={styles.searchPane} role="region" aria-label={t('settings.search.resultsLabel')}>
            {results.length > 0 ? <ul className={styles.resultList}>
              {results.map((entry, idx) => <li key={entry.id}>
                <button
                  type="button"
                  className={styles.resultRow}
                  data-active={idx === safeIndex || undefined}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => pickSearchResult(entry)}
                >
                  <span className={styles.resultIcon} aria-hidden="true">
                    {entry.toolId ? <ToolIcon toolId={entry.toolId} size={20} /> : <Icon name={entry.categoryIcon} size={16} />}
                  </span>
                  <span className={styles.resultBody}>
                    <span className={styles.resultHead}>
                      <strong><Highlighted text={entry.title} query={trimmedQuery} /></strong>
                      <Badge tone="neutral">{entry.categoryLabel}</Badge>
                    </span>
                    <small><Highlighted text={entry.description} query={trimmedQuery} /></small>
                  </span>
                  <span className={styles.resultAction} aria-hidden="true">
                    <span>{t('settings.search.jumpHint')}</span>
                    <Icon name="chevronRight" size={14} />
                  </span>
                </button>
              </li>)}
            </ul> : <div className={styles.searchEmpty} role="status">
              <span className={styles.searchEmptyGlyph} aria-hidden="true"><Icon name="search" size={20} /></span>
              <strong>{t('settings.search.noMatchTitle')}</strong>
              <p>{t('settings.search.noMatchDetail', { query: trimmedQuery })}</p>
              <Button size="sm" onClick={() => { setQuery(''); setActiveIndex(0); searchRef.current?.focus(); }}>{t('common.search.clear')}</Button>
            </div>}
          </div>}

          <section
            hidden={isSearching}
            className={styles.panel}
            role="tabpanel"
            id="settings-panel"
            aria-label={active.label}
          >
            <SubViewEscapeContext.Provider value={registerSubViewEscape}>{children}</SubViewEscapeContext.Provider>
          </section>
        </div>
      </div>
    </div>
    </ToastHost>
  </dialog>;
}
