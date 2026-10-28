import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/ui';
import { modLabel } from '../../lib/shortcut';
import type { TerminalThemePreference } from './terminalTheme';
import styles from './SessionWorkbench.module.css';

export type TerminalDensity = 'compact' | 'standard' | 'relaxed';

export const DENSITY_LINE_HEIGHT: Record<TerminalDensity, number> = { compact: 1.2, standard: 1.35, relaxed: 1.5 };

export function TerminalAppearance({ open, theme, fontSize, defaultFontSize, minFontSize, maxFontSize, density, cursorBlink, soundEnabled, onToggle, onClose, onTheme, onFontSize, onDensity, onCursorBlink, onSound }: {
  open: boolean;
  theme: TerminalThemePreference;
  fontSize: number;
  defaultFontSize: number;
  minFontSize: number;
  maxFontSize: number;
  density: TerminalDensity;
  cursorBlink: boolean;
  soundEnabled: boolean;
  onToggle: () => void;
  onClose: () => void;
  onTheme: (theme: TerminalThemePreference) => void;
  onFontSize: (size: number) => void;
  onDensity: (density: TerminalDensity) => void;
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

  const themes: { value: TerminalThemePreference; label: string }[] = [
    { value: 'auto', label: t('sessions.termThemeAuto') },
    { value: 'dark', label: t('sessions.termThemeDark') },
    { value: 'light', label: t('sessions.termThemeLight') },
  ];
  const densities: { value: TerminalDensity; label: string }[] = [
    { value: 'compact', label: t('sessions.lineCompact') },
    { value: 'standard', label: t('sessions.lineStandard') },
    { value: 'relaxed', label: t('sessions.lineRelaxed') },
  ];

  return <div className={styles.appearance} ref={root}>
    <IconButton ref={trigger} size="sm" className={styles.toolButton} aria-label={t('sessions.displaySettings')} aria-expanded={open} aria-controls="terminal-appearance-panel" onClick={onToggle} icon={<Icon name="sliders" size={16} />} />
    {open && <div className={styles.appearancePanel} id="terminal-appearance-panel" role="dialog" aria-label={t('sessions.displaySettings')}>
      <div className={styles.appearanceHead}><span><Icon name="sliders" size={14} />{t('sessions.displaySettings')}</span><IconButton size="sm" className={styles.iconBtn} aria-label={t('common.dialog.close')} onClick={onClose} icon={<Icon name="close" size={14} />} /></div>
      <div className={styles.appearanceSection}>
        <span className={styles.appearanceLabel}>{t('sessions.terminalColors')}</span>
        <div className={styles.themeChoices} role="group" aria-label={t('sessions.terminalColors')}>{themes.map((item) => <button key={item.value} type="button" data-theme-choice={item.value} aria-pressed={theme === item.value} aria-label={item.label} onClick={() => onTheme(item.value)}>
          <span className={styles.themePreview} data-preview={item.value} aria-hidden="true"><i /><i /><i /><b /></span>
          <span className={styles.themeChoiceLabel}>{item.label}{theme === item.value && <Icon name="check" size={12} />}</span>
        </button>)}</div>
      </div>
      <div className={styles.appearanceSection}>
        <div className={styles.appearanceRow}><span className={styles.appearanceLabel}>{t('sessions.fontSize')}</span><div className={styles.fontStepper}><button type="button" disabled={fontSize <= minFontSize} aria-label={t('sessions.fontSizeDown')} title={t('sessions.fontSizeDown') + ` (${modLabel}+-)`} onClick={() => onFontSize(fontSize - 1)}><span aria-hidden="true">−</span></button><button type="button" className={styles.fontValue} aria-label={t('sessions.fontSizeReset', { size: defaultFontSize })} title={t('sessions.fontSizeReset', { size: defaultFontSize })} onClick={() => onFontSize(defaultFontSize)}>{fontSize}<small>px</small></button><button type="button" disabled={fontSize >= maxFontSize} aria-label={t('sessions.fontSizeUp')} title={t('sessions.fontSizeUp') + ` (${modLabel}+=)`} onClick={() => onFontSize(fontSize + 1)}><Icon name="plus" size={12} /></button></div></div>
        <div className={styles.appearanceRow}><span className={styles.appearanceLabel}>{t('sessions.lineHeight')}</span><div className={styles.densityChoices} role="radiogroup" aria-label={t('sessions.lineHeight')}>{densities.map((item) => <button key={item.value} type="button" role="radio" aria-checked={density === item.value} onClick={() => onDensity(item.value)}>{item.label}</button>)}</div></div>
      </div>
      <div className={styles.appearanceSwitches}>
        <button type="button" role="switch" aria-checked={cursorBlink} onClick={onCursorBlink}><span><Icon name="terminal" size={14} />{t('sessions.cursorBlink')}</span><span className={styles.switchTrack} aria-hidden="true"><i /></span></button>
        <button type="button" role="switch" aria-checked={soundEnabled} onClick={onSound}><span><Icon name="info" size={14} />{t('sessions.sound')}</span><span className={styles.switchTrack} aria-hidden="true"><i /></span></button>
      </div>
      <div className={styles.appearanceFoot}><Icon name="command" size={12} /><span>{t('sessions.displayShortcutHint', { shortcut: modLabel })}</span></div>
    </div>}
  </div>;
}
