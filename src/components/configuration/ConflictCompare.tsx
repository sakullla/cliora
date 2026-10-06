import { CodeEditor, type CodeFormat } from '../CodeEditor';
import styles from './ConflictCompare.module.css';

/** Unified conflict comparison (ADR-5): one warning banner, a dual-pane read-only
 *  diff and a single 使用本次/保留当前 action pair. Multi-file views render one
 *  ConflictCompare per file and pass `banner` only on the first so a conflict
 *  view keeps exactly one banner. */
export function ConflictCompare({ title, banner, status, currentContent, nextContent, format = 'text', busy, actions = true, onUseNext, onKeepCurrent }: {
  title?: string;
  banner?: string;
  status?: string;
  currentContent: string;
  nextContent: string;
  format?: CodeFormat;
  busy?: boolean;
  actions?: boolean;
  onUseNext: () => void;
  onKeepCurrent: () => void;
}) {
  return <section className={styles.compare} aria-label={title ?? '冲突比较'}>
    {banner && <p className={styles.banner} data-banner="conflict">{banner}</p>}
    {title && <strong className={styles.title}>{title}{status ? ` · ${status}` : ''}</strong>}
    <div className={styles.columns}>
      <div><strong>当前文件</strong><CodeEditor label={title ? `${title} 当前内容` : '当前文件内容'} value={currentContent} format={format} readOnly compact /></div>
      <div><strong>本次内容</strong><CodeEditor label={title ? `${title} 本次内容` : '本次内容'} value={nextContent} format={format} readOnly compact /></div>
    </div>
    {actions && <div className={styles.actions}><button type="button" disabled={busy} onClick={onKeepCurrent}>保留当前文件</button><button type="button" disabled={busy} onClick={onUseNext}>使用本次内容</button></div>}
  </section>;
}
