import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open as pickPath } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable, setLaunchInteraction } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  setTerminalCursorBlink,
  setTerminalDensity,
  setTerminalFontSize,
  setTerminalScrollSpeed,
  setTerminalSoundEnabled,
  setTerminalThemePreference,
  useTerminalPreferences,
  type TerminalDensity,
  type TerminalScrollSpeed,
  type TerminalThemePreference,
} from '../../lib/terminalPreferences';
import { Icon } from '../../components/Icon';
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect';
import { Button, Segmented, Switch } from '../../components/ui';
import type { InteractionMode, LaunchMode, LaunchSettings, TerminalId, TerminalPreset, TrayStatus } from '../../types/launch';
import i18n from '../../i18n';

function matchedPreset(current: LaunchSettings | null) {
  // Custom commands remain saved when another terminal becomes the active choice.
  if (current?.selected !== 'custom' || !current.custom) return null;
  const args = current.custom.args.join('\n');
  return (current.presets ?? []).find((preset) => preset.program === current.custom?.program && preset.args.join('\n') === args) ?? null;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
}

function message(error: unknown): string {
  const detail = error && typeof error === 'object' && 'message' in error && String(error.message).trim()
    ? String(error.message).trim().replace(/[。！？\s]+$/, '')
    : i18n.t('settings.terminal.unavailable');
  // The CMD-length error carries its own recovery advice, so the generic repick hint
  // must not be appended. Recognize it by code first; the text check stays as the
  // fallback for payloads without a code.
  const selfRecovering = errorCode(error) === 'terminal_command_too_long' || detail.includes('重新选择终端');
  return selfRecovering ? detail : i18n.t('settings.terminal.repickSuffix', { detail });
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

/** The launch terminal is a filterable list: system terminals, saved presets, and the custom command. */
export function TerminalSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LaunchSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [program, setProgram] = useState('');
  const [argsText, setArgsText] = useState('{script}');
  const [showCustom, setShowCustom] = useState(false);
  const [saved, setSaved] = useState('');
  /** A start-mode write that failed, kept so the row can offer the same choice again. */
  const [failedInteraction, setFailedInteraction] = useState<InteractionMode | null>(null);

  // A write is only announced after the backend returned the stored settings.
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(''), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (!nativeAvailable) return;
    void native.getLaunchSettings().then((launch) => {
      setSettings(launch);
      setProgram(launch.custom?.program ?? '');
      setArgsText((launch.custom?.args ?? ['{script}']).join('\n'));
      setShowCustom(launch.selected === 'custom' && !matchedPreset(launch));
    }).catch((value) => setError(loadFailure(value)));
  }, []);

  function selectionKey() {
    if (showCustom) return 'custom';
    if (!settings || settings.selected === 'auto' || settings.selected === 'workbench') return 'workbench';
    const preset = matchedPreset(settings);
    return preset ? `preset:${preset.id}` : settings.selected;
  }

  function terminalOptions(): FilterSelectOption[] {
    const source = settings?.terminals?.length
      ? settings.terminals
      : [{ id: 'workbench' as TerminalId, label: t('settings.terminal.workbench'), available: true }];
    const visible = source.filter((item) => item.id !== 'custom');
    if (!visible.some((item) => item.id === 'workbench')) visible.unshift({ id: 'workbench', label: t('settings.terminal.workbench'), available: true });
    return [
      ...visible.map((item) => ({
        value: item.id,
        label: item.label,
        detail: item.available ? undefined : t('settings.terminal.unavailableNote'),
        disabled: !item.available,
      })),
      ...(settings?.presets ?? []).map((item: TerminalPreset) => ({ value: `preset:${item.id}`, label: item.label, detail: item.program })),
      { value: 'custom', label: t('settings.terminal.custom'), detail: t('settings.terminal.customDetail') },
    ];
  }

  async function choose(value: string) {
    if (value === 'custom') { setShowCustom(true); return; }
    setShowCustom(false);
    setBusy(true); setError('');
    const terminal = value === 'auto' ? 'workbench' : value;
    try {
      if (terminal.startsWith('preset:')) {
        const preset = (settings?.presets ?? []).find((item) => item.id === terminal.slice('preset:'.length));
        if (!preset) return;
        const next = await native.setCustomTerminal(preset.program, preset.args);
        setSettings(next);
        setProgram(next.custom?.program ?? preset.program);
        setArgsText((next.custom?.args ?? preset.args).join('\n'));
        setSaved(t('settings.terminal.saved'));
        return;
      }
      setSettings(await native.setPreferredTerminal(terminal as TerminalId));
      setSaved(t('settings.terminal.saved'));
    } catch (value) { setSaved(''); setError(message(value as unknown)); }
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
      setSaved(t('settings.terminal.saved'));
    } catch (value) { setSaved(''); setError(message(value)); }
    finally { setBusy(false); }
  }

  async function chooseMode(target: 'cli' | 'project', mode: LaunchMode) {
    setBusy(true); setError('');
    try {
      setSettings(await native.setDefaultLaunchMode(target, mode));
      setSaved(t('settings.terminal.saved'));
    }
    catch (value) { setSaved(''); setError(message(value)); }
    finally { setBusy(false); }
  }

  /** A stored value the backend cannot recognize reads as a terminal; nothing is rewritten. */
  const interactionValue: InteractionMode = settings?.interactionError ? 'terminal' : settings?.interaction === 'acp' ? 'acp' : 'terminal';
  const writesDisabled = !nativeAvailable || busy || !settings;

  /** Only later launches follow this: an open session keeps the way it was started. */
  async function chooseInteraction(mode: InteractionMode) {
    if (writesDisabled || mode === interactionValue) return;
    setBusy(true); setError(''); setFailedInteraction(null);
    try {
      setSettings(await setLaunchInteraction(mode));
      setSaved(t('settings.terminal.saved'));
    } catch (value) {
      setSaved('');
      setFailedInteraction(mode);
      // The terminal-specific recovery advice (re-pick a terminal) does not apply here.
      const detail = value && typeof value === 'object' && 'message' in value && String(value.message).trim()
        ? String(value.message).trim().replace(/[。！？\s]+$/, '')
        : '';
      setError(detail || t('settings.terminal.interactionSaveFailed'));
    } finally { setBusy(false); }
  }
  const interactionOptions = [
    { value: 'terminal' as InteractionMode, label: t('settings.terminal.interactionTerminal'), disabled: writesDisabled },
    { value: 'acp' as InteractionMode, label: t('settings.terminal.interactionAcp'), disabled: writesDisabled },
  ];
  const modeOptions = [
    { value: 'normal' as LaunchMode, label: t('settings.terminal.modeNormal'), disabled: writesDisabled },
    { value: 'yolo' as LaunchMode, label: t('settings.terminal.modeYolo'), disabled: writesDisabled },
  ];

  return <section className="settings-group" id="settings-terminal" aria-label={t('settings.terminal.title')}>
    <div className="setting-intro"><h2>{t('settings.terminal.title')}</h2><p>{t('settings.terminal.description')}</p>{saved && <span className="setting-saved" role="status"><Icon name="check" size={13} />{saved}</span>}</div>
    <div className="setting-row"><span><strong>{t('settings.terminal.launch')}</strong><small>{t('settings.terminal.launchHint')}</small></span><FilterSelect className="setting-select" label={t('settings.terminal.launch')} value={selectionKey()} options={terminalOptions()} disabled={writesDisabled} searchable={false} onChange={(value) => void choose(value)} /></div>
    {selectionKey() === 'custom' && <div className="setting-row setting-row-top"><span><strong>{t('settings.terminal.customCommand')}</strong><small>{t('settings.terminal.customHint')}</small></span><span className="custom-terminal-fields"><input aria-label={t('settings.terminal.program')} value={program} onChange={(event) => setProgram(event.target.value)} placeholder="/Applications/Tabby.app" /><textarea aria-label={t('settings.terminal.args')} rows={4} value={argsText} onChange={(event) => setArgsText(event.target.value)} /><span className="custom-terminal-actions"><Button disabled={!nativeAvailable || busy} onClick={() => void pickProgram()}>{t('settings.terminal.pickProgram')}</Button><Button disabled={!nativeAvailable || busy || !program.trim()} onClick={() => void saveCustom()}>{t('settings.terminal.useCommand')}</Button></span></span></div>}
    <div className="setting-row"><span><strong>{t('settings.terminal.interaction')}</strong><small>{t('settings.terminal.interactionHint')}</small></span><Segmented label={t('settings.terminal.interactionAria')} value={interactionValue} options={interactionOptions} onChange={(mode) => void chooseInteraction(mode)} /></div>
    {settings?.interactionError && <p role="alert" className="setting-error">{t('settings.terminal.interactionUnknown')}</p>}
    {failedInteraction && <p role="alert" className="setting-error">{error}<Button size="sm" variant="ghost" onClick={() => void chooseInteraction(failedInteraction)}>{t('settings.terminal.interactionRetry')}</Button></p>}
    <div className="setting-row"><span><strong>{t('settings.terminal.cliMode')}</strong><small>{t('settings.terminal.cliModeHint')}</small></span><Segmented label={t('settings.terminal.cliModeAria')} value={settings?.cliMode ?? 'normal'} options={modeOptions} onChange={(mode) => void chooseMode('cli', mode)} /></div>
    <div className="setting-row"><span><strong>{t('settings.terminal.projectMode')}</strong><small>{t('settings.terminal.projectModeHint')}</small></span><Segmented label={t('settings.terminal.projectModeAria')} value={settings?.projectMode ?? 'normal'} options={modeOptions} onChange={(mode) => void chooseMode('project', mode)} /></div>
    {error && !failedInteraction && <p role="alert" className="setting-error">{error}</p>}
  </section>;
}

/** Workbench display preferences write local storage through the shared store, so a
 *  mounted workbench reacts while the settings dialog stays open — and vice versa. */
export function TerminalDisplaySettings() {
  const { t } = useTranslation();
  const prefs = useTerminalPreferences();
  const themes = [
    { value: 'auto' as TerminalThemePreference, label: t('sessions.termThemeAuto') },
    { value: 'dark' as TerminalThemePreference, label: t('sessions.termThemeDark') },
    { value: 'light' as TerminalThemePreference, label: t('sessions.termThemeLight') },
  ];
  const densities = [
    { value: 'compact' as TerminalDensity, label: t('sessions.lineCompact') },
    { value: 'standard' as TerminalDensity, label: t('sessions.lineStandard') },
    { value: 'relaxed' as TerminalDensity, label: t('sessions.lineRelaxed') },
  ];
  const speeds = [
    { value: 'slow' as TerminalScrollSpeed, label: t('sessions.scrollSlow') },
    { value: 'standard' as TerminalScrollSpeed, label: t('sessions.scrollStandard') },
    { value: 'fast' as TerminalScrollSpeed, label: t('sessions.scrollFast') },
  ];
  return <section className="settings-group" id="settings-terminal-display" aria-label={t('settings.terminal.display')}>
    <div className="setting-intro"><h2>{t('settings.terminal.display')}</h2><p>{t('settings.terminal.displayHint')}</p></div>
    <div className="setting-row"><span><strong>{t('sessions.terminalColors')}</strong><small>{t('settings.terminal.colorsHint')}</small></span><Segmented label={t('sessions.terminalColors')} value={prefs.theme} options={themes} onChange={setTerminalThemePreference} /></div>
    <div className="setting-row"><span><strong>{t('sessions.fontSize')}</strong><small>{t('settings.terminal.fontSizeHint', { size: TERMINAL_FONT_SIZE_DEFAULT })}</small></span>
      <span className="term-stepper" role="group" aria-label={t('sessions.fontSize')}>
        <Button variant="ghost" size="sm" disabled={prefs.fontSize <= TERMINAL_FONT_SIZE_MIN} aria-label={t('sessions.fontSizeDown')} title={t('sessions.fontSizeDown')} onClick={() => setTerminalFontSize(prefs.fontSize - 1)} icon={<span aria-hidden="true">−</span>} />
        <button type="button" className="term-stepper-value" aria-label={t('sessions.fontSizeReset', { size: TERMINAL_FONT_SIZE_DEFAULT })} title={t('sessions.fontSizeReset', { size: TERMINAL_FONT_SIZE_DEFAULT })} onClick={() => setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT)}>{prefs.fontSize}<small>px</small></button>
        <Button variant="ghost" size="sm" disabled={prefs.fontSize >= TERMINAL_FONT_SIZE_MAX} aria-label={t('sessions.fontSizeUp')} title={t('sessions.fontSizeUp')} onClick={() => setTerminalFontSize(prefs.fontSize + 1)} icon={<Icon name="plus" size={13} />} />
      </span>
    </div>
    <div className="setting-row"><span><strong>{t('sessions.lineHeight')}</strong><small>{t('settings.terminal.densityHint')}</small></span><Segmented label={t('sessions.lineHeight')} value={prefs.density} options={densities} onChange={setTerminalDensity} /></div>
    <div className="setting-row"><span><strong>{t('sessions.scrollSpeed')}</strong><small>{t('settings.terminal.scrollSpeedHint')}</small></span><Segmented label={t('sessions.scrollSpeed')} value={prefs.scrollSpeed} options={speeds} onChange={setTerminalScrollSpeed} /></div>
    <label className="setting-row"><span><strong>{t('sessions.cursorBlink')}</strong><small>{t('settings.terminal.cursorBlinkHint')}</small></span><Switch aria-label={t('sessions.cursorBlink')} checked={prefs.cursorBlink} onChange={setTerminalCursorBlink} /></label>
    <label className="setting-row"><span><strong>{t('sessions.sound')}</strong><small>{t('settings.terminal.soundHint')}</small></span><Switch aria-label={t('sessions.sound')} checked={prefs.soundEnabled} onChange={setTerminalSoundEnabled} /></label>
  </section>;
}

/** Closing the window keeps Cliora in the tray; quitting fully is an explicit, confirmed action. */
export function TraySettings() {
  const { t } = useTranslation();
  const [tray, setTray] = useState<TrayStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!nativeAvailable) return;
    void native.getTrayStatus().then(setTray).catch((value) => setError(message(value)));
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void listen<string>('cliora:tray-error', (event) => {
      if (active) void native.getTrayStatus().then((status) => setTray({ ...status, error: event.payload }));
    }).then((stop) => { if (active) unsubscribe = stop; else stop(); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);
  async function quitApp() {
    const accepted = await confirmAction(t('settings.terminal.quitMessage'), () => true, { title: t('settings.terminal.quitTitle'), confirmLabel: t('settings.terminal.quit'), destructive: true });
    if (!accepted) return;
    try { await native.quitApp(); }
    catch (value) { setError(message(value)); }
  }
  return <section className="settings-group" id="settings-tray" aria-label={t('settings.terminal.tray')}>
    <div className="setting-row"><span><strong>{t('settings.terminal.tray')}</strong><small>{error || tray?.error || (tray?.available ? t('settings.terminal.trayAvailable') : t('settings.terminal.trayChecking'))}</small></span><Button disabled={!nativeAvailable} onClick={() => void quitApp()}>{t('settings.terminal.quit')}</Button></div>
  </section>;
}
