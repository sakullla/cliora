import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { native, nativeAvailable } from '../lib/native';

/** WebView cannot reliably open target=_blank, especially on macOS. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  return <><a href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (!nativeAvailable) return;
    event.preventDefault();
    setError('');
    void native.openExternalUrl(href).catch((reason: unknown) => {
      setError(typeof reason === 'object' && reason && 'message' in reason ? String(reason.message) : t('common.externalLink.openFailed'));
    });
  }}>{children}</a>{error && <span role="alert">{error}</span>}</>;
}
