import { useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { GuideDialog } from '../../components/GuideDialog';
import { modLabel } from '../../lib/shortcut';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { Project } from '../../types/launch';

export function NativeRuleEditor({ tools, projects }: { tools: AdapterDescriptor[]; projects: Project[] }) {
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
    setFailure(detail ? `${summary}：${detail}。${next}` : `${summary}。${next}`);
  }
  async function change(action: () => void) {
    const started = latest.current;
    if (!dirty || await confirmAction('规则有未保存修改，切换后放弃这些修改？', () => isCurrent(started), { title: '放弃未保存修改？', confirmLabel: '放弃修改' })) action();
  }
  useEffect(() => {
    setLoaded(null); setText(''); setConflict(null); clearResult();
    if (!tool || scope === 'project' && !project) return;
    let live = true;
    void native.readNativeRule(target).then(value => { if (live) { setLoaded(value); setText(value.text); setEnabled(!!value.text); } }).catch(value => { if (live) showFailure(value, '规则读取失败', '可以重新选择工具或范围。'); });
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
      setFailure(''); setStatus('规则已保存。'); setOpen(false);
    } catch (value) {
      if (latest.current.context !== started.context) return;
      showFailure(value, '规则保存失败', '可以修改后再次点击保存规则。');
      const current = await native.readNativeRule(target).catch(() => null);
      if (latest.current.context === started.context && current && current.text !== original) setConflict(current.text);
    } finally { setBusy(false); }
  }
  async function toggle(next: boolean) {
    const snapshot = latest.current;
    if (dirty && !await confirmAction('切换规则前放弃未保存修改？', () => isCurrent(snapshot), { title: '放弃未保存修改？', confirmLabel: '放弃修改' })) return;
    const started=latest.current.context;setBusy(true);clearResult();
    try { await native.setNativeRuleEnabled({ ...target, contextId: loaded?.contextId },next); const value=await native.readNativeRule(target); if(latest.current.context===started){setLoaded(value);setText(value.text);setEnabled(!!value.text);} }
    catch(value){if(latest.current.context===started)showFailure(value,'规则切换失败','可以再次切换启用规则。');}finally{setBusy(false);}
  }
  return <>
    <button type="button" className="button native-rule-open" onClick={() => setOpen(true)}>修改当前 CLI 规则</button>
    {status && !open && <p className="native-rule-message" role="status">{status}</p>}
    <GuideDialog open={open} title="修改当前 CLI 规则" hint="选择工具和范围，改完后保存。保存会写入这个 CLI 正在读取的规则文件。" onClose={() => { void change(() => setOpen(false)); }}>
    <div className="native-rule-editor">
    <div className="native-rule-controls"><label>工具<select aria-label="规则工具" value={tool} onChange={event => { const value = event.target.value; void change(() => setTool(value)); }}>{tools.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>范围<select aria-label="规则范围" value={scope} onChange={event => { const value = event.target.value as Scope; void change(() => setScope(value)); }}><option value="global">全局</option><option value="project">项目</option></select></label>
      {scope === 'project' && <label>项目<select aria-label="规则项目" value={project} onChange={event => { const value = event.target.value; void change(() => setProject(value)); }}><option value="">选择项目…</option>{projects.filter(item => item.available && item.path).map(item => <option key={item.id} value={item.path!}>{item.name}</option>)}</select></label>}</div>
    {loaded && <><label className="native-rule-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => void toggle(event.target.checked)} />启用规则</label><p className="native-rule-path" title={loaded.path}><strong>{loaded.path.split(/[\\/]/).pop()}</strong><small>{loaded.path}</small></p><CodeEditor label="当前原生规则" value={text} onChange={setText} format="markdown" /><div className="native-rule-actions"><span>{dirty ? '未保存' : ''}</span><button type="button" className="button primary" data-dialog-save title={`保存规则（${modLabel}+S）`} disabled={busy || !dirty} onClick={() => void save()}>保存规则</button></div></>}
    {conflict !== null && <ConflictCompare title="规则文件" banner="文件已在其他地方修改。请选择要保存的内容。" currentContent={conflict} nextContent={text} format="markdown" busy={busy} onKeepCurrent={() => { setLoaded(old => old ? { ...old, text: conflict } : old); setText(conflict); setConflict(null); }} onUseNext={() => void save(conflict)} />}
    {failure && <p className="native-rule-message" role="alert" style={{ color: 'var(--danger)', borderColor: 'var(--danger-line)', background: 'var(--danger-soft)' }}>{failure}</p>}
    {status && <p className="native-rule-message" role="status">{status}</p>}
    </div>
    </GuideDialog>
  </>;
}
