import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchSettings } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor, ApplyComparison, RegisteredToolWorkspace } from '../../types/native';
import { CodeEditor } from '../../components/CodeEditor';
import { FilterSelect } from '../../components/FilterSelect';
import type { FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { displayPath } from '../../lib/paths';
import styles from './ManagedTools.module.css';

type Notice = { tone: 'ok' | 'error' | 'pending'; text: string; title: string };
type Activity = 'launch' | 'apply' | null;
type Loaded = { workspace: RegisteredToolWorkspace | null; error: string | null; busy: boolean; activity: Activity; notice: Notice | null };

const rememberedHome = new Map<string, RegisteredToolWorkspace>();
const launchDirectories = new Map<string, string>();
let lastLaunchDirectory = '';

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

type SwitchableProfile = { id: string; name: string; connection: { model?: string | null } | null | undefined };

function StepGlyph({ direction }: { direction: 'left' | 'right' }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={direction === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} /></svg>;
}

function ProfileMenu({ label, profiles, selected, appliedCurrent, disabled, title, onSwitch }: {
  label: string;
  profiles: SwitchableProfile[];
  selected: SwitchableProfile | undefined;
  appliedCurrent: boolean;
  disabled: boolean;
  title?: string;
  onSwitch: (profileId: string) => void;
}) {
  const options: FilterSelectOption[] = profiles.map((item) => ({ value: item.id, label: item.name, detail: item.connection?.model?.trim() || undefined, note: item.id === selected?.id && !appliedCurrent ? '有未应用修改' : undefined }));
  const selectedIndex = profiles.findIndex((item) => item.id === selected?.id);

  function move(direction: -1 | 1) {
    if (disabled || profiles.length < 2) return;
    const index = selectedIndex < 0 ? 0 : selectedIndex;
    const next = profiles[(index + direction + profiles.length) % profiles.length];
    if (next && (next.id !== selected?.id || !appliedCurrent)) onSwitch(next.id);
  }

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); return; }
  }

  return <div className={styles.switcher}>
    <button type="button" className={styles.step} aria-label="上一个配置" disabled={disabled || profiles.length < 2} title="切换到上一个配置" onClick={() => move(-1)}><StepGlyph direction="left" /></button>
    <FilterSelect className={styles.switchSelect} label={label} value={selected?.id ?? ''} options={options} placeholder="选择要使用的配置" disabled={disabled} title={title} variant="accent" searchLabel="搜索配置" searchPlaceholder="输入配置名称" onChange={(value) => { if (value !== selected?.id || !appliedCurrent) onSwitch(value); }} onTriggerKeyDown={onTriggerKey} />
    <button type="button" className={styles.step} aria-label="下一个配置" disabled={disabled || profiles.length < 2} title="切换到下一个配置" onClick={() => move(1)}><StepGlyph direction="right" /></button>
  </div>;
}

export function ManagedTools({ tools, onOpenTool }: { tools: AdapterDescriptor[]; onOpenTool: (toolId: string) => void }) {
  const [states, setStates] = useState<Record<string, Loaded>>(() => Object.fromEntries(tools.flatMap((tool) => {
    const workspace = rememberedHome.get(tool.id);
    return workspace ? [[tool.id, { workspace, error: null, busy: false, activity: null, notice: null }]] : [];
  })));
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const [conflict, setConflict] = useState<{ toolId: string; toolName: string; profileName: string; comparison: ApplyComparison } | null>(null);
  const [conflictError, setConflictError] = useState('');
  const generation = useRef(0);
  const acting = useRef(new Set<string>());
  const noticeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = noticeTimers.current;
    return () => { timers.forEach((timer) => clearTimeout(timer)); timers.clear(); };
  }, []);

  function clearNoticeLater(toolId: string, notice: Notice) {
    const timers = noticeTimers.current;
    const old = timers.get(toolId);
    if (old) clearTimeout(old);
    if (notice.tone !== 'ok') { timers.delete(toolId); return; }
    timers.set(toolId, setTimeout(() => {
      timers.delete(toolId);
      setStates((old) => {
        const current = old[toolId];
        if (!current || current.notice !== notice) return old;
        return { ...old, [toolId]: { ...current, notice: null } };
      });
    }, 5000));
  }

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
        void native.getRegisteredToolWorkspace(tool.id, 'global', undefined, true).then((workspace) => {
          rememberedHome.set(tool.id, workspace);
          if (active && current === generation.current) setStates((old) => ({ ...old, [tool.id]: { workspace, error: null, busy: old[tool.id]?.busy ?? false, activity: old[tool.id]?.activity ?? null, notice: old[tool.id]?.notice ?? null } }));
        }).catch((error) => {
          rememberedHome.delete(tool.id);
          if (active && current === generation.current) setStates((old) => ({ ...old, [tool.id]: { workspace: null, error: message(error), busy: false, activity: null, notice: null } }));
        });
      }
    };
    refresh();
    void listen('cliora:bindings-changed', refresh).then((stop) => {
      if (active) unsubscribe = stop; else stop();
    }).catch(() => {});
    return () => { active = false; generation.current++; unsubscribe?.(); };
  }, [tools.map((item) => item.id).join('|')]);

  async function launchTool(toolId: string, pickDirectory = false) {
    const previous = states[toolId];
    if (!previous || previous.busy || acting.current.has(toolId)) return;
    acting.current.add(toolId);
    const toolName = tools.find((item) => item.id === toolId)?.name ?? toolId;
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: true, activity: 'launch', error: null, notice: null } }));
    try {
      const remembered = launchDirectories.get(toolId);
      let directory = pickDirectory ? undefined : remembered;
      if (!directory) {
        const picked = await open({ directory: true, multiple: false, title: '选择启动工作目录', defaultPath: remembered || lastLaunchDirectory || undefined });
        if (typeof picked !== 'string') {
          setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
          return;
        }
        directory = picked;
        launchDirectories.set(toolId, picked);
        lastLaunchDirectory = picked;
      }
      await native.launchCli({ toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(launchSettings, 'cli', !!tools.find((item) => item.id === toolId)?.yoloAvailable), directory });
      const notice = lineNotice('ok', `${toolName} 已向外部终端发出请求。`);
      setStates((old) => ({ ...old, [toolId]: settle(previous, notice) }));
      clearNoticeLater(toolId, notice);
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
      const notice = lineNotice('ok', `${toolName} 已写入原生文件，下次启动读取。`);
      setStates((old) => {
        const current = old[toolId];
        if (!current?.workspace) return old;
        const version = current.workspace.profiles.find((item) => item.id === profileId)?.version ?? current.workspace.binding?.profileVersion ?? 0;
        const workspace = { ...current.workspace, binding: { scopeKey: 'global', tool: toolId, profileId, profileVersion: version, managed: {} } };
        rememberedHome.set(toolId, workspace);
        return { ...old, [toolId]: { ...current, busy: false, activity: null, error: null, notice, workspace } };
      });
      clearNoticeLater(toolId, notice);
    } catch (error) {
      const detail = message(error);
      const profile = previous.workspace?.profiles.find((item) => item.id === profileId);
      if (profile && (detail.includes('请确认接管') || detail.includes('外部修改'))) {
        try {
          const comparison = await native.compareRegisteredApplication(profileId, 'global', '');
          setConflict({ toolId, toolName, profileName: profile.name, comparison });
          setConflictError('');
          setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
          return;
        } catch (compareError) {
          const reason = message(compareError);
          const text = `${toolName} 未能比较当前文件。${reason}`;
          setStates((old) => ({ ...old, [toolId]: settle(previous, { tone: 'error', text, title: text }) }));
          return;
        }
      }
      const text = `${toolName} 未切换：${detail}`;
      setStates((old) => ({ ...old, [toolId]: settle(previous, { tone: 'error', text, title: text }) }));
    } finally {
      acting.current.delete(toolId);
    }
  }

  async function useComparedFile() {
    if (!conflict) return;
    const { toolId, toolName, comparison } = conflict;
    const previous = states[toolId];
    setConflictError('');
    try {
      await native.applyComparedApplication(comparison, 'global', '');
      setConflict(null);
      const notice = lineNotice('ok', `${toolName} 已写入原生文件，下次启动读取。`);
      setStates((old) => {
        const current = old[toolId];
        if (!current?.workspace) return old;
        const version = current.workspace.profiles.find((item) => item.id === comparison.profile.id)?.version ?? comparison.profile.version;
        const workspace = { ...current.workspace, binding: { scopeKey: 'global', tool: toolId, profileId: comparison.profile.id, profileVersion: version, managed: {} } };
        rememberedHome.set(toolId, workspace);
        return { ...old, [toolId]: { ...current, busy: false, activity: null, error: null, notice, workspace } };
      });
      clearNoticeLater(toolId, notice);
    } catch (error) {
      setConflictError(message(error));
      if (previous) setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
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
      const rememberedDir = launchDirectories.get(tool.id);
      const switchTitle = !workspace ? undefined : !writable ? workspace.probe.nativeWrites.reason || '当前不能写入这个工具的配置' : '点一下即切换，下次启动会读取这份配置';
      const launchTitle = !installed && workspace ? '尚未确认安装，可在“工具与连接”中检查'
        : [rememberedDir ? `在 ${displayPath(rememberedDir)} 启动` : '', launchMode === 'yolo' ? '按此 CLI 的原生参数跳过审批' : launchSettings?.cliMode === 'yolo' ? '此 CLI 未提供已确认的 YOLO 参数，将用普通模式启动' : ''].filter(Boolean).join('；') || undefined;
      const line = loaded?.error
        ? lineNotice('error', `${tool.name} 检测失败。可编辑配置或重新进入本页重新读取。`, loaded.error)
        : loaded?.activity === 'apply'
          ? lineNotice('pending', `正在应用 ${tool.name} 的配置。`)
          : loaded?.notice ?? null;
      return <div className={styles.row} data-tool-row key={tool.id}>
        <div className={styles.name}><ToolIcon toolId={tool.id} size={34} /><span><strong>{tool.name}</strong><small className={styles.status} data-state={loaded?.error ? 'error' : !workspace ? 'loading' : installed ? 'ok' : 'warn'}>{loaded?.error ? '检测失败' : workspace ? installed ? workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? '已安装' : '未确认安装' : '正在检测'}</small></span></div>
        <div className={styles.switch}>
          {loaded?.error ? null
            : !workspace ? (nativeAvailable ? <><span className="sr-only">正在读取配置</span><span className={styles.loadingBar} aria-hidden="true" /></> : null)
            : profiles.length > 4 ? <ProfileMenu label={`切换${tool.name}的配置`} profiles={profiles} selected={selected} appliedCurrent={appliedCurrent} disabled={!!loaded?.busy || !writable} title={switchTitle} onSwitch={(profileId) => void switchProfile(tool.id, profileId)} />
            : profiles.length ? <div role="radiogroup" aria-label={`切换${tool.name}的配置`} title={switchTitle}>{profiles.map((item) => <button key={item.id} type="button" role="radio" aria-checked={item.id === selected?.id} className={item.id === selected?.id ? styles.activeConfig : ''} disabled={loaded?.busy || !writable} title={profileLabel(item.name, item.connection)} onClick={() => { if (item.id !== selected?.id || !appliedCurrent) void switchProfile(tool.id, item.id); }}>{item.name}</button>)}</div>
            : <button type="button" className={styles.addConfig} onClick={() => onOpenTool(tool.id)}>新建配置</button>}
        </div>
        <div className={styles.rowActions}><button type="button" className={styles.iconAction} aria-label={`选择${tool.name}的启动目录`} title="选择本次启动的工作目录" disabled={!installed || loaded?.busy} onClick={() => void launchTool(tool.id, true)}><Icon name="folder" size={15} /></button><button type="button" className={styles.launch} disabled={!installed || loaded?.busy} aria-busy={loaded?.activity === 'launch' || undefined} title={launchTitle} onClick={() => void launchTool(tool.id)}>{loaded?.activity === 'launch' ? '正在启动' : '启动'}</button><button type="button" onClick={() => onOpenTool(tool.id)}>编辑配置 →</button></div>
        {line && <div className={styles.note} data-tone={line.tone} role={line.tone === 'error' ? 'alert' : 'status'} title={line.title}>{line.text}</div>}
      </div>;
    })}
    <GuideDialog open={!!conflict} title="比较当前文件与本次配置" hint={conflict ? `${conflict.toolName} 的文件和「${conflict.profileName}」不一致。可以保留现有文件，或改用这份配置。` : undefined} onClose={() => { setConflict(null); setConflictError(''); }}>
      {conflict && <div className="file-conflict" aria-label="配置应用冲突">{conflict.comparison.files.map((file) => <div className="file-conflict-columns" key={file.role}><div><strong>当前文件</strong><CodeEditor label={`当前 ${file.role} 文件`} readOnly compact format={file.format} value={file.current} /></div><div><strong>本次配置</strong><CodeEditor label={`本次 ${file.role} 配置`} readOnly compact format={file.format} value={file.proposedText ?? ''} /></div></div>)}{conflictError && <p role="alert">{conflictError}</p>}<div className="file-conflict-actions"><button type="button" onClick={() => { setConflict(null); setConflictError(''); }}>保留当前文件</button><button type="button" onClick={() => void useComparedFile()}>使用本次配置</button></div></div>}
    </GuideDialog>
  </div>;
}
