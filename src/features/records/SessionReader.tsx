import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryDetail, HistoryMessage } from '../../types/history';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { writeClipboard } from '../../lib/clipboard';
import { useDisclosure } from './useDisclosure';
import i18n from '../../i18n';
import styles from './SessionReader.module.css';

const readerLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';

const MessageMarkdown = lazy(() => import('./MessageMarkdown'));
const CLAMP_LENGTH = 1800;

function MarkdownPending() {
  return <div className={styles.markdownPending} aria-hidden="true"><span /><span /><span /></div>;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts: Array<string | React.JSX.Element> = [];
  let offset = 0;
  let index = text.toLowerCase().indexOf(query.toLowerCase());
  while (index !== -1) {
    parts.push(text.slice(offset, index), <mark key={index}>{text.slice(index, index + query.length)}</mark>);
    offset = index + query.length;
    index = text.toLowerCase().indexOf(query.toLowerCase(), offset);
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

const Message = memo(function Message({ item, toolId, toolName, raw, query, current, renderMarkdown }: {
  item: HistoryMessage; toolId: string; toolName: string; raw: boolean; query: string; current: boolean; renderMarkdown: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState('');
  const approximate = item.timestampSource !== 'native';
  const timeSource = item.timestampSource === 'turn' ? t('records.reader.timeTurn') : item.timestampSource === 'session' ? t('records.reader.timeSession') : t('records.reader.timeUnknown');
  const user = item.role === 'user';
  const context = item.kind === 'project_context' ? t('records.reader.contextProject') : item.kind === 'environment_context' ? t('records.reader.contextEnv') : null;
  const collapsedContext = context && !expanded && !raw && !query;
  const role = user ? t('records.reader.you') : item.role === 'assistant' ? toolName : (item.role === 'system' ? t('records.reader.roleSystem') : item.role === 'tool' ? t('records.reader.roleTool') : item.role);
  const clamped = item.text.length > CLAMP_LENGTH && !expanded && !query && !raw;
  const text = clamped ? item.text.slice(0, CLAMP_LENGTH) : item.text;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(''), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <article className={styles.message} data-message-id={item.id} data-role={item.role} data-context={!!context || undefined} data-current-match={current || undefined}>
    {collapsedContext ? <button type="button" className={styles.contextToggle} aria-expanded={false} onClick={() => setExpanded(true)}><Icon name="folder" size={14} /><span>{context}</span><span>{t('records.reader.expand')}</span></button> : <>
    <div className={styles.avatar}>{user ? t('records.reader.you') : <ToolIcon toolId={toolId} size={22} />}</div>
    <div className={styles.messageContent}>
      <header className={styles.messageHead}><strong>{context ?? role}</strong>
        <time title={item.timestamp === null ? t('records.format.timeUnknown') : `${new Date(item.timestamp).toLocaleString(readerLocale())}${approximate ? ` · ${timeSource}` : ''}`}>{item.timestamp === null ? t('records.format.timeUnknown') : `${approximate ? t('records.reader.approxPrefix') : ''}${new Date(item.timestamp).toLocaleTimeString(readerLocale(), { hour: '2-digit', minute: '2-digit' })}`}</time>
        <button type="button" aria-label={copied || t('records.reader.copy')} title={t('records.reader.copy')} onClick={() => void writeClipboard(item.text).then((ok) => setCopied(ok ? t('records.reader.copied') : t('records.reader.copyFailed')))}>
          <Icon name={copied === t('records.reader.copied') ? 'check' : 'copy'} size={14} />{copied && <span role="status">{copied}</span>}
        </button>
      </header>
      <div className={`${styles.prose} ${clamped ? styles.clamped : ''}`}>
        {raw || user || query || !renderMarkdown ? <p className={styles.raw}><Highlight text={text} query={query} /></p>
          : <Suspense fallback={<MarkdownPending />}><MessageMarkdown text={text} /></Suspense>}
      </div>
      {(context || item.text.length > CLAMP_LENGTH) && !query && !raw && <button type="button" className={styles.expand} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? context ? t('records.reader.collapseContext') : t('records.reader.collapseLong') : t('records.reader.expandFull', { count: item.text.length.toLocaleString() })}</button>}
    </div>
    </>}
  </article>;
});

export function SessionReader({ detail, toolName }: { detail: HistoryDetail; toolName: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const findButton = useRef<HTMLButtonElement>(null);
  const optionsRef = useDisclosure();
  const [onlyQuestions, setOnlyQuestions] = useState(false);
  const [raw, setRaw] = useState(false);
  const [current, setCurrent] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(() => new Set(detail.messages.slice(0, 8).map((item) => item.id)));
  const search = query.trim();
  useEffect(() => {
    void import('./MessageMarkdown').catch(() => {});
  }, []);
  const visible = useMemo(() => detail.messages.map((item) => ({ item })).filter(({ item }) => !onlyQuestions || item.role === 'user'), [detail.messages, onlyQuestions]);
  const matches = useMemo(() => search ? visible.filter(({ item }) => item.text.toLowerCase().includes(search.toLowerCase())) : [], [visible, search]);
  const selected = matches.length ? current % matches.length : 0;
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const ids = entries.filter((entry) => entry.isIntersecting).map((entry) => {
        observer.unobserve(entry.target);
        return (entry.target as HTMLElement).dataset.messageId!;
      });
      if (ids.length) setRendered((old) => new Set([...old, ...ids]));
    }, { root: root.current?.parentElement, rootMargin: '600px 0px' });
    root.current?.querySelectorAll('[data-role="assistant"]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [detail.messages, onlyQuestions]);
  function revealMatch(id: string) {
    const message = root.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    (message?.querySelector('mark') ?? message)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  function jump(index: number) {
    if (!matches.length) return;
    const next = (index + matches.length) % matches.length;
    setCurrent(next);
    revealMatch(matches[next].item.id);
  }
  function jumpLatest() {
    const latest = visible[visible.length - 1]?.item;
    if (!latest) return;
    setRendered((old) => new Set([...old, latest.id]));
    requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(latest.id)}"]`)
        ?.scrollIntoView({ block: 'end', behavior: 'instant' });
    });
  }
  useEffect(() => {
    setCurrent(0);
    if (search && matches.length) revealMatch(matches[0].item.id);
  }, [search, onlyQuestions]);
  return <div className={styles.reader} aria-label={t('records.reader.label')} ref={root}>
    <div className={styles.readerToolbar}>
      <div className={styles.readerTitle}><strong>{onlyQuestions ? t('records.reader.onlyQuestions') : t('records.reader.allMessages')}</strong><span>{t('records.reader.messageCount', { count: visible.length.toLocaleString() })}{raw ? t('records.reader.rawSuffix') : ''}</span>
        {detail.session.messageCount > detail.messages.length && <span title={t('records.reader.indexedTitle')}>{t('records.reader.indexed', { count: detail.session.messageCount.toLocaleString() })}</span>}
      </div>
      <div className={styles.readerOptions}>
        <button type="button" ref={findButton} aria-label={t('records.reader.findAria')} aria-expanded={findOpen} onClick={() => { setFindOpen(!findOpen); setQuery(''); }}><Icon name="search" size={14} />{t('records.reader.find')}</button>
        <details className={styles.readingOptions} ref={optionsRef}><summary>{t('records.reader.options')}</summary><div>
        <label><input type="checkbox" checked={onlyQuestions} onChange={(event) => setOnlyQuestions(event.target.checked)} />{t('records.reader.onlyQuestions')}</label>
        <label><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />{t('records.reader.showRaw')}</label>
        </div></details>
        <button type="button" title={t('records.reader.latestTitle')} onClick={jumpLatest}><Icon name="arrowDown" size={13} />{t('records.reader.latest')}</button>
      </div>
      {findOpen && <div className={styles.find}>
        <Icon name="search" size={14} /><input autoFocus aria-label={t('records.reader.findAria')} placeholder={t('records.reader.findPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); jump(selected + (event.shiftKey ? -1 : 1)); }
          if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); setFindOpen(false); findButton.current?.focus(); }
        }} />
        {search && <><span role="status">{matches.length ? t('records.reader.matchCount', { current: selected + 1, total: matches.length }) : t('records.reader.noMatch')}</span><button type="button" disabled={!matches.length} aria-label={t('records.reader.prevMatch')} onClick={() => jump(selected - 1)}>↑</button><button type="button" disabled={!matches.length} aria-label={t('records.reader.nextMatch')} onClick={() => jump(selected + 1)}>↓</button><button type="button" aria-label={t('records.reader.clearFind')} onClick={() => setQuery('')}><Icon name="close" size={13} /></button></>}
      </div>}
      {search && <small className={styles.findHint}>{t('records.reader.findHint')}</small>}
    </div>
    <div className={styles.messages}>
      {visible.map(({ item }, visibleIndex) => {
        const previous = visible[visibleIndex - 1]?.item;
        const date = item.timestamp === null ? t('records.reader.dateUnknown') : new Date(item.timestamp).toLocaleDateString(readerLocale(), { year: 'numeric', month: 'long', day: 'numeric' });
        const changedDay = !previous || (previous.timestamp === null ? 'unknown' : new Date(previous.timestamp).toDateString()) !== (item.timestamp === null ? 'unknown' : new Date(item.timestamp).toDateString());
        return <div key={item.id}>{changedDay && <div className={styles.dayDivider}>{date}</div>}<Message item={item} toolId={detail.session.toolId} toolName={toolName} raw={raw} query={search} current={matches[selected]?.item.id === item.id} renderMarkdown={rendered.has(item.id)} /></div>;
      })}
      {!visible.length && <div className={styles.empty}><Icon name="records" size={24} /><h3>{onlyQuestions ? t('records.reader.emptyQuestions') : t('records.reader.emptyTitle')}</h3><p>{onlyQuestions ? t('records.reader.emptyQuestionsHint') : t('records.reader.emptyHint')}</p>{onlyQuestions && <button type="button" onClick={() => setOnlyQuestions(false)}>{t('records.reader.viewAll')}</button>}</div>}
    </div>
  </div>;
}
