/** GitHub-style heading slug: lower case, punctuation dropped, spaces to dashes. CJK stays. */
export function headingSlug(text: string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Scrolls a rendered heading with this anchor into view inside `container`. */
export function scrollToAnchor(container: ParentNode | null | undefined, anchor: string) {
  if (!container || !anchor) return false;
  const wanted = [anchor, headingSlug(decodeAnchor(anchor))];
  const heading = [...container.querySelectorAll<HTMLElement>('[data-anchor]')].find(node => wanted.includes(node.dataset.anchor ?? ''));
  heading?.scrollIntoView({ block: 'start' });
  return !!heading;
}

function decodeAnchor(anchor: string) {
  try { return decodeURIComponent(anchor); } catch { return anchor; }
}

/** `scheme:` links, protocol-relative links and in-page anchors are not file references. */
export function isRelativeHref(href: string) {
  return !!href && !href.startsWith('#') && !href.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Splits `a/b.md#part` into the file part and the anchor. */
export function splitAnchor(target: string): { file: string; anchor: string | null } {
  const at = target.indexOf('#');
  return at < 0 ? { file: target, anchor: null } : { file: target.slice(0, at), anchor: target.slice(at + 1) || null };
}

const pluginRoot = /^(?:<plugin_root>|\$\{?CLAUDE_PLUGIN_ROOT\}?|\$\{PLUGIN_ROOT\})\//;
/**
 * Inline code that reads like a file path: `references/a.md`, `../_shared/b.md`,
 * `run.py`, `<plugin_root>/agents/x.md`. Version numbers, globs, placeholders,
 * commands and URLs are not.
 */
export function looksLikeFilePath(text: string) {
  const value = text.trim().replace(pluginRoot, '');
  if (!value || value.length > 240 || /[\s<>*?|"'`$(){}[\]]/.test(value) || value.includes('://')) return false;
  const name = value.split('#')[0].split('/').pop() ?? '';
  return /^[^.].*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(name) || /^\.[A-Za-z]/.test(name) && value.includes('/');
}

/** Link targets and path-like inline code of a Markdown document, in order, once each. */
export function referenceCandidates(markdown: string) {
  const found = new Set<string>();
  const add = (value: string | undefined) => { const item = value?.trim(); if (item && found.size < 400) found.add(item); };
  for (const match of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"')]*["'])?\s*\)/g)) if (isRelativeHref(match[1])) add(match[1]);
  for (const match of markdown.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm)) if (isRelativeHref(match[1])) add(match[1]);
  for (const match of markdown.matchAll(/(`+)([^`\n]+?)\1/g)) if (looksLikeFilePath(match[2])) add(match[2].trim());
  return [...found];
}

/** Markdown and plain text formats for a referenced file, by extension. */
export function fileFormat(path: string): 'markdown' | 'json' | 'toml' | 'yaml' | 'javascript' | 'text' {
  const ext = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
  if (['json', 'jsonc'].includes(ext)) return 'json';
  if (ext === 'toml') return 'toml';
  if (['yaml', 'yml'].includes(ext)) return 'yaml';
  if (['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].includes(ext)) return 'javascript';
  return 'text';
}
