import { useRef } from 'react';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { ToastStack } from '../../components/Toast';
import { ToolIconSettings } from './ToolIconSettings';
import { TerminalSettings } from './TerminalSettings';
import { nativeAvailable } from '../../lib/native';
import { useToasts } from '../../lib/toast';
import type { Theme } from '../../types/domain';

type ToolItem = { id: string; name: string };

const themeChoices: { id: Theme; label: string; glyph: IconName }[] = [
  { id: 'system', label: '跟随系统', glyph: 'monitor' },
  { id: 'light', label: '浅色', glyph: 'sun' },
  { id: 'dark', label: '深色', glyph: 'moon' },
];

function ThemeChoice({ value, disabled, onChange }: { value: Theme; disabled: boolean; onChange: (theme: Theme) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function move(from: number, step: number) {
    const next = (from + step + themeChoices.length) % themeChoices.length;
    refs.current[next]?.focus();
    onChange(themeChoices[next].id);
  }
  return <div className="theme-choice" role="radiogroup" aria-label="主题">{themeChoices.map((item, index) => <button key={item.id} ref={(element) => { refs.current[index] = element; }} type="button" role="radio" aria-checked={value === item.id} tabIndex={value === item.id ? 0 : -1} disabled={disabled} onClick={() => onChange(item.id)} onKeyDown={(event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
  }}><Icon name={item.glyph} size={15} />{item.label}</button>)}</div>;
}

export function GeneralSettings({ tools, managed, preservedUnknown, icons, busy, theme, onThemeChange, onManagedChange, onIconChange, onIconError, onOpenMigration }: {
  tools: ToolItem[];
  managed: string[];
  preservedUnknown: { id: string; profileCount: number }[];
  icons: Record<string, string>;
  busy: boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onManagedChange: (id: string, checked: boolean) => void;
  onIconChange: (toolId: string, dataUrl: string | null) => Promise<void>;
  onIconError: (message: string) => void;
  onOpenMigration: () => void;
}) {
  const toasts = useToasts();
  async function handleIconChange(toolId: string, dataUrl: string | null) {
    try {
      await onIconChange(toolId, dataUrl);
      toasts.showNotice(dataUrl ? '工具图标已更新。' : '已恢复默认图标。');
    } catch { /* 失败原因由页面顶部错误条展示。 */ }
  }
  return <>
    <section className="settings-group">
      <div className="setting-intro"><h2>管理的 CLI</h2><p>首页、工具页与使用记录只显示勾选的工具。关闭管理不会删除已有配置。</p></div>
      <div className="managed-checks">{tools.map((item) => <label key={item.id}><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => onManagedChange(item.id, event.target.checked)} /><ToolIcon toolId={item.id} size={24} /><span>{item.name}</span></label>)}</div>
      <ToolIconSettings tools={tools} icons={icons} busy={busy} onChange={handleIconChange} onError={onIconError} />
      {preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>未安装适配器，保留 {item.profileCount} 份配置，只读</small></span></div>)}
    </section>
    <section className="settings-group">
      <div className="setting-intro"><h2>外观</h2><p>跟随系统，或固定浅色、深色。</p></div>
      <div className="setting-row"><span><strong>主题</strong><small>侧边栏底部也可以随时切换。</small></span><ThemeChoice value={theme} disabled={busy} onChange={(next) => { if (next !== theme) onThemeChange(next); }} /></div>
    </section>
    {nativeAvailable && <TerminalSettings />}
    <div className="setting-row migration-entry"><span><strong>换设备与备份</strong><small>导出加密配置包，或通过 WebDAV 同步</small></span><button className="button" type="button" onClick={onOpenMigration}>迁移与同步 →</button></div>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </>;
}
