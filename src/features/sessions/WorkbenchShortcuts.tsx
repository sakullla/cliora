import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { Button, IconButton } from '../../components/ui';
import { modLabel } from '../../lib/shortcut';
import styles from './SessionWorkbench.module.css';

/** Keyboard reference for the terminal. Every entry mirrors a handler in terminalKeyAction or the workbench. */
export function WorkbenchShortcuts({ open, onToggle, onClose }: { open: boolean; onToggle: () => void; onClose: () => void }) {
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

  const groups: { title: string; items: { keys: string[][]; label: string }[] }[] = [
    { title: t('sessions.kbGroupSessions'), items: [
      { keys: [['Alt', 'N']], label: t('sessions.shortcutNew') },
      { keys: [['Alt', '↑'], ['Alt', '↓']], label: t('sessions.shortcutSwitch') },
      { keys: [['Ctrl', 'Tab']], label: t('sessions.kbCycle') },
      { keys: [[modLabel, 'Shift', 'D']], label: t('sessions.splitView') },
    ] },
    { title: t('sessions.kbGroupTerminal'), items: [
      { keys: [[modLabel, 'Shift', 'F']], label: t('sessions.findOutput') },
      { keys: [[modLabel, 'Shift', 'M']], label: t('sessions.composerShort') },
      { keys: [['Shift', 'Enter']], label: t('sessions.kbNewline') },
      { keys: [[modLabel, 'C']], label: t('sessions.kbCopy') },
      { keys: [[modLabel, 'V']], label: t('sessions.pasteClipboard') },
      { keys: [['Shift', t('sessions.kbWheel')]], label: t('sessions.kbHistory') },
      { keys: [[modLabel, t('sessions.kbClick')]], label: t('sessions.kbLink') },
    ] },
    { title: t('sessions.kbGroupView'), items: [
      { keys: [[modLabel, '+'], [modLabel, '−']], label: t('sessions.kbZoom') },
      { keys: [[modLabel, '0']], label: t('sessions.kbZoomReset') },
    ] },
  ];

  return <div className={styles.shortcuts} ref={root}>
    <Button ref={trigger} variant="ghost" size="sm" className={styles.statusButton} aria-expanded={open} aria-controls="workbench-shortcuts-panel" aria-label={t('sessions.shortcutsTitle')} title={t('sessions.shortcutsTitle')} onClick={onToggle} icon={<Icon name="keyboard" size={14} />}>{t('sessions.shortcutsShort')}</Button>
    {open && <div className={styles.shortcutsPanel} id="workbench-shortcuts-panel" role="dialog" aria-label={t('sessions.shortcutsTitle')}>
      <div className={styles.appearanceHead}><span><Icon name="keyboard" size={14} />{t('sessions.shortcutsTitle')}</span><IconButton size="sm" className={styles.iconBtn} aria-label={t('common.dialog.close')} onClick={onClose} icon={<Icon name="close" size={14} />} /></div>
      <div className={styles.shortcutsBody}>
        {groups.map((group) => <section key={group.title} className={styles.shortcutsGroup}>
          <h3>{group.title}</h3>
          <dl>{group.items.map((item) => <div key={item.label} className={styles.shortcutRow}>
            <dt>{item.label}</dt>
            <dd>{item.keys.map((combo, index) => <span key={index} className={styles.keyCombo}>{index > 0 && <span className={styles.keyOr}>/</span>}{combo.map((key) => <kbd key={key}>{key}</kbd>)}</span>)}</dd>
          </div>)}</dl>
        </section>)}
      </div>
    </div>}
  </div>;
}
