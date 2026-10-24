import { useTranslation } from 'react-i18next';
import { useLayoutEffect, type RefObject } from 'react';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import type { LibraryItem } from '../../types/library';
import styles from './SessionWorkbench.module.css';

export function WorkbenchComposer({ toolId, toolName, place, draft, prompts, inputRef, onChange, onSubmit, onClose }: {
  toolId: string;
  toolName: string;
  place: string;
  draft: string;
  prompts: LibraryItem[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    const fit = () => {
      node.style.height = 'auto';
      const height = Math.min(144, Math.max(48, node.scrollHeight));
      node.style.height = height + 'px';
      node.style.overflowY = node.scrollHeight > height ? 'auto' : 'hidden';
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft, inputRef]);
  return <section className={styles.composerDock} aria-label={t('sessions.composerTitle')}>
    <div className={styles.composerHead}>
      <span className={styles.composerTarget}><ToolIcon toolId={toolId} size={14} /><span>{t('sessions.composerTarget')}</span><strong>{toolName}</strong><span className={styles.composerPlace}>· {place}</span></span>
      <span className={styles.composerScope}><Icon name="lock" size={11} />{t('sessions.terminalInputHint')}</span>
      <button type="button" className={styles.composerClose} aria-label={t('sessions.composerClose')} title={t('sessions.composerClose') + ' (Esc)'} onClick={onClose}><Icon name="close" size={14} /></button>
    </div>
    {prompts.length > 0 && <div className={styles.composerPrompts}>
      <span className={styles.composerPromptLabel}><Icon name="library" size={12} />{t('sessions.pickLibraryPrompt')}</span>
      <div className={styles.composerPromptList}>{prompts.map((prompt) => <button key={prompt.id} type="button" className={styles.promptPill} title={prompt.body} onClick={() => onChange(draft ? draft + '\n' + prompt.body : prompt.body)}><Icon name="plus" size={10} />{prompt.title}</button>)}</div>
    </div>}
    <div className={styles.composerInputRow}>
      <span className={styles.promptMark} aria-hidden="true">›</span>
      <textarea ref={inputRef} rows={1} className={styles.composerTextarea} value={draft} placeholder={t('sessions.composerPlaceholder', { tool: toolName })} aria-label={t('sessions.composerPlaceholder', { tool: toolName })} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }} />
      <button type="button" className={`button primary ${styles.sendBtn}`} onClick={onSubmit}><Icon name="arrowUp" size={15} /><span>{t('sessions.sendInput')}</span></button>
    </div>
    <div className={styles.composerFoot}>
      <span className={styles.composerHint} title={t('sessions.composerDraftHint')}>{t('sessions.composerHint')}</span>
      <span className={styles.composerDraftBadge}><Icon name="pencil" size={10} />{t('sessions.composerDraftHint')}</span>
    </div>
  </section>;
}
