import { removalContext, useAccountLabels } from './resourceContexts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open as pickPath } from '@tauri-apps/plugin-dialog';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { Icon } from '../../components/Icon';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import { confirmAction } from '../../lib/confirm';
import { CliTargetGrid } from './CliTargetGrid';
import { native } from '../../lib/native';
import { useFeedback } from '../../lib/toast';
import { searchShortcutHint } from '../../lib/shortcut';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { SkillImportPreview, SkillInstallation, SkillPackage } from '../../types/resources';
import { SkillDistribution } from './SkillDistribution';
import i18n from '../../i18n';
import styles from './LibraryPage.module.css';

function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('tools.workspace.operationFailed');
}

function installStateLabel(state: SkillInstallation['state']): string {
  return i18n.t(`library.resources.installState.${state}`);
}

/** Skill library section. MCP lives in LibraryMcp. */
export function LibraryResources({ active, tools, projects, createSignal = 0, onCountChange }: { active: boolean; tools: AdapterDescriptor[]; projects: Project[]; createSignal?: number; onCountChange?: (count: number) => void }) {
  const { t } = useTranslation();
  const contextLabel = useAccountLabels();
  const [packages, setPackages] = useState<SkillPackage[]>([]);
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

  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = native.listSkillPackages().then(async (items) => {
        if (!live) return;
        setPackages(items);
        const found = (await Promise.all(items.map((item) => native.listSkillInstallations(item.id)))).flat();
        if (live) setInstallations(found);
      });
    void load.catch((value) => { if (live) setError(failure(value)); });
    return () => { live = false; };
  }, [active]);

  useEffect(() => {
    onCountChange?.(packages.filter((item) => item.inLibrary !== false).length);
  }, [packages, onCountChange]);

  const handledCreate = useRef(createSignal);
  useEffect(() => {
    if (createSignal === handledCreate.current) return;
    handledCreate.current = createSignal;
    if (!busy) { setDialogError(''); setSkillOpen(true); }
  }, [createSignal]);

  async function reloadSkills() {
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
      const notes: string[] = [];
      const conflicts: string[] = [];
      for (const target of targets) {
        const name = tools.find((tool) => tool.id === target.toolId)?.name ?? target.toolId;
        const preview = await native.previewSkillTarget(item.id, target.toolId, target.scope, target.projectPath);
        if (preview?.status === 'conflict') { conflicts.push(name); continue; }
        const outcome = await native.installSkill(item.id, target.toolId, target.scope, target.projectPath, preview?.previewToken ?? null, false);
        notes.push(t('library.resources.syncEntry', { name, result: outcome.status === 'failed' ? outcome.detail : t('library.resources.synced') }));
      }
      await reloadSkills();
      const failed = notes.filter((line) => !line.endsWith(t('library.resources.synced')));
      if (conflicts.length) {
        setSkillSeed([]);
        setSkillTarget(item);
        setNotice(t('library.resources.conflictsNotice', { names: conflicts.join('、') }));
      } else if (failed.length) setError(failed.join(t('tools.quota.errorSeparator')));
      else setNotice(notes.join(t('tools.quota.errorSeparator')) || t('library.resources.syncedAll'));
      if (!failed.length) setError('');
      return;
    }
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
    try {
      const source = await pickPath({ directory: true, multiple: false, title: t('tools.skills.pickDirTitle') });
      if (typeof source !== 'string') return;
      setBusy(true); setDialogError('');
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
    const placed = installations.some((entry) => entry.packageId === item.id);
    const message = placed ? t('library.resources.confirmDeletePlaced', { name: item.name }) : t('library.resources.confirmDelete', { name: item.name });
    if (busy || !await confirmAction(message, () => true, { title: t('library.resources.deleteSkillTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteSkillPackage(item.id);
      await reloadSkills();
      setNotice(t('library.resources.removed'));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function toggleSkill(item: SkillPackage, toolId: string, scope: Scope, projectPath: string | null, contextId: string | null) {
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

  return <div className={styles.layout}>
    <SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.resources.searchSkillPlaceholder')} />
    <div className={styles.list} aria-label={t('library.resources.skillListAria')}>
      {libraryPackages.length ? libraryPackages.map((item) => {
        return <article className={styles.card} key={item.id}>
          <div className={styles.cardHead}>
            <button className={styles.cardTitle} type="button" onClick={() => { setSkillSeed([]); setSkillTarget(item); }}>{item.name}</button>
            <span className={styles.badge}>{t('tools.skills.fileCount', { count: item.fileCount })}</span>
          </div>
          <p>{item.description || t('library.resources.fullPackage')}</p>
          <div className={styles.cardBar}>
            <ScopeMarks contextLabel={contextLabel} accountContexts label={t('library.page.cliMarks', { title: item.name })} tools={tools} places={installations.filter((entry) => entry.packageId === item.id)} projects={projects} busy={busy} onToggle={(toolId, scope, projectPath, contextId) => void toggleSkill(item, toolId, scope, projectPath, contextId)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: t('tools.skills.stateNotInstalled') };
              if (place.state === 'current') return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
              if (place.state === 'conflict' || place.state === 'update_available') return { pressed: true, state: 'drifted', status: installStateLabel(place.state) };
              return { pressed: true, state: 'unavailable', status: installStateLabel(place.state) };
            }} />
            <div className={styles.cardActions}><button type="button" className={styles.dangerQuiet} disabled={busy} onClick={() => void removePackage(item)}>{t('tools.agents.delete')}</button><button type="button" className={styles.quiet} disabled={busy} onClick={() => { setSkillSeed([]); setSkillTarget(item); }}>{t('tools.workspace.edit')}</button></div>
          </div>
        </article>;
      }) : needle
        ? <div className={styles.empty}><Icon name="search" size={24} />{t('library.resources.noSkillMatch', { query: search.trim() })}</div>
        : <div className={styles.empty}><Icon name="sparkle" size={24} /><strong>{t('library.resources.emptySkillTitle')}</strong>{t('library.resources.emptySkillDetail')}<button type="button" disabled={busy} onClick={() => { setDialogError(''); setSkillOpen(true); }}><Icon name="plus" size={14} />{t('tools.skills.add')}</button></div>}
    </div>
    <GuideDialog open={skillOpen} title={t('tools.skills.add')} hint={t('library.resources.addSkillHint')} onClose={closeSkill}>
      <div className={styles.skillAdd}>
        {!archiveSelection && !pendingImport && <>
          <section className={styles.skillSection}>
            <h3>{t('library.resources.installAfterImport')}</h3>
            <p>{t('library.resources.installAfterHint')}</p>
            <CliTargetGrid tools={tools} selected={installTools} onToggle={(id, checked) => setInstallTools(checked ? [...installTools, id] : installTools.filter((item) => item !== id))} />
          </section>
          <section className={styles.skillSection}>
            <h3>{t('library.resources.importFrom')}</h3>
            <div className={styles.sources}>
              <button type="button" aria-label={t('tools.skills.pickFolder')} disabled={busy} onClick={() => void addFolder()}><Icon name="folder" size={18} /><strong>{t('tools.skills.pickFolder')}</strong><span>{t('tools.skills.pickFolderHint')}</span></button>
              <button type="button" aria-label={t('tools.skills.importZip')} disabled={busy} onClick={() => void addZip()}><Icon name="archive" size={18} /><strong>{t('tools.skills.importZip')}</strong><span>{t('tools.skills.importZipHint')}</span></button>
            </div>
            <label>{t('tools.skills.zipUrl')}<span className={styles.urlRow}><input aria-label={t('tools.skills.zipUrlAria')} value={skillUrl} onChange={(event) => setSkillUrl(event.target.value)} placeholder="https://example.com/skill.zip" /><button type="button" disabled={busy || !skillUrl.trim()} onClick={() => void addArchive(skillUrl.trim(), false)}>{t('tools.skills.importUrl')}</button></span></label>
          </section>
        </>}
        {archiveSelection && <section className={styles.skillSection}>
          <h3>{t('library.resources.archiveMultiTitle')}</h3>
          <label>{t('library.resources.archiveChoose')}<select aria-label={t('tools.skills.archiveAria')} value={archiveSelection.chosen ?? '__choose__'} onChange={(event) => setArchiveSelection({ ...archiveSelection, chosen: event.target.value === '__choose__' ? null : event.target.value })}><option value="__choose__">{t('tools.skills.archivePlaceholder')}</option>{archiveSelection.entries.map((entry) => <option key={entry} value={entry}>{entry || t('tools.skills.archiveRoot')}</option>)}</select></label>
          <div className={styles.actions}><button type="button" onClick={() => setArchiveSelection(null)}>{t('library.resources.back')}</button><button type="button" className={styles.primary} disabled={busy || archiveSelection.chosen === null} onClick={() => void addArchive(archiveSelection.source, archiveSelection.local, archiveSelection.chosen ?? undefined)}>{t('tools.skills.archiveImport')}</button></div>
        </section>}
        {pendingImport && <section className={styles.skillSection} role="group" aria-label={t('tools.skills.importLabel')}>
          <h3>{t('library.resources.existingTitle', { name: pendingImport.preview.name })}</h3>
          <p>{t('library.resources.existingNote', { source: pendingImport.preview.source, count: pendingImport.preview.fileCount, install: installTools.length ? t('library.resources.existingInstall') : '' })}</p>
          <div className={styles.actions}><button type="button" onClick={() => setPendingImport(null)}>{t('library.resources.back')}</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void confirmSkillImport()}>{installations.some((entry) => packages.some((item) => item.id === entry.packageId && item.name === pendingImport.preview.name)) ? t('library.resources.updateAndSync') : t('library.resources.confirmUpdate')}</button></div>
        </section>}
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
      </div>
    </GuideDialog>
    <GuideDialog open={!!skillTarget} title={t('library.resources.editSkillTitle')} hint={t('library.resources.editSkillHint')} onClose={() => { setSkillTarget(null); setSkillSeed([]); }}>
      {skillTarget && <SkillDistribution item={skillTarget} tools={tools} projects={projects} installations={installations} initialTools={skillSeed} autoRun={skillSeed.length > 0} onChanged={reloadSkills} />}
    </GuideDialog>
  </div>;
}
