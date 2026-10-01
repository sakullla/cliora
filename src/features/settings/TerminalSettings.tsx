import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchMode, LaunchSettings, TerminalId, TrayStatus } from '../../types/launch';

function message(error: unknown): string {
  const detail = error && typeof error === 'object' && 'message' in error && String(error.message).trim()
    ? String(error.message).trim().replace(/[。！？\s]+$/, '')
    : '终端设置暂时不可用';
  return detail.includes('重新选择终端') ? detail : `${detail}。可以重新选择终端。`;
}

export function TerminalSettings() {
  const [settings, setSettings] = useState<LaunchSettings | null>(null);
  const [tray, setTray] = useState<TrayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!nativeAvailable) return;
    void Promise.all([native.getLaunchSettings(), native.getTrayStatus()]).then(([launch, trayStatus]) => { setSettings(launch); setTray(trayStatus); }).catch((value) => setError(message(value)));
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void listen<string>('cliora:tray-error', (event) => {
      if (active) void native.getTrayStatus().then((status) => setTray({ ...status, error: event.payload }));
    }).then((stop) => { if (active) unsubscribe = stop; else stop(); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);

  async function choose(terminal: TerminalId) {
    setBusy(true); setError('');
    try { setSettings(await native.setPreferredTerminal(terminal)); }
    catch (value) { setError(message(value)); }
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
    <label className="setting-row"><span><strong>启动终端</strong><small>默认选用本机可用终端</small></span><select aria-label="启动终端" value={settings?.selected ?? 'auto'} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void choose(event.target.value as TerminalId)}>{(settings?.terminals ?? [{ id: 'auto' as TerminalId, label: '系统默认', available: false }]).map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? '' : ' · 不可用'}</option>)}</select></label>
    <label className="setting-row"><span><strong>CLI 默认模式</strong><small>工具列表和直接启动使用。YOLO 按该 CLI 的原生参数跳过审批。</small></span><select aria-label="CLI 默认启动模式" value={settings?.cliMode ?? 'normal'} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void chooseMode('cli', event.target.value as LaunchMode)}><option value="normal">普通模式</option><option value="yolo">YOLO 模式</option></select></label>
    <label className="setting-row"><span><strong>项目默认模式</strong><small>项目卡片和托盘最近项目使用。此 CLI 没有 YOLO 参数时仍用普通模式。</small></span><select aria-label="项目默认启动模式" value={settings?.projectMode ?? 'normal'} disabled={!nativeAvailable || busy || !settings} onChange={(event) => void chooseMode('project', event.target.value as LaunchMode)}><option value="normal">普通模式</option><option value="yolo">YOLO 模式</option></select></label>
    {error && <p role="alert" style={{ color: 'var(--danger)', padding: '0 20px 16px' }}>{error}</p>}
    <div className="setting-row"><span><strong>关闭与托盘</strong><small>{tray?.error ?? (tray?.available ? '关闭窗口后，栖点留在托盘中；已启动的 CLI 独立运行。' : '正在检查托盘状态')}</small></span><button type="button" className="button" disabled={!nativeAvailable} onClick={() => void native.quitApp()}>完全退出</button></div>
  </section>;
}
