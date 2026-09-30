import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { native, nativeAvailable } from '../../lib/native';
import type { AdapterDescriptor, RegisteredToolWorkspace } from '../../types/native';
import { ToolIcon } from '../../components/ToolIcon';
import styles from './ManagedTools.module.css';

type Loaded = { workspace: RegisteredToolWorkspace | null; error: string | null; busy: boolean };

function message(value: unknown): string {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : '操作失败，请重试';
}

export function ManagedTools({ tools, onOpenTool }: { tools: AdapterDescriptor[]; onOpenTool: (toolId: string) => void }) {
  const [states, setStates] = useState<Record<string, Loaded>>({});
  const generation = useRef(0);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      const current = ++generation.current;
      for (const tool of tools) {
        void native.getRegisteredToolWorkspace(tool.id, 'global').then((workspace) => {
          if (active && current === generation.current) setStates((old) => ({ ...old, [tool.id]: { workspace, error: null, busy: false } }));
        }).catch((error) => {
          if (active && current === generation.current) setStates((old) => ({ ...old, [tool.id]: { workspace: null, error: message(error), busy: false } }));
        });
      }
    };
    refresh();
    void listen('cliora:bindings-changed', refresh).then((stop) => {
      if (active) unsubscribe = stop; else stop();
    }).catch(() => {});
    return () => { active = false; generation.current++; unsubscribe?.(); };
  }, [tools.map((item) => item.id).join('|')]);

  async function launchTool(toolId: string) {
    const previous = states[toolId];
    if (!previous || previous.busy) return;
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: true, error: null } }));
    try { await native.launchCli({ toolId, projectId: null, sessionId: null, mode: 'normal' }); }
    catch (error) { setStates((old) => ({ ...old, [toolId]: { ...previous, busy: false, error: message(error) } })); return; }
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: false } }));
  }

  async function switchProfile(tool: string, profileId: string) {
    if (!profileId) return;
    const previous = states[tool];
    if (!previous?.workspace || previous.busy) return;
    setStates((old) => ({ ...old, [tool]: { ...previous, busy: true, error: null } }));
    try {
      await native.applyRegisteredNativeProfile(tool, profileId, 'global', undefined, false);
      const workspace = await native.getRegisteredToolWorkspace(tool, 'global');
      setStates((old) => ({ ...old, [tool]: { workspace, busy: false, error: null } }));
    } catch (error) {
      setStates((old) => ({ ...old, [tool]: { ...previous, busy: false, error: message(error) } }));
    }
  }

  if (!tools.length) return <div className={styles.empty}>尚未管理工具。可在设置中选择需要的 CLI。</div>;
  return <div className={styles.list} aria-label="管理中的工具">
    <div className={styles.heading}><span>工具</span><span>当前全局配置</span><span>操作</span></div>
    {tools.map((tool) => {
      const loaded = states[tool.id];
      const workspace = loaded?.workspace;
      const selected = workspace?.profiles.find((item) => item.id === workspace.binding?.profileId);
      const appliedCurrent = !!selected && workspace?.binding?.profileVersion === selected.version;
      const installed = !!workspace?.probe.selectedPath;
      const writable = workspace?.probe.nativeWrites.state === 'supported';
      return <div className={styles.row} key={tool.id}>
        <div className={styles.name}><ToolIcon toolId={tool.id} /><span><strong>{tool.name}</strong><small>{loaded?.error ? '检测失败' : workspace ? installed ? workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? '已安装' : '未确认安装' : '正在检测'}</small></span></div>
        <div className={styles.current}>{workspace?.profiles.length && writable ? <select aria-label={`${tool.name} 全局配置`} value={appliedCurrent ? selected.id : ''} disabled={loaded?.busy} onChange={(event) => void switchProfile(tool.id, event.target.value)}><option value="">{selected && !appliedCurrent ? `${selected.name} · 有未应用修改` : '选择配置'}</option>{workspace.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}{item.connection?.model ? ` · ${item.connection.model}` : ''}</option>)}</select> : <span>{!workspace ? '尚未检测' : !workspace.profiles.length ? '尚未配置' : workspace.probe.nativeWrites.state !== 'supported' ? '原生写入不可用' : '选择配置'}</span>}<small>{loaded?.error ?? (appliedCurrent ? '已写入原生文件 · 下次启动读取' : selected ? '已保存的修改尚未应用；请在工具页应用' : workspace?.probe.nativeWrites.reason ?? '等待检测')}</small></div>
        <div className={styles.rowActions}><button type="button" className={styles.launch} disabled={!installed || loaded?.busy} onClick={() => void launchTool(tool.id)}>启动</button><button type="button" onClick={() => onOpenTool(tool.id)}>编辑配置 →</button></div>
      </div>;
    })}
  </div>;
}
