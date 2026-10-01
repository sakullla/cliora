import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchSettings } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor, NativeInspection, RegisteredToolWorkspace } from '../../types/native';
import { ToolIcon } from '../../components/ToolIcon';
import styles from './ManagedTools.module.css';

type Notice = { tone: 'ok' | 'error' | 'pending'; text: string; title: string };
type Activity = 'launch' | 'apply' | null;
type Loaded = { workspace: RegisteredToolWorkspace | null; inspection?: NativeInspection | null; error: string | null; busy: boolean; activity: Activity; notice: Notice | null };

function message(value: unknown): string {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : '操作失败，请重试';
}

function lineNotice(tone: Notice['tone'], text: string, detail = ''): Notice {
  const extra = detail && detail !== '操作失败，请重试' ? detail.replace(/\s+/g, ' ').trim() : '';
  const full = extra ? `${text} ${extra}` : text;
  return { tone, text: full, title: full };
}

function settle(previous: Loaded, next: Notice | null): Loaded {
  return { ...previous, busy: false, activity: null, error: null, notice: next };
}

function profileLabel(name: string, connection: { model?: string | null } | null | undefined): string {
  const model = connection?.model?.trim();
  return model ? `${name} · ${model}` : name;
}

export function ManagedTools({ tools, onOpenTool }: { tools: AdapterDescriptor[]; onOpenTool: (toolId: string) => void }) {
  const [states, setStates] = useState<Record<string, Loaded>>({});
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const generation = useRef(0);
  const acting = useRef(new Set<string>());

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
          if (active && current === generation.current) setStates((old) => ({ ...old, [tool.id]: { workspace, inspection, error: null, busy: old[tool.id]?.busy ?? false, activity: old[tool.id]?.activity ?? null, notice: old[tool.id]?.notice ?? null } }));
        }).catch((error) => {
          if (active && current === generation.current) setStates((old) => ({ ...old, [tool.id]: { workspace: null, inspection: null, error: message(error), busy: false, activity: null, notice: null } }));
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
    if (!previous || previous.busy || acting.current.has(toolId)) return;
    acting.current.add(toolId);
    const toolName = tools.find((item) => item.id === toolId)?.name ?? toolId;
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: true, activity: 'launch', error: null, notice: null } }));
    try {
      const directory = await open({ directory: true, multiple: false, title: '选择启动工作目录' });
      if (typeof directory !== 'string') {
        setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
        return;
      }
      await native.launchCli({ toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(launchSettings, 'cli', !!tools.find((item) => item.id === toolId)?.yoloAvailable), directory });
      setStates((old) => ({ ...old, [toolId]: settle(previous, lineNotice('ok', `${toolName} 已向外部终端发出请求。`)) }));
    } catch (error) {
      setStates((old) => ({ ...old, [toolId]: settle(previous, lineNotice('error', `${toolName} 启动失败。可再次启动或编辑配置。`, message(error))) }));
    } finally {
      acting.current.delete(toolId);
    }
  }

  async function switchProfile(toolId: string, profileId: string) {
    if (!profileId) return;
    const previous = states[toolId];
    if (!previous?.workspace || previous.busy || acting.current.has(toolId)) return;
    acting.current.add(toolId);
    const toolName = tools.find((item) => item.id === toolId)?.name ?? toolId;
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: true, activity: 'apply', error: null, notice: null } }));
    try {
      await native.applyRegisteredNativeProfile(toolId, profileId, 'global', undefined, false);
      const workspace = await native.getRegisteredToolWorkspace(toolId, 'global');
      setStates((old) => ({ ...old, [toolId]: { workspace, busy: false, activity: null, error: null, notice: lineNotice('ok', `${toolName} 已写入原生文件，下次启动读取。`) } }));
    } catch (error) {
      const text = `${toolName} 未切换，画面仍是原来的选中项。可重新选择配置。`;
      const detail = message(error);
      setStates((old) => ({ ...old, [toolId]: settle(previous, { tone: 'error', text, title: detail === '操作失败，请重试' ? text : `${text} ${detail}` }) }));
    } finally {
      acting.current.delete(toolId);
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
      const line = loaded?.error
        ? lineNotice('error', `${tool.name} 检测失败。可编辑配置或重新进入本页重新读取。`, loaded.error)
        : loaded?.activity === 'apply'
          ? lineNotice('pending', `正在应用 ${tool.name} 的配置。`)
          : loaded?.notice ?? null;
      return <div className={styles.row} key={tool.id}>
        <div className={styles.name}><ToolIcon toolId={tool.id} size={34} /><span><strong>{tool.name}</strong><small className={styles.status} data-state={loaded?.error ? 'error' : !workspace ? 'loading' : installed ? 'ok' : 'warn'}>{loaded?.error ? '检测失败' : workspace ? installed ? workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? '已安装' : '未确认安装' : '正在检测'}</small></span></div>
        <div className={styles.switch}>
          {loaded?.error ? null
            : !workspace ? (nativeAvailable ? <small>正在读取配置</small> : null)
            : profiles.length > 4 ? <select aria-label={`切换${tool.name}的配置`} value={selected?.id ?? ''} disabled={loaded?.busy || !writable} title={switchTitle} onChange={(event) => void switchProfile(tool.id, event.target.value)}>{!selected && <option value="">选择要使用的配置</option>}{profiles.map((item) => <option key={item.id} value={item.id}>{profileLabel(item.name, item.connection)}{item.id === selected?.id && !appliedCurrent ? ' · 有未应用修改' : ''}</option>)}</select>
            : profiles.length ? <div role="radiogroup" aria-label={`切换${tool.name}的配置`} title={switchTitle}>{profiles.map((item) => <button key={item.id} type="button" role="radio" aria-checked={item.id === selected?.id} className={item.id === selected?.id ? styles.activeConfig : ''} disabled={loaded?.busy || !writable} title={profileLabel(item.name, item.connection)} onClick={() => { if (item.id !== selected?.id || !appliedCurrent) void switchProfile(tool.id, item.id); }}>{item.name}</button>)}</div>
            : <button type="button" className={styles.addConfig} onClick={() => onOpenTool(tool.id)}>新建配置</button>}
        </div>
        <div className={styles.rowActions}><button type="button" className={styles.launch} disabled={!installed || loaded?.busy} aria-busy={loaded?.activity === 'launch' || undefined} title={launchMode === 'yolo' ? '按此 CLI 的原生参数跳过审批' : launchSettings?.cliMode === 'yolo' ? '此 CLI 未提供已确认的 YOLO 参数，将用普通模式启动' : undefined} onClick={() => void launchTool(tool.id)}>{loaded?.activity === 'launch' ? '正在启动' : '启动'}</button><button type="button" onClick={() => onOpenTool(tool.id)}>编辑配置 →</button></div>
        {line && <div className={styles.note} data-tone={line.tone} role={line.tone === 'error' ? 'alert' : 'status'} title={line.title}>{line.text}</div>}
      </div>;
    })}
  </div>;
}
