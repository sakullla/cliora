import { useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { writeClipboard } from '../../lib/clipboard';
import { Icon } from '../../components/Icon';
import styles from './SessionReader.module.css';

function CopyText({ value, label, children }: { value: string; label: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const [result, setResult] = useState('');
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(''), 1800);
    return () => window.clearTimeout(timer);
  }, [result]);
  return <button type="button" title={label} aria-label={result || label} className={children ? styles.link : styles.codeCopy}
    onClick={() => void writeClipboard(value).then((ok) => setResult(ok ? t('home.launcher.copied') : t('records.markdown.failed')))}>
    {children ?? <><Icon name={result === t('home.launcher.copied') ? 'check' : 'copy'} size={13} />{result || t('records.markdown.copyCode')}</>}
    {children && result && <span role="status">{t('records.markdown.result', { result })}</span>}
  </button>;
}

export default function MessageMarkdown({ text }: { text: string }) {
  const { t } = useTranslation();
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    // Historical messages are read locally; remote images never load implicitly.
    img: ({ alt }) => <span className={styles.imageNote}>{t('records.markdown.image', { alt: alt || t('records.markdown.noAlt') })}</span>,
    a: ({ href, children }) => href ? <CopyText value={href} label={t('records.markdown.link', { href })}>{children} <Icon name="copy" size={11} /></CopyText> : <span>{children}</span>,
    pre: ({ children, node }) => {
      const code = node?.children.find((item) => item.type === 'element' && item.tagName === 'code');
      const value = code?.type === 'element' ? code.children.filter((item) => item.type === 'text').map((item) => item.value).join('') : '';
      const language = code?.type === 'element' ? String(code.properties.className ?? '').replace('language-', '') : '';
      return <div className={styles.codeBlock}><div className={styles.codeHead}><span>{language || t('records.markdown.code')}</span><CopyText value={value} label={t('records.markdown.copyCode')} /></div><pre>{children}</pre></div>;
    },
    table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
  }}>{text}</Markdown>;
}
