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
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpPlacement, McpTargetRequest, SkillImportPreview, SkillInstallation, SkillPackage } from '../../types/resources';
import { McpDistribution, type McpDistributeHandle } from './McpDistribution';
import { SkillDistribution } from './SkillDistribution';
import i18n from '../../i18n';
import styles from './LibraryPage.module.css';

function blank(): McpDraft {
  return { id: null, name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, inLibrary: true, expectedVersion: null };
}
function draftOf(item: McpDefinition): McpDraft {
  return { id: item.id, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url, env: item.env, headers: item.headers, inLibrary: item.inLibrary !== false, expectedVersion: item.version };
}
function lines(value: Record<string, string>): string {
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join('\n');
}
function keptArgs(args: string[]) {
  return args.map((item) => item.trim()).filter((item) => item.length > 0);
}
function parseLines(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const equals = line.indexOf('=');
    if (equals < 1) throw new Error(i18n.t('tools.mcp.parseError'));
    output[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return output;
}
function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('tools.workspace.operationFailed');
}

function installStateLabel(state: SkillInstallation['state']): string {
  return i18n.t(`library.resources.installState.${state}`);
}

export function LibraryResources({ section, active, tools, projects, createSignal = 0 }: { section: 'mcp' | 'skill'; active: boolean; tools: AdapterDescriptor[]; projects: Project[]; createSignal?: number }) {
  const { t } = useTranslation();
  const contextLabel = useAccountLabels();
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [placements, setPlacements] = useState<McpPlacement[]>([]);
  const [willDistribute, setWillDistribute] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const distributeRef = useRef<McpDistributeHandle>(null);
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [dialogError, setDialogError] = useState('');
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillUrl, setSkillUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null } | null>(null);
  const [skillTarget, setSkillTarget] = useState<SkillPackage | null>(null);
  const [skillSeed, setSkillSeed] = useState<string[]>([]);
  const [installTools, setInstallTools] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  useEffect(() => { setSearch(''); }, [section]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = section === 'mcp'
      ? Promise.all([native.listMcpDefinitions(), native.listMcpPlacements()]).then(([items, placed]) => { if (live) { setDefinitions(items); setPlacements(placed); } })
      : native.listSkillPackages().then(async (items) => {
        if (!live) return;
        setPackages(items);
        const found = (await Promise.all(items.map((item) => native.listSkillInstallations(item.id)))).flat();
        if (live) setInstallations(found);
      });
    void load.catch((value) => { if (live) setError(failure(value)); });
    return () => { live = false; };
  }, [active, section]);

  function editMcp(item?: McpDefinition) {
    const next = item ? draftOf(item) : blank();
    setDraft(next);
    setEnvText(item ? lines(item.env) : '');
    setHeaderText(item ? lines(item.headers) : '');
    setDialogError('');
    setWillDistribute(false);
    setConflict(false);
    setFormKey((value) => value + 1);
  }

  const handledCreate = useRef(createSignal);
  useEffect(() => {
    if (createSignal === handledCreate.current) return;
    handledCreate.current = createSignal;
    if (section === 'mcp') editMcp();
    else if (!busy) { setDialogError(''); setSkillOpen(true); }
  }, [createSignal]);

  async function remove(item: McpDefinition) {
    if (busy || !await confirmAction(t('library.resources.confirmRemoveMcp', { name: item.name }), () => true, { title: t('tools.mcp.removeTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteMcpDefinition(item.id, item.version);
      setDefinitions(await native.listMcpDefinitions());
      setDraft(null);
      setNotice(t('library.resources.removed'));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

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

  async function save() {
    if (!draft || busy) return;
    setBusy(true); setDialogError('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, args: keptArgs(draft.args), inLibrary: true, env: parseLines(envText), headers: parseLines(headerText) });
      setDefinitions(await native.listMcpDefinitions());
      setDraft(draftOf(saved));
      const alreadyPlaced = placements.some((item) => item.definitionId === saved.id);
      if (willDistribute || alreadyPlaced) {
        const outcome = await distributeRef.current?.run(saved);
        setPlacements(await native.listMcpPlacements().catch(() => []));
        if (outcome?.status === 'written') { setConflict(false); setDialogError(''); setDraft(null); setNotice(outcome.notice); }
        else if (outcome?.status === 'pending') setConflict(true);
        else {
          setConflict(false);
          setDialogError(outcome?.status === 'failed' ? outcome.message : t('library.resources.savedNotDistributed'));
        }
      } else {
        setPlacements(await native.listMcpPlacements().catch(() => []));
        setDraft(null);
        setNotice(t('library.resources.saved'));
      }
      setError('');
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function replaceDistribution() {
    if (busy) return;
    setBusy(true); setDialogError('');
    try {
      const outcome = await distributeRef.current?.commit();
      setPlacements(await native.listMcpPlacements().catch(() => []));
      if (outcome?.status === 'written') { setConflict(false); setDraft(null); setNotice(outcome.notice); setError(''); }
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function toggleMcp(item: McpDefinition, toolId: string, scope: Scope, projectPath: string | null, contextId: string | null) {
    if (busy) return;
    const toolName = tools.find((tool) => tool.id === toolId)?.name ?? toolId;
    const where = scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(scope, projectPath, projects) }) : '';
    const place = placements.find((entry) => entry.definitionId === item.id && entry.toolId === toolId && entry.scope === scope && (entry.contextId ?? null) === contextId && (scope === 'global' || samePath(entry.projectPath, projectPath)));
    setBusy(true); setError(''); setNotice('');
    try {
      if (place) {
        await native.removeNativeMcp({ toolId, scope, projectPath: place.projectPath, contextId: await removalContext(place), enabled: place.enabled }, item.name);
        setNotice(t('library.page.removed', { where, tool: toolName }));
      } else {
        const target: McpTargetRequest = { toolId, scope, projectPath, enabled: true };
        const preview = await native.previewMcpTargets(item.id, [target]);
        const first = preview[0];
        if (!first || (first.status !== 'ready' && first.status !== 'conflict')) { setError(first?.detail || t('library.resources.cannotWrite', { tool: toolName })); return; }
        if (first.status === 'conflict' && !await confirmAction(t('library.resources.confirmReplace', { name: item.name, tool: toolName }), () => true, { title: t('library.resources.replaceMcpTitle'), confirmLabel: t('library.page.replaceAction') })) return;
        await native.distributeMcp(item.id, [{ ...target, contextId: first.contextId, baselineHash: first.baselineHash, previewToken: first.previewToken, allowReplace: first.status === 'conflict' }]);
        setNotice(t('library.page.written', { where, tool: toolName }));
      }
      setPlacements(await native.listMcpPlacements().catch(() => placements));
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
  const libraryDefinitions = definitions.filter((item) => item.inLibrary !== false)
    .filter((item) => !needle || `${item.name} ${item.command} ${item.args.join(' ')} ${item.url ?? ''}`.toLowerCase().includes(needle));
  const libraryPackages = packages.filter((item) => item.inLibrary !== false)
    .filter((item) => !needle || `${item.name} ${item.description ?? ''}`.toLowerCase().includes(needle));

  if (section === 'skill') {
    return <div className={styles.layout}>
      <SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.resources.searchSkillPlaceholder')} />
      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
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
          ? <div className={styles.empty}><Icon name="search" size={28} strokeWidth={1.3} />{t('library.resources.noSkillMatch', { query: search.trim() })}</div>
          : <div className={styles.empty}><Icon name="sparkle" size={28} strokeWidth={1.3} /><strong>{t('library.resources.emptySkillTitle')}</strong>{t('library.resources.emptySkillDetail')}<button type="button" disabled={busy} onClick={() => { setDialogError(''); setSkillOpen(true); }}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.skills.add')}</button></div>}
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
                <button type="button" aria-label={t('tools.skills.pickFolder')} disabled={busy} onClick={() => void addFolder()}><Icon name="folder" size={17} /><strong>{t('tools.skills.pickFolder')}</strong><span>{t('tools.skills.pickFolderHint')}</span></button>
                <button type="button" aria-label={t('tools.skills.importZip')} disabled={busy} onClick={() => void addZip()}><Icon name="archive" size={17} /><strong>{t('tools.skills.importZip')}</strong><span>{t('tools.skills.importZipHint')}</span></button>
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

  return <div className={styles.layout}>
    <SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.resources.searchMcpPlaceholder')} />
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <div className={styles.list} aria-label={t('library.resources.mcpListAria')}>
      {libraryDefinitions.length ? libraryDefinitions.map((item) => {
        return <article className={styles.card} key={item.id}>
          <div className={styles.cardHead}>
            <button className={styles.cardTitle} type="button" onClick={() => editMcp(item)}>{item.name}</button>
            <span className={styles.badge} data-accent={item.transport === 'http' || undefined}>{item.transport === 'http' ? 'HTTP' : 'stdio'}</span>
          </div>
          <p className={styles.mono}>{item.transport === 'http' ? item.url || t('library.resources.noUrl') : [item.command, ...item.args].filter(Boolean).join(' ') || t('library.resources.noCommand')}</p>
          <div className={styles.cardBar}>
            <ScopeMarks contextLabel={contextLabel} accountContexts label={t('library.page.cliMarks', { title: item.name })} tools={tools} places={placements.filter((entry) => entry.definitionId === item.id)} projects={projects} busy={busy} onToggle={(toolId, scope, projectPath, contextId) => void toggleMcp(item, toolId, scope, projectPath, contextId)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: t('library.page.markOff') };
              if (!place.enabled) return { pressed: true, state: 'unavailable', status: t('library.resources.markDisabled') };
              return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
            }} />
            <div className={styles.cardActions}><button type="button" className={styles.dangerQuiet} disabled={busy} onClick={() => void remove(item)}>{t('tools.agents.delete')}</button><button type="button" className={styles.quiet} onClick={() => editMcp(item)}>{t('tools.workspace.edit')}</button></div>
          </div>
        </article>;
      }) : needle
        ? <div className={styles.empty}><Icon name="search" size={28} strokeWidth={1.3} />{t('library.resources.noMcpMatch', { query: search.trim() })}</div>
        : <div className={styles.empty}><Icon name="connections" size={28} strokeWidth={1.3} /><strong>{t('library.resources.emptyMcpTitle')}</strong>{t('library.resources.emptyMcpDetail')}<button type="button" onClick={() => editMcp()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('library.resources.emptyMcpCreate')}</button></div>}
    </div>
    <GuideDialog open={!!draft} title={draft?.id ? t('tools.mcp.editTitle') : t('library.resources.newMcpTitle')} hint={t('library.resources.mcpDialogHint')} onClose={() => { setDraft(null); setConflict(false); }}>
      {draft && <>
        <div className={styles.fields}>
          <label className={styles.span}>{t('tools.mcp.name')}<input aria-label={t('tools.mcp.nameAria')} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('tools.mcp.namePlaceholder')} /></label>
          <div className={`${styles.typeField} ${styles.span}`}><span>{t('tools.mcp.type')}</span><div className={styles.typeSwitch} role="radiogroup" aria-label={t('tools.mcp.transport')}>{([['http', 'HTTP'], ['stdio', 'stdio']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.transport === value} onClick={() => setDraft({ ...draft, transport: value })}>{label}</button>)}</div></div>
          {draft.transport === 'stdio' ? <>
            <label className={styles.span}>{t('tools.mcp.command')}<input aria-label={t('tools.mcp.command')} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
            <label className={styles.span}>{t('tools.mcp.args')}<textarea rows={3} value={draft.args.join('\n')} onChange={(event) => setDraft({ ...draft, args: event.target.value.split(/\r?\n/) })} placeholder={'-y\nchrome-devtools-mcp@latest'} /></label>
            <label className={styles.span}>{t('tools.mcp.env')}<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'KEY=value\nAPI_TOKEN=${API_TOKEN}'} /></label>
          </> : <>
            <label className={styles.span}>URL<input aria-label={t('tools.mcp.urlAria')} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
            <label className={styles.span}>{t('tools.mcp.headers')}<textarea rows={4} value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization=Bearer ${API_TOKEN}" /></label>
          </>}
        </div>
        <McpDistribution key={formKey} ref={distributeRef} definition={definitions.find((item) => item.id === draft.id) ?? { ...draft, id: draft.id ?? '', version: draft.expectedVersion ?? 0 }} tools={tools} projects={projects} placements={placements} formStamp={JSON.stringify([draft.name, draft.transport, draft.command, draft.args, draft.url, envText, headerText])} onWillDistribute={setWillDistribute} onConflictChange={setConflict} />
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
        <div className="dialog-footer">{draft.id && <button type="button" disabled={busy} onClick={() => { const current = definitions.find((item) => item.id === draft.id); if (current) void remove(current); }}>{t('tools.agents.delete')}</button>}<span className="dialog-footer-gap" />{conflict && <button type="button" disabled={busy} onClick={() => { setConflict(false); distributeRef.current?.dismiss(); }}>{t('common.conflict.keepCurrent')}</button>}<button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.name.trim()} onClick={() => void (conflict ? replaceDistribution() : save())}>{conflict ? t('library.resources.replaceDistribute') : willDistribute ? t('library.resources.saveDistribute') : t('home.launcher.save')}</button></div>
      </>}
    </GuideDialog>
  </div>;
}
