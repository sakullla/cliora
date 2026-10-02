import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open as pickPath } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchMode, LaunchSettings, TerminalId, TerminalPreset, TrayStatus } from '../../types/launch';

function matchedPreset(current: LaunchSettings | null) {
  if (!current?.custom) return null;
  const args = current.custom.args.join('\n');
  return (current.presets ?? []).find((preset) => preset.program === current.custom?.program && preset.args.join('\n') === args) ?? null;
}

function message(error: unknown): string {
  const detail = error && typeof error === 'object' && 'message' in error && String(error.message).trim()
    ? String(error.message).trim().replace(/[。！？\s]+$/, '')
    : '终端设置暂时不可用';
  return detail.includes('重新选择终端') ? detail : `${detail}。可以重新选择终端。`;
}

function loadFailure(error: unknown): string {
  const raw = error && typeof error === 'object' && 'message' in error && String(error.message).trim()
    ? String(error.message).trim()
    : '';
  const action = error && typeof error === 'object' && typeof (error as { action?: unknown }).action === 'string'
    ? String((error as { action: string }).action).trim()
    : '';
  const usable = !!action && !/^请重试[。！]?$/.test(action) && !action.includes('重新选择终端');
  const detail = (raw || '终端设置读取失败').replace(/可以重新选择终端。?/g, '').replace(/重新选择终端/g, '').replace(/[。！？\s]+$/, '');
  const next = (usable ? action : '可先打开「迁移与同步」，再回到「常规」重新读取').replace(/[。！？\s]+$/, '');
  return `${detail || '终端设置读取失败'}。${next}。`;
}

export function TerminalSettings() {
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
      const picked = await pickPath({ directory: false, multiple: false, title: '选择终端程序' });
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

  return <section className="settings-group" aria-label="外部终端">
    <div className="setting-intro"><h2>外部终端</h2><p>新会话在选定终端打开。关闭栖点不会结束已启动的 CLI。</p></div>
    <label className="setting-row"><span><strong>启动终端</strong><small>系统默认使用本机终端。其他应用选已识别的项，或自定义命令。参数里保留单独一行的 {'{script}'}。</small></span><select aria-label="启动终端" value={selectionKey()} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void choose(event.target.value)}>{(settings?.terminals ?? [{ id: 'auto' as TerminalId, label: '系统默认', available: false }]).filter((item) => item.id !== 'custom').map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? '' : ' · 不可用'}</option>)}{(settings?.presets ?? []).map((item: TerminalPreset) => <option key={item.id} value={`preset:${item.id}`}>{item.label}</option>)}<option value="custom">自定义</option></select></label>
    {selectionKey() === 'custom' && <div className="setting-row" style={{ alignItems: 'start' }}><span><strong>自定义命令</strong><small>程序是终端的可执行文件。参数按行填写，其中一行必须是 {'{script}'}。</small></span><span style={{ display: 'grid', gap: 8, justifyItems: 'stretch', minWidth: 280 }}><input aria-label="终端程序" value={program} onChange={(event) => setProgram(event.target.value)} placeholder="/Applications/Tabby.app" /><textarea aria-label="终端参数" rows={4} value={argsText} onChange={(event) => setArgsText(event.target.value)} /><span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="button" disabled={!nativeAvailable || busy} onClick={() => void pickProgram()}>选择程序</button><button type="button" className="button" disabled={!nativeAvailable || busy || !program.trim()} onClick={() => void saveCustom()}>使用这个命令</button></span></span></div>}
    <label className="setting-row"><span><strong>CLI 默认模式</strong><small>工具列表和直接启动使用。YOLO 按该 CLI 的原生参数跳过审批。</small></span><select aria-label="CLI 默认启动模式" value={settings?.cliMode ?? 'normal'} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void chooseMode('cli', event.target.value as LaunchMode)}><option value="normal">普通模式</option><option value="yolo">YOLO 模式</option></select></label>
    <label className="setting-row"><span><strong>项目默认模式</strong><small>项目卡片和托盘最近项目使用。此 CLI 没有 YOLO 参数时仍用普通模式。</small></span><select aria-label="项目默认启动模式" value={settings?.projectMode ?? 'normal'} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void chooseMode('project', event.target.value as LaunchMode)}><option value="normal">普通模式</option><option value="yolo">YOLO 模式</option></select></label>
    {error && <p role="alert" style={{ color: 'var(--danger)', padding: '0 20px 16px' }}>{error}</p>}
    <div className="setting-row"><span><strong>关闭与托盘</strong><small>{tray?.error ?? (tray?.available ? '关闭窗口后，栖点留在托盘中；已启动的 CLI 独立运行。' : '正在检查托盘状态')}</small></span><button type="button" className="button" disabled={!nativeAvailable} onClick={() => void native.quitApp()}>完全退出</button></div>
  </section>;
}
