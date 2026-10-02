import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryDetail, HistoryMessage } from '../../types/history';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { writeClipboard } from '../../lib/clipboard';
import styles from './SessionReader.module.css';

const MessageMarkdown = lazy(() => import('./MessageMarkdown'));
const CLAMP_LENGTH = 1800;

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

const Message = memo(function Message({ item, index, toolId, toolName, raw, query, current }: {
  item: HistoryMessage; index: number; toolId: string; toolName: string; raw: boolean; query: string; current: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState('');
  const user = item.role === 'user';
  const role = user ? '你' : item.role === 'assistant' ? toolName : ({ system: '系统', tool: '工具' }[item.role] ?? item.role);
  const clamped = item.text.length > CLAMP_LENGTH && !expanded && !query;
  const text = clamped ? item.text.slice(0, CLAMP_LENGTH) : item.text;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(''), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <article className={styles.message} data-message-id={item.id} data-role={item.role} data-current-match={current || undefined}>
    <div className={styles.avatar}>{user ? '你' : <ToolIcon toolId={toolId} size={22} />}</div>
    <div className={styles.messageContent}>
      <header className={styles.messageHead}><strong>{role}</strong><span>#{index + 1}</span>
        <time title={item.timestamp === null ? '时间未知' : new Date(item.timestamp).toLocaleString()}>{item.timestamp === null ? '时间未知' : new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
        <button type="button" aria-label={copied || '复制这条消息'} title="复制这条消息" onClick={() => void writeClipboard(item.text).then((ok) => setCopied(ok ? '已复制这条消息' : '复制失败，请手动选择'))}>
          <Icon name={copied === '已复制这条消息' ? 'check' : 'copy'} size={14} />{copied && <span role="status">{copied}</span>}
        </button>
      </header>
      <div className={`${styles.prose} ${clamped ? styles.clamped : ''}`}>
        {raw || user || query ? <p className={styles.raw}><Highlight text={text} query={query} /></p>
          : <Suspense fallback={<p className={styles.raw}>{text}</p>}><MessageMarkdown text={text} /></Suspense>}
      </div>
      {item.text.length > CLAMP_LENGTH && !query && <button type="button" className={styles.expand} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起长消息' : `展开全文 · ${item.text.length.toLocaleString()} 字`}</button>}
    </div>
  </article>;
});

export function SessionReader({ detail, toolName }: { detail: HistoryDetail; toolName: string }) {
  const [query, setQuery] = useState('');
  const [onlyQuestions, setOnlyQuestions] = useState(false);
  const [raw, setRaw] = useState(false);
  const [current, setCurrent] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = query.trim();
  const visible = useMemo(() => detail.messages.map((item, index) => ({ item, index })).filter(({ item }) => !onlyQuestions || item.role === 'user'), [detail.messages, onlyQuestions]);
  const matches = useMemo(() => search ? visible.filter(({ item }) => item.text.toLowerCase().includes(search.toLowerCase())) : [], [visible, search]);
  const selected = matches.length ? current % matches.length : 0;
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
  useEffect(() => {
    setCurrent(0);
    if (search && matches.length) revealMatch(matches[0].item.id);
  }, [search, onlyQuestions]);
  return <div className={styles.reader} aria-label="会话正文" ref={root}>
    <div className={styles.readerToolbar}>
      <div className={styles.readerTitle}><strong>对话内容</strong><span>{detail.messages.length.toLocaleString()} 条消息</span>
        {detail.session.messageCount > detail.messages.length && <span title="目前可读取的正文少于索引消息数">已索引 {detail.session.messageCount.toLocaleString()} 条</span>}
      </div>
      <div className={styles.readerOptions}>
        <button type="button" aria-pressed={onlyQuestions} onClick={() => setOnlyQuestions(!onlyQuestions)}>只看提问</button>
        <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>原文</button>
        <button type="button" title="跳到最后一条消息" onClick={() => { const messages = root.current?.querySelectorAll('article'); messages?.[messages.length - 1]?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }}><Icon name="arrowDown" size={13} />最新</button>
      </div>
      <div className={styles.find}>
        <Icon name="search" size={14} /><input aria-label="查找本会话" placeholder="在当前会话中查找…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); jump(selected + (event.shiftKey ? -1 : 1)); }
          if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); }
        }} />
        {search && <><span role="status">{matches.length ? `${selected + 1} / ${matches.length} 条` : '无匹配'}</span><button type="button" disabled={!matches.length} aria-label="上一条匹配" onClick={() => jump(selected - 1)}>↑</button><button type="button" disabled={!matches.length} aria-label="下一条匹配" onClick={() => jump(selected + 1)}>↓</button><button type="button" aria-label="清空会话内查找" onClick={() => setQuery('')}><Icon name="close" size={13} /></button></>}
      </div>
      {search && <small className={styles.findHint}>查找时显示消息原文 · Enter 下一条 / Shift + Enter 上一条</small>}
    </div>
    <div className={styles.messages}>
      {visible.map(({ item, index }, visibleIndex) => {
        const previous = visible[visibleIndex - 1]?.item;
        const date = item.timestamp === null ? '日期未知' : new Date(item.timestamp).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
        const changedDay = !previous || (previous.timestamp === null ? 'unknown' : new Date(previous.timestamp).toDateString()) !== (item.timestamp === null ? 'unknown' : new Date(item.timestamp).toDateString());
        return <div key={item.id}>{changedDay && <div className={styles.dayDivider}>{date}</div>}<Message item={item} index={index} toolId={detail.session.toolId} toolName={toolName} raw={raw} query={search} current={matches[selected]?.item.id === item.id} /></div>;
      })}
      {!visible.length && <div className={styles.empty}><Icon name="records" size={24} /><h3>{onlyQuestions ? '没有可读取的提问' : '此会话没有可读取的正文'}</h3><p>{onlyQuestions ? '切回完整对话，查看其他消息。' : '会话信息仍然保留，你可以尝试在原生 CLI 中继续。'}</p>{onlyQuestions && <button type="button" onClick={() => setOnlyQuestions(false)}>查看完整对话</button>}</div>}
    </div>
  </div>;
}
