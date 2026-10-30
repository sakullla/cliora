import { lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeEditor } from '../../components/CodeEditor';
import type { MarkdownFileLinks } from '../../components/MarkdownView';
import { Icon } from '../../components/Icon';
import { fileFormat, referenceCandidates, scrollToAnchor } from '../../lib/markdownLinks';
import type { SkillFileListing, SkillFilePreview } from '../../types/resources';
import { readModel } from './DocumentReader';
import { documentStyles as doc } from './DocumentWorkspace';
import styles from './SkillManifestView.module.css';

const MarkdownView = lazy(() => import('../../components/MarkdownView'));

/** The skill's own document; every other path is relative to the skill directory. */
export const SKILL_FILE = 'SKILL.md';

export type SkillFileState = { preview: SkillFilePreview | null; error: string };
export type ResolveReferences = (from: string, targets: string[]) => Promise<Array<string | null>>;

export function shortSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const baseName = (path: string) => path.split('/').pop() ?? path;
const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/**
 * Resolves the file references of one document once per text. The lookup
 * answers `undefined` until the backend replies, then a path or `null`.
 */
export function useSkillReferences(resolver: ResolveReferences | null, scope: string, from: string, text: string | null) {
  const [state, setState] = useState<{ key: string; paths: Map<string, string | null> } | null>(null);
  const key = `${scope}\n${from}\n${text ?? ''}`;
  const latest = useRef(resolver);
  latest.current = resolver;
  const enabled = !!resolver && text !== null;
  useEffect(() => {
    const resolver = latest.current;
    if (!resolver || text === null) return;
    const targets = referenceCandidates(text);
    if (!targets.length) { setState({ key, paths: new Map() }); return; }
    let live = true;
    // A failed lookup leaves the targets unresolved; links then keep their plain behaviour.
    void resolver(from, targets).then(result => {
      if (!live) return;
      setState({ key, paths: new Map(targets.map((target, index) => [target, Array.isArray(result) ? result[index] ?? null : null])) });
    }).catch(() => { if (live) setState({ key, paths: new Map(targets.map(target => [target, null])) }); });
    return () => { live = false; };
  }, [enabled, key]);
  const paths = state?.key === key ? state.paths : null;
  return useMemo(() => ({
    paths,
    resolve: (target: string) => paths ? paths.has(target) ? paths.get(target)! : null : undefined,
  }), [paths]);
}

/** Back control and breadcrumb from SKILL.md to the open file. */
export function SkillFileTrail({ trail, size, onBack, onCrumb }: { trail: string[]; size: number | null; onBack: () => void; onCrumb: (index: number) => void }) {
  const { t } = useTranslation();
  return <nav className={styles.trail} aria-label={t('tools.skills.trailLabel')}>
    <button type="button" className={styles.trailBack} onClick={onBack} title={t('tools.skills.trailBack')}><Icon name="arrowLeft" size={14} /><span>{t('tools.skills.trailBack')}</span></button>
    <ol>
      <li><button type="button" onClick={() => onCrumb(-1)}>{SKILL_FILE}</button></li>
      {trail.map((path, index) => <li key={`${index}:${path}`}>
        <Icon name="chevronRight" size={12} />
        {index === trail.length - 1
          ? <span aria-current="page" title={path}>{path}</span>
          : <button type="button" title={path} onClick={() => onCrumb(index)}>{baseName(path)}</button>}
      </li>)}
    </ol>
    {size !== null && <small>{shortSize(size)}</small>}
  </nav>;
}

/**
 * One referenced file. Markdown reads like SKILL.md, with its own links
 * resolved from its folder; other text shows read-only with line numbers.
 */
export function SkillFileView({ path, anchor, state, mode, label, links, regionRef, onRetry }: {
  path: string; anchor: string | null; state: SkillFileState | undefined; mode: 'read' | 'edit'; label: string;
  links?: MarkdownFileLinks; regionRef?: RefObject<HTMLDivElement | null>; onRetry: () => void;
}) {
  const { t } = useTranslation();
  const format = fileFormat(path);
  const text = state?.preview?.text ?? null;
  const model = useMemo(() => text !== null && format === 'markdown' ? readModel(text, 'markdown') : null, [text, format]);
  // Markdown loads lazily; look for the anchor for a moment after the text arrives.
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!anchor || text === null || mode !== 'read' || scrolled.current === `${path}#${anchor}`) return;
    let frames = 0; let handle = 0;
    const attempt = () => {
      if (scrollToAnchor(regionRef?.current, anchor) || ++frames > 30) { scrolled.current = `${path}#${anchor}`; return; }
      handle = requestAnimationFrame(attempt);
    };
    handle = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(handle);
  }, [anchor, text, mode, path, regionRef]);
  if (!state || (!state.preview && !state.error)) return <div className={doc.body} role="status" aria-label={t('tools.skills.fileLoading')}><div className={doc.pending}><span /><span /><span /></div></div>;
  if (state.error) return <div className={doc.body} role="region" aria-label={label}><div className={doc.readColumn}><div className={styles.fileProblem} role="alert"><Icon name="alert" size={16} /><span>{state.error}</span><button type="button" onClick={onRetry}>{t('tools.skills.fileRetry')}</button></div></div></div>;
  const preview = state.preview!;
  if (text === null) return <div className={doc.body} role="region" aria-label={label}><div className={doc.readColumn}><div className={styles.fileProblem}><Icon name="info" size={16} /><span>{preview.digest ? t('tools.skills.fileBinary', { size: shortSize(preview.size) }) : t('tools.skills.fileTooLarge', { size: preview.size })}</span></div></div></div>;
  if (mode === 'edit' || !model) return <div className={doc.editor} data-readonly><CodeEditor format={format} label={label} documentId={path} value={text} readOnly /></div>;
  const empty = !model.description && !model.fields.length && !model.sections.length && !model.body.trim();
  return <div ref={regionRef} className={doc.body} role="region" aria-label={label} tabIndex={0}>
    <div className={doc.readColumn}>
      {model.description && <p className={doc.lead}>{model.description}</p>}
      {model.fields.length > 0 && <dl className={doc.fieldCard} aria-label={t('common.document.properties')}>{model.fields.map(item => <div key={item.key}><dt>{item.key}</dt><dd>{item.value || '—'}</dd></div>)}</dl>}
      {model.sections.map(item => <section key={item.key} className={doc.section} aria-label={item.key}><span className={doc.sectionLabel}>{item.key}</span><Suspense fallback={<pre className={doc.lead}>{item.value}</pre>}><MarkdownView text={item.value} files={links} /></Suspense></section>)}
      {model.body.trim() && <Suspense fallback={<pre className={doc.lead}>{model.body}</pre>}><MarkdownView text={model.body} files={links} /></Suspense>}
      {empty && <p className={doc.empty}>{t('common.document.empty')}</p>}
    </div>
  </div>;
}

/**
 * Files at the end of SKILL.md: the bundled files by folder, then shared
 * files outside the skill that the document links to. Each opens in the reader.
 */
export function SkillFilesPanel({ listing, error, referenced, onOpen }: { listing: SkillFileListing | null; error: string; referenced: string[]; onOpen: (path: string) => void }) {
  const { t } = useTranslation();
  const files = listing?.files ?? [];
  const folders = useMemo(() => {
    const groups = new Map<string, typeof files>();
    for (const file of files) groups.set(folderOf(file.path), [...(groups.get(folderOf(file.path)) ?? []), file]);
    return [...groups.entries()].sort(([left], [right]) => left === '' ? -1 : right === '' ? 1 : left.localeCompare(right));
  }, [files]);
  if (!error && !files.length && !listing?.truncated && !referenced.length) return null;
  const row = (path: string, name: string, size: number | null) => <button type="button" className={styles.fileRow} aria-label={path} title={size === null ? path : `${path} · ${t('tools.skills.fileSize', { size })}`} onClick={() => onOpen(path)}>
    <Icon name="file" size={14} /><span>{name}</span>{size !== null && <small>{shortSize(size)}</small>}<Icon name="chevronRight" size={13} />
  </button>;
  return <>
    {(error || files.length > 0 || listing?.truncated) && <section className={styles.files} aria-label={t('tools.skills.filesTitle')}>
      <header><span className={doc.sectionLabel}>{t('tools.skills.filesTitle')}</span>{files.length > 0 && <small>{t('tools.skills.fileCount', { count: files.length })}</small>}</header>
      {error && <p className={styles.filesNote}>{t('tools.skills.filesFailed', { detail: error })}</p>}
      {listing?.truncated && <p className={styles.filesNote}>{t('tools.skills.filesIncomplete')}</p>}
      {folders.map(([folder, items]) => <div key={folder} className={styles.fileGroup} role="group" aria-label={folder ? `${folder}/` : t('tools.skills.filesTop')}>
        {folder && <div className={styles.folder}><Icon name="folder" size={14} /><span>{folder}/</span></div>}
        <ul>{items.map(file => <li key={file.path}>{file.readable
          ? row(file.path, baseName(file.path), file.size)
          : <span className={styles.fileRow} data-readable="false" title={file.detail}><Icon name="file" size={14} /><span>{baseName(file.path)}</span><small>{file.detail}</small></span>}</li>)}</ul>
      </div>)}
    </section>}
    {referenced.length > 0 && <section className={styles.files} aria-label={t('tools.skills.referencedTitle')}>
      <header><span className={doc.sectionLabel}>{t('tools.skills.referencedTitle')}</span><small>{t('tools.skills.referencedHint')}</small></header>
      <ul>{referenced.map(path => <li key={path}>{row(path, path, null)}</li>)}</ul>
    </section>}
  </>;
}
