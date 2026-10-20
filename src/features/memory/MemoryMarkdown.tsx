import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { writeClipboard } from '../../lib/clipboard';
import { Icon } from '../../components/Icon';
import styles from './MemoryWorkspace.module.css';

const wikiPrefix = '#memory:';

/** `[[target]]` and `[[target|label]]` become in-app links to another memory entry. */
function withWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_match, target: string, label?: string) => {
    const name = target.trim();
    const shown = (label ?? name).trim().replace(/[[\]]/g, '');
    return `[${shown}](${wikiPrefix}${encodeURIComponent(name)})`;
  });
}

/** Memory body renderer: local reading only, no navigation away from the app. */
export default function MemoryMarkdown({ text, resolve, onOpen }: { text: string; resolve: (target: string) => boolean; onOpen: (target: string) => void }) {
  const { t } = useTranslation();
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className={styles.imageNote}>{t('records.markdown.image', { alt: alt || t('records.markdown.noAlt') })}</span>,
    a: ({ href, children }) => {
      if (href?.startsWith(wikiPrefix)) {
        const target = decodeURIComponent(href.slice(wikiPrefix.length));
        const found = resolve(target);
        return <button type="button" className={styles.wikiLink} data-missing={!found || undefined} disabled={!found} title={found ? t('common.memory.openLinked', { name: target }) : t('common.memory.missingLinked', { name: target })} onClick={() => onOpen(target)}><Icon name="link" size={12} />{children}</button>;
      }
      if (!href) return <span>{children}</span>;
      return <button type="button" className={styles.externalLink} title={t('records.markdown.link', { href })} onClick={() => void writeClipboard(href)}>{children}<Icon name="copy" size={11} /></button>;
    },
    pre: ({ children }) => <pre className={styles.codeBlock}>{children}</pre>,
    table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
  }}>{withWikiLinks(text)}</Markdown>;
}
