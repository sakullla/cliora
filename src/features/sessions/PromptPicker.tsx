import { useTranslation } from 'react-i18next';
import { FilterSelect } from '../../components/FilterSelect';
import { Icon } from '../../components/Icon';
import type { LibraryItem } from '../../types/library';
import styles from './SessionWorkbench.module.css';

/** Prompts shown as pills before the rest move into the searchable list. */
const inlineLimit = 3;

const preview = (body: string) => body.replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * Library prompts for the composer and the new-session dialog. A few stay one click away as pills;
 * a longer library opens a searchable list instead of a row that scrolls off the edge.
 */
export function PromptPicker({ prompts, onPick, className, labelClassName }: { prompts: LibraryItem[]; onPick: (prompt: LibraryItem) => void; className?: string; labelClassName?: string }) {
  const { t } = useTranslation();
  if (!prompts.length) return null;
  const pills = prompts.slice(0, inlineLimit);
  const label = t('sessions.pickLibraryPrompt');
  return <div className={className} role="group" aria-label={label}>
    <span className={labelClassName}><Icon name="library" size={12} />{label}</span>
    {pills.map((prompt) => <button key={prompt.id} type="button" className={styles.promptPill} title={prompt.body} onClick={() => onPick(prompt)}><Icon name="plus" size={12} />{prompt.title}</button>)}
    {prompts.length > inlineLimit && <FilterSelect className={styles.promptMore} label={t('sessions.promptAll', { count: prompts.length })} placeholder={t('sessions.promptAll', { count: prompts.length })} value="" searchLabel={t('sessions.promptSearch')} searchPlaceholder={t('sessions.promptSearchPlaceholder')} emptyText={t('sessions.promptNoMatch')} triggerDetail={false}
      options={prompts.map((prompt) => ({ value: prompt.id, label: prompt.title, detail: preview(prompt.body) }))}
      onChange={(id) => { const prompt = prompts.find((item) => item.id === id); if (prompt) onPick(prompt); }} />}
  </div>;
}
