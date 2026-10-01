import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchSettings } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor, ApplyComparison, RegisteredToolWorkspace } from '../../types/native';
import { CodeEditor } from '../../components/CodeEditor';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import styles from './ManagedTools.module.css';

type Notice = { tone: 'ok' | 'error' | 'pending'; text: string; title: string };
type Activity = 'launch' | 'apply' | null;
type Loaded = { workspace: RegisteredToolWorkspace | null; error: string | null; busy: boolean; activity: Activity; notice: Notice | null };

const rememberedHome = new Map<string, RegisteredToolWorkspace>();

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();
  const showSearch = profiles.length > 8;
  const matches = profiles.filter((item) => profileLabel(item.name, item.connection).toLowerCase().includes(query.trim().toLowerCase()));
  const selectedModel = selected?.connection?.model?.trim() ?? '';
  const selectedIndex = profiles.findIndex((item) => item.id === selected?.id);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < 220 && above > below;
      setBox({ left, width, maxHeight: Math.max(180, Math.min(320, upward ? above : below)), top: upward ? undefined : rect.bottom + 4, bottom: upward ? window.innerHeight - rect.top + 4 : undefined });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, profiles.findIndex((item) => item.id === selected?.id)));
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (!open || showSearch) return;
    panel.current?.focus();
  }, [open, showSearch, box]);
  useEffect(() => {
    if (!open || !panel.current) return;
    const node = panel.current.querySelector<HTMLElement>('[data-active="true"]');
    const list = node?.parentElement;
    if (!node || !list) return;
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open, active, query]);

  function choose(item: SwitchableProfile) {
    setOpen(false);
    setQuery('');
    if (item.id !== selected?.id || !appliedCurrent) onSwitch(item.id);
  }

  function move(direction: -1 | 1) {
    if (disabled || profiles.length < 2) return;
    const index = selectedIndex < 0 ? 0 : selectedIndex;
    const next = profiles[(index + direction + profiles.length) % profiles.length];
    if (next) choose(next);
  }

  function onMenuKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0))); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); return; }
    if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active]); return; }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setQuery(''); }
  }

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); return; }
    if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); }
  }

  return <>
    <div ref={anchor} className={styles.switcher}>
      <button type="button" className={styles.step} aria-label="上一个配置" disabled={disabled || profiles.length < 2} title="切换到上一个配置" onClick={() => move(-1)}><StepGlyph direction="left" /></button>
      <button type="button" className={styles.menuTrigger} data-empty={!selected || undefined} data-open={open || undefined} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled} title={title ?? (selected ? profileLabel(selected.name, selected.connection) : undefined)} onClick={() => setOpen((value) => !value)} onKeyDown={onTriggerKey}>
        <span className={styles.switchCopy}><span>{selected?.name ?? '选择要使用的配置'}</span>{selectedModel && <small>{selectedModel}</small>}</span>
      </button>
      <button type="button" className={styles.step} aria-label="下一个配置" disabled={disabled || profiles.length < 2} title="切换到下一个配置" onClick={() => move(1)}><StepGlyph direction="right" /></button>
    </div>
    {open && box && createPortal(<div ref={panel} className={styles.menu} role="listbox" id={listId} aria-label={label} tabIndex={-1} style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width }} onKeyDown={showSearch ? undefined : onMenuKey}>
      {showSearch && <input aria-label="搜索配置" placeholder="输入配置名称" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} onKeyDown={onMenuKey} />}
      <div className={styles.menuList} style={{ maxHeight: Math.max(140, box.maxHeight - (showSearch ? 52 : 8)) }}>
        {matches.length ? matches.map((item, index) => {
          const model = item.connection?.model?.trim();
          const current = item.id === selected?.id;
          return <button key={item.id} type="button" role="option" aria-selected={current} data-active={index === active || undefined} title={profileLabel(item.name, item.connection)} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
            <span><strong>{item.name}</strong>{model && <small>{model}</small>}</span>
            <span className={styles.menuMarks}>{current && !appliedCurrent && <em>有未应用修改</em>}{current && <Icon name="check" size={14} />}</span>
          </button>;
        }) : <p>没有匹配的配置</p>}
      </div>
    </div>, document.body)}
  </>;
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
      setStates((old) => {
        const current = old[toolId];
        if (!current?.workspace) return old;
        const version = current.workspace.profiles.find((item) => item.id === profileId)?.version ?? current.workspace.binding?.profileVersion ?? 0;
        const workspace = { ...current.workspace, binding: { scopeKey: 'global', tool: toolId, profileId, profileVersion: version, managed: {} } };
        rememberedHome.set(toolId, workspace);
        return { ...old, [toolId]: { ...current, busy: false, activity: null, error: null, notice: lineNotice('ok', `${toolName} 已写入原生文件，下次启动读取。`), workspace } };
      });
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
      setStates((old) => {
        const current = old[toolId];
        if (!current?.workspace) return old;
        const version = current.workspace.profiles.find((item) => item.id === comparison.profile.id)?.version ?? comparison.profile.version;
        const workspace = { ...current.workspace, binding: { scopeKey: 'global', tool: toolId, profileId: comparison.profile.id, profileVersion: version, managed: {} } };
        rememberedHome.set(toolId, workspace);
        return { ...old, [toolId]: { ...current, busy: false, activity: null, error: null, notice: lineNotice('ok', `${toolName} 已写入原生文件，下次启动读取。`), workspace } };
      });
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
      const switchTitle = !workspace ? undefined : !writable ? workspace.probe.nativeWrites.reason || '当前不能写入这个工具的配置' : '点一下即切换，下次启动会读取这份配置';
      const line = loaded?.error
        ? lineNotice('error', `${tool.name} 检测失败。可编辑配置或重新进入本页重新读取。`, loaded.error)
        : loaded?.activity === 'apply'
          ? lineNotice('pending', `正在应用 ${tool.name} 的配置。`)
          : loaded?.notice ?? null;
      return <div className={styles.row} data-tool-row key={tool.id}>
        <div className={styles.name}><ToolIcon toolId={tool.id} size={34} /><span><strong>{tool.name}</strong><small className={styles.status} data-state={loaded?.error ? 'error' : !workspace ? 'loading' : installed ? 'ok' : 'warn'}>{loaded?.error ? '检测失败' : workspace ? installed ? workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? '已安装' : '未确认安装' : '正在检测'}</small></span></div>
        <div className={styles.switch}>
          {loaded?.error ? null
            : !workspace ? (nativeAvailable ? <small>正在读取配置</small> : null)
            : profiles.length > 4 ? <ProfileMenu label={`切换${tool.name}的配置`} profiles={profiles} selected={selected} appliedCurrent={appliedCurrent} disabled={!!loaded?.busy || !writable} title={switchTitle} onSwitch={(profileId) => void switchProfile(tool.id, profileId)} />
            : profiles.length ? <div role="radiogroup" aria-label={`切换${tool.name}的配置`} title={switchTitle}>{profiles.map((item) => <button key={item.id} type="button" role="radio" aria-checked={item.id === selected?.id} className={item.id === selected?.id ? styles.activeConfig : ''} disabled={loaded?.busy || !writable} title={profileLabel(item.name, item.connection)} onClick={() => { if (item.id !== selected?.id || !appliedCurrent) void switchProfile(tool.id, item.id); }}>{item.name}</button>)}</div>
            : <button type="button" className={styles.addConfig} onClick={() => onOpenTool(tool.id)}>新建配置</button>}
        </div>
        <div className={styles.rowActions}><button type="button" className={styles.launch} disabled={!installed || loaded?.busy} aria-busy={loaded?.activity === 'launch' || undefined} title={launchMode === 'yolo' ? '按此 CLI 的原生参数跳过审批' : launchSettings?.cliMode === 'yolo' ? '此 CLI 未提供已确认的 YOLO 参数，将用普通模式启动' : undefined} onClick={() => void launchTool(tool.id)}>{loaded?.activity === 'launch' ? '正在启动' : '启动'}</button><button type="button" onClick={() => onOpenTool(tool.id)}>编辑配置 →</button></div>
        {line && <div className={styles.note} data-tone={line.tone} role={line.tone === 'error' ? 'alert' : 'status'} title={line.title}>{line.text}</div>}
      </div>;
    })}
    <GuideDialog open={!!conflict} title="比较当前文件与本次配置" hint={conflict ? `${conflict.toolName} 的文件和「${conflict.profileName}」不一致。可以保留现有文件，或改用这份配置。` : undefined} onClose={() => { setConflict(null); setConflictError(''); }}>
      {conflict && <div className="file-conflict" aria-label="配置应用冲突">{conflict.comparison.files.map((file) => <div className="file-conflict-columns" key={file.role}><div><strong>当前文件</strong><CodeEditor label={`当前 ${file.role} 文件`} readOnly compact format={file.format} value={file.current} /></div><div><strong>本次配置</strong><CodeEditor label={`本次 ${file.role} 配置`} readOnly compact format={file.format} value={file.proposedText ?? ''} /></div></div>)}{conflictError && <p role="alert">{conflictError}</p>}<div className="file-conflict-actions"><button type="button" onClick={() => { setConflict(null); setConflictError(''); }}>保留当前文件</button><button type="button" onClick={() => void useComparedFile()}>使用本次配置</button></div></div>}
    </GuideDialog>
  </div>;
}
