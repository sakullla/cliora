import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { GuideDialog } from '../../components/GuideDialog';
import { modLabel } from '../../lib/shortcut';
import { Button } from '../../components/ui';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { NativeRuleFile } from '../../types/resources';
import type { Project } from '../../types/launch';

export function NativeRuleEditor({ tools, projects }: { tools: AdapterDescriptor[]; projects: Project[] }) {
  const { t } = useTranslation();
  const [tool, setTool] = useState(tools[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>('global');
  const [project, setProject] = useState('');
  const [loaded, setLoaded] = useState<{ contextId?: string | null; path: string; text: string } | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<NativeRuleFile[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [createName, setCreateName] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  const descriptor = tools.find(item => item.id === tool);
  const catalog = !!descriptor?.management?.rules?.catalog && scope === 'project';
  const context = JSON.stringify([tool, scope, project, catalog]);
  const latest = useRef({ context, text }); latest.current = { context, text };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function isCurrent(started: typeof latest.current) { return mounted.current && latest.current.context === started.context && latest.current.text === started.text; }
  const target = { toolId: tool, scope, projectPath: scope === 'project' ? project || null : null };
  const selected = files.find(file => file.id === selectedId) ?? null;
  const dirty = catalog ? !!selected && text !== selected.text : !!loaded && text !== loaded.text;
  const errorText = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : String(value);
  function clearResult() { setStatus(''); setFailure(''); }
  function showFailure(value: unknown, summary: string, next: string) {
    const detail = errorText(value).trim().replace(/[。！？\s]+$/, '');
    setStatus('');
    setFailure(detail ? t('library.nativeRule.failureDetail', { summary, detail, next }) : t('library.nativeRule.failure', { summary, next }));
  }
  async function change(action: () => void) {
    const started = latest.current;
    if (!dirty || await confirmAction(t('library.nativeRule.confirmDiscard'), () => isCurrent(started), { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') })) action();
  }
  useEffect(() => {
    setLoaded(null); setText(''); setFiles([]); setSelectedId(''); setConflict(null); clearResult();
    if (!tool || scope === 'project' && !project) return;
    let live = true;
    if (catalog) {
      void native.listNativeRuleFiles(target).then(value => {
        if (!live) return;
        setFiles(value);
        const first = value[0];
        setSelectedId(first?.id ?? '');
        setText(first?.text ?? '');
      }).catch(value => { if (live) showFailure(value, t('library.nativeRule.readFailed'), t('library.nativeRule.readFailedNext')); });
    } else {
      void native.readNativeRule(target).then(value => { if (live) { setLoaded(value); setText(value.text); setEnabled(!!value.text); } }).catch(value => { if (live) showFailure(value, t('library.nativeRule.readFailed'), t('library.nativeRule.readFailedNext')); });
    }
    return () => { live = false; };
  }, [context]);
  function chooseFile(id: string) {
    const file = files.find(item => item.id === id);
    void change(() => { setSelectedId(id); setText(file?.text ?? ''); setConflict(null); });
  }
  async function reloadFiles(preferId?: string) {
    const value = await native.listNativeRuleFiles(target);
    setFiles(value);
    const next = value.find(file => file.id === (preferId || selectedId)) ?? value[0];
    setSelectedId(next?.id ?? '');
    setText(next?.text ?? '');
    return next;
  }
  async function save(original = catalog ? selected?.text : loaded?.text) {
    if (original === undefined) return;
    const started = { ...latest.current }; setBusy(true); clearResult();
    try {
      if (catalog) {
        if (!selected) return;
        await native.saveNativeRuleFile({ ...target, contextId: loaded?.contextId }, selected.path, original, started.text);
      } else {
        await native.saveNativeRule({ ...target, contextId: loaded?.contextId }, original, started.text);
      }
      if (latest.current.context !== started.context) return;
      if (catalog) {
        const current = await reloadFiles(selected?.id);
        if (latest.current.text === started.text && current) setText(current.text);
      } else {
        const current = await native.readNativeRule(target);
        if (latest.current.context !== started.context) return;
        setLoaded(current); setEnabled(!!current.text); if (latest.current.text === started.text) { setText(current.text); setConflict(null); }
      }
      setConflict(null);
      setFailure(''); setStatus(t('library.nativeRule.saved')); setOpen(false);
    } catch (value) {
      if (latest.current.context !== started.context) return;
      showFailure(value, t('library.nativeRule.saveFailed'), t('library.nativeRule.saveFailedNext'));
      if (catalog && selected) {
        const current = await native.listNativeRuleFiles(target).catch(() => null);
        const fresh = current?.find(file => file.id === selected.id);
        if (latest.current.context === started.context && fresh && fresh.text !== original) setConflict(fresh.text);
      } else {
        const current = await native.readNativeRule(target).catch(() => null);
        if (latest.current.context === started.context && current && current.text !== original) setConflict(current.text);
      }
    } finally { setBusy(false); }
  }
  async function toggle(next: boolean) {
    const snapshot = latest.current;
    if (dirty && !await confirmAction(t('library.nativeRule.confirmToggle'), () => isCurrent(snapshot), { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') })) return;
    const started = latest.current.context; setBusy(true); clearResult();
    try {
      if (catalog) {
        if (!selected || selected.kind !== 'mdc') return;
        await native.setNativeRuleFileEnabled({ ...target }, selected.path, next, selected.text);
        if (latest.current.context === started) await reloadFiles();
      } else {
        await native.setNativeRuleEnabled({ ...target, contextId: loaded?.contextId }, next);
        const value = await native.readNativeRule(target);
        if (latest.current.context === started) { setLoaded(value); setText(value.text); setEnabled(!!value.text); }
      }
    }
    catch (value) { if (latest.current.context === started) showFailure(value, t('library.nativeRule.toggleFailed'), t('library.nativeRule.toggleFailedNext')); }
    finally { setBusy(false); }
  }
  async function createRule() {
    const name = createName.trim();
    if (!name) return;
    setBusy(true); clearResult();
    try {
      await native.createNativeRuleFile(target, name, '');
      setCreateName('');
      const value = await native.listNativeRuleFiles(target);
      // Rule names cannot contain dots, so the stem identifies the new file
      // under whichever extension the current tool uses (.mdc, .md, …).
      const created = value.find(file => file.name === name || file.name.startsWith(`${name}.`)) ?? value[0];
      setFiles(value);
      setSelectedId(created?.id ?? '');
      setText(created?.text ?? '');
      setStatus(t('library.nativeRule.saved'));
    } catch (value) {
      showFailure(value, t('library.nativeRule.saveFailed'), t('library.nativeRule.saveFailedNext'));
    } finally { setBusy(false); }
  }
  async function removeRule() {
    if (!selected || selected.kind !== 'mdc') return;
    if (!await confirmAction(t('library.nativeRule.confirmDelete', { name: selected.name }))) return;
    setBusy(true); clearResult();
    try {
      await native.deleteNativeRuleFile(target, selected.path, selected.text);
      await reloadFiles();
      setStatus(t('library.nativeRule.deleted'));
    } catch (value) {
      showFailure(value, t('library.nativeRule.saveFailed'), t('library.nativeRule.saveFailedNext'));
    } finally { setBusy(false); }
  }
  const kindLabel = (kind: string) => kind === 'mdc' ? t('library.nativeRule.kindMdc')
    : kind === 'md' ? t('library.nativeRule.kindMd')
    : kind === 'permissions' ? t('library.nativeRule.kindPermissions')
    : kind === 'agents' ? t('library.nativeRule.kindAgents')
    : t('library.nativeRule.kindInert');
  return <>
    <Button className="native-rule-open" onClick={() => setOpen(true)}>{t('library.nativeRule.open')}</Button>
    {status && !open && <p className="native-rule-message" role="status">{status}</p>}
    <GuideDialog open={open} title={t('library.nativeRule.open')} hint={catalog ? t('library.nativeRule.catalogHint') : t('library.nativeRule.hint')} onClose={() => { void change(() => setOpen(false)); }}>
    <div className="native-rule-editor">
    <div className="native-rule-controls"><label>{t('library.nativeRule.tool')}<select aria-label={t('library.nativeRule.toolAria')} value={tool} onChange={event => { const value = event.target.value; void change(() => setTool(value)); }}>{tools.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>{t('library.nativeRule.scope')}<select aria-label={t('library.nativeRule.scopeAria')} value={scope} onChange={event => { const value = event.target.value as Scope; void change(() => setScope(value)); }}><option value="global">{t('tools.apply.global')}</option><option value="project">{t('tools.accounts.scopeProject')}</option></select></label>
      {scope === 'project' && <label>{t('library.nativeRule.project')}<select aria-label={t('library.nativeRule.projectAria')} value={project} onChange={event => { const value = event.target.value; void change(() => setProject(value)); }}><option value="">{t('library.distribute.projectPlaceholder')}</option>{projects.filter(item => item.available && item.path).map(item => <option key={item.id} value={item.path!}>{item.name}</option>)}</select></label>}</div>
    {catalog && <div className="native-rule-controls"><label>{t('library.nativeRule.file')}<select aria-label={t('library.nativeRule.fileAria')} value={selectedId} onChange={event => chooseFile(event.target.value)}><option value="">{files.length ? t('library.nativeRule.pickFile') : t('library.nativeRule.emptyCatalog')}</option>{files.map(file => <option key={file.id} value={file.id}>{file.name} · {kindLabel(file.kind)}</option>)}</select></label>
      <label>{t('library.nativeRule.createName')}<input aria-label={t('library.nativeRule.createName')} value={createName} placeholder={t('library.nativeRule.createPlaceholder')} onChange={event => setCreateName(event.target.value)} /></label>
      <Button disabled={busy || !project || !createName.trim()} onClick={() => void createRule()}>{t('library.nativeRule.create')}</Button></div>}
    {catalog && selected && <>
      {selected.kind === 'mdc' && <label className="native-rule-enabled"><input type="checkbox" checked={selected.enabled} disabled={busy} onChange={event => void toggle(event.target.checked)} />{t('library.nativeRule.enable')}</label>}
      {selected.detail && <p className="native-rule-message" role="status">{selected.detail}</p>}
      {selected.kind === 'agents' && <p className="native-rule-message">{t('library.nativeRule.agentsNote')}</p>}
      <p className="native-rule-path" title={selected.path}><strong>{selected.name}</strong><small>{selected.path}</small></p>
      <CodeEditor label={t('library.nativeRule.editorLabel')} value={text} onChange={setText} format="markdown" readOnly={!selected.writable || busy} />
      <div className="native-rule-actions"><span>{dirty ? t('library.nativeRule.unsaved') : ''}</span>{selected.kind === 'mdc' && <Button disabled={busy} onClick={() => void removeRule()}>{t('library.nativeRule.delete')}</Button>}<Button variant="primary" data-dialog-save title={t('library.nativeRule.saveTitle', { mod: modLabel })} disabled={busy || !dirty || !selected.writable} onClick={() => void save()}>{t('library.nativeRule.save')}</Button></div>
    </>}
    {!catalog && loaded && <><label className="native-rule-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => void toggle(event.target.checked)} />{t('library.nativeRule.enable')}</label><p className="native-rule-path" title={loaded.path}><strong>{loaded.path.split(/[\\/]/).pop()}</strong><small>{loaded.path}</small></p><CodeEditor label={t('library.nativeRule.editorLabel')} value={text} onChange={setText} format="markdown" /><div className="native-rule-actions"><span>{dirty ? t('library.nativeRule.unsaved') : ''}</span><Button variant="primary" data-dialog-save title={t('library.nativeRule.saveTitle', { mod: modLabel })} disabled={busy || !dirty} onClick={() => void save()}>{t('library.nativeRule.save')}</Button></div></>}
    {conflict !== null && <ConflictCompare title={t('library.nativeRule.conflictTitle')} banner={t('home.conflict.banner')} currentContent={conflict} nextContent={text} format="markdown" busy={busy} onKeepCurrent={() => { if (catalog && selected) { setFiles(old => old.map(file => file.id === selected.id ? { ...file, text: conflict } : file)); setText(conflict); } else { setLoaded(old => old ? { ...old, text: conflict } : old); setText(conflict); } setConflict(null); }} onUseNext={() => void save(conflict)} />}
    {failure && <p className="native-rule-message" role="alert" data-tone="error">{failure}</p>}
    {status && <p className="native-rule-message" role="status">{status}</p>}
    </div>
    </GuideDialog>
  </>;
}
