import { useTranslation } from 'react-i18next';
import { useLayoutEffect, type RefObject } from 'react';
import { Icon } from '../../components/Icon';
import { Button, IconButton } from '../../components/ui';
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
      const height = Math.min(144, Math.max(44, node.scrollHeight));
      node.style.height = height + 'px';
      node.style.overflowY = node.scrollHeight > height ? 'auto' : 'hidden';
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft, inputRef]);
  const lines = draft ? draft.split('\n').length : 0;
  return <section className={styles.composerDock} aria-label={t('sessions.composerTitle')}>
    <div className={styles.composerCard}>
      <div className={styles.composerHead}>
        <span className={styles.composerTarget}><ToolIcon toolId={toolId} size={14} /><span>{t('sessions.composerTarget')}</span><strong>{toolName}</strong><span className={styles.composerPlace}>{place}</span></span>
        {prompts.length > 0 && <div className={styles.composerPromptList} role="group" aria-label={t('sessions.pickLibraryPrompt')}>
          <span className={styles.composerPromptLabel}><Icon name="library" size={12} />{t('sessions.pickLibraryPrompt')}</span>
          {prompts.map((prompt) => <button key={prompt.id} type="button" className={styles.promptPill} title={prompt.body} onClick={() => onChange(draft ? draft + '\n' + prompt.body : prompt.body)}><Icon name="plus" size={12} />{prompt.title}</button>)}
        </div>}
        <IconButton size="sm" className={styles.composerClose} aria-label={t('sessions.composerClose')} title={t('sessions.composerClose') + ' (Esc)'} onClick={onClose} icon={<Icon name="close" size={14} />} />
      </div>
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
        <Button variant="primary" className={styles.sendBtn} aria-label={t('sessions.sendInput')} title={t('sessions.sendInput') + ' (Enter)'} onClick={onSubmit} icon={<Icon name="arrowUp" size={16} />}><span className={styles.sendLabel}>{t('sessions.sendInput')}</span></Button>
      </div>
      <div className={styles.composerFoot}>
        <span className={styles.composerHint}><kbd>Enter</kbd>{t('sessions.composerSend')}<kbd>Shift</kbd><kbd>Enter</kbd>{t('sessions.composerNewline')}<kbd>Esc</kbd>{t('sessions.composerCollapse')}</span>
        <span className={styles.composerDraftBadge}>{lines > 1 ? t('sessions.composerLines', { count: lines }) : t('sessions.composerDraftHint')}</span>
      </div>
    </div>
  </section>;
}
