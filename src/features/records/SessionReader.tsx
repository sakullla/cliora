import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryDetail, HistoryMessage } from '../../types/history';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { writeClipboard } from '../../lib/clipboard';
import { useDisclosure } from './useDisclosure';
import styles from './SessionReader.module.css';

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
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState('');
  const approximate = item.timestampSource !== 'native';
  const timeSource = item.timestampSource === 'turn' ? '按轮次开始时间推断' : item.timestampSource === 'session' ? '会话参考时间' : '时间来源未确认';
  const user = item.role === 'user';
  const context = item.kind === 'project_context' ? '项目说明' : item.kind === 'environment_context' ? '运行环境' : null;
  const collapsedContext = context && !expanded && !raw && !query;
  const role = user ? '你' : item.role === 'assistant' ? toolName : ({ system: '系统', tool: '工具' }[item.role] ?? item.role);
  const clamped = item.text.length > CLAMP_LENGTH && !expanded && !query && !raw;
  const text = clamped ? item.text.slice(0, CLAMP_LENGTH) : item.text;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(''), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <article className={styles.message} data-message-id={item.id} data-role={item.role} data-context={!!context || undefined} data-current-match={current || undefined}>
    {collapsedContext ? <button type="button" className={styles.contextToggle} aria-expanded={false} onClick={() => setExpanded(true)}><Icon name="folder" size={14} /><span>{context}</span><span>展开</span></button> : <>
    <div className={styles.avatar}>{user ? '你' : <ToolIcon toolId={toolId} size={22} />}</div>
    <div className={styles.messageContent}>
      <header className={styles.messageHead}><strong>{context ?? role}</strong>
        <time title={item.timestamp === null ? '时间未知' : `${new Date(item.timestamp).toLocaleString()}${approximate ? ` · ${timeSource}` : ''}`}>{item.timestamp === null ? '时间未知' : `${approximate ? '约 ' : ''}${new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</time>
        <button type="button" aria-label={copied || '复制这条消息'} title="复制这条消息" onClick={() => void writeClipboard(item.text).then((ok) => setCopied(ok ? '已复制这条消息' : '复制失败，请手动选择'))}>
          <Icon name={copied === '已复制这条消息' ? 'check' : 'copy'} size={14} />{copied && <span role="status">{copied}</span>}
        </button>
      </header>
      <div className={`${styles.prose} ${clamped ? styles.clamped : ''}`}>
        {raw || user || query || !renderMarkdown ? <p className={styles.raw}><Highlight text={text} query={query} /></p>
          : <Suspense fallback={<MarkdownPending />}><MessageMarkdown text={text} /></Suspense>}
      </div>
      {(context || item.text.length > CLAMP_LENGTH) && !query && !raw && <button type="button" className={styles.expand} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? context ? '收起项目上下文' : '收起长消息' : `展开全文 · ${item.text.length.toLocaleString()} 字`}</button>}
    </div>
    </>}
  </article>;
});

export function SessionReader({ detail, toolName }: { detail: HistoryDetail; toolName: string }) {
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
  return <div className={styles.reader} aria-label="会话正文" ref={root}>
    <div className={styles.readerToolbar}>
      <div className={styles.readerTitle}><strong>{onlyQuestions ? '只看提问' : '对话内容'}</strong><span>{visible.length.toLocaleString()} 条消息{raw ? ' · 原文' : ''}</span>
        {detail.session.messageCount > detail.messages.length && <span title="目前可读取的正文少于索引消息数">已索引 {detail.session.messageCount.toLocaleString()} 条</span>}
      </div>
      <div className={styles.readerOptions}>
        <button type="button" ref={findButton} aria-label="查找本会话" aria-expanded={findOpen} onClick={() => { setFindOpen(!findOpen); setQuery(''); }}><Icon name="search" size={14} />查找</button>
        <details className={styles.readingOptions} ref={optionsRef}><summary>阅读</summary><div>
        <label><input type="checkbox" checked={onlyQuestions} onChange={(event) => setOnlyQuestions(event.target.checked)} />只看提问</label>
        <label><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />显示原文</label>
        </div></details>
        <button type="button" title="跳到最后一条消息" onClick={jumpLatest}><Icon name="arrowDown" size={13} />最新</button>
      </div>
      {findOpen && <div className={styles.find}>
        <Icon name="search" size={14} /><input autoFocus aria-label="查找本会话" placeholder="在当前会话中查找…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); jump(selected + (event.shiftKey ? -1 : 1)); }
          if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); setFindOpen(false); findButton.current?.focus(); }
        }} />
        {search && <><span role="status">{matches.length ? `${selected + 1} / ${matches.length} 条` : '无匹配'}</span><button type="button" disabled={!matches.length} aria-label="上一条匹配" onClick={() => jump(selected - 1)}>↑</button><button type="button" disabled={!matches.length} aria-label="下一条匹配" onClick={() => jump(selected + 1)}>↓</button><button type="button" aria-label="清空会话内查找" onClick={() => setQuery('')}><Icon name="close" size={13} /></button></>}
      </div>}
      {search && <small className={styles.findHint}>查找时显示消息原文 · Enter 下一条 / Shift + Enter 上一条</small>}
    </div>
    <div className={styles.messages}>
      {visible.map(({ item }, visibleIndex) => {
        const previous = visible[visibleIndex - 1]?.item;
        const date = item.timestamp === null ? '日期未知' : new Date(item.timestamp).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
        const changedDay = !previous || (previous.timestamp === null ? 'unknown' : new Date(previous.timestamp).toDateString()) !== (item.timestamp === null ? 'unknown' : new Date(item.timestamp).toDateString());
        return <div key={item.id}>{changedDay && <div className={styles.dayDivider}>{date}</div>}<Message item={item} toolId={detail.session.toolId} toolName={toolName} raw={raw} query={search} current={matches[selected]?.item.id === item.id} renderMarkdown={rendered.has(item.id)} /></div>;
      })}
      {!visible.length && <div className={styles.empty}><Icon name="records" size={24} /><h3>{onlyQuestions ? '没有可读取的提问' : '此会话没有可读取的正文'}</h3><p>{onlyQuestions ? '切回完整对话，查看其他消息。' : '会话信息仍然保留，你可以尝试在原生 CLI 中继续。'}</p>{onlyQuestions && <button type="button" onClick={() => setOnlyQuestions(false)}>查看完整对话</button>}</div>}
    </div>
  </div>;
}
