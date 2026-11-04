import { useRemoteReads, RemoteReadStatus } from '../../lib/remoteReads';
import { removalContext, useAccountLabels } from './resourceContexts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open as pickPath } from '@tauri-apps/plugin-dialog';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { Icon } from '../../components/Icon';
import { EmptyState } from '../../components/EmptyState';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import { confirmAction } from '../../lib/confirm';
import { CliTargetGrid } from './CliTargetGrid';
import { Badge, Button, Card } from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import { native } from '../../lib/native';
import { useFeedback } from '../../lib/toast';
import { searchShortcutHint } from '../../lib/shortcut';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { NativeSkillEntry, SkillImportPreview, SkillInstallation, SkillPackage } from '../../types/resources';
import { SkillDistribution } from './SkillDistribution';
import { SkillManifestView, isSkillManifest } from '../tools/SkillManifestView';
import i18n from '../../i18n';
import styles from './LibraryPage.module.css';

function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('tools.workspace.operationFailed');
}

function installStateLabel(state: SkillInstallation['state']): string {
  return i18n.t(`library.resources.installState.${state}`);
}

type LibrarySkill = SkillPackage & { remoteToolId?: string; remoteReadOnly?: boolean };

/** Where the card's files actually live: the library package, a remote root, or a read-only remote root. */
type SkillSource = 'managed' | 'remote' | 'remoteReadOnly';
/** One target of an import or sync, so a partial result names what worked and what did not. */
type TargetOutcome = { name: string; state: 'ok' | 'failed' | 'conflict'; detail: string };
/** Results belong to the host that produced them, so an old host cannot inherit new rows. */
type OutcomeReport = { host: string | null; rows: TargetOutcome[] };

function remoteSkillPackages(toolIds: string[], stores: unknown[]): LibrarySkill[] {
  return stores.flatMap((value, index) => ((value as { entries?: NativeSkillEntry[] }).entries ?? []).map(entry => {
    const toolId = toolIds[index];
    return { id: entry.packageId ?? `remote:${toolId}:${entry.path}`, name: entry.name, description: entry.detail, compatibility: null, source: entry.path, digest: entry.digest ?? '', fileCount: 1, updatedAt: 0, inLibrary: true, remoteToolId: toolId, remoteReadOnly: entry.source === 'read_only' || entry.state === 'read_only' };
  }));
}

function remoteSkillInstallations(items: LibrarySkill[]): SkillInstallation[] {
  return items.flatMap(item => item.remoteToolId ? [{ packageId: item.id, toolId: item.remoteToolId, scope: 'global' as const, projectPath: null, targetPath: item.source, digest: item.digest, state: 'current' as const }] : []);
}

async function readRemoteSkillStores(targetId: string, toolIds: string[], reader = native, fresh = false) {
  if (!toolIds.length) return [];
  const bundle = await reader.listRemoteResourceStores(targetId, toolIds, 'skills', { fresh });
  return toolIds.map(toolId => bundle.stores?.[toolId] ?? { entries: [] });
}

/** Skill library section. MCP lives in LibraryMcp. */
export function LibraryResources({ active, tools, projects, createSignal = 0, onCountChange, remoteTargetId = null }: { active: boolean; tools: AdapterDescriptor[]; projects: Project[]; createSignal?: number; onCountChange?: (count: number) => void; remoteTargetId?: string | null }) {
  const { t, i18n } = useTranslation();
  const contextLabel = useAccountLabels(!!remoteTargetId);
  const remoteTools = tools.filter(tool => tool.remoteSkillDirectories ? tool.remoteSkillDirectories.length > 0 : tool.remoteResources ? !!tool.remoteResources.skillRoot : tool.management?.skills === true);
  const remoteWritableTools = remoteTools.filter(tool => tool.remoteResources ? !!tool.remoteResources.skillRoot : tool.management?.skills === true);
  const remoteToolId = remoteTools[0]?.id ?? '';
  const remoteToolIds = remoteTools.map(tool => tool.id);
  const remoteToolFor = (item: SkillPackage) => (item as LibrarySkill).remoteToolId ?? remoteToolId;
  const packageWritable = (item: SkillPackage) => !remoteTargetId || (!(item as LibrarySkill).remoteReadOnly && remoteWritableTools.some(tool => tool.id === remoteToolFor(item)));
  const sourceOf = (item: SkillPackage): SkillSource => !remoteTargetId ? 'managed' : (item as LibrarySkill).remoteReadOnly ? 'remoteReadOnly' : 'remote';
  const sourceLabel = (item: SkillPackage) => t(sourceOf(item) === 'managed' ? 'library.resources.sourceManaged' : sourceOf(item) === 'remoteReadOnly' ? 'library.resources.sourceRemoteReadOnly' : 'library.resources.sourceRemote');
  const remoteReads = useRemoteReads(remoteTargetId, remoteToolIds.join('|'), active);
  const native = remoteReads.native;
  const [packages, setPackages] = useState<LibrarySkill[]>([]);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [busy, setBusy] = useState(false);
  // Page results float as toasts so the card grid never jumps.
  const { setError, setNotice } = useFeedback();
  const [dialogError, setDialogError] = useState('');
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillUrl, setSkillUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null } | null>(null);
  const [skillTarget, setSkillTarget] = useState<SkillPackage | null>(null);
  const [skillSeed, setSkillSeed] = useState<string[]>([]);
  const [installTools, setInstallTools] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [outcomes, setOutcomes] = useState<OutcomeReport | null>(null);

  useEffect(() => {
    if (!active) return;
    if (remoteTargetId) {
      let live = true;
      const sequence = ++reloadSequence.current;
      void readRemoteSkillStores(remoteTargetId, remoteToolIds, native).then(values => {
        if (!live || sequence !== reloadSequence.current) return;
        const items = remoteSkillPackages(remoteToolIds, values);
        setPackages(items);
        setInstallations(remoteSkillInstallations(items));
      }).catch(value => { if (live) setError(failure(value)); });
      return () => { live = false; };
    }
    let live = true;
    const load = native.listSkillPackages().then(async (items) => {
        if (!live) return;
        setPackages(items);
        const found = (await Promise.all(items.map((item) => native.listSkillInstallations(item.id)))).flat();
        if (live) setInstallations(found);
      });
    void load.catch((value) => { if (live) setError(failure(value)); });
    return () => { live = false; };
  }, [active, remoteTargetId, remoteToolIds.join('|')]);

  // A report names the targets of one run: leaving the page or changing the host drops it,
  // so old rows never sit next to another host's Skill list.
  useEffect(() => { setOutcomes(null); }, [remoteTargetId, active]);

  useEffect(() => {
    onCountChange?.(packages.filter((item) => item.inLibrary !== false).length);
  }, [packages, onCountChange]);

  const handledCreate = useRef(createSignal);
  useEffect(() => {
    if (createSignal === handledCreate.current) return;
    handledCreate.current = createSignal;
    if (!busy && (!remoteTargetId || remoteWritableTools.length > 0)) { setDialogError(''); setSkillOpen(true); }
  }, [createSignal]);

  const reloadSequence = useRef(0);
  useEffect(() => () => { reloadSequence.current++; }, [remoteTargetId, active]);
  async function reloadSkills() {
    remoteReads.rebaseWriteAction();
    const sequence = ++reloadSequence.current;
    if (remoteTargetId) {
      const values = await readRemoteSkillStores(remoteTargetId, remoteToolIds, native, true);
      if (sequence !== reloadSequence.current) return;
      const items = remoteSkillPackages(remoteToolIds, values);
      setPackages(items);
      setInstallations(remoteSkillInstallations(items));
      return;
    }
    const items = await native.listSkillPackages();
    setPackages(items);
    setInstallations((await Promise.all(items.map((entry) => native.listSkillInstallations(entry.id)))).flat());
  }

  function closeSkill() {
    setSkillOpen(false);
    setArchiveSelection(null);
    setPendingImport(null);
    setDialogError('');
  }

  async function finishSkillImport(item?: SkillPackage) {
    const prior = item ? installations.filter((entry) => entry.packageId === item.id && entry.state !== 'conflict' && entry.state !== 'disabled' && entry.state !== 'unavailable') : [];
    const checked = installTools.filter((toolId) => !prior.some((entry) => entry.toolId === toolId && entry.scope === 'global'));
    await reloadSkills();
    closeSkill();
    setInstallTools([]);
    const targets = [
      ...prior.map((entry) => ({ toolId: entry.toolId, scope: entry.scope, projectPath: entry.projectPath })),
      ...checked.map((toolId) => ({ toolId, scope: 'global' as const, projectPath: null })),
    ];
    if (item && targets.length) {
      // Every target keeps its own row: a skipped target is a result, not a silent success.
      const rows: TargetOutcome[] = [];
      for (const target of targets) {
        const name = tools.find((tool) => tool.id === target.toolId)?.name ?? target.toolId;
        const preview = await native.previewSkillTarget(item.id, target.toolId, target.scope, target.projectPath);
        if (preview?.status === 'conflict') {
          rows.push({ name, state: 'conflict', detail: preview.detail || t('library.resources.resultConflictDetail') });
          continue;
        }
        const outcome = await native.installSkill(item.id, target.toolId, target.scope, target.projectPath, preview?.previewToken ?? null, false);
        rows.push({ name, state: outcome.status === 'failed' ? 'failed' : 'ok', detail: outcome.status === 'failed' ? outcome.detail : t('library.resources.synced') });
      }
      await reloadSkills();
      const report: OutcomeReport | null = rows.length ? { host: remoteTargetId ?? null, rows } : null;
      setOutcomes(report);
      const failed = rows.filter((row) => row.state === 'failed');
      const conflicts = rows.filter((row) => row.state === 'conflict');
      // The panel already names every target, so only failures keep the alert toast.
      setError(failed.length ? failed.map((row) => t('library.resources.syncEntry', { name: row.name, result: row.detail })).join(t('tools.quota.errorSeparator')) : '');
      // Conflicted targets keep the existing replace flow: open the Skill and let the user confirm there.
      if (conflicts.length) { setSkillSeed([]); setSkillTarget(item); }
      return;
    }
    setOutcomes(null);
    setNotice(t('library.resources.addedToLibrary'));
    setError('');
  }

  async function importPreview(preview: SkillImportPreview, kind: 'local' | 'zip' | 'local_zip', source: string, subdirectory: string | null) {
    if (preview.existingDigest && preview.existingDigest !== preview.digest) {
      setPendingImport({ preview, kind, source, subdirectory });
      setArchiveSelection(null);
      return;
    }
    const item = kind === 'local'
      ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
      : kind === 'local_zip'
        ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
    if (item) await finishSkillImport(item);
  }

  async function addFolder() {
    remoteReads.beginWriteAction();
    try {
      const source = await pickPath({ directory: true, multiple: false, title: t('tools.skills.pickDirTitle') });
      if (typeof source !== 'string') return;
      setBusy(true); setDialogError('');
      if (remoteTargetId) {
        const toolIds = installTools.length ? installTools.filter(id => remoteWritableTools.some(tool => tool.id === id)) : remoteWritableTools.slice(0, 1).map(tool => tool.id);
        if (!toolIds.length) throw new Error(t('library.page.remoteUnavailable'));
        for (const toolId of toolIds) await native.importRemoteSkillDirectory(remoteTargetId, toolId, source);
        await reloadSkills();
        closeSkill();
        setNotice(t('library.resources.addedToLibrary'));
        return;
      }
      await importPreview(await native.previewSkillLocal(source), 'local', source, null);
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function addArchive(source: string, localZip: boolean, chosen?: string) {
    setBusy(true); setDialogError('');
    try {
      let child = chosen ?? null;
      if (chosen === undefined) {
        const entries = await native.listSkillZipEntries(source, localZip);
        if (entries.length > 1) { setArchiveSelection({ source, local: localZip, entries, chosen: null }); return; }
        child = entries[0] || null;
      }
      const preview = localZip ? await native.previewSkillLocalZip(source, child) : await native.previewSkillHttpsZip(source, child);
      await importPreview(preview, localZip ? 'local_zip' : 'zip', source, child);
      if (!localZip) setSkillUrl('');
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function addZip() {
    try {
      const source = await pickPath({ directory: false, multiple: false, title: t('tools.skills.pickZipTitle'), filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (typeof source === 'string') await addArchive(source, true);
    } catch (value) { setDialogError(failure(value)); }
  }

  async function confirmSkillImport() {
    if (!pendingImport) return;
    setBusy(true); setDialogError('');
    try {
      const { preview, kind, source, subdirectory } = pendingImport;
      const item = kind === 'local' ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : kind === 'local_zip' ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      await finishSkillImport(item);
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function removePackage(item: SkillPackage) {
    if (!packageWritable(item)) return;
    remoteReads.beginWriteAction();
    const placed = !remoteTargetId && installations.some((entry) => entry.packageId === item.id);
    const message = placed ? t('library.resources.confirmDeletePlaced', { name: item.name }) : t('library.resources.confirmDelete', { name: item.name });
    if (busy || !await confirmAction(message, () => true, { title: t('library.resources.deleteSkillTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      if (remoteTargetId) {
        const targetToolId = remoteToolFor(item); const store = await native.getRemoteResourceStore(remoteTargetId, targetToolId, 'skills', { fresh: true }) as { entries?: NativeSkillEntry[]; documents?: Record<string, string> };
        const entry = (store.entries ?? []).find(value => (value.packageId ?? `remote:${targetToolId}:${value.path}`) === item.id || value.path === item.source);
        const entries = (store.entries ?? []).filter(value => value !== entry);
        const documents = { ...(store.documents ?? {}) };
        if (entry) delete documents[entry.path];
        await native.saveRemoteResourceStore(remoteTargetId, targetToolId, 'skills', { ...store, entries, documents });
      } else await native.deleteSkillPackage(item.id);
      await reloadSkills();
      setNotice(t('library.resources.removed'));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function toggleSkill(item: SkillPackage, toolId: string, scope: Scope, projectPath: string | null, contextId: string | null) {
    if (remoteTargetId || !packageWritable(item)) return;
    remoteReads.beginWriteAction();
    if (busy) return;
    const toolName = tools.find((tool) => tool.id === toolId)?.name ?? toolId;
    const where = scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(scope, projectPath, projects) }) : '';
    const place = installations.find((entry) => entry.packageId === item.id && entry.toolId === toolId && entry.scope === scope && (entry.contextId ?? null) === contextId && (scope === 'global' || samePath(entry.projectPath, projectPath)));
    setBusy(true); setError(''); setNotice('');
    try {
      if (place) {
        await native.removeSkill(item.id, toolId, scope, place.projectPath, await removalContext(place));
        setNotice(t('library.page.removed', { where, tool: toolName }));
      } else {
        const preview = await native.previewSkillTarget(item.id, toolId, scope, projectPath);
        if (preview?.status === 'conflict' && !await confirmAction(t('library.resources.confirmReplace', { name: item.name, tool: toolName }), () => true, { title: t('library.resources.replaceSkillTitle'), confirmLabel: t('library.resources.replaceInstall') })) return;
        const outcome = await native.installSkill(item.id, toolId, scope, projectPath, preview?.previewToken ?? null, preview?.status === 'conflict');
        if (outcome.status === 'failed') { setError(outcome.detail); return; }
        setNotice(t('library.resources.installedTo', { where, tool: toolName }));
      }
      await reloadSkills();
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  const needle = search.trim().toLowerCase();
  const libraryPackages = packages.filter((item) => item.inLibrary !== false)
    .filter((item) => !needle || `${item.name} ${item.description ?? ''}`.toLowerCase().includes(needle));

  // Only rows of the current host render; a stale report never speaks for another host.
  const report = outcomes && outcomes.host === (remoteTargetId ?? null) ? outcomes.rows : null;
  const allOk = !!report && report.every((row) => row.state === 'ok');
  const count = (state: TargetOutcome['state']) => report?.filter((row) => row.state === state).length ?? 0;
  return <div className={styles.layout}><RemoteReadStatus state={remoteReads} />
    <div className={styles.skillToolbar}><SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.resources.searchSkillPlaceholder')} /></div>
    <div className={styles.resultBar}>
      <Badge tone={needle ? 'accent' : 'neutral'}>{t('library.page.countFiltered', { filtered: libraryPackages.length, total: packages.filter((entry) => entry.inLibrary !== false).length })}</Badge>
      <span className={styles.resultNote}>{t(remoteTargetId ? 'library.page.sourceRemote' : 'library.page.sourceLocal')}</span>
    </div>
    {report && <section className={styles.result} data-tone={allOk ? undefined : 'warning'} role="status" aria-label={t('library.resources.resultAria')}>
      <div className={styles.resultHead}><Icon name={allOk ? 'check' : 'alert'} size={16} /><span>{t(allOk ? 'library.resources.resultOk' : count('conflict') ? 'library.resources.resultConflict' : 'library.resources.resultMixed', { total: report.length, ok: count('ok'), failed: count('failed'), conflict: count('conflict') })}</span><Button variant="ghost" size="sm" onClick={() => setOutcomes(null)}>{t('common.dialog.close')}</Button></div>
      <ul className={styles.resultList}>{report.map((row, index) => <li key={`${row.name}:${index}`} data-state={row.state}><Icon name={row.state === 'ok' ? 'check' : 'alert'} size={14} /><strong>{row.name}</strong><small>{row.detail}</small></li>)}</ul>
    </section>}
    <div className={styles.list} aria-label={t('library.resources.skillListAria')}>
      {libraryPackages.length ? libraryPackages.map((item) => {
        return <Card className={styles.card} interactive key={item.id} data-skill-id={item.id} data-source={sourceOf(item)}>
          <div className={styles.cardHead}>
            <button className={styles.cardTitle} type="button" data-card-title onClick={() => { setSkillSeed([]); setSkillTarget(item); }}>{item.name}</button>
            {(item.issues?.length ?? 0) > 0 && <Badge tone="warning">{t('tools.skills.specIssues')}</Badge>}
            <div className={styles.cardActions} role="group" aria-label={t('library.page.itemActions', { title: item.name })}><Button variant="ghost" size="sm" disabled={busy || !!remoteTargetId} title={remoteTargetId ? t('library.page.remoteUnavailable') : undefined} onClick={() => { setSkillSeed([]); setSkillTarget(item); }}>{t('tools.workspace.edit')}</Button><RowMenu label={t('library.resources.rowMenu', { name: item.name })}><button type="button" role="menuitem" data-danger="true" disabled={busy || !packageWritable(item)} onClick={() => void removePackage(item)}><Icon name="trash" size={14} /><span>{t('tools.agents.delete')}</span></button></RowMenu></div>
          </div>
          <p className={styles.cardBody}>{item.description || t('library.resources.fullPackage')}</p>
          <div className={styles.cardMeta}>
            <Badge className={styles.metaBadge} tone={sourceOf(item) === 'remoteReadOnly' ? 'warning' : sourceOf(item) === 'remote' ? 'info' : 'neutral'} dot>{sourceLabel(item)}</Badge>
            <span>{t('tools.skills.fileCount', { count: item.fileCount })}</span>
            {!!item.updatedAt && <span className={styles.cardTime} title={new Date(item.updatedAt * 1000).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')}><Icon name="clock" size={12} />{new Date(item.updatedAt * 1000).toLocaleDateString(i18n.language === 'en' ? 'en-US' : 'zh-CN')}</span>}
          </div>
          {packageWritable(item) ? <div className={styles.cardFoot}>
            <ScopeMarks contextLabel={contextLabel} accountContexts label={t('library.page.cliMarks', { title: item.name })} tools={remoteTargetId ? remoteWritableTools : tools} places={installations.filter((entry) => entry.packageId === item.id)} projects={projects} busy={busy} unavailable={remoteTargetId ? toolId => installations.some(entry => entry.packageId === item.id && entry.toolId === toolId) ? t('library.resources.remoteSkillInstalled') : t('library.resources.remoteSkillDistributionUnavailable') : undefined} onToggle={(toolId, scope, projectPath, contextId) => void toggleSkill(item, toolId, scope, projectPath, contextId)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: t('tools.skills.stateNotInstalled') };
              if (place.state === 'current') return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
              if (place.state === 'conflict' || place.state === 'update_available') return { pressed: true, state: 'drifted', status: installStateLabel(place.state) };
              return { pressed: true, state: 'unavailable', status: installStateLabel(place.state) };
            }} />
          </div> : null}
        </Card>;
      }) : needle
        ? <EmptyState icon="search" title={t('library.resources.noSkillMatch', { query: search.trim() })} />
        : <EmptyState icon="sparkle" title={t('library.resources.emptySkillTitle')} detail={t('library.resources.emptySkillDetail')} action={!remoteTargetId ? <Button icon={<Icon name="plus" size={14} />} disabled={busy} onClick={() => { setDialogError(''); setSkillOpen(true); }}>{t('tools.skills.add')}</Button> : undefined} />}
    </div>
    <GuideDialog open={skillOpen} title={t('tools.skills.add')} hint={t('library.resources.addSkillHint')} onClose={closeSkill}>
      <div className={styles.skillAdd}>
        {!archiveSelection && !pendingImport && <>
          <section className={styles.skillSection}>
            <h3>{t('library.resources.installAfterImport')}</h3>
            <p>{t('library.resources.installAfterHint')}</p>
            <CliTargetGrid tools={remoteTargetId ? remoteWritableTools : tools} selected={installTools} onToggle={(id, checked) => setInstallTools(checked ? [...installTools, id] : installTools.filter((item) => item !== id))} />
          </section>
          <section className={styles.skillSection}>
            <h3>{t('library.resources.importFrom')}</h3>
            <div className={styles.sources}>
              <button type="button" aria-label={t('tools.skills.pickFolder')} disabled={busy} onClick={() => void addFolder()}><Icon name="folder" size={18} /><strong>{t('tools.skills.pickFolder')}</strong><span>{t('tools.skills.pickFolderHint')}</span></button>
              <button type="button" aria-label={t('tools.skills.importZip')} disabled={busy || !!remoteTargetId} onClick={() => void addZip()}><Icon name="archive" size={18} /><strong>{t('tools.skills.importZip')}</strong><span>{t('tools.skills.importZipHint')}</span></button>
            </div>
            <label>{t('tools.skills.zipUrl')}<span className={styles.urlRow}><input aria-label={t('tools.skills.zipUrlAria')} disabled={!!remoteTargetId} value={skillUrl} onChange={(event) => setSkillUrl(event.target.value)} placeholder="https://example.com/skill.zip" /><Button disabled={busy || !!remoteTargetId || !skillUrl.trim()} onClick={() => void addArchive(skillUrl.trim(), false)}>{t('tools.skills.importUrl')}</Button></span></label>
          </section>
        </>}
        {archiveSelection && <section className={styles.skillSection}>
          <h3>{t('library.resources.archiveMultiTitle')}</h3>
          <label>{t('library.resources.archiveChoose')}<select aria-label={t('tools.skills.archiveAria')} value={archiveSelection.chosen ?? '__choose__'} onChange={(event) => setArchiveSelection({ ...archiveSelection, chosen: event.target.value === '__choose__' ? null : event.target.value })}><option value="__choose__">{t('tools.skills.archivePlaceholder')}</option>{archiveSelection.entries.map((entry) => <option key={entry} value={entry}>{entry || t('tools.skills.archiveRoot')}</option>)}</select></label>
          <div className={styles.actions}><Button onClick={() => setArchiveSelection(null)}>{t('library.resources.back')}</Button><Button variant="primary" disabled={busy || archiveSelection.chosen === null} onClick={() => void addArchive(archiveSelection.source, archiveSelection.local, archiveSelection.chosen ?? undefined)}>{t('tools.skills.archiveImport')}</Button></div>
        </section>}
        {pendingImport && <section className={styles.skillSection} role="group" aria-label={t('tools.skills.importLabel')}>
          <h3>{t('library.resources.existingTitle', { name: pendingImport.preview.name })}</h3>
          <p>{t('library.resources.existingNote', { source: pendingImport.preview.source, count: pendingImport.preview.fileCount, install: installTools.length ? t('library.resources.existingInstall') : '' })}</p>
          {isSkillManifest(pendingImport.preview.manifest) && <SkillManifestView manifest={pendingImport.preview.manifest} directory={pendingImport.preview.name} />}
          <div className={styles.actions}><Button onClick={() => setPendingImport(null)}>{t('library.resources.back')}</Button><Button variant="primary" disabled={busy} onClick={() => void confirmSkillImport()}>{installations.some((entry) => packages.some((item) => item.id === entry.packageId && item.name === pendingImport.preview.name)) ? t('library.resources.updateAndSync') : t('library.resources.confirmUpdate')}</Button></div>
        </section>}
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
      </div>
    </GuideDialog>
    <GuideDialog open={!!skillTarget} title={t('library.resources.editSkillTitle')} hint={t('library.resources.editSkillHint')} onClose={() => { setSkillTarget(null); setSkillSeed([]); }}>
      {!remoteTargetId && skillTarget && <SkillDistribution item={skillTarget} tools={tools} projects={projects} installations={installations} initialTools={skillSeed} autoRun={skillSeed.length > 0} onChanged={reloadSkills} />}
    </GuideDialog>
  </div>;
}
