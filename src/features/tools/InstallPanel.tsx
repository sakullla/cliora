import { ExternalLink } from '../../components/ExternalLink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import type { ToolProbe } from '../../types/native';
import i18n from '../../i18n';
import styles from './ToolWorkspace.module.css';

function sourceLabel(source: string) {
  if (source === 'npm_shim') return 'npm';
  if (source === 'native' || source === 'claude_native') return i18n.t('tools.install.sourceNative');
  return i18n.t('tools.install.sourceOther');
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

const latestVersions = new Map<string, { at: number; request: Promise<string> }>();
function latestVersion(tool: string, fresh: boolean) {
  const cached = latestVersions.get(tool);
  if (!fresh && cached && Date.now() - cached.at < 300_000) return cached.request;
  const request = native.cliLatestVersion(tool).catch(error => {
    if (latestVersions.get(tool)?.request === request) latestVersions.delete(tool);
    throw error;
  });
  latestVersions.set(tool, { at: Date.now(), request });
  return request;
}

/** Negative when current is older than latest. */
function compareVersions(current: string, latest: string) {
  const left = versionParts(current);
  const right = versionParts(latest);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta) return delta;
  }
  const prerelease = (version: string) => version.split('+')[0].split('-').slice(1).join('-');
  const a = prerelease(current);
  const b = prerelease(latest);
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const aParts = a.split('.');
  const bParts = b.split('.');
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    if (aParts[index] === undefined) return -1;
    if (bParts[index] === undefined) return 1;
    if (aParts[index] === bParts[index]) continue;
    const aNumber = /^\d+$/.test(aParts[index]);
    const bNumber = /^\d+$/.test(bParts[index]);
    if (aNumber && bNumber) return Number(aParts[index]) - Number(bParts[index]);
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return aParts[index] < bParts[index] ? -1 : 1;
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
  const { t } = useTranslation();
  const available = probe.installations.filter(item => item.status === 'available');
  const failed = probe.installations.filter(item => item.status !== 'available');
  const selected = available.find(item => item.path === probe.selectedPath) ?? available[0];
  const hasNpm = available.some(item => item.source === 'npm_shim');
  const hasNative = available.some(item => isNative(item.source));
  const multiple = Boolean(probe.nativeInstallCommand && probe.npmInstallCommand);
  const preferNative = probe.installCommand === probe.nativeInstallCommand;
  const problems = probe.dependencies.filter(item => item.status !== 'found');
  const versionKey = `${probe.tool}:${selected?.version ?? ''}`;
  const [retry, setRetry] = useState(0);
  const [latest, setLatest] = useState<{ state: 'loading' | 'ready' | 'unknown' | 'unsupported'; version: string }>({ state: 'loading', version: '' });
  useEffect(() => {
    if (probe.latestVersionSupported === false) { setLatest({ state: 'unsupported', version: '' }); return; }
    let live = true;
    setLatest({ state: 'loading', version: '' });
    void latestVersion(probe.tool, retry > 0).then((version) => {
      if (!live) return;
      const text = typeof version === 'string' ? version.trim() : '';
      setLatest(text ? { state: 'ready', version: text } : { state: 'unknown', version: '' });
    }).catch(() => { if (live) setLatest({ state: 'unknown', version: '' }); });
    return () => { live = false; };
  }, [probe.tool, versionKey, probe.latestVersionSupported, retry]);
  const currentVersion = selected?.version?.trim() ?? '';
  const behind = Boolean(selected && currentVersion && latest.state === 'ready' && compareVersions(currentVersion, latest.version) < 0);
  const current = !selected || latest.state !== 'ready' || !currentVersion ? false : compareVersions(currentVersion, latest.version) >= 0;
  const updateLabel = multiple ? (selected && isNative(selected.source) ? t('tools.install.updateNative') : t('tools.install.updateNpm')) : t('tools.install.update');
  // 未安装时默认展开检测面板；仅取初始值，用户折叠或安装成功后不再强制。
  const [startOpen] = useState(!selected);
  const latestNote = behind ? t('tools.install.canUpdate', { latest: latest.version }) : current ? t('tools.install.upToDate') : latest.state === 'loading' ? t('tools.install.querying') : t(latest.state === 'unsupported' ? 'tools.install.unsupportedVersion' : 'tools.install.unavailable');
  const summary = !selected
    ? t('tools.install.notInstalled')
    : latest.state === 'ready'
      ? (behind ? t('tools.install.currentLatest', { current: currentVersion, latest: latest.version }) : t('tools.install.currentUpToDate', { current: currentVersion }))
      : latest.state === 'loading'
        ? t('tools.install.checkingLatest', { current: currentVersion || t('tools.install.unknownVersion') })
        : t(latest.state === 'unsupported' ? 'tools.install.latestUnsupported' : 'tools.install.latestUnknown', { current: currentVersion || t('tools.install.unknownVersion') });
  return <details className={styles.pathControl} open={startOpen || undefined}>
    <summary><span className={styles.statusDot} data-ok={probe.nativeWrites.state === 'supported'} /><strong>{toolName}</strong><span>{selected || probe.nativeWrites.state === 'supported' ? summary : probe.nativeWrites.reason}</span><span className={styles.diagnosticLabel}>{t('tools.install.label')}</span></summary>
    {selected && <div className={styles.release}>
      <div>
        <span>{t('tools.install.currentVersion')}</span>
        <strong>{currentVersion || t('tools.install.unknown')}</strong>
        <small title={selected.path}>{sourceLabel(selected.source)} · {fileName(selected.path)}</small>
      </div>
      <div data-state={behind ? 'behind' : current ? 'current' : undefined}>
        <span>{t('tools.install.latestVersion')}</span>
        <strong>{latest.state === 'ready' ? latest.version : latest.state === 'loading' ? '…' : t(latest.state === 'unsupported' ? 'tools.install.officialVersion' : 'tools.install.notFound')}</strong>
        <small title={latestNote}>{latestNote}</small>
        {latest.state === 'unknown' && <button type="button" onClick={() => setRetry(value => value + 1)}>{t('tools.install.retryVersion')}</button>}
      </div>
    </div>}
    {available.filter(item => item.path !== selected?.path).map(item => <div className={styles.installRow} key={item.path}>
      <strong>{sourceLabel(item.source)}</strong>
      <span title={item.path}>{item.version ?? t('tools.install.unknownVersion')} · {fileName(item.path)}</span>
      <button type="button" disabled={busy} title={t('tools.install.useTitle')} onClick={() => onUsePath(item.path)}>{t('tools.install.use')}</button>
    </div>)}
    {failed.map(item => <p className={styles.installFail} key={item.path} title={item.detail ?? item.path}>{t('tools.install.runFailed', { file: fileName(item.path) })}</p>)}
    {hasNpm && hasNative && <p className={styles.installNote}>{t('tools.install.duplicatesNote')}</p>}
    {problems.map(item => <p className={styles.installNote} key={item.name}>{item.name} {item.status === 'outdated' ? t('tools.install.outdated') : t('tools.install.missing')}{item.helpUrl && <ExternalLink href={item.helpUrl}>{t('tools.install.installLink')}</ExternalLink>}</p>)}
    <div className={styles.installActions}>
      {!selected && multiple && <>
        <button type="button" className={preferNative ? styles.primary : undefined} disabled={busy} onClick={() => onMaintain('install_native', 'native')}>{t('tools.install.installNative')}</button>
        <button type="button" className={!preferNative ? styles.primary : undefined} disabled={busy} onClick={() => onMaintain('install', 'npm_shim')}>{t('tools.install.installNpm')}</button>
      </>}
      {selected && multiple && !hasNative && <button type="button" disabled={busy} onClick={() => onMaintain('install_native', 'native')}>{t('tools.install.installNative')}</button>}
      {!selected && !multiple && probe.installCommand && <button type="button" className={styles.primary} disabled={busy} onClick={() => onMaintain('install')}>{t('tools.install.install')}</button>}
      {selected && probe.upgradeCommand && (behind || latest.state === 'unknown' || latest.state === 'unsupported') && <button type="button" className={styles.primary} disabled={busy || loading} onClick={() => onMaintain('upgrade', selected.source)}>{updateLabel}</button>}
      {probe.installUrl && <ExternalLink href={probe.installUrl}>{t('tools.install.officialGuide')}</ExternalLink>}
    </div>
    <details className={styles.pathCustom}><summary>{t('tools.install.customPath')}</summary><div><input aria-label={t('tools.install.pathAria')} value={customPath} onChange={event => onCustomPath(event.target.value)} placeholder={t('tools.install.pathPlaceholder')} /><button type="button" disabled={busy} onClick={onSavePath}>{t('tools.install.saveAndRecheck')}</button></div></details>
  </details>;
}
