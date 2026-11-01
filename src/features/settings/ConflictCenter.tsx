import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon, type IconName } from '../../components/Icon';
import { Badge, Button } from '../../components/ui';
import type { ConflictPreview, SyncConflict } from '../../types/portable';
import { compareText } from '../../lib/textDiff';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { relativeTime, useKindLabel } from './syncParts';
import styles from './ConflictCenter.module.css';

type Choice = { kind: 'local' } | { kind: 'remote'; id: string; deleted: boolean };

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; value: ConflictPreview }
  | { status: 'error'; message: string };

const text = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

/** Split a one-line summary into display segments; null when it is not segmented. */
function segmentsOf(summary: string | null | undefined): string[] | null {
  const trimmed = (summary ?? '').trim();
  if (!trimmed || !trimmed.includes('·')) return null;
  return trimmed.split('·').map(part => part.trim()).filter(Boolean);
}

function SummaryBlock({ summary, deleted }: { summary: string | null | undefined; deleted?: boolean }) {
  const { t } = useTranslation();
  if (deleted) {
    return <div className={styles.summaryDeleted}><Icon name="trash" size={14} /><span>{t('settings.webdav.remoteDeletedNote')}</span></div>;
  }
  const segments = segmentsOf(summary);
  if (segments) {
    return <ul className={styles.segments}>{segments.map((segment, index) => <li key={index}>{segment}</li>)}</ul>;
  }
  if (summary?.trim()) {
    return <pre className={styles.summaryPre}>{summary}</pre>;
  }
  return <p className={styles.summaryEmpty}>{t('settings.webdav.contentMissing')}</p>;
}

/**
 * The standalone conflict resolution center. One dialog lists every conflict;
 * each conflict explains why it happened and shows every version side by side,
 * so a choice is a comparison instead of a guess. A single action can keep the
 * local version for all remaining conflicts at once.
 */
export function ConflictCenter({ open, conflicts, focusKey, onClose, onResolve, onBulkDone }: {
  open: boolean;
  conflicts: SyncConflict[];
  focusKey?: string | null;
  onClose: () => void;
  onResolve: (key: string, versionId: string | null, deleted: boolean, options?: { announce?: boolean }) => Promise<boolean>;
  onBulkDone?: (count: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const kindLabel = useKindLabel();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [working, setWorking] = useState(false);
  const [total, setTotal] = useState(0);
  const generation = useRef(0);

  // Reset the session each time the center opens.
  useEffect(() => {
    if (!open) return;
    generation.current += 1;
    setChoices({});
    setPreviews({});
    setWorking(false);
    setTotal(conflicts.length);
    setSelectedKey(focusKey && conflicts.some(item => item.key === focusKey) ? focusKey : conflicts[0]?.key ?? null);
    // Conflicts at open time define the session; the list shrinks as choices land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = conflicts.find(item => item.key === selectedKey) ?? null;

  const loadPreview = useCallback(async (key: string) => {
    const version = generation.current;
    setPreviews((old) => ({ ...old, [key]: { status: 'loading' } }));
    try {
      const value = await native.previewWebdavConflict(key);
      if (generation.current !== version) return;
      setPreviews((old) => ({ ...old, [key]: { status: 'ready', value } }));
    } catch (error) {
      if (generation.current !== version) return;
      setPreviews((old) => ({ ...old, [key]: { status: 'error', message: text(error) } }));
    }
  }, []);

  useEffect(() => {
    if (!open || !selectedKey) return;
    const current = previews[selectedKey];
    if (!current) void loadPreview(selectedKey);
  }, [open, selectedKey, previews, loadPreview]);

  // The resolved conflict disappears from the list; move on to the next one.
  useEffect(() => {
    if (!open) return;
    if (selectedKey && !conflicts.some(item => item.key === selectedKey)) {
      setSelectedKey(conflicts[0]?.key ?? null);
      setChoices((old) => {
        if (!(selectedKey in old)) return old;
        const next = { ...old };
        delete next[selectedKey];
        return next;
      });
    }
  }, [open, conflicts, selectedKey]);

  const preview = selected ? previews[selected.key] : undefined;
  const choice = selected ? choices[selected.key] : undefined;

  const options = useMemo(() => {
    if (!selected) return [];
    const ready = preview?.status === 'ready' ? preview.value : null;
    // Newest first so the choice reads like a timeline; unknown times sink to the end.
    const remote = [...(ready?.versions ?? [])].sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
    const newestId = remote.find(version => (version.at ?? 0) > 0)?.id;
    const list: Array<{ optionKey: string; choice: Choice; label: string; note: string; icon: IconName; summary: string | null; content: string; deleted: boolean; at?: number; isNewest?: boolean }> = [{
      optionKey: 'local',
      choice: { kind: 'local' },
      label: t('settings.webdav.localVersion'),
      note: t('settings.webdav.localVersionNote'),
      icon: 'monitor',
      summary: ready?.localSummary ?? null,
      content: ready?.localContent ?? '',
      deleted: false,
    }];
    remote.forEach((version, index) => {
      list.push({
        optionKey: version.id,
        choice: { kind: 'remote', id: version.id, deleted: version.deleted },
        label: t('settings.webdav.remoteVersion', { index: index + 1 }),
        note: t('settings.webdav.remoteVersionId', { id: version.id.slice(0, 8) }),
        icon: 'cloud',
        summary: version.deleted ? null : version.summary,
        content: version.deleted ? '' : version.content,
        deleted: version.deleted,
        at: version.at || undefined,
        isNewest: version.id === newestId,
      });
    });
    return list;
  }, [selected, preview, t]);

  function why(conflict: SyncConflict) {
    const versions = Math.max(conflict.remoteVersions, conflict.versions.length, preview?.status === 'ready' ? preview.value.versions.length : 0);
    if (!conflict.localPresent) return { main: t('settings.webdav.whyLocalDeleted', { count: versions }), extra: '' };
    if (conflict.remoteDeleted) return { main: t('settings.webdav.whyRemoteDeleted'), extra: '' };
    return {
      main: t('settings.webdav.whyBoth'),
      extra: versions > 1 ? t('settings.webdav.whyVersions', { count: versions }) : '',
    };
  }

  async function applyChoice() {
    if (!selected || !choice || working) return;
    setWorking(true);
    try {
      const ok = await onResolve(selected.key, choice.kind === 'remote' ? choice.id : null, choice.kind === 'remote' && choice.deleted);
      if (ok) setChoices((old) => { const next = { ...old }; delete next[selected.key]; return next; });
    } finally {
      setWorking(false);
    }
  }

  async function keepAllLocal() {
    if (working) return;
    const snapshot = conflicts;
    if (!await confirmAction(t('settings.webdav.keepAllLocalConfirm'), undefined, { title: t('settings.webdav.keepAllLocalTitle'), confirmLabel: t('settings.webdav.keepAllLocal') })) return;
    setWorking(true);
    try {
      for (const conflict of snapshot) {
        const ok = await onResolve(conflict.key, null, false, { announce: false });
        if (!ok) return;
      }
      onBulkDone?.(snapshot.length);
      onClose();
    } finally {
      setWorking(false);
    }
  }

  const done = total > 0 && conflicts.length === 0;
  const resolvedCount = Math.max(0, total - conflicts.length);
  const confirmLabel = !choice
    ? t('settings.webdav.useSelected')
    : choice.kind === 'local'
      ? t('settings.webdav.useSelectedLocal')
      : choice.deleted
        ? t('settings.webdav.useSelectedDelete')
        : t('settings.webdav.useSelected');

  return <GuideDialog wide open={open} title={t('settings.webdav.centerTitle')}
    hint={total > 1 ? t('settings.webdav.centerProgress', { done: resolvedCount, total }) : undefined}
    onClose={() => { if (!working) onClose(); }}>
    <div className={styles.center}>
      <div className={styles.panes}>
        <aside className={styles.rail} aria-label={t('settings.webdav.centerTitle')}>
          <ul className={styles.railList}>
            {conflicts.map((conflict) => {
              const picked = choices[conflict.key];
              return <li key={conflict.key}>
                <button type="button" className={styles.railItem} data-selected={conflict.key === selectedKey ? '' : undefined}
                  onClick={() => setSelectedKey(conflict.key)}>
                  <span className={styles.railIcon} aria-hidden="true"><Icon name={conflict.remoteDeleted ? 'trash' : 'copy'} size={15} /></span>
                  <span className={styles.railBody}>
                    <span className={styles.railTitle}>
                      <strong>{conflict.label}</strong>
                      {picked && <span className={styles.railCheck} aria-hidden="true"><Icon name="check" size={12} /></span>}
                    </span>
                    <small>{kindLabel(conflict.key.split(':')[0])} · {t('settings.webdav.versionCount', { count: Math.max(conflict.remoteVersions, conflict.versions.length) })}</small>
                  </span>
                </button>
              </li>;
            })}
          </ul>
        </aside>
        <section className={styles.detail} aria-live="polite">
          {selected ? <>
            <header className={styles.detailHead}>
              <h3>{selected.label}</h3>
              <Badge tone="warning">{kindLabel(selected.key.split(':')[0])}</Badge>
            </header>
            {(() => {
              const reason = why(selected);
              return <div className={styles.why}><Icon name="info" size={15} /><div><p>{reason.main}</p>{reason.extra && <p className={styles.whyExtra}>{reason.extra}</p>}</div></div>;
            })()}
            {(!preview || preview.status === 'loading') && <div className={styles.loading} role="status">
              <span className={styles.spin} aria-hidden="true"><Icon name="refresh" size={16} /></span>{t('settings.webdav.previewLoading')}
            </div>}
            {preview?.status === 'error' && <div className={styles.previewError} role="alert">
              <p>{t('settings.webdav.previewFailed')}</p><small>{preview.message}</small>
              <Button size="sm" disabled={working} onClick={() => void loadPreview(selected.key)}>{t('settings.webdav.previewRetry')}</Button>
            </div>}
            {preview?.status === 'ready' && <div className={styles.options} role="radiogroup" aria-label={t('settings.webdav.centerTitle')}>
              {options.map((option) => {
                const active = !!choice && choice.kind === option.choice.kind && (choice.kind === 'local' || option.choice.kind === 'remote' && choice.id === option.choice.id);
                // Real content diff against the local version drives both the badge and the expandable view.
                const compared = option.choice.kind === 'remote' && !option.deleted
                  ? compareText(preview.value.localContent, option.content, 'text')
                  : null;
                const changeCount = compared ? compared.removed + compared.added : 0;
                return <div key={option.optionKey} className={styles.optionWrap}>
                  <button type="button" role="radio" aria-checked={active} data-selected={active ? '' : undefined}
                    data-deleted={option.deleted || undefined} className={styles.option} disabled={working}
                    onClick={() => setChoices((old) => ({ ...old, [selected.key]: option.choice }))}>
                    <span className={styles.radio} aria-hidden="true"><span className={styles.radioDot} /></span>
                    <span className={styles.optionBody}>
                      <span className={styles.optionHead}>
                        <Icon name={option.icon} size={14} />
                        <strong>{option.label}</strong>
                        <small>{option.note}</small>
                        {option.at && (() => {
                          const stamp = relativeTime(option.at, i18n.language);
                          return <span className={styles.time} title={stamp.absolute}><Icon name="clock" size={11} /><time dateTime={new Date(option.at * 1000).toISOString()}>{stamp.text}</time></span>;
                        })()}
                        {option.isNewest && <Badge tone="accent">{t('settings.webdav.versionLatest')}</Badge>}
                        {option.deleted && <Badge tone="danger">{t('settings.webdav.remoteDeletedBadge')}</Badge>}
                        {compared && (compared.same
                          ? <Badge tone="success">{t('settings.webdav.identicalToLocal')}</Badge>
                          : <Badge tone="neutral">{t('settings.webdav.differsFromLocal', { count: changeCount })}</Badge>)}
                      </span>
                      <span className={styles.summary}><SummaryBlock summary={option.summary} deleted={option.deleted} /></span>
                    </span>
                  </button>
                  {compared && !compared.same && <details className={styles.optionDiff}>
                    <summary><Icon name="columns" size={13} />{t('settings.webdav.viewDiff', { count: changeCount })}</summary>
                    <ConflictCompare
                      currentContent={preview.value.localContent}
                      nextContent={option.content}
                      format="text"
                      actions={false}
                      onUseNext={() => {}}
                      onKeepCurrent={() => {}}
                    />
                  </details>}
                </div>;
              })}
            </div>}
          </> : <div className={styles.allDone}>
            <span className={styles.doneGlyph} aria-hidden="true"><Icon name="check" size={26} /></span>
            <h3>{t('settings.webdav.centerEmptyTitle')}</h3>
            <p>{t('settings.webdav.centerEmptyHint')}</p>
          </div>}
        </section>
      </div>
      <footer className={styles.foot}>
        {!done && conflicts.length > 1 && <Button variant="ghost" size="sm" disabled={working} onClick={() => void keepAllLocal()}>{t('settings.webdav.keepAllLocal')}</Button>}
        <span className={styles.footGap} />
        <Button disabled={working} onClick={onClose}>{done ? t('settings.webdav.centerClose') : t('common.dialog.cancel')}</Button>
        <Button variant="primary" disabled={!selected || !choice || working} loading={working} data-dialog-save onClick={() => void applyChoice()}>{confirmLabel}</Button>
      </footer>
    </div>
  </GuideDialog>;
}
