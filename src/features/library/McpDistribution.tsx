import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CodeEditor } from '../../components/CodeEditor';
import { ToolIcon } from '../../components/ToolIcon';
import { native } from '../../lib/native';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpPlacement, McpTargetRequest, McpTargetResult } from '../../types/resources';
import { samePath, scopeLabel } from './CliMarks';
import styles from './LibraryPage.module.css';

function text(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试';
}

export type McpDistributeOutcome = { status: 'written'; notice: string } | { status: 'pending' } | { status: 'failed' } | { status: 'stale' };
export type McpDistributeHandle = {
  run: (saved: McpDefinition) => Promise<McpDistributeOutcome>;
  commit: () => Promise<McpDistributeOutcome>;
  dismiss: () => void;
};

export const McpDistribution = forwardRef<McpDistributeHandle, {
  definition: McpDefinition;
  tools: AdapterDescriptor[];
  projects: Project[];
  placements: McpPlacement[];
  formStamp: string;
  onWillDistribute: (active: boolean) => void;
  onConflictChange: (active: boolean) => void;
}>(function McpDistribution({ definition, tools, projects, placements, formStamp, onWillDistribute, onConflictChange }, ref) {
  const placedFor = (nextScope: Scope, nextPath: string | null) => placements.filter((item) => item.definitionId === definition.id && item.scope === nextScope && (nextScope === 'global' || samePath(item.projectPath, nextPath)));
  const idsFor = (nextScope: Scope, nextPath: string | null) => placedFor(nextScope, nextPath).map((item) => item.toolId);
  const mine = placements.filter((item) => item.definitionId === definition.id);
  const globalPlaced = mine.filter((item) => item.scope === 'global');
  const firstProject = mine.find((item) => item.scope === 'project');
  const openOnProject = !globalPlaced.length && !!firstProject;
  const openProjectId = (openOnProject ? projects.find((item) => samePath(item.path, firstProject?.projectPath))?.id : undefined) ?? projects.find((item) => item.available)?.id ?? '';
  const openPath = openOnProject ? projects.find((item) => item.id === openProjectId)?.path ?? firstProject?.projectPath ?? null : null;
  const openScope: Scope = openOnProject ? 'project' : 'global';
  const initialPlaced = placedFor(openScope, openOnProject ? openPath : null);
  const [scope, setScope] = useState<Scope>(openScope);
  const [projectId, setProjectId] = useState(openProjectId);
  const [selected, setSelected] = useState<string[]>(() => initialPlaced.map((item) => item.toolId));
  const [enabled, setEnabled] = useState(() => initialPlaced.length === 0 || initialPlaced.some((item) => item.enabled));
  const [previewState, setPreview] = useState<{ epoch: number; items: McpTargetResult[] } | null>(null);
  const [results, setResults] = useState<McpTargetResult[] | null>(null);
  const [error, setError] = useState('');
  const project = projects.find((item) => item.id === projectId);
  const projectPath = scope === 'project' ? project?.path ?? null : null;
  const context = JSON.stringify([scope, projectPath, selected, enabled]);
  const epochRef = useRef({ context, epoch: 0 });
  if (epochRef.current.context !== context) epochRef.current = { context, epoch: epochRef.current.epoch + 1 };
  const requestRef = useRef(0);
  const preview = previewState?.epoch === epochRef.current.epoch ? previewState.items : null;
  const dropRef = useRef<string[]>([]);
  const stampRef = useRef(formStamp);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onWillDistribute(willDistribute(selected, scope, projectPath)); }, []);
  useEffect(() => {
    if (stampRef.current === formStamp) return;
    stampRef.current = formStamp;
    if (!previewState) return;
    setPreview(null);
    setResults(null);
    onConflictChange(false);
  }, [formStamp, previewState, onConflictChange]);

  function toolName(id: string) {
    return tools.find((item) => item.id === id)?.name ?? id;
  }
  function willDistribute(ids: string[], nextScope: Scope, nextPath: string | null) {
    const placed = idsFor(nextScope, nextPath);
    return ids.length > 0 || placed.some((id) => !ids.includes(id));
  }
  function droppedIds(ids = selected) {
    return idsFor(scope, projectPath).filter((id) => !ids.includes(id));
  }
  function noticeFor(writtenIds: string[], removedIds: string[]) {
    const where = scope === 'project' ? `${scopeLabel(scope, projectPath, projects)} 的 ` : '';
    const parts: string[] = [];
    if (writtenIds.length) parts.push(`已写入 ${where}${writtenIds.map(toolName).join('、')}。`);
    if (removedIds.length) parts.push(`已从 ${where}${removedIds.map(toolName).join('、')} 移除。`);
    return parts.join('');
  }
  function targets(ids = selected): McpTargetRequest[] {
    return ids.map((toolId) => ({ toolId, scope, projectPath, enabled }));
  }
  function choose(ids: string[], nextScope = scope, nextPath = projectPath) {
    setSelected(ids);
    onWillDistribute(willDistribute(ids, nextScope, nextPath));
    setPreview(null);
    setResults(null);
    onConflictChange(false);
  }
  function applyScope(nextScope: Scope, nextProjectId = projectId) {
    const nextProject = projects.find((item) => item.id === nextProjectId);
    const nextPath = nextScope === 'project' ? nextProject?.path ?? null : null;
    const placed = placedFor(nextScope, nextPath);
    const ids = placed.map((item) => item.toolId);
    setScope(nextScope);
    setProjectId(nextProjectId);
    setEnabled(placed.length === 0 || placed.some((item) => item.enabled));
    choose(ids, nextScope, nextPath);
  }
  async function removeDropped(saved: McpDefinition, ids: string[]) {
    const failed: string[] = [];
    for (const toolId of ids) {
      try {
        await native.removeNativeMcp({ toolId, scope, projectPath, enabled }, saved.name);
      } catch (value) {
        failed.push(`${toolName(toolId)}：${text(value)}`);
      }
    }
    return failed;
  }
  async function finish(saved: McpDefinition, written: McpTargetResult[], removed: string[]): Promise<McpDistributeOutcome> {
    const failedWrites = written.filter((item) => item.status !== 'written');
    if (failedWrites.length) {
      setResults(written);
      setError('');
      return { status: 'failed' };
    }
    const failedRemoves = await removeDropped(saved, removed);
    if (!mounted.current) return { status: 'stale' };
    if (failedRemoves.length) {
      setError(failedRemoves.join('；'));
      return { status: 'failed' };
    }
    onConflictChange(false);
    return { status: 'written', notice: noticeFor(written.map((item) => item.toolId), removed) };
  }
  async function inspect(saved: McpDefinition): Promise<McpDistributeOutcome> {
    const ids = selected;
    const removed = droppedIds(ids);
    if (!saved.id) return { status: 'failed' };
    if (!ids.length && !removed.length) return { status: 'failed' };
    if (scope === 'project' && !projectPath) { setError('请先选择项目。'); return { status: 'failed' }; }
    const epoch = epochRef.current.epoch;
    const request = ++requestRef.current;
    setPreview(null); setResults(null); setError('');
    onConflictChange(false);
    try {
      if (!ids.length) {
        const failed = await removeDropped(saved, removed);
        if (!mounted.current || request !== requestRef.current || epoch !== epochRef.current.epoch) return { status: 'stale' };
        if (failed.length) { setError(failed.join('；')); return { status: 'failed' }; }
        return { status: 'written', notice: noticeFor([], removed) };
      }
      const items = await native.previewMcpTargets(saved.id, targets(ids));
      if (!mounted.current || request !== requestRef.current || epoch !== epochRef.current.epoch) return { status: 'stale' };
      const writable = items.filter((item) => item.status === 'ready' || item.status === 'conflict');
      if (!writable.length) { setError(items.map((item) => item.detail).filter(Boolean).join('；') || '没有可写入的目标。'); return { status: 'failed' }; }
      if (items.some((item) => item.status === 'conflict')) {
        dropRef.current = removed;
        stampRef.current = formStamp;
        setPreview({ epoch, items });
        onConflictChange(true);
        return { status: 'pending' };
      }
      const written = await native.distributeMcp(saved.id, writable.map((item): McpTargetRequest => ({
        toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken,
      })));
      if (!mounted.current || request !== requestRef.current || epoch !== epochRef.current.epoch) return { status: 'stale' };
      return finish(saved, written, removed);
    } catch (value) {
      if (request === requestRef.current && epoch === epochRef.current.epoch) setError(text(value));
      return { status: 'failed' };
    }
  }
  async function commit(): Promise<McpDistributeOutcome> {
    const current = preview;
    if (!current) return { status: 'failed' };
    const epoch = epochRef.current.epoch;
    const request = ++requestRef.current;
    const active = current.filter((item) => item.status === 'ready' || item.status === 'conflict');
    const removed = dropRef.current;
    setError('');
    try {
      const written = await native.distributeMcp(definition.id, active.map((item): McpTargetRequest => ({
        toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: item.status === 'conflict',
      })));
      if (!mounted.current || request !== requestRef.current || epoch !== epochRef.current.epoch) return { status: 'stale' };
      setPreview(null);
      return finish(definition, written, removed);
    } catch (value) {
      if (request === requestRef.current) setError(text(value));
      return { status: 'failed' };
    }
  }

  useImperativeHandle(ref, () => ({
    run: inspect,
    commit,
    dismiss: () => { setPreview(null); setResults(null); onConflictChange(false); },
  }), [selected, scope, projectPath, enabled, definition, placements, formStamp, preview]);

  const placedNow = new Set(idsFor(scope, projectPath));

  return <div className={styles.distribute}>
    <p>已经写入的 CLI 会预先勾上。保存时按勾选写入；取消勾选会从该 CLI 移除。同名内容不一致时，留在这里比较后再替换。</p>
    <div className={styles.fields}>
      <label>范围<select aria-label="分发范围" value={scope} onChange={(event) => applyScope(event.target.value as Scope)}><option value="global">全局</option><option value="project">项目</option></select></label>
      {scope === 'project' && <label>项目<select aria-label="分发项目" value={projectId} onChange={(event) => applyScope('project', event.target.value)}><option value="">选择项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.available ? '' : ' · 目录失效'}</option>)}</select></label>}
    </div>
    <label className={styles.choice}><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setPreview(null); setResults(null); onConflictChange(false); }} />写入后启用</label>
    <div className={styles.targets}>{tools.map((item) => <label key={item.id} title={placedNow.has(item.id) ? '已写入。取消勾选并保存会从该 CLI 移除。' : '保存时写入这个 CLI'}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => choose(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><ToolIcon toolId={item.id} size={22} />{item.name}</label>)}</div>
    {preview && <div className={styles.distribute} role="group" aria-label="MCP 写入冲突">
      <p><strong>这些 CLI 上已有同名内容。</strong>比较后可以选择替换，或保留当前文件。</p>
      {preview.map((item) => <div key={item.toolId}>
        <p><strong>{toolName(item.toolId)}</strong> · {item.status === 'conflict' ? '同名冲突' : item.status === 'ready' ? '可写入' : '不可写入'}{item.path ? ` · ${item.path}` : ''}</p>
        <p>{item.detail}</p>
        {(item.existing !== null || item.proposed !== null) && <div className={styles.fields}><CodeEditor compact label="当前 MCP" format="json" readOnly value={item.existing === null ? 'null' : JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label="写入后 MCP" format="json" readOnly value={item.proposed === null ? 'null' : JSON.stringify(item.proposed, null, 2)} /></div>}
      </div>)}
    </div>}
    {results && <div role="status">{results.map((item) => <p key={item.toolId}>{toolName(item.toolId)}：{item.status === 'written' ? '已写入' : item.detail}</p>)}</div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
});
