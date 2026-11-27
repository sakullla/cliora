import { Children, cloneElement, isValidElement, useRef, type ReactElement, type ReactNode } from 'react';
import Markdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { writeClipboard } from '../lib/clipboard';
import { headingSlug, isRelativeHref, looksLikeFilePath, scrollToAnchor, splitAnchor } from '../lib/markdownLinks';
import { TextLink } from './TextLink';
import styles from './MarkdownView.module.css';

export type MarkdownHighlight = {
  query: string;
  caseSensitive: boolean;
};

function highlightString(text: string, query: string, caseSensitive: boolean): ReactNode {
  const trimmed = query.trim();
  if (!trimmed || !text) return text;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  if (!needle || hay.length !== text.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor <= hay.length - needle.length) {
    const index = hay.indexOf(needle, cursor);
    if (index < 0) break;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={key++} className={styles.findMark}>{text.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
  }
  if (!parts.length) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function highlightNodes(nodes: ReactNode, highlight?: MarkdownHighlight): ReactNode {
  const query = highlight?.query.trim() ?? '';
  if (!query || nodes == null || typeof nodes === 'boolean') return nodes;
  const caseSensitive = !!highlight?.caseSensitive;
  return Children.map(nodes, (child) => {
    if (typeof child === 'string') return highlightString(child, query, caseSensitive);
    if (isValidElement<{ children?: ReactNode }>(child)) {
      if (child.type === 'mark' || child.type === 'pre') return child;
      if (child.props.children == null) return child;
      return cloneElement(child as ReactElement<{ children?: ReactNode }>, undefined, highlightNodes(child.props.children, highlight));
    }
    return child;
  });
}

const wikiPrefix = '#wiki:';

/** `[[target]]` and `[[target|label]]` become in-app links when a resolver is given. */
function withWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_match, target: string, label?: string) => {
    const name = target.trim();
    const shown = (label ?? name).trim().replace(/[[\]]/g, '');
    return `[${shown}](${wikiPrefix}${encodeURIComponent(name)})`;
  });
}

/**
 * Local files a document refers to. `resolve` returns the openable path for a
 * link or inline-code target, `null` when it names no readable file, and
 * `undefined` while that is not known yet.
 */
export type MarkdownFileLinks = {
  resolve: (target: string) => string | null | undefined;
  open: (path: string, anchor: string | null) => void;
};

type HastNode = { type?: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };
function textOf(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** The fenced language of a `<pre><code class="language-x">` block. */
function fenceLanguage(node: HastNode | undefined): string | null {
  const code = node?.children?.find((child) => child.tagName === 'code');
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes.map(String) : typeof classes === 'string' ? classes.split(/\s+/) : [];
  const found = list.find((name) => name.startsWith('language-'));
  return found ? found.slice('language-'.length) || null : null;
}

type MdNode = { type: string; value?: string; children?: MdNode[] };

/** Control characters other than line breaks and tabs, as their Unicode control pictures. */
function controlPictures(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => {
    const code = char.charCodeAt(0);
    return String.fromCharCode(code === 0x7f ? 0x2421 : 0x2400 + code);
  });
}

/** Literal text: raw HTML stays visible as text instead of being dropped or run, and
 *  escape sequences (OSC, CSI) read as visible control pictures. Fenced code keeps
 *  its source; its renderer decides how to show it. */
function remarkLiteralText() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (node.type === 'html') node.type = 'text';
      if ((node.type === 'text' || node.type === 'inlineCode') && typeof node.value === 'string') node.value = controlPictures(node.value);
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

function decoded(value: string) {
  try { return decodeURI(value); } catch { return value; }
}

/**
 * Local Markdown reading: no HTML, no images, no navigation away from the app.
 * Links copy their target; wiki links open another document through `onOpen`;
 * with `files`, relative links and path-like inline code open local files, and
 * `#anchor` links scroll to their heading.
 *
 * `tone="terminal"` reads inside a session pane: the colors come from the pane's
 * `--term-*` tokens, raw HTML is shown as literal text, and `codeBlock` may render
 * fenced blocks (language label, copy) instead of the plain `<pre>`.
 */
export default function MarkdownView({ text, resolve, onOpen, files, tone, codeBlock, highlight }: {
  text: string;
  resolve?: (target: string) => boolean;
  onOpen?: (target: string) => void;
  files?: MarkdownFileLinks;
  tone?: 'terminal';
  /** Renders one fenced block from its source text and fence language. */
  codeBlock?: (code: string, language: string | null) => ReactNode;
  /** Optional plain-text search highlight (renders safe React <mark> nodes). */
  highlight?: MarkdownHighlight;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const wiki = !!onOpen;
  const activeHighlight = highlight?.query.trim() ? highlight : undefined;
  const hl = (children: ReactNode) => (activeHighlight ? highlightNodes(children, activeHighlight) : children);
  const lookup = (target: string) => {
    if (!files) return undefined;
    // Markdown hands over percent-encoded hrefs; the source text holds the plain form.
    const direct = files.resolve(target);
    return direct || decoded(target) === target ? direct : files.resolve(decoded(target)) ?? direct;
  };
  const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ children, node }: { children?: ReactNode } & ExtraProps) =>
    <Tag data-anchor={headingSlug(textOf(node as HastNode))}>{hl(children)}</Tag>;
  const terminal = tone === 'terminal';
  return <div ref={root} className={styles.prose} data-tone={tone}><Markdown remarkPlugins={terminal ? [remarkGfm, remarkLiteralText] : [remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className={styles.imageNote}>{t('records.markdown.image', { alt: alt || t('records.markdown.noAlt') })}</span>,
    a: ({ href, children }) => {
      const content = hl(children);
      if (href?.startsWith(wikiPrefix)) {
        const target = decodeURIComponent(href.slice(wikiPrefix.length));
        const found = resolve?.(target) ?? false;
        return <TextLink href={href} className={styles.wikiLink} missing={!found} title={found ? t('common.memory.openLinked', { name: target }) : t('common.memory.missingLinked', { name: target })} onActivate={found ? () => onOpen?.(target) : undefined}>{content}</TextLink>;
      }
      if (!href) return <span>{content}</span>;
      if (files && href.startsWith('#') && href.length > 1) {
        const anchor = href.slice(1);
        return <TextLink href={href} className={styles.fileLink} title={t('records.markdown.anchor', { anchor: decoded(anchor) })} onActivate={() => scrollToAnchor(root.current, anchor)}>{content}</TextLink>;
      }
      if (files && isRelativeHref(href)) {
        const path = lookup(href);
        const { anchor } = splitAnchor(href);
        if (path) return <TextLink href={href} className={styles.fileLink} title={t('records.markdown.openFile', { path })} onActivate={() => files.open(path, anchor)}>{content}</TextLink>;
        if (path === null) return <TextLink href={href} className={styles.fileLink} missing title={t('records.markdown.missingFile', { target: decoded(href) })}>{content}</TextLink>;
      }
      return <TextLink href={href} className={styles.externalLink} title={t('records.markdown.link', { href })} onActivate={() => void writeClipboard(href)}>{content}</TextLink>;
    },
    code: ({ className, children }) => {
      const value = typeof children === 'string' ? children : null;
      const content = !className ? hl(children) : children;
      if (!files || className || value === null || value.includes('\n') || !looksLikeFilePath(value)) return <code className={className}>{content}</code>;
      const path = lookup(value.trim());
      if (!path) return <code>{content}</code>;
      return <TextLink href={value} className={styles.codeLink} title={t('records.markdown.openFile', { path })} onActivate={() => files.open(path, splitAnchor(value.trim()).anchor)}><code>{content}</code></TextLink>;
    },
    p: ({ children }) => <p>{hl(children)}</p>,
    li: ({ children }) => <li>{hl(children)}</li>,
    td: ({ children }) => <td>{hl(children)}</td>,
    th: ({ children }) => <th>{hl(children)}</th>,
    blockquote: ({ children }) => <blockquote>{hl(children)}</blockquote>,
    h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
    pre: ({ children, node }) => {
      if (!codeBlock) return <pre className={styles.codeBlock}>{children}</pre>;
      const source = textOf(node as HastNode);
      return <>{codeBlock(source.endsWith('\n') ? source.slice(0, -1) : source, fenceLanguage(node as HastNode))}</>;
    },
    table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
  }}>{wiki ? withWikiLinks(text) : text}</Markdown></div>;
}
