import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { writeClipboard } from '../../lib/clipboard';
import { resourceError } from '../../lib/resources';
import type { FeedbackOperation } from '../../lib/notifications';
import type { SkillPackageDocument } from '../../types/resources';
import { CodeEditor } from '../CodeEditor';
import { FeedbackRegion, useFeedback } from '../Feedback';
import styles from './ResourceList.module.css';

export function SkillDocumentEditor({ packageId, onChanged, onDirtyChange }: { packageId: string; onDirtyChange?: (dirty: boolean) => void; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const feedback = useFeedback(JSON.stringify(['skill-document', packageId]));
  const [document, setDocument] = useState<SkillPackageDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { onDirtyChange?.(!!document && draft !== document.content); }, [draft, document, onDirtyChange]);
  async function load() {
    const result = feedback.begin('read');
    try { const value = await native.readSkillPackageDocument(packageId); if (live.current) { setDocument(value); setDraft(value.content); } result.complete(); }
    catch (error) { result.error(resourceError(error), { recovery: { label: t('common.feedback.retry'), valid: () => live.current, run: load } }); }
  }
  useEffect(() => { void load(); return () => { live.current = false; }; }, []);
  async function refresh(result: FeedbackOperation) {
    try { await onChanged(); result.success(t('library.experience.packageSaved')); }
    catch (error) { result.error(resourceError(error), { recovery: {
      label: t('common.feedback.retry'), valid: () => live.current,
      run: async () => { const retry = feedback.resume(result); retry.committed(t('tools.skills.saved')); setBusy(true); try { await refresh(retry); } finally { if (live.current) setBusy(false); } },
    } }); }
  }
  async function save() {
    if (!document || busy) return;
    const result = feedback.begin('save'); const content = draft;
    setBusy(true);
    try {
      const saved = await native.saveSkillPackageDocument(packageId, document.digest, content);
      result.committed(t('tools.skills.saved'));
      if (live.current) setDocument(saved);
      // Keep later typing; only the accepted digest/content baseline advances.
      await refresh(result);
    } catch (error) { result.error(resourceError(error)); }
    finally { if (live.current) setBusy(false); }
  }
  return <section className={styles.editor}>
    <p>{t('library.experience.packageScope')}</p>
    {document && <><CodeEditor label={t('tools.skills.editorLabel')} format="markdown" documentId={packageId} value={draft} onChange={setDraft} /><div className={styles.actions}><button type="button" onClick={() => { const result = feedback.begin('copy'); void writeClipboard(draft).then(ok => ok ? result.success(t('library.page.copied')) : result.error(t('library.experience.copyFailed'))); }}>{t('library.experience.copySkill')}</button><button type="button" data-dialog-save disabled={busy || draft === document.content} onClick={() => void save()}>{t('tools.skills.save')}</button></div></>}
    <FeedbackRegion context={feedback.context} />
  </section>;
}
