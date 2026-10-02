import { useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { writeClipboard } from '../../lib/clipboard';
import { Icon } from '../../components/Icon';
import styles from './SessionReader.module.css';

function CopyText({ value, label, children }: { value: string; label: string; children?: ReactNode }) {
  const [result, setResult] = useState('');
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(''), 1800);
    return () => window.clearTimeout(timer);
  }, [result]);
  return <button type="button" title={label} aria-label={result || label} className={children ? styles.link : styles.codeCopy}
    onClick={() => void writeClipboard(value).then((ok) => setResult(ok ? '已复制' : '复制失败，请手动选择'))}>
    {children ?? <><Icon name={result === '已复制' ? 'check' : 'copy'} size={13} />{result || '复制代码'}</>}
    {children && result && <span role="status">（{result}）</span>}
  </button>;
}

export default function MessageMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    // Historical messages are read locally; remote images never load implicitly.
    img: ({ alt }) => <span className={styles.imageNote}>图片：{alt || '未提供描述'}</span>,
    a: ({ href, children }) => href ? <CopyText value={href} label={`复制链接：${href}`}>{children} <Icon name="copy" size={11} /></CopyText> : <span>{children}</span>,
    pre: ({ children, node }) => {
      const code = node?.children.find((item) => item.type === 'element' && item.tagName === 'code');
      const value = code?.type === 'element' ? code.children.filter((item) => item.type === 'text').map((item) => item.value).join('') : '';
      const language = code?.type === 'element' ? String(code.properties.className ?? '').replace('language-', '') : '';
      return <div className={styles.codeBlock}><div className={styles.codeHead}><span>{language || '代码'}</span><CopyText value={value} label="复制代码" /></div><pre>{children}</pre></div>;
    },
    table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
  }}>{text}</Markdown>;
}
