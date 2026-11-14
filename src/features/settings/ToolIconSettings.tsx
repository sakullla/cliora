import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui';

/**
 * Inline custom icon actions embedded inside each unified CLI tool row.
 * Validates PNG/JPEG/WebP <= 128 KB; "Restore default" only appears when a custom icon is set.
 */
export function ToolIconActions({
  toolId,
  toolName,
  hasCustomIcon,
  disabled,
  onChange,
  onError,
}: {
  toolId: string;
  toolName: string;
  hasCustomIcon: boolean;
  disabled: boolean;
  onChange: (id: string, data: string | null) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 128 * 1024) {
      onError(t('settings.icons.invalid'));
      return;
    }
    const data = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!data) {
      onError(t('settings.icons.readFailed'));
      return;
    }
    await onChange(toolId, data);
  }

  return <span className="managed-tool-icon-actions">
    <label className="icon-file">
      {t('settings.icons.pick')}
      <input
        aria-label={t('settings.icons.pickAria', { name: toolName })}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled}
        onChange={(event) => void pick(event)}
      />
    </label>
    {hasCustomIcon && <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => void onChange(toolId, null)}
    >
      {t('common.field.restoreDefault')}
    </Button>}
  </span>;
}
