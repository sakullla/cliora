import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ToolIcon } from '../../components/ToolIcon';

export function ToolIconSettings({ tools, icons, busy, onChange, onError }: { tools: { id: string; name: string }[]; icons: Record<string, string>; busy: boolean; onChange: (id: string, data: string | null) => Promise<void>; onError: (message: string) => void }) {
  const { t } = useTranslation();
  async function pick(id: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 128 * 1024) { onError(t('settings.icons.invalid')); return; }
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => null);
    if (!data) { onError(t('settings.icons.readFailed')); return; }
    await onChange(id, data);
  }
  return <details className="icon-settings"><summary>{t('settings.icons.title')}</summary><p>{t('settings.icons.description')}</p>
    {tools.map((tool) => <div className="icon-setting-row" key={tool.id}><span className="tool-identity"><ToolIcon toolId={tool.id} size={26} />{tool.name}</span><label className="button icon-file">{t('settings.icons.pick')}<input aria-label={t('settings.icons.pickAria', { name: tool.name })} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => void pick(tool.id, event)} /></label><button className="text-button" type="button" disabled={busy || !icons[tool.id]} onClick={() => void onChange(tool.id, null)}>{t('common.field.restoreDefault')}</button></div>)}
  </details>;
}
