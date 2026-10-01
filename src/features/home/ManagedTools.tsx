import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchSettings } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor, NativeInspection, RegisteredToolWorkspace } from '../../types/native';
import { ToolIcon } from '../../components/ToolIcon';
import styles from './ManagedTools.module.css';

type Loaded = { workspace: RegisteredToolWorkspace | null; inspection?: NativeInspection | null; error: string | null; busy: boolean };

function message(value: unknown): string {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : '操作失败，请重试';
}

function profileLabel(name: string, connection: { model?: string | null } | null | undefined): string {
  const model = connection?.model?.trim();
  return model ? `${name} · ${model}` : name;
}

export function ManagedTools({ tools, onOpenTool }: { tools: AdapterDescriptor[]; onOpenTool: (toolId: string) => void }) {
  const [states, setStates] = useState<Record<string, Loaded>>({});
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    void native.getLaunchSettings().then((value) => { if (active) setLaunchSettings(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      const current = ++generation.current;
      for (const tool of tools) {
        void native.getRegisteredToolWorkspace(tool.id, 'global').then(async (workspace) => {
          const files = Object.fromEntries(workspace.snapshots.filter(item => item.text !== null && !workspace.probe.nativeFiles.find(file => file.role === item.role)?.sensitive).map(item => [item.role, item.text!]));
          const inspection = Object.keys(files).length ? await native.inspectRegisteredNativeDraft(tool.id, files).catch(() => null) : null;
          if (active && current === generation.current) setStates((old) => ({ ...old, [tool.id]: { workspace, inspection, error: null, busy: false } }));
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
    try {
      const directory = await open({ directory: true, multiple: false, title: '选择启动工作目录' });
      if (typeof directory === 'string') await native.launchCli({ toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(launchSettings, 'cli', !!tools.find((item) => item.id === toolId)?.yoloAvailable), directory });
    }
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
    {tools.map((tool) => {
      const loaded = states[tool.id];
      const workspace = loaded?.workspace;
      const profiles = workspace?.profiles ?? [];
      const selected = profiles.find((item) => item.id === workspace?.binding?.profileId);
      const appliedCurrent = !!selected && workspace?.binding?.profileVersion === selected.version;
      const installed = !!workspace?.probe.selectedPath;
      const writable = workspace?.probe.nativeWrites.state === 'supported';
      const launchMode = preferredLaunchMode(launchSettings, 'cli', !!tool.yoloAvailable);
      const switchTitle = !workspace ? undefined : !writable ? workspace.probe.nativeWrites.reason || '当前不能写入这个工具的配置' : '点一下即切换，下次启动会读取这份配置';
      return <div className={styles.row} key={tool.id}>
        <div className={styles.name}><ToolIcon toolId={tool.id} size={34} /><span><strong>{tool.name}</strong><small className={styles.status} data-state={loaded?.error ? 'error' : !workspace ? 'loading' : installed ? 'ok' : 'warn'}>{loaded?.error ? '检测失败' : workspace ? installed ? workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? '已安装' : '未确认安装' : '正在检测'}</small></span></div>
        <div className={styles.switch}>
          {loaded?.error ? <small>{loaded.error}</small>
            : !workspace ? (nativeAvailable ? <small>正在读取配置</small> : null)
            : profiles.length > 4 ? <select aria-label={`切换${tool.name}的配置`} value={selected?.id ?? ''} disabled={loaded?.busy || !writable} title={switchTitle} onChange={(event) => void switchProfile(tool.id, event.target.value)}>{!selected && <option value="">选择要使用的配置</option>}{profiles.map((item) => <option key={item.id} value={item.id}>{profileLabel(item.name, item.connection)}{item.id === selected?.id && !appliedCurrent ? ' · 有未应用修改' : ''}</option>)}</select>
            : profiles.length ? <div role="radiogroup" aria-label={`切换${tool.name}的配置`} title={switchTitle}>{profiles.map((item) => <button key={item.id} type="button" role="radio" aria-checked={item.id === selected?.id} className={item.id === selected?.id ? styles.activeConfig : ''} disabled={loaded?.busy || !writable} title={profileLabel(item.name, item.connection)} onClick={() => { if (item.id !== selected?.id || !appliedCurrent) void switchProfile(tool.id, item.id); }}>{item.name}</button>)}</div>
            : <button type="button" className={styles.addConfig} onClick={() => onOpenTool(tool.id)}>新建配置</button>}
        </div>
        <div className={styles.rowActions}><button type="button" className={styles.launch} disabled={!installed || loaded?.busy} title={launchMode === 'yolo' ? '按此 CLI 的原生参数跳过审批' : launchSettings?.cliMode === 'yolo' ? '此 CLI 未提供已确认的 YOLO 参数，将用普通模式启动' : undefined} onClick={() => void launchTool(tool.id)}>启动</button><button type="button" onClick={() => onOpenTool(tool.id)}>编辑配置 →</button></div>
      </div>;
    })}
  </div>;
}
