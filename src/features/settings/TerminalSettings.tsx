import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open as pickPath } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchMode, LaunchSettings, TerminalId, TerminalPreset, TrayStatus } from '../../types/launch';
import i18n from '../../i18n';

function matchedPreset(current: LaunchSettings | null) {
  // Custom commands remain saved when another terminal becomes the active choice.
  if (current?.selected !== 'custom' || !current.custom) return null;
  const args = current.custom.args.join('\n');
  return (current.presets ?? []).find((preset) => preset.program === current.custom?.program && preset.args.join('\n') === args) ?? null;
}

function message(error: unknown): string {
  const detail = error && typeof error === 'object' && 'message' in error && String(error.message).trim()
    ? String(error.message).trim().replace(/[。！？\s]+$/, '')
    : i18n.t('settings.terminal.unavailable');
  return detail.includes('重新选择终端') ? detail : i18n.t('settings.terminal.repickSuffix', { detail });
}

function loadFailure(error: unknown): string {
  const raw = error && typeof error === 'object' && 'message' in error && String(error.message).trim()
    ? String(error.message).trim()
    : '';
  const action = error && typeof error === 'object' && typeof (error as { action?: unknown }).action === 'string'
    ? String((error as { action: string }).action).trim()
    : '';
  const usable = !!action && !/^请重试[。！]?$/.test(action) && !action.includes('重新选择终端');
  const fallback = i18n.t('settings.terminal.readFailed');
  const detail = (raw || fallback).replace(/可以重新选择终端。?/g, '').replace(/重新选择终端/g, '').replace(/[。！？\s]+$/, '');
  const next = (usable ? action : i18n.t('settings.terminal.reloadHint')).replace(/[。！？\s]+$/, '');
  return i18n.t('settings.terminal.failureTemplate', { detail: detail || fallback, next });
}

export function TerminalSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LaunchSettings | null>(null);
  const [tray, setTray] = useState<TrayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [program, setProgram] = useState('');
  const [argsText, setArgsText] = useState('{script}');
  const [showCustom, setShowCustom] = useState(false);

  useEffect(() => {
    if (!nativeAvailable) return;
    void Promise.all([native.getLaunchSettings(), native.getTrayStatus()]).then(([launch, trayStatus]) => {
      setSettings(launch);
      setTray(trayStatus);
      setProgram(launch.custom?.program ?? '');
      setArgsText((launch.custom?.args ?? ['{script}']).join('\n'));
      setShowCustom(launch.selected === 'custom' && !matchedPreset(launch));
    }).catch((value) => setError(loadFailure(value)));
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void listen<string>('cliora:tray-error', (event) => {
      if (active) void native.getTrayStatus().then((status) => setTray({ ...status, error: event.payload }));
    }).then((stop) => { if (active) unsubscribe = stop; else stop(); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);

  function selectionKey() {
    if (showCustom || !settings) return showCustom ? 'custom' : 'auto';
    const preset = matchedPreset(settings);
    return preset ? `preset:${preset.id}` : settings.selected;
  }

  async function choose(value: string) {
    if (value === 'custom') { setShowCustom(true); return; }
    setShowCustom(false);
    setBusy(true); setError('');
    try {
      if (value.startsWith('preset:')) {
        const preset = (settings?.presets ?? []).find((item) => item.id === value.slice('preset:'.length));
        if (!preset) return;
        const next = await native.setCustomTerminal(preset.program, preset.args);
        setSettings(next);
        setProgram(next.custom?.program ?? preset.program);
        setArgsText((next.custom?.args ?? preset.args).join('\n'));
        return;
      }
      setSettings(await native.setPreferredTerminal(value as TerminalId));
    } catch (value) { setError(message(value as unknown)); }
    finally { setBusy(false); }
  }

  async function pickProgram() {
    try {
      const picked = await pickPath({ directory: false, multiple: false, title: t('settings.terminal.pickProgramTitle') });
      if (typeof picked !== 'string') return;
      setProgram(picked);
      setShowCustom(true);
      const preset = (settings?.presets ?? []).find((item) => item.program === picked);
      if (preset) setArgsText(preset.args.join('\n'));
    } catch (value) { setError(message(value)); }
  }

  async function saveCustom() {
    setBusy(true); setError('');
    try {
      const next = await native.setCustomTerminal(program, argsText.split(/\r?\n/));
      setSettings(next);
      setProgram(next.custom?.program ?? program);
      setArgsText((next.custom?.args ?? ['{script}']).join('\n'));
      setShowCustom(true);
    } catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }

  async function chooseMode(target: 'cli' | 'project', mode: LaunchMode) {
    setBusy(true); setError('');
    try { setSettings(await native.setDefaultLaunchMode(target, mode)); }
    catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }

  return <section className="settings-group" aria-label={t('settings.terminal.title')}>
    <div className="setting-intro"><h2>{t('settings.terminal.title')}</h2><p>{t('settings.terminal.description')}</p></div>
    <label className="setting-row"><span><strong>{t('settings.terminal.launch')}</strong><small>{t('settings.terminal.launchHint')}</small></span><select aria-label={t('settings.terminal.launch')} value={selectionKey()} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void choose(event.target.value)}>{(settings?.terminals ?? [{ id: 'auto' as TerminalId, label: t('settings.terminal.systemDefault'), available: false }]).filter((item) => item.id !== 'custom').map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? '' : t('settings.terminal.unavailableSuffix')}</option>)}{(settings?.presets ?? []).map((item: TerminalPreset) => <option key={item.id} value={`preset:${item.id}`}>{item.label}</option>)}<option value="custom">{t('settings.terminal.custom')}</option></select></label>
    {selectionKey() === 'custom' && <div className="setting-row setting-row-top"><span><strong>{t('settings.terminal.customCommand')}</strong><small>{t('settings.terminal.customHint')}</small></span><span className="custom-terminal-fields"><input aria-label={t('settings.terminal.program')} value={program} onChange={(event) => setProgram(event.target.value)} placeholder="/Applications/Tabby.app" /><textarea aria-label={t('settings.terminal.args')} rows={4} value={argsText} onChange={(event) => setArgsText(event.target.value)} /><span className="custom-terminal-actions"><button type="button" className="button" disabled={!nativeAvailable || busy} onClick={() => void pickProgram()}>{t('settings.terminal.pickProgram')}</button><button type="button" className="button" disabled={!nativeAvailable || busy || !program.trim()} onClick={() => void saveCustom()}>{t('settings.terminal.useCommand')}</button></span></span></div>}
    <label className="setting-row"><span><strong>{t('settings.terminal.cliMode')}</strong><small>{t('settings.terminal.cliModeHint')}</small></span><select aria-label={t('settings.terminal.cliModeAria')} value={settings?.cliMode ?? 'normal'} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void chooseMode('cli', event.target.value as LaunchMode)}><option value="normal">{t('settings.terminal.modeNormal')}</option><option value="yolo">{t('settings.terminal.modeYolo')}</option></select></label>
    <label className="setting-row"><span><strong>{t('settings.terminal.projectMode')}</strong><small>{t('settings.terminal.projectModeHint')}</small></span><select aria-label={t('settings.terminal.projectModeAria')} value={settings?.projectMode ?? 'normal'} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void chooseMode('project', event.target.value as LaunchMode)}><option value="normal">{t('settings.terminal.modeNormal')}</option><option value="yolo">{t('settings.terminal.modeYolo')}</option></select></label>
    {error && <p role="alert" className="setting-error">{error}</p>}
    <div className="setting-row"><span><strong>{t('settings.terminal.tray')}</strong><small>{tray?.error ?? (tray?.available ? t('settings.terminal.trayAvailable') : t('settings.terminal.trayChecking'))}</small></span><button type="button" className="button" disabled={!nativeAvailable} onClick={() => void native.quitApp()}>{t('settings.terminal.quit')}</button></div>
  </section>;
}
