/** Parsing is bounded and runs on hovered logical lines, never on the output stream. */
export const TERMINAL_LINK_TEXT_LIMIT = 16_384;
const LINK_LIMIT = 128;
const CACHE_LIMIT = 32;

export type TerminalLinkMatch = { kind: 'url' | 'path'; value: string; start: number; end: number };

export function validTerminalUrl(value: string): boolean {
  if (value.length > 8192 || /[\p{Cc}]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function fileUrl(value: string): boolean {
  if (!/^file:\/\//i.test(value) || value.length > 8192 || /[\p{Cc}]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function oscTerminalLink(value: string): Pick<TerminalLinkMatch, 'kind' | 'value'> | null {
  if (validTerminalUrl(value)) return { kind: 'url', value };
  return fileUrl(value) ? { kind: 'path', value } : null;
}

function trimPunctuation(value: string): string {
  let result = value.replace(/[.,;:!?，。；：！？]+$/u, '');
  for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    const openings = result.split(opening).length - 1;
    let closings = result.split(closing).length - 1;
    while (closings > openings && result.endsWith(closing)) {
      result = result.slice(0, -1);
      closings -= 1;
    }
  }
  return result;
}

/** File extensions a bare `name.ext` must end with. Prose like `e.g.`, `v1.2` or `example.com` stays text. */
const FILE_EXTENSIONS = new Set(('ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx markdown txt rst adoc yml yaml toml ini cfg conf env properties lock log '
  + 'rs go py pyi rb java kt kts scala swift m mm c h cc cpp cxx hpp hh cs fs vb dart php lua r jl ex exs erl hrl hs ml mli zig nim pl pm '
  + 'css scss sass less styl html htm xml xhtml svg vue svelte astro hbs ejs pug '
  + 'sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto tf hcl gradle cmake mk make patch diff '
  + 'png jpg jpeg gif webp bmp ico avif pdf csv tsv xlsx docx pptx zip gz tgz tar 7z rar wasm so dll exe dylib jar class ipynb').split(' '));

/** Tech names written like files (Node.js, Vue.js) are prose, not files in the working directory. */
const PROSE_NAME = /^[A-Z][a-z]+\.js$/;

function extension(segment: string): string {
  const dot = segment.lastIndexOf('.');
  return dot > 0 ? segment.slice(dot + 1).toLowerCase() : '';
}

function pathCandidate(value: string): boolean {
  if (!value || value.length > 8192 || /[\p{Cc}<>|*?]/u.test(value.replace(/^\\\\\?\\/, ''))) return false;
  if (fileUrl(value)) return true;
  const path = value.replace(/(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))$/, '');
  if (!/\p{L}/u.test(path)) return false;
  // `/C:/work/a.ts` is how some CLIs print a Windows path in URL form.
  if (/^\/?[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')) return true;
  // Other URI schemes, emails and drive-relative paths are not local files.
  if (path.includes(':')) return false;
  const segments = path.split(/[\\/]/).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const named = /\.[\p{L}\p{N}_-]{1,16}$/u.test(last);
  if (/^(?:~[\\/]|\.{1,2}[\\/])/.test(path)) return true;
  // A lone `/word` is a slash command (`/compact`, `/model`), not a file at the root.
  if (path.startsWith('/')) return segments.length >= 2 || named;
  if (/[\\/]/.test(path)) {
    // `and/or`, `TCP/IP`, `DTS/DTS-HD` and `1/2` are prose: a relative path needs a
    // file name, a trailing separator, or at least three segments.
    return /[\\/]$/.test(path) || named || segments.length >= 3;
  }
  if (path.includes('@')) return false;
  if (/^\.[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(path)) return true;
  if (/^(?:Dockerfile|Makefile|GNUmakefile|LICENSE|README|AGENTS|SKILL|CLAUDE)$/.test(path)) return true;
  return /^[\p{L}\p{N}_-][\p{L}\p{N}_.@+ -]*$/u.test(path) && FILE_EXTENSIONS.has(extension(path)) && !PROSE_NAME.test(path);
}

/** Cheap test before any per-cell work: text with none of these cannot hold a link. */
export function mayContainTerminalLink(text: string): boolean {
  return /[\\/]|\.[\p{L}\p{N}]|\b(?:Dockerfile|Makefile|GNUmakefile|LICENSE|README|AGENTS|SKILL|CLAUDE)\b/u.test(text);
}

export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  if (text.length > TERMINAL_LINK_TEXT_LIMIT || !mayContainTerminalLink(text)) return [];
  const matches: TerminalLinkMatch[] = [];
  // Preserve URL recognition even in log fields such as `url=https://…`.
  for (const match of text.matchAll(/https?:\/\/[^\s\p{Cc}<>"'`\\]+/giu)) {
    const value = trimPunctuation(match[0]);
    if (validTerminalUrl(value)) matches.push({ kind: 'url', value, start: match.index!, end: match.index! + value.length });
    if (matches.length === LINK_LIMIT) return matches;
  }
  const urls = matches.slice();
  // Quotes retain spaces in paths. Unquoted paths deliberately end at whitespace;
  // guessing across prose would require speculative filesystem probes.
  // CJK prose has no spaces, so its punctuation (，。：；、「」…) also ends a token.
  const tokens = /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|[^\s\p{Cc}<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2018-\u201f\u2026\u2014]+/gu;
  for (const token of text.matchAll(tokens)) {
    const quoted = token[1] ?? token[2] ?? token[3];
    const raw = quoted ?? token[0];
    const leading = quoted === undefined ? raw.match(/^[([{]+/)?.[0].length ?? 0 : 0;
    const value = quoted ?? trimPunctuation(raw.slice(leading));
    const start = token.index! + (quoted === undefined ? leading : 1);
    const end = start + value.length;
    if (!urls.some(url => start < url.end && end > url.start) && pathCandidate(value)) {
      matches.push({ kind: 'path', value, start, end });
    }
    if (matches.length === LINK_LIMIT) break;
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Content keys remain valid across cursor redraws; no stale row/scroll offsets are cached. */
export function createTerminalLinkCache() {
  const cache = new Map<string, TerminalLinkMatch[]>();
  return (text: string): TerminalLinkMatch[] => {
    if (text.length > TERMINAL_LINK_TEXT_LIMIT) return [];
    const previous = cache.get(text);
    if (previous) return previous;
    const matches = findTerminalLinks(text);
    cache.set(text, matches);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return matches;
  };
}
