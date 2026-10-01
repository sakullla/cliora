import type { ToolProbe } from '../../types/native';
import styles from './ToolWorkspace.module.css';

function sourceLabel(source: string) {
  if (source === 'npm_shim') return 'npm';
  if (source === 'native' || source === 'claude_native') return '原生';
  return '其他';
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function isNative(source: string) {
  return source === 'native' || source === 'claude_native';
}

export function InstallPanel({ toolName, probe, customPath, busy, loading, onCustomPath, onSavePath, onRecheck, onMaintain, onUsePath }: {
  toolName: string;
  probe: ToolProbe;
  customPath: string;
  busy: boolean;
  loading: boolean;
  onCustomPath: (value: string) => void;
  onSavePath: () => void;
  onRecheck: () => void;
  onMaintain: (action: 'install' | 'upgrade' | 'install_native' | 'uninstall_npm', source?: string) => void;
  onUsePath: (path: string) => void;
}) {
  const available = probe.installations.filter(item => item.status === 'available');
  const failed = probe.installations.filter(item => item.status !== 'available');
  const selected = available.find(item => item.path === probe.selectedPath) ?? available[0];
  const hasNpm = available.some(item => item.source === 'npm_shim');
  const hasNative = available.some(item => isNative(item.source));
  const multiple = Boolean(probe.nativeInstallCommand && probe.npmInstallCommand);
  const problems = probe.dependencies.filter(item => item.status !== 'found');
  const version = selected?.version ? ` ${selected.version}` : '';
  const updateLabel = multiple ? (selected && isNative(selected.source) ? '更新原生' : '更新 npm') : '更新';
  return <details className={styles.pathControl}>
    <summary><span className={styles.statusDot} data-ok={probe.nativeWrites.state === 'supported'} /><strong>{selected ? `${toolName}${version}` : `${toolName} 未安装`}</strong><span>{probe.nativeWrites.reason}</span><span className={styles.diagnosticLabel}>安装与更新</span></summary>
    {available.map(item => <div className={styles.installRow} key={item.path}>
      <strong>{sourceLabel(item.source)}</strong>
      <span title={item.path}>{item.version ?? '未知版本'} · {fileName(item.path)}</span>
      {item.path === selected?.path ? <em>正在使用</em> : <button type="button" disabled={busy} title="之后栖点启动使用这个文件" onClick={() => onUsePath(item.path)}>使用</button>}
    </div>)}
    {failed.map(item => <p className={styles.installFail} key={item.path} title={item.detail ?? item.path}>未能运行 · {fileName(item.path)}</p>)}
    {hasNpm && hasNative && <p className={styles.installNote}>两份都在。选择栖点启动用的那一份。</p>}
    {problems.map(item => <p className={styles.installNote} key={item.name}>{item.name} {item.status === 'outdated' ? '版本过旧' : '缺失'}{item.helpUrl && <a href={item.helpUrl} target="_blank" rel="noreferrer"> 安装 ↗</a>}</p>)}
    <div className={styles.installActions}>
      {!selected && multiple && <>
        <button type="button" disabled={busy} onClick={() => onMaintain('install_native', 'native')}>安装原生</button>
        <button type="button" disabled={busy} onClick={() => onMaintain('install', 'npm_shim')}>安装 npm</button>
      </>}
      {!selected && !multiple && probe.installCommand && <button type="button" className={styles.primary} disabled={busy} onClick={() => onMaintain('install')}>安装</button>}
      {selected && probe.upgradeCommand && <button type="button" className={styles.primary} disabled={busy} onClick={() => onMaintain('upgrade', selected.source)}>{updateLabel}</button>}
      {selected && multiple && !hasNative && <button type="button" disabled={busy} onClick={() => onMaintain('install_native', 'native')}>安装原生</button>}
      {selected && multiple && !hasNpm && <button type="button" disabled={busy} onClick={() => onMaintain('install', 'npm_shim')}>安装 npm</button>}
      <button type="button" disabled={loading} onClick={onRecheck}>重新检测</button>
      {probe.installUrl && <a href={probe.installUrl} target="_blank" rel="noreferrer">官方安装说明 ↗</a>}
    </div>
    <details className={styles.pathCustom}><summary>指定路径</summary><div><input aria-label="CLI 可执行文件路径" value={customPath} onChange={event => onCustomPath(event.target.value)} placeholder="可执行文件完整路径" /><button type="button" disabled={busy} onClick={onSavePath}>保存并重检</button></div></details>
  </details>;
}
