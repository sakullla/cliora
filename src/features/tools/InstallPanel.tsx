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
  const { t } = useTranslation();
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
  const updateLabel = multiple ? (selected && isNative(selected.source) ? t('tools.install.updateNative') : t('tools.install.updateNpm')) : t('tools.install.update');
  const summary = !selected
    ? t('tools.install.notInstalled')
    : latest.state === 'ready'
      ? (behind ? t('tools.install.currentLatest', { current: currentVersion, latest: latest.version }) : t('tools.install.currentUpToDate', { current: currentVersion }))
      : latest.state === 'loading'
        ? t('tools.install.checkingLatest', { current: currentVersion || t('tools.install.unknownVersion') })
        : t('tools.install.latestUnknown', { current: currentVersion || t('tools.install.unknownVersion') });
  return <details className={styles.pathControl}>
    <summary><span className={styles.statusDot} data-ok={probe.nativeWrites.state === 'supported'} /><strong>{toolName}</strong><span>{selected || probe.nativeWrites.state === 'supported' ? summary : probe.nativeWrites.reason}</span><span className={styles.diagnosticLabel}>{t('tools.install.label')}</span></summary>
    {selected && <div className={styles.release}>
      <div>
        <span>{t('tools.install.currentVersion')}</span>
        <strong>{currentVersion || t('tools.install.unknown')}</strong>
        <small>{sourceLabel(selected.source)} · {fileName(selected.path)}</small>
      </div>
      <div data-state={behind ? 'behind' : current ? 'current' : undefined}>
        <span>{t('tools.install.latestVersion')}</span>
        <strong>{latest.state === 'ready' ? latest.version : latest.state === 'loading' ? '…' : t('tools.install.notFound')}</strong>
        <small>{behind ? t('tools.install.canUpdate', { latest: latest.version }) : current ? t('tools.install.upToDate') : latest.state === 'loading' ? t('tools.install.querying') : t('tools.install.unavailable')}</small>
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
        <button type="button" disabled={busy} onClick={() => onMaintain('install_native', 'native')}>{t('tools.install.installNative')}</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => onMaintain('install', 'npm_shim')}>{t('tools.install.installNpm')}</button>
      </>}
      {!selected && !multiple && probe.installCommand && <button type="button" className={styles.primary} disabled={busy} onClick={() => onMaintain('install')}>{t('tools.install.install')}</button>}
      {behind && probe.upgradeCommand && <button type="button" className={styles.primary} disabled={busy || loading} onClick={() => onMaintain('upgrade', selected?.source)}>{updateLabel}</button>}
      {probe.installUrl && <ExternalLink href={probe.installUrl}>{t('tools.install.officialGuide')}</ExternalLink>}
    </div>
    <details className={styles.pathCustom}><summary>{t('tools.install.customPath')}</summary><div><input aria-label={t('tools.install.pathAria')} value={customPath} onChange={event => onCustomPath(event.target.value)} placeholder={t('tools.install.pathPlaceholder')} /><button type="button" disabled={busy} onClick={onSavePath}>{t('tools.install.saveAndRecheck')}</button></div></details>
  </details>;
}
