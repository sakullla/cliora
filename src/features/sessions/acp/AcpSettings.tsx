import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import { ACP_LEGACY_MODEL_CONFIG, type AcpSessionConfig } from '../../../types/acp';
import { acpSettings, settingLabel, type AcpSetting } from './composerModel';
import styles from './acpComposer.module.css';

function errorText(value: unknown): string {
  return String((value as { message?: string })?.message ?? value);
}

/**
 * The mode, model and configuration selectors the agent declared, and nothing it
 * did not (see acpSettings for which declaration wins). In the input card each one is
 * a compact pill that shows only its value; its name is the accessible label, the
 * hover text and the heading of its open list. A change shows the new value at once
 * and sends the request; when the agent refuses, the selector returns to the value it
 * had and says why. The host's own config update is the final word, so any later
 * config replaces what is shown. In a narrow pane the selectors fold into a menu,
 * one row per setting with its name.
 */
export function AcpSettings({ config, compact, disabled, onSetMode, onSetConfig }: {
  config: AcpSessionConfig;
  compact: boolean;
  disabled: boolean;
  onSetMode: (modeId: string) => Promise<void>;
  onSetConfig: (configId: string, value: string | boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const settings = acpSettings(config, ACP_LEGACY_MODEL_CONFIG, { mode: t('sessions.acpModeLabel'), model: t('sessions.acpModelLabel'), thought: t('sessions.acpThoughtLabel') });
  const [shown, setShown] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A config the host published replaces every value shown optimistically: it is
  // either the confirmation or, after a refusal, the original republished.
  useEffect(() => { setShown({}); }, [config]);
  useEffect(() => { if (!compact) setOpen(false); }, [compact]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  if (!settings.length) return null;

  const valueOf = (setting: AcpSetting) => (Object.hasOwn(shown, setting.key) ? shown[setting.key] : setting.value);
  const summary = settings
    .filter((setting) => setting.type === 'select')
    .slice(0, 2)
    .map((setting) => settingLabel(setting, valueOf(setting)))
    .filter(Boolean)
    .join(' · ');

  async function change(setting: AcpSetting, value: string | boolean) {
    if (busy) return;
    setBusy(setting.key);
    setError('');
    setShown((current) => ({ ...current, [setting.key]: value }));
    try {
      if (setting.target.kind === 'mode') await onSetMode(String(value));
      else await onSetConfig(setting.target.configId, value);
    } catch (value) {
      setShown((current) => {
        const next = { ...current };
        delete next[setting.key];
        return next;
      });
      setError(t('sessions.acpSettingFailed', { name: setting.name, reason: errorText(value) }));
    } finally { setBusy(''); }
  }

  const controls = settings.map((setting) => {
    const value = valueOf(setting);
    const off = disabled || !!busy;
    if (setting.type === 'boolean') {
      return <label key={setting.key} className={styles.setting} data-setting={setting.key} data-type="boolean" title={setting.description ?? undefined}>
        <input type="checkbox" role="switch" className={styles.settingSwitch} checked={value === true} disabled={off} onChange={(event) => void change(setting, event.currentTarget.checked)} />
        <span className={styles.settingName}>{setting.name}</span>
      </label>;
    }
    const known = setting.options.some((option) => option.value === value);
    const groups = new Map<string | null, AcpSetting['options']>();
    for (const option of setting.options) groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
    const optionView = (option: AcpSetting['options'][number]) => <option key={option.value} value={option.value} title={option.description ?? undefined}>{option.name}</option>;
    // The open list is headed by the setting's name: options without a group sit under
    // it, a declared group is named after it.
    const hover = [t('sessions.acpSettingValue', { name: setting.name, value: settingLabel(setting, value) }), setting.description].filter(Boolean).join('\n');
    const select = <select className={styles.settingSelect} value={String(value)} disabled={off} aria-label={setting.name} title={hover} aria-busy={busy === setting.key || undefined} onChange={(event) => void change(setting, event.currentTarget.value)}>
      {!known && <option value={String(value)}>{String(value)}</option>}
      {[...groups.entries()].map(([group, options]) => <optgroup key={group ?? ''} label={group ? `${setting.name} · ${group}` : setting.name}>{options.map(optionView)}</optgroup>)}
    </select>;
    if (!compact) return <span key={setting.key} className={styles.setting} data-setting={setting.key}><span className={styles.selectWrap}>{select}</span></span>;
    return <label key={setting.key} className={styles.setting} data-setting={setting.key} title={setting.description ?? undefined}>
      <span className={styles.settingName}>{setting.name}</span>
      <span className={styles.selectWrap}>{select}</span>
    </label>;
  });

  const compactTitle = summary ? t('sessions.acpSettingsSummary', { summary }) : t('sessions.acpSettings');

  return <div ref={rootRef} className={styles.settings} data-acp-settings={compact ? 'menu' : 'inline'}>
    {compact ? <>
      <button
        type="button"
        className={summary ? styles.settingsTrigger : styles.iconButton}
        aria-label={t('sessions.acpSettings')}
        title={compactTitle}
        data-summary={summary || undefined}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); } }}
      >
        <Icon name="sliders" size={13} />
        {summary && <span className={styles.settingsSummary} aria-hidden="true">{summary}</span>}
      </button>
      {open && <div id={menuId} className={styles.settingsMenu} role="group" aria-label={t('sessions.acpSettings')} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); } }}>
        {controls}
      </div>}
    </> : <div className={styles.settingsInline} role="group" aria-label={t('sessions.acpSettings')}>{controls}</div>}
    {error && <p className={styles.settingsError} role="alert">{error}</p>}
  </div>;
}
