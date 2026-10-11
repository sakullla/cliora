import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { GuideDialog } from '../../components/GuideDialog';
import { modLabel } from '../../lib/shortcut';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { Project } from '../../types/launch';

export function NativeRuleEditor({ tools, projects }: { tools: AdapterDescriptor[]; projects: Project[] }) {
  const { t } = useTranslation();
  const [tool, setTool] = useState(tools[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>('global');
  const [project, setProject] = useState('');
  const [loaded, setLoaded] = useState<{ contextId?: string | null; path: string; text: string } | null>(null);
  const [text, setText] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  const context = JSON.stringify([tool, scope, project]);
  const latest = useRef({ context, text }); latest.current = { context, text };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function isCurrent(started: typeof latest.current) { return mounted.current && latest.current.context === started.context && latest.current.text === started.text; }
  const target = { toolId: tool, scope, projectPath: scope === 'project' ? project || null : null };
  const dirty = !!loaded && text !== loaded.text;
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
    setLoaded(null); setText(''); setConflict(null); clearResult();
    if (!tool || scope === 'project' && !project) return;
    let live = true;
    void native.readNativeRule(target).then(value => { if (live) { setLoaded(value); setText(value.text); setEnabled(!!value.text); } }).catch(value => { if (live) showFailure(value, t('library.nativeRule.readFailed'), t('library.nativeRule.readFailedNext')); });
    return () => { live = false; };
  }, [context]);
  async function save(original = loaded?.text) {
    if (original === undefined) return;
    const started = { ...latest.current }; setBusy(true); clearResult();
    try {
      await native.saveNativeRule({ ...target, contextId: loaded?.contextId }, original, started.text);
      if (latest.current.context !== started.context) return;
      const current = await native.readNativeRule(target);
      if (latest.current.context !== started.context) return;
      setLoaded(current); setEnabled(!!current.text); if (latest.current.text === started.text) { setText(current.text); setConflict(null); }
      setFailure(''); setStatus(t('library.nativeRule.saved')); setOpen(false);
    } catch (value) {
      if (latest.current.context !== started.context) return;
      showFailure(value, t('library.nativeRule.saveFailed'), t('library.nativeRule.saveFailedNext'));
      const current = await native.readNativeRule(target).catch(() => null);
      if (latest.current.context === started.context && current && current.text !== original) setConflict(current.text);
    } finally { setBusy(false); }
  }
  async function toggle(next: boolean) {
    const snapshot = latest.current;
    if (dirty && !await confirmAction(t('library.nativeRule.confirmToggle'), () => isCurrent(snapshot), { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') })) return;
    const started=latest.current.context;setBusy(true);clearResult();
    try { await native.setNativeRuleEnabled({ ...target, contextId: loaded?.contextId },next); const value=await native.readNativeRule(target); if(latest.current.context===started){setLoaded(value);setText(value.text);setEnabled(!!value.text);} }
    catch(value){if(latest.current.context===started)showFailure(value,t('library.nativeRule.toggleFailed'),t('library.nativeRule.toggleFailedNext'));}finally{setBusy(false);}
  }
  return <>
    <button type="button" className="button native-rule-open" onClick={() => setOpen(true)}>{t('library.nativeRule.open')}</button>
    {status && !open && <p className="native-rule-message" role="status">{status}</p>}
    <GuideDialog open={open} title={t('library.nativeRule.open')} hint={t('library.nativeRule.hint')} onClose={() => { void change(() => setOpen(false)); }}>
    <div className="native-rule-editor">
    <div className="native-rule-controls"><label>{t('library.nativeRule.tool')}<select aria-label={t('library.nativeRule.toolAria')} value={tool} onChange={event => { const value = event.target.value; void change(() => setTool(value)); }}>{tools.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>{t('library.nativeRule.scope')}<select aria-label={t('library.nativeRule.scopeAria')} value={scope} onChange={event => { const value = event.target.value as Scope; void change(() => setScope(value)); }}><option value="global">{t('tools.apply.global')}</option><option value="project">{t('tools.accounts.scopeProject')}</option></select></label>
      {scope === 'project' && <label>{t('library.nativeRule.project')}<select aria-label={t('library.nativeRule.projectAria')} value={project} onChange={event => { const value = event.target.value; void change(() => setProject(value)); }}><option value="">{t('library.distribute.projectPlaceholder')}</option>{projects.filter(item => item.available && item.path).map(item => <option key={item.id} value={item.path!}>{item.name}</option>)}</select></label>}</div>
    {loaded && <><label className="native-rule-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => void toggle(event.target.checked)} />{t('library.nativeRule.enable')}</label><p className="native-rule-path" title={loaded.path}><strong>{loaded.path.split(/[\\/]/).pop()}</strong><small>{loaded.path}</small></p><CodeEditor label={t('library.nativeRule.editorLabel')} value={text} onChange={setText} format="markdown" /><div className="native-rule-actions"><span>{dirty ? t('library.nativeRule.unsaved') : ''}</span><button type="button" className="button primary" data-dialog-save title={t('library.nativeRule.saveTitle', { mod: modLabel })} disabled={busy || !dirty} onClick={() => void save()}>{t('library.nativeRule.save')}</button></div></>}
    {conflict !== null && <ConflictCompare title={t('library.nativeRule.conflictTitle')} banner={t('home.conflict.banner')} currentContent={conflict} nextContent={text} format="markdown" busy={busy} onKeepCurrent={() => { setLoaded(old => old ? { ...old, text: conflict } : old); setText(conflict); setConflict(null); }} onUseNext={() => void save(conflict)} />}
    {failure && <p className="native-rule-message" role="alert" data-tone="error">{failure}</p>}
    {status && <p className="native-rule-message" role="status">{status}</p>}
    </div>
    </GuideDialog>
  </>;
}
