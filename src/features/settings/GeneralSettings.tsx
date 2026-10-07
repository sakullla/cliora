import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { ToastStack } from '../../components/Toast';
import { ToolIconSettings } from './ToolIconSettings';
import { TerminalSettings } from './TerminalSettings';
import { nativeAvailable } from '../../lib/native';
import { useToasts } from '../../lib/toast';
import { setLanguage, supportedLanguages, type AppLanguage } from '../../i18n';
import type { Theme } from '../../types/domain';
import styles from './GeneralSettings.module.css';

type ToolItem = { id: string; name: string };

const themeGlyphs: Record<Theme, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const themeOrder: Theme[] = ['system', 'light', 'dark'];

function ThemeChoice({ value, disabled, onChange }: { value: Theme; disabled: boolean; onChange: (theme: Theme) => void }) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function move(from: number, step: number) {
    const next = (from + step + themeOrder.length) % themeOrder.length;
    refs.current[next]?.focus();
    onChange(themeOrder[next]);
  }
  return <div className="theme-choice" role="radiogroup" aria-label={t('settings.theme.label')}>{themeOrder.map((id, index) => <button key={id} ref={(element) => { refs.current[index] = element; }} type="button" role="radio" aria-checked={value === id} tabIndex={value === id ? 0 : -1} disabled={disabled} onClick={() => onChange(id)} onKeyDown={(event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
  }}><Icon name={themeGlyphs[id]} size={15} />{t(`settings.theme.${id}`)}</button>)}</div>;
}

function LanguageChoice({ value, disabled }: { value: AppLanguage; disabled: boolean }) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function choose(language: AppLanguage) {
    if (language !== value) setLanguage(language);
  }
  function move(from: number, step: number) {
    const next = (from + step + supportedLanguages.length) % supportedLanguages.length;
    refs.current[next]?.focus();
    choose(supportedLanguages[next]);
  }
  return <div className={styles.languageChoice} role="radiogroup" aria-label={t('settings.language.label')}>{supportedLanguages.map((id, index) => <button key={id} ref={(element) => { refs.current[index] = element; }} type="button" role="radio" aria-checked={value === id} tabIndex={value === id ? 0 : -1} disabled={disabled} onClick={() => choose(id)} onKeyDown={(event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
  }}>{t(`common.language.${id}`)}</button>)}</div>;
}

export function GeneralSettings({ tools, managed, preservedUnknown, icons, busy, theme, onThemeChange, onManagedChange, onIconChange, onIconError, onOpenMigration, onOpenShortcutHelp }: {
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
  onOpenShortcutHelp: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const language: AppLanguage = i18n.language === 'en' ? 'en' : 'zh';
  async function handleIconChange(toolId: string, dataUrl: string | null) {
    try {
      await onIconChange(toolId, dataUrl);
      toasts.showNotice(dataUrl ? t('settings.icons.updated') : t('settings.icons.restored'));
    } catch { /* 失败原因由页面顶部错误条展示。 */ }
  }
  return <>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.managed.title')}</h2><p>{t('settings.managed.description')}</p></div>
      <div className="managed-checks">{tools.map((item) => <label key={item.id}><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => onManagedChange(item.id, event.target.checked)} /><ToolIcon toolId={item.id} size={24} /><span>{item.name}</span></label>)}</div>
      <ToolIconSettings tools={tools} icons={icons} busy={busy} onChange={handleIconChange} onError={onIconError} />
      {preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>{t('settings.managed.preservedUnknown', { count: item.profileCount })}</small></span></div>)}
    </section>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.appearance.title')}</h2><p>{t('settings.appearance.description')}</p></div>
      <div className="setting-row"><span><strong>{t('settings.theme.label')}</strong><small>{t('settings.theme.hint')}</small></span><ThemeChoice value={theme} disabled={busy} onChange={(next) => { if (next !== theme) onThemeChange(next); }} /></div>
    </section>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.language.title')}</h2><p>{t('settings.language.description')}</p></div>
      <div className="setting-row"><span><strong>{t('settings.language.label')}</strong><small>{t('settings.language.hint')}</small></span><LanguageChoice value={language} disabled={busy} /></div>
    </section>
    {nativeAvailable && <TerminalSettings />}
    <div className="setting-row"><span><strong>{t('settings.shortcuts.label')}</strong><small>{t('settings.shortcuts.hint')}</small></span><button className="button" type="button" aria-label={t('settings.shortcuts.label')} onClick={onOpenShortcutHelp}>{t('settings.shortcuts.action')}</button></div>
    <div className="setting-row migration-entry"><span><strong>{t('settings.migration.label')}</strong><small>{t('settings.migration.hint')}</small></span><button className="button" type="button" onClick={onOpenMigration}>{t('settings.migration.action')}</button></div>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </>;
}
