import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { modLabel } from '../../lib/shortcut';
import type { TerminalThemePreference } from './terminalTheme';
import styles from './SessionWorkbench.module.css';

export function TerminalAppearance({ open, theme, fontSize, defaultFontSize, minFontSize, maxFontSize, cursorBlink, soundEnabled, onToggle, onClose, onTheme, onFontSize, onCursorBlink, onSound }: {
  open: boolean;
  theme: TerminalThemePreference;
  fontSize: number;
  defaultFontSize: number;
  minFontSize: number;
  maxFontSize: number;
  cursorBlink: boolean;
  soundEnabled: boolean;
  onToggle: () => void;
  onClose: () => void;
  onTheme: (theme: TerminalThemePreference) => void;
  onFontSize: (size: number) => void;
  onCursorBlink: () => void;
  onSound: () => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', keydown, true); };
  }, [open, onClose]);

  const themes: { value: TerminalThemePreference; label: string; icon: 'monitor' | 'moon' | 'sun' }[] = [
    { value: 'auto', label: t('sessions.termThemeAuto'), icon: 'monitor' },
    { value: 'dark', label: t('sessions.termThemeDark'), icon: 'moon' },
    { value: 'light', label: t('sessions.termThemeLight'), icon: 'sun' },
  ];

  return <div className={styles.appearance} ref={root}>
    <button ref={trigger} type="button" className={styles.toolButton} aria-label={t('sessions.displaySettings')} title={t('sessions.displaySettings')} aria-expanded={open} aria-controls="terminal-appearance-panel" onClick={onToggle}><Icon name="sliders" size={16} /><span>{t('sessions.displayShort')}</span></button>
    {open && <div className={styles.appearancePanel} id="terminal-appearance-panel" role="dialog" aria-label={t('sessions.displaySettings')}>
      <div className={styles.appearanceHead}><span><Icon name="sliders" size={15} />{t('sessions.displaySettings')}</span><button type="button" className={styles.iconBtn} aria-label={t('common.dialog.close')} onClick={onClose}><Icon name="close" size={13} /></button></div>
      <div className={styles.appearanceSection}><span className={styles.appearanceLabel}>{t('sessions.terminalColors')}</span><div className={styles.themeChoices} role="group" aria-label={t('sessions.terminalColors')}>{themes.map((item) => <button key={item.value} type="button" data-theme-choice={item.value} aria-pressed={theme === item.value} onClick={() => onTheme(item.value)}><span className={styles.themePreview} data-preview={item.value}><Icon name={item.icon} size={16} /></span><span>{item.label}</span>{theme === item.value && <Icon name="check" size={11} />}</button>)}</div></div>
      <div className={styles.appearanceRow}><span className={styles.appearanceLabel}>{t('sessions.fontSize')}</span><div className={styles.fontStepper}><button type="button" disabled={fontSize <= minFontSize} aria-label={t('sessions.fontSizeDown')} title={t('sessions.fontSizeDown') + ` (${modLabel}+-)`} onClick={() => onFontSize(fontSize - 1)}><span aria-hidden="true">−</span></button><button type="button" className={styles.fontValue} aria-label={t('sessions.fontSizeReset', { size: defaultFontSize })} title={t('sessions.fontSizeReset', { size: defaultFontSize })} onClick={() => onFontSize(defaultFontSize)}>{fontSize}<small>px</small></button><button type="button" disabled={fontSize >= maxFontSize} aria-label={t('sessions.fontSizeUp')} title={t('sessions.fontSizeUp') + ` (${modLabel}+=)`} onClick={() => onFontSize(fontSize + 1)}><Icon name="plus" size={12} /></button></div></div>
      <div className={styles.appearanceSwitches}>
        <button type="button" role="switch" aria-checked={cursorBlink} onClick={onCursorBlink}><span><Icon name="terminal" size={15} />{t('sessions.cursorBlink')}</span><span className={styles.switchTrack} aria-hidden="true"><i /></span></button>
        <button type="button" role="switch" aria-checked={soundEnabled} onClick={onSound}><span><Icon name="info" size={15} />{t('sessions.sound')}</span><span className={styles.switchTrack} aria-hidden="true"><i /></span></button>
      </div>
      <div className={styles.appearanceFoot}><Icon name="command" size={12} /><span>{t('sessions.displayShortcutHint', { shortcut: modLabel })}</span></div>
    </div>}
  </div>;
}
