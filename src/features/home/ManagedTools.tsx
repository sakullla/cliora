import { useEffect, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { CLI_NAMES } from '../../types/domain';
import type { CliId } from '../../types/domain';
import type { ToolWorkspace } from '../../types/native';
import styles from './ManagedTools.module.css';

type Loaded = { workspace: ToolWorkspace | null; error: string | null; busy: boolean };

function message(value: unknown): string {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : '操作失败，请重试';
}

export function ManagedTools({ tools, onOpenTool }: { tools: CliId[]; onOpenTool: (tool: CliId) => void }) {
  const [states, setStates] = useState<Partial<Record<CliId, Loaded>>>({});
  const generation = useRef(0);

  useEffect(() => {
    if (!nativeAvailable) return;
    const current = ++generation.current;
    for (const tool of tools) {
      void native.getToolWorkspace(tool, 'global').then((workspace) => {
        if (current === generation.current) setStates((old) => ({ ...old, [tool]: { workspace, error: null, busy: false } }));
      }).catch((error) => {
        if (current === generation.current) setStates((old) => ({ ...old, [tool]: { workspace: null, error: message(error), busy: false } }));
      });
    }
    return () => { generation.current++; };
  }, [tools.join('|')]);

  async function switchProfile(tool: CliId, profileId: string) {
    if (!profileId) return;
    const previous = states[tool];
    if (!previous?.workspace || previous.busy) return;
    setStates((old) => ({ ...old, [tool]: { ...previous, busy: true, error: null } }));
    try {
      await native.applyNativeProfile(tool, profileId, 'global', undefined, false);
      const workspace = await native.getToolWorkspace(tool, 'global');
      setStates((old) => ({ ...old, [tool]: { workspace, busy: false, error: null } }));
    } catch (error) {
      setStates((old) => ({ ...old, [tool]: { ...previous, busy: false, error: message(error) } }));
    }
  }

  if (!tools.length) return <div className={styles.empty}>尚未管理工具。可在设置中选择需要的 CLI。</div>;
  return <div className={styles.list} aria-label="管理中的工具">
    <div className={styles.heading}><span>工具</span><span>当前全局配置</span><span>操作</span></div>
    {tools.map((tool) => {
      const loaded = states[tool];
      const workspace = loaded?.workspace;
      const selected = workspace?.profiles.find((item) => item.id === workspace.binding?.profileId);
      const installed = !!workspace?.probe.selectedPath;
      const writable = workspace?.probe.nativeWrites.state === 'supported';
      return <div className={styles.row} key={tool}>
        <div className={styles.name}><span className={styles.icon}>{CLI_NAMES[tool].slice(0, 1)}</span><span><strong>{CLI_NAMES[tool]}</strong><small>{loaded?.error ? '检测失败' : workspace ? installed ? workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? '已安装' : '未确认安装' : '正在检测'}</small></span></div>
        <div className={styles.current}>{workspace?.profiles.length && writable ? <select aria-label={`${CLI_NAMES[tool]} 全局配置`} value={selected?.id ?? ''} disabled={loaded?.busy} onChange={(event) => void switchProfile(tool, event.target.value)}><option value="">选择配置</option>{workspace.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}{item.connection?.model ? ` · ${item.connection.model}` : ''}</option>)}</select> : <span>{!workspace ? '尚未检测' : !workspace.profiles.length ? '尚未配置' : '此版本暂不能安全切换'}</span>}<small>{loaded?.error ?? (selected ? '已写入原生文件 · 下次启动读取' : workspace?.probe.nativeWrites.reason ?? '等待检测')}</small></div>
        <button type="button" onClick={() => onOpenTool(tool)}>编辑配置 →</button>
      </div>;
    })}
  </div>;
}
