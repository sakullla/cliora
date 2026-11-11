import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { displayPath, shortPath } from '../../lib/paths';
import { Icon } from '../../components/Icon';
import { Button, IconButton } from '../../components/ui';
import type { LaunchSettings, Project, WorkbenchSession, WorktreeLaunchMode, WorktreeLedgerEntry } from '../../types/launch';
import styles from './WorktreeSettings.module.css';

const FILTER_MIN = 6;

function rawMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String((error as { message?: unknown }).message ?? '').trim() : '';
}

function normalize(value: string) {
  const clean = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(clean) ? clean.toLowerCase() : clean;
}

function within(root: string, child: string): boolean {
  const base = normalize(root);
  const target = normalize(child);
  return !!base && !!target && (target === base || target.startsWith(base + '/'));
}

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

type PrepareRow = { state: 'loading' | 'ready' | 'failed'; command: string; error: string };

/**
 * Settings → Worktrees: where new sessions start, the per-repository prepare command,
 * and the worktrees Cliora created. Every write is confirmed from what native hands back.
 */
export function WorktreeSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LaunchSettings | null>(null);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [notice, setNotice] = useState('');

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [prepare, setPrepare] = useState<Map<string, PrepareRow>>(() => new Map());
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [savingId, setSavingId] = useState('');
  const [query, setQuery] = useState('');
  const prepareEpoch = useRef(0);

  const [ledger, setLedger] = useState<WorktreeLedgerEntry[] | null>(null);
  const [ledgerError, setLedgerError] = useState('');
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [cleaning, setCleaning] = useState('');
  const [cleanError, setCleanError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loadPrepare = useCallback((list: Project[]) => {
    const epoch = ++prepareEpoch.current;
    setPrepare(new Map(list.map((item) => [item.id, { state: 'loading', command: '', error: '' }])));
    for (const item of list) {
      void native.worktreePrepare(item.path!).then((value) => {
        if (!mounted.current || prepareEpoch.current !== epoch) return;
        setPrepare((current) => new Map(current).set(item.id, { state: 'ready', command: typeof value === 'string' ? value : '', error: '' }));
      }).catch((value) => {
        if (!mounted.current || prepareEpoch.current !== epoch) return;
        setPrepare((current) => new Map(current).set(item.id, { state: 'failed', command: '', error: rawMessage(value) || t('settings.worktrees.prepareReadFailed') }));
      });
    }
  }, [t]);

  const loadLedger = useCallback(() => {
    setLedgerError('');
    void native.listWorktreeLedger().then((rows) => { if (mounted.current) setLedger(Array.isArray(rows) ? rows : []); })
      .catch((value) => { if (mounted.current) { setLedger((current) => current ?? []); setLedgerError(rawMessage(value) || t('settings.worktrees.ledgerReadFailed')); } });
    void native.listWorkbenchSessions().then((rows) => { if (mounted.current) setSessions(Array.isArray(rows) ? rows : []); }).catch(() => {});
  }, [t]);

  useEffect(() => {
    if (!nativeAvailable) return;
    void native.getLaunchSettings().then(setSettings).catch((value) => setLaunchError(rawMessage(value) || t('settings.terminal.readFailed')));
    void native.listProjects().then((rows) => {
      const local = (Array.isArray(rows) ? rows : []).filter((item) => item.available && item.path);
      if (!mounted.current) return;
      setProjects(local);
      loadPrepare(local);
    }).catch(() => setProjects([]));
    loadLedger();
  }, []);

  async function chooseLaunch(mode: WorktreeLaunchMode) {
    if (launchBusy || (!settings?.worktreeLaunchError && settings?.worktreeLaunch === mode)) return;
    setLaunchBusy(true);
    setLaunchError('');
    try {
      setSettings(await native.setWorktreeLaunch(mode));
      setNotice(t('settings.worktrees.launchSaved'));
    } catch (value) {
      setLaunchError(rawMessage(value) || t('settings.terminal.worktreeSaveFailed'));
    } finally { setLaunchBusy(false); }
  }

  async function savePrepare(item: Project, text: string) {
    if (savingId) return;
    setSavingId(item.id);
    try {
      const stored = await native.saveWorktreePrepare(item.path!, text);
      if (!mounted.current) return;
      setEditing(null);
      setNotice(stored.command ? t('settings.worktrees.prepareSaved', { name: item.name }) : t('settings.worktrees.prepareCleared', { name: item.name }));
      // Projects in the same repository share the command: read them all again.
      if (projects) loadPrepare(projects);
    } catch (value) {
      setPrepare((current) => new Map(current).set(item.id, { ...(current.get(item.id) ?? { state: 'ready', command: '' }), error: rawMessage(value) || t('settings.terminal.worktreePrepareFailed') }));
    } finally { if (mounted.current) setSavingId(''); }
  }

  function editKeys(event: KeyboardEvent<HTMLInputElement>, item: Project) {
    if (event.key === 'Enter') { event.preventDefault(); if (editing) void savePrepare(item, editing.text); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); }
  }

  function userOf(row: WorktreeLedgerEntry): WorkbenchSession | undefined {
    return sessions.find((session) => session.running && !session.projectId?.startsWith('remote:') && !!session.directory && within(row.worktreePath, session.directory));
  }

  async function clean(row: WorktreeLedgerEntry): Promise<boolean> {
    const preview = await native.cleanupWorktree(row.worktreePath, false);
    if (!preview.needsConfirmation) return preview.removed;
    const accepted = await confirmAction(preview.detail || t('sessions.worktreeCleanupConfirmTitle'), () => mounted.current, {
      title: t('sessions.worktreeCleanupConfirmTitle'), confirmLabel: t('sessions.worktreeCleanupConfirm'), destructive: true,
    });
    if (!accepted) return false;
    await native.cleanupWorktree(row.worktreePath, true);
    return true;
  }

  async function cleanRows(rows: WorktreeLedgerEntry[]) {
    if (cleaning) return;
    setCleanError('');
    let removed = 0;
    try {
      for (const row of rows) {
        if (userOf(row)) continue;
        setCleaning(row.worktreePath);
        if (await clean(row)) removed++;
      }
      if (removed) setNotice(t('settings.worktrees.ledgerRemoved', { count: removed }));
    } catch (value) {
      setCleanError(rawMessage(value) || t('sessions.worktreeCleanupFailed'));
    } finally {
      if (mounted.current) { setCleaning(''); loadLedger(); }
    }
  }

  const needle = query.trim().toLowerCase();
  const shownProjects = useMemo(() => (projects ?? []).filter((item) => !needle || `${item.name}\n${item.path}\n${prepare.get(item.id)?.command ?? ''}`.toLowerCase().replace(/\\/g, '/').includes(needle.replace(/\\/g, '/'))), [projects, prepare, needle]);
  const groups = useMemo(() => {
    const map = new Map<string, WorktreeLedgerEntry[]>();
    for (const row of ledger ?? []) map.set(row.mainCheckout, [...(map.get(row.mainCheckout) ?? []), row]);
    return [...map.entries()];
  }, [ledger]);
  const missing = (ledger ?? []).filter((row) => row.missing && !userOf(row));
  const launchValue: WorktreeLaunchMode | '' = settings?.worktreeLaunchError ? '' : settings?.worktreeLaunch ?? 'direct';
  const options: { mode: WorktreeLaunchMode; icon: 'folder' | 'gitWorktree' }[] = [{ mode: 'direct', icon: 'folder' }, { mode: 'worktree', icon: 'gitWorktree' }];

  return <div className={styles.page}>
    {notice && <p className={styles.notice} role="status"><Icon name="check" size={13} />{notice}</p>}

    <section className="settings-group" id="settings-worktree-launch" aria-labelledby="worktree-launch-title">
      <div className="setting-intro"><h2 id="worktree-launch-title">{t('settings.worktrees.launchTitle')}</h2><p>{t('settings.worktrees.launchDescription')}</p></div>
      <div className={styles.choices} role="radiogroup" aria-label={t('settings.terminal.worktreeLaunch')}>
        {options.map(({ mode, icon }) => <button key={mode} type="button" role="radio" aria-checked={launchValue === mode} className={styles.choice} disabled={!nativeAvailable || launchBusy || !settings} onClick={() => void chooseLaunch(mode)}>
          <span className={styles.choiceGlyph} aria-hidden="true"><Icon name={icon} size={18} /></span>
          <span className={styles.choiceText}><strong>{t(`settings.worktrees.${mode}`)}</strong><small>{t(`settings.worktrees.${mode}Detail`)}</small></span>
          <span className={styles.choiceMark} aria-hidden="true">{launchValue === mode && <Icon name="check" size={12} />}</span>
        </button>)}
      </div>
      {(launchError || settings?.worktreeLaunchError) && <p className={styles.error} role="alert"><Icon name="alert" size={14} />{launchError || t('settings.worktrees.launchUnrecognized')}</p>}
    </section>

    <section className="settings-group" id="settings-worktree-prepare" aria-labelledby="worktree-prepare-title">
      <div className={`setting-intro ${styles.introRow}`}>
        <div><h2 id="worktree-prepare-title">{t('settings.worktrees.prepareTitle')}</h2><p>{t('settings.worktrees.prepareDescription')}</p></div>
      </div>
      {(projects?.length ?? 0) >= FILTER_MIN && <label className={styles.filter} data-field-frame=""><Icon name="search" size={14} /><input type="search" value={query} placeholder={t('settings.worktrees.prepareFilter')} aria-label={t('settings.worktrees.prepareFilter')} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} /></label>}
      {projects === null ? <p className={styles.muted} role="status">{t('settings.worktrees.loading')}</p>
        : !projects.length ? <p className={styles.empty}><Icon name="folder" size={16} />{t('settings.worktrees.prepareEmpty')}</p>
        : !shownProjects.length ? <p className={styles.empty}><Icon name="search" size={16} />{t('settings.worktrees.prepareNoMatch', { query: query.trim() })}</p>
        : <ul className={styles.list} aria-label={t('settings.worktrees.prepareTitle')}>{shownProjects.map((item) => {
          const row = prepare.get(item.id);
          const open = editing?.id === item.id;
          const saving = savingId === item.id;
          return <li key={item.id} className={styles.row} data-editing={open || undefined}>
            <span className={styles.rowGlyph} aria-hidden="true"><Icon name="folder" size={15} /></span>
            <span className={styles.rowMain}>
              <strong title={item.name}>{item.name}</strong>
              <small title={displayPath(item.path!)}>{shortPath(displayPath(item.path!))}</small>
            </span>
            {open ? <span className={styles.editor}>
              <span className={styles.commandField} data-field-frame=""><span aria-hidden="true">$</span><input autoFocus aria-label={t('settings.worktrees.prepareInput', { name: item.name })} value={editing.text} placeholder={t('settings.terminal.worktreePreparePlaceholder')} disabled={saving} spellCheck={false} onChange={(event) => setEditing({ id: item.id, text: event.target.value })} onKeyDown={(event) => editKeys(event, item)} /></span>
              <Button size="sm" disabled={saving} onClick={() => setEditing(null)}>{t('settings.worktrees.cancel')}</Button>
              <Button size="sm" variant="primary" loading={saving} disabled={saving} onClick={() => void savePrepare(item, editing.text)}>{t('settings.worktrees.save')}</Button>
            </span> : <>
              <span className={styles.command} data-state={row?.state} data-empty={row?.state === 'ready' && !row.command || undefined}>
                {row?.state === 'loading' ? t('settings.worktrees.loadingShort') : row?.state === 'failed' ? <span role="alert">{row.error}</span> : row?.command ? <code title={row.command}>{row.command}</code> : t('settings.worktrees.prepareNone')}
              </span>
              <Button size="sm" variant="ghost" disabled={!nativeAvailable || row?.state === 'loading' || !!savingId} aria-label={t('settings.worktrees.prepareEdit', { name: item.name })} icon={<Icon name="pencil" size={13} />} onClick={() => setEditing({ id: item.id, text: row?.command ?? '' })}>{t('settings.worktrees.edit')}</Button>
            </>}
            {row?.error && row.state !== 'failed' && <p className={styles.rowError} role="alert">{row.error}</p>}
          </li>;
        })}</ul>}
    </section>

    <section className="settings-group" id="settings-worktree-ledger" aria-labelledby="worktree-ledger-title">
      <div className={`setting-intro ${styles.introRow}`}>
        <div><h2 id="worktree-ledger-title">{t('settings.worktrees.ledgerTitle')}{(ledger?.length ?? 0) > 0 && <em className={styles.count}>{ledger!.length}</em>}</h2><p>{t('settings.worktrees.ledgerDescription')}</p></div>
        <span className={styles.introActions}>
          {missing.length > 1 && <Button size="sm" variant="ghost" disabled={!!cleaning} icon={<Icon name="trash" size={13} />} onClick={() => void cleanRows(missing)}>{t('settings.worktrees.ledgerForgetMissing', { count: missing.length })}</Button>}
          <IconButton size="sm" aria-label={t('settings.worktrees.ledgerRefresh')} title={t('settings.worktrees.ledgerRefresh')} disabled={!nativeAvailable || !!cleaning} onClick={loadLedger} icon={<Icon name="refresh" size={14} />} />
        </span>
      </div>
      {(cleanError || ledgerError) && <p className={styles.error} role="alert"><Icon name="alert" size={14} />{cleanError || ledgerError}</p>}
      {ledger === null ? <p className={styles.muted} role="status">{t('settings.worktrees.loading')}</p>
        : !ledger.length ? <p className={styles.empty}><Icon name="gitWorktree" size={16} />{t('settings.worktrees.ledgerEmpty')}</p>
        : <ul className={styles.list} aria-label={t('settings.worktrees.ledgerTitle')}>{groups.map(([repository, rows]) => <li key={repository} className={styles.group}>
          <p className={styles.groupHead} title={displayPath(repository)}><Icon name="folder" size={12} /><strong>{folderName(repository)}</strong><code>{shortPath(displayPath(repository))}</code><em>{rows.length}</em></p>
          <ul>{rows.map((row) => {
            const user = userOf(row);
            const busy = cleaning === row.worktreePath;
            return <li key={row.worktreePath} className={styles.row} data-missing={row.missing || undefined} data-busy={busy || undefined}>
              <span className={styles.rowGlyph} aria-hidden="true"><Icon name="gitWorktree" size={15} /></span>
              <span className={styles.rowMain}>
                <strong className={styles.branch} title={row.branch}>{row.branch}</strong>
                <small title={displayPath(row.worktreePath)}>{shortPath(displayPath(row.worktreePath))}</small>
              </span>
              <span className={styles.tags}>
                {row.missing && <span className={styles.tag} data-tone="warning" title={t('sessions.worktreeMissingHint')}>{t('settings.worktrees.ledgerMissing')}</span>}
                {user && <span className={styles.tag} data-tone="info" title={t('settings.worktrees.ledgerInUseHint')}>{t('settings.worktrees.ledgerInUse')}</span>}
              </span>
              <Button size="sm" variant="ghost" className={styles.danger} disabled={!nativeAvailable || !!cleaning || !!user} title={user ? t('settings.worktrees.ledgerInUseHint') : undefined}
                aria-label={t(row.missing ? 'settings.worktrees.ledgerForgetAria' : 'settings.worktrees.ledgerCleanAria', { branch: row.branch })}
                icon={<Icon name={busy ? 'refresh' : row.missing ? 'close' : 'trash'} size={13} />} onClick={() => void cleanRows([row])}>
                {busy ? t('settings.worktrees.ledgerCleaning') : row.missing ? t('settings.worktrees.ledgerForget') : t('settings.worktrees.ledgerClean')}
              </Button>
            </li>;
          })}</ul>
        </li>)}</ul>}
    </section>
  </div>;
}
