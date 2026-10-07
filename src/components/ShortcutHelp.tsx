import { useTranslation } from 'react-i18next';
import { GuideDialog } from './GuideDialog';
import { modLabel } from '../lib/shortcut';

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return <GuideDialog open={open} title={t('common.shortcuts.title')} onClose={onClose}>
    <div className="shortcut-help">
      <section><h3>{t('common.shortcuts.global')}</h3><dl>
        <div><dt><kbd>{modLabel}+K</kbd></dt><dd>{t('common.shortcuts.palette')}</dd></div>
        <div><dt><kbd>{modLabel}+1…5</kbd></dt><dd>{t('common.shortcuts.switchPage')}</dd></div>
        <div><dt><kbd>{modLabel}+\</kbd></dt><dd>{t('common.shortcuts.toggleSidebar')}</dd></div>
        <div><dt><kbd>/</kbd> {t('common.shortcuts.or')} <kbd>{modLabel}+F</kbd></dt><dd>{t('common.shortcuts.focusSearch')}</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>{t('common.shortcuts.clearOrClose')}</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>{t('common.shortcuts.openPanel')}</dd></div>
      </dl></section>
      <section><h3>{t('common.shortcuts.editing')}</h3><dl>
        <div><dt><kbd>{modLabel}+S</kbd></dt><dd>{t('common.shortcuts.saveDialog')}</dd></div>
        <div><dt><kbd>Alt+1…6</kbd></dt><dd>{t('common.shortcuts.switchView')}</dd></div>
        <div><dt><kbd>{t('common.shortcuts.arrows')}</kbd></dt><dd>{t('common.shortcuts.moveOptions')}</dd></div>
      </dl></section>
    </div>
  </GuideDialog>;
}
