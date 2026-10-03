import { ExternalLink } from '../../components/ExternalLink';
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
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

function versionParts(value: string) {
  return value.trim().replace(/^v/i, '').split('-')[0].split('.').map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
}

/** Negative when current is older than latest. */
const latestVersions = new Map<string, string>();

function compareVersions(current: string, latest: string) {
  const left = versionParts(current);
  const right = versionParts(latest);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export function InstallPanel({ toolName, probe, customPath, busy, loading, onCustomPath, onSavePath, onMaintain, onUsePath }: {
  toolName: string;
  probe: Omit<ToolProbe, 'tool'> & { tool: string };
  customPath: string;
  busy: boolean;
  loading: boolean;
  onCustomPath: (value: string) => void;
  onSavePath: () => void;
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
  const versionKey = `${probe.tool}:${selected?.version ?? ''}`;
  const [latest, setLatest] = useState<{ state: 'loading' | 'ready' | 'unknown'; version: string }>(() => {
    const remembered = latestVersions.get(versionKey);
    return remembered ? { state: 'ready', version: remembered } : { state: 'loading', version: '' };
  });
  useEffect(() => {
    const remembered = latestVersions.get(versionKey);
    if (remembered) { setLatest({ state: 'ready', version: remembered }); return; }
    let live = true;
    setLatest({ state: 'loading', version: '' });
    void native.cliLatestVersion(probe.tool).then((version) => {
      if (!live) return;
      const text = typeof version === 'string' ? version.trim() : '';
      if (text) latestVersions.set(versionKey, text);
      setLatest(text ? { state: 'ready', version: text } : { state: 'unknown', version: '' });
    }).catch(() => { if (live) setLatest({ state: 'unknown', version: '' }); });
    return () => { live = false; };
  }, [probe.tool, versionKey]);
  const currentVersion = selected?.version?.trim() ?? '';
  const behind = Boolean(selected && currentVersion && latest.state === 'ready' && compareVersions(currentVersion, latest.version) < 0);
  const current = !selected || latest.state !== 'ready' || !currentVersion ? false : compareVersions(currentVersion, latest.version) >= 0;
  const updateLabel = multiple ? (selected && isNative(selected.source) ? '更新原生' : '更新 npm') : '更新';
  const summary = !selected
    ? '未安装'
    : latest.state === 'ready'
      ? (behind ? `当前 ${currentVersion} · 最新 ${latest.version}` : `当前 ${currentVersion} · 已是最新`)
      : latest.state === 'loading'
        ? `当前 ${currentVersion || '未知版本'} · 正在查看最新版本`
        : `当前 ${currentVersion || '未知版本'} · 暂时查不到最新版本`;
  return <details className={styles.pathControl}>
    <summary><span className={styles.statusDot} data-ok={probe.nativeWrites.state === 'supported'} /><strong>{toolName}</strong><span>{selected || probe.nativeWrites.state === 'supported' ? summary : probe.nativeWrites.reason}</span><span className={styles.diagnosticLabel}>安装与更新</span></summary>
    {selected && <div className={styles.release}>
      <div>
        <span>当前版本</span>
        <strong>{currentVersion || '未知'}</strong>
        <small>{sourceLabel(selected.source)} · {fileName(selected.path)}</small>
      </div>
      <div data-state={behind ? 'behind' : current ? 'current' : undefined}>
        <span>最新版本</span>
        <strong>{latest.state === 'ready' ? latest.version : latest.state === 'loading' ? '…' : '查不到'}</strong>
        <small>{behind ? `可以更新到 ${latest.version}` : current ? '已是最新版本' : latest.state === 'loading' ? '正在查询 npm 公开版本' : '暂时查不到公开版本'}</small>
      </div>
    </div>}
    {available.filter(item => item.path !== selected?.path).map(item => <div className={styles.installRow} key={item.path}>
      <strong>{sourceLabel(item.source)}</strong>
      <span title={item.path}>{item.version ?? '未知版本'} · {fileName(item.path)}</span>
      <button type="button" disabled={busy} title="之后栖点启动使用这个文件" onClick={() => onUsePath(item.path)}>使用</button>
    </div>)}
    {failed.map(item => <p className={styles.installFail} key={item.path} title={item.detail ?? item.path}>未能运行 · {fileName(item.path)}</p>)}
    {hasNpm && hasNative && <p className={styles.installNote}>两份都在。选择栖点启动用的那一份。</p>}
    {problems.map(item => <p className={styles.installNote} key={item.name}>{item.name} {item.status === 'outdated' ? '版本过旧' : '缺失'}{item.helpUrl && <ExternalLink href={item.helpUrl}> 安装 ↗</ExternalLink>}</p>)}
    <div className={styles.installActions}>
      {!selected && multiple && <>
        <button type="button" disabled={busy} onClick={() => onMaintain('install_native', 'native')}>安装原生</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => onMaintain('install', 'npm_shim')}>安装 npm</button>
      </>}
      {!selected && !multiple && probe.installCommand && <button type="button" className={styles.primary} disabled={busy} onClick={() => onMaintain('install')}>安装</button>}
      {behind && probe.upgradeCommand && <button type="button" className={styles.primary} disabled={busy || loading} onClick={() => onMaintain('upgrade', selected?.source)}>{updateLabel}</button>}
      {probe.installUrl && <ExternalLink href={probe.installUrl}>官方安装说明 ↗</ExternalLink>}
    </div>
    <details className={styles.pathCustom}><summary>指定路径</summary><div><input aria-label="CLI 可执行文件路径" value={customPath} onChange={event => onCustomPath(event.target.value)} placeholder="可执行文件完整路径" /><button type="button" disabled={busy} onClick={onSavePath}>保存并重检</button></div></details>
  </details>;
}
