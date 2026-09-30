import { useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import { FileConflict } from '../../components/FileConflict';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { Project } from '../../types/launch';

export function NativeRuleEditor({ tools, projects }: { tools: AdapterDescriptor[]; projects: Project[] }) {
  const [tool, setTool] = useState(tools[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>('global');
  const [project, setProject] = useState('');
  const [loaded, setLoaded] = useState<{ path: string; text: string } | null>(null);
  const [text, setText] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const context = JSON.stringify([tool, scope, project]);
  const latest = useRef({ context, text }); latest.current = { context, text };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function isCurrent(started: typeof latest.current) { return mounted.current && latest.current.context === started.context && latest.current.text === started.text; }
  const target = { toolId: tool, scope, projectPath: scope === 'project' ? project || null : null };
  const dirty = !!loaded && text !== loaded.text;
  const errorText = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : String(value);
  async function change(action: () => void) {
    const started = latest.current;
    if (!dirty || await confirmAction('规则有未保存修改，切换后放弃这些修改？', () => isCurrent(started), { title: '放弃未保存修改？', confirmLabel: '放弃修改' })) action();
  }
  useEffect(() => {
    setLoaded(null); setText(''); setConflict(null); setMessage('');
    if (!tool || scope === 'project' && !project) return;
    let live = true;
    void native.readNativeRule(target).then(value => { if (live) { setLoaded(value); setText(value.text); setEnabled(!!value.text); } }).catch(value => { if (live) setMessage(errorText(value)); });
    return () => { live = false; };
  }, [context]);
  async function save(original = loaded?.text) {
    if (original === undefined) return;
    const started = { ...latest.current }; setBusy(true); setMessage('');
    try {
      await native.saveNativeRule(target, original, started.text);
      if (latest.current.context !== started.context) return;
      const current = await native.readNativeRule(target);
      if (latest.current.context !== started.context) return;
      setLoaded(current); setEnabled(!!current.text); if (latest.current.text === started.text) { setText(current.text); setConflict(null); }
      setMessage('规则已保存。');
    } catch (value) {
      if (latest.current.context !== started.context) return;
      setMessage(errorText(value));
      const current = await native.readNativeRule(target).catch(() => null);
      if (latest.current.context === started.context && current && current.text !== original) setConflict(current.text);
    } finally { setBusy(false); }
  }
  async function toggle(next: boolean) {
    const snapshot = latest.current;
    if (dirty && !await confirmAction('切换规则前放弃未保存修改？', () => isCurrent(snapshot), { title: '放弃未保存修改？', confirmLabel: '放弃修改' })) return;
    const started=latest.current.context;setBusy(true);setMessage('');
    try { await native.setNativeRuleEnabled(target,next); const value=await native.readNativeRule(target); if(latest.current.context===started){setLoaded(value);setText(value.text);setEnabled(!!value.text);} }
    catch(value){if(latest.current.context===started)setMessage(errorText(value));}finally{setBusy(false);}
  }
  return <details className="native-rule-editor"><summary>编辑当前 CLI 规则</summary>
    <div className="native-rule-controls"><label>工具<select aria-label="规则工具" value={tool} onChange={event => { const value = event.target.value; void change(() => setTool(value)); }}>{tools.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>范围<select aria-label="规则范围" value={scope} onChange={event => { const value = event.target.value as Scope; void change(() => setScope(value)); }}><option value="global">全局</option><option value="project">项目</option></select></label>
      {scope === 'project' && <label>项目<select aria-label="规则项目" value={project} onChange={event => { const value = event.target.value; void change(() => setProject(value)); }}><option value="">选择项目…</option>{projects.filter(item => item.available && item.path).map(item => <option key={item.id} value={item.path!}>{item.name}</option>)}</select></label>}</div>
    {loaded && <><label className="native-rule-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => void toggle(event.target.checked)} />启用规则</label><p title={loaded.path}>{loaded.path.split(/[\\/]/).pop()}</p><CodeEditor label="当前原生规则" value={text} onChange={setText} format="markdown" /><button type="button" disabled={busy || !dirty} onClick={() => void save()}>保存规则</button></>}
    {conflict !== null && <FileConflict current={conflict} edited={text} format="markdown" busy={busy} onKeep={() => { setLoaded(old => old ? { ...old, text: conflict } : old); setText(conflict); setConflict(null); }} onUse={() => void save(conflict)} />}
    {message && <p role="status">{message}</p>}
  </details>;
}
