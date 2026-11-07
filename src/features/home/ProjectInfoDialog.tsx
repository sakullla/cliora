import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { writeClipboard } from '../../lib/clipboard';
import styles from './ProjectLauncher.module.css';

export type ProjectInfoRow = { id: string; label: string; value: string; mono?: boolean };

/**
 * Read-only full project identity: the card truncates the name, host and directory, so this
 * dialog shows every value in full and copies each one. It never launches or edits anything.
 */
export function ProjectInfoDialog({ open, title, rows, onClose }: { open: boolean; title: string; rows: ProjectInfoRow[]; onClose: () => void }) {
  const { t } = useTranslation();
  // Copy feedback stays beside the row it belongs to; a failure keeps the value selectable.
  const [copy, setCopy] = useState<{ id: string; ok: boolean } | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (!open) { window.clearTimeout(timer.current); setCopy(null); } }, [open]);
  async function copyRow(row: ProjectInfoRow) {
    const ok = await writeClipboard(row.value);
    window.clearTimeout(timer.current);
    setCopy({ id: row.id, ok });
    // Success fades; a failure stays until the next copy or close so it can be read.
    if (ok) timer.current = window.setTimeout(() => setCopy((current) => current?.id === row.id && current.ok ? null : current), 1600);
  }
  return <GuideDialog open={open} title={title} hint={t('home.launcher.infoHint')} onClose={onClose}>
    <dl className={styles.infoList}>
      {rows.map((row) => {
        const state = copy?.id === row.id ? copy : null;
        return <div key={row.id} className={styles.infoRow} data-info-row={row.id}>
          <dt>{row.label}</dt>
          <dd>
            <span className={row.mono ? styles.infoValueMono : styles.infoValue}>{row.value}</span>
            <span className={styles.infoActions}>
              <Button size="sm" variant="ghost" icon={<Icon name={state?.ok ? 'check' : 'copy'} size={13} />} aria-label={t('home.launcher.copyValue', { label: row.label })} onClick={() => void copyRow(row)}>{state?.ok ? t('home.launcher.copied') : t('home.launcher.copy')}</Button>
              {state && !state.ok && <span className={styles.infoCopyFailed} role="alert">{t('home.launcher.copyFailedManual')}</span>}
            </span>
          </dd>
        </div>;
      })}
    </dl>
  </GuideDialog>;
}
