import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export type Toast = { id: number; tone: 'status' | 'alert'; text: string };

export function ToastStack({ status, alert, onDismiss }: { status: Toast | null; alert: Toast | null; onDismiss: (tone: Toast['tone']) => void }) {
  const { t } = useTranslation();
  if (!status && !alert) return null;
  return <div className="toast-stack">
    {[alert, status].filter(Boolean).map((item) => <div key={item!.tone} className="toast" data-tone={item!.tone} role={item!.tone === 'alert' ? 'alert' : 'status'}>
      <span className="toast-icon"><Icon name={item!.tone === 'alert' ? 'alert' : 'check'} size={14} strokeWidth={2.2} /></span>
      <span className="toast-text">{item!.text}</span>
      <button type="button" aria-label={item!.tone === 'alert' ? t('common.dismissError') : t('common.dismiss')} onClick={() => onDismiss(item!.tone)}><Icon name="close" size={12} strokeWidth={2.2} /></button>
    </div>)}
  </div>;
}
