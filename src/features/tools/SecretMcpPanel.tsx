import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { writeClipboard } from '../../lib/clipboard';
import { formatFailure } from '../../lib/feedback';
import { buildSecretUsageFromMetadata, grantedSecretAliases } from '../../lib/secretCommands';
import { Icon } from '../../components/Icon';
import { Badge, Button } from '../../components/ui';
import type { Tone } from '../../lib/statusTone';
import type { Scope } from '../../types/native';
import type { SecretMcpState, SecretMcpTarget } from '../../types/secrets';
import styles from './SecretMcpPanel.module.css';

const stateTone: Record<SecretMcpState['state'], Tone> = { unsupported: 'neutral', unverified: 'warning', disabled: 'neutral', enabled: 'success' };
const healthTone: Record<SecretMcpState['health'], Tone> = { unknown: 'neutral', healthy: 'success', failed: 'danger' };

/**
 * The secret MCP state of one tool and scope, inside the MCP workspace.
 *
 * The panel shows three separate facts and never merges them: what the adapter
 * registry declares (`capability`), what the native files currently hold
 * (`placement`) and whether the distributed helper actually negotiated the
 * protocol (`health`). Only `available` claims a working tool entry, and the CLI
 * fallback text stays offered in every state because the value never travels in
 * it. Nothing here branches on a CLI id.
 */
export function SecretMcpPanel({ toolId, scope, projectPath, contextId }: {
  toolId: string;
  scope: Scope;
  projectPath: string | null;
  contextId?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const target: SecretMcpTarget = { toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId: contextId ?? null };
  const [state, setState] = useState<SecretMcpState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fallback, setFallback] = useState('');
  const mounted = useRef(true);
  const sequence = useRef(0);
  const ready = !!toolId && !(scope === 'project' && !projectPath);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; };
  }, []);

  const load = useCallback(async () => {
    if (!ready) { setState(null); setLoading(false); return; }
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = await native.secretMcpStatus(target);
      if (!mounted.current || request !== sequence.current) return;
      setState(next);
      setError('');
    } catch (failure) {
      if (!mounted.current || request !== sequence.current) return;
      setError(formatFailure(failure, t('library.secrets.mcp.readFailed'), t('library.secrets.retry')));
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, [ready, toolId, scope, projectPath, contextId]);
  useEffect(() => { void load(); }, [load]);

  /** The fallback is built from this device's metadata: ids, aliases and grants only. */
  const loadFallback = useCallback(async () => {
    try {
      const { cli, installations, executors, grants } = await native.secretAccessOptions();
      if (!mounted.current) return '';
      const text = buildSecretUsageFromMetadata({
        context: cli, installations, executors, grants,
        secrets: grantedSecretAliases(grants),
        // The fallback names the installation this panel manages when it exists.
        preferredId: state?.installationId ?? null,
        locale: i18n.language?.startsWith('en') ? 'en' : 'zh',
      }) ?? '';
      setFallback(text);
      return text;
    } catch (failure) {
      if (mounted.current) setError(formatFailure(failure, t('library.secrets.mcp.fallbackFailed'), t('library.secrets.retry')));
      return '';
    }
  }, [i18n.language, state?.installationId, t]);
  // An unavailable MCP entry is exactly the case that needs the fallback, so it is
  // composed as soon as that state is known instead of only on a copy click.
  useEffect(() => {
    if (open && state && !state.available) void loadFallback();
  }, [open, state, loadFallback]);

  async function run(operation: () => Promise<SecretMcpState>, done?: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await operation();
      if (!mounted.current) return;
      setState(next);
      if (done) setNotice(t(done));
    } catch (failure) {
      if (mounted.current) setError(formatFailure(failure, t('library.secrets.mcp.actionFailed'), t('library.secrets.retry')));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function copyText(text: string, doneKey: string) {
    if (!text) return;
    try {
      await writeClipboard(text);
      if (mounted.current) setNotice(t(doneKey));
    } catch {
      if (mounted.current) setError(t('common.editor.clipboardUnavailable'));
    }
  }
  async function copyFallback() {
    const text = fallback || await loadFallback();
    await copyText(text, 'library.secrets.mcp.fallbackCopied');
  }

  if (!ready) return null;
  const enabled = state?.placement === 'enabled';
  const verifyPrimary = enabled && state?.health !== 'healthy';
  const commandText = state?.command ? [state.command, ...state.args].join(' ') : '';
  const summaryTone = !state ? 'neutral' : state.available ? 'success' : state.health === 'failed' ? 'danger' : state.capability === 'unverified' ? 'warning' : 'neutral';

  return <section className={styles.panel} data-secret-mcp data-secret-mcp-state={state?.state ?? 'loading'} data-secret-mcp-available={state?.available ? 'true' : 'false'}>
    <button type="button" className={styles.head} data-secret-mcp-toggle aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      <Icon name="shield" size={13} className={styles.shieldIcon} />
      <strong>{t('library.secrets.mcp.title')}</strong>
      <span className={styles.gap} />
      {state && <Badge tone={stateTone[state.state]} dot>{t(`library.secrets.mcp.state.${state.state}`)}</Badge>}
      {state && <Badge tone={healthTone[state.health]}>{t(`library.secrets.mcp.health.${state.health}`)}</Badge>}
    </button>
    {open && <div className={styles.body}>
      {loading && !state && <p className={styles.hint} role="status">{t('library.secrets.mcp.loading')}</p>}
      {error && <p className={styles.error} role="alert" data-secret-mcp-error>{error}</p>}
      {notice && <p className={styles.notice} role="status" data-secret-mcp-notice>{notice}</p>}
      {state && <>
        <div className={styles.summary} data-tone={summaryTone}>
          <p className={styles.reason} data-secret-mcp-reason>{state.reason}</p>
          {state.capability === 'unsupported' && <p className={styles.hint} data-secret-mcp-unsupported>{state.capabilityReason}</p>}
        </div>
        <div className={styles.actions}>
          {state.capability !== 'unsupported' && <Button size="sm" variant={verifyPrimary ? undefined : 'primary'} data-secret-mcp-enable disabled={busy} onClick={() => void run(
            () => native.setSecretMcpEnabled(target, !enabled),
            enabled ? 'library.secrets.mcp.disabledNotice' : 'library.secrets.mcp.writtenNotice',
          )}>{enabled ? t('library.secrets.mcp.disable') : t('library.secrets.mcp.enable')}</Button>}
          {state.placement !== 'absent' && <Button size="sm" variant={verifyPrimary ? 'primary' : undefined} data-secret-mcp-verify disabled={busy} onClick={() => void run(
            () => native.checkSecretMcpHealth(target),
            'library.secrets.mcp.verifiedNotice',
          )}>{t('library.secrets.mcp.verify')}</Button>}
          {state.installationId && <Button size="sm" variant="ghost" data-secret-mcp-revoke disabled={busy} onClick={() => void run(
            () => native.revokeSecretMcpInstallation(target),
            'library.secrets.mcp.revokedNotice',
          )}>{t('library.secrets.mcp.revoke')}</Button>}
          <Button size="sm" variant="ghost" data-secret-mcp-refresh disabled={busy || loading} icon={<Icon name="refresh" size={12} />} onClick={() => void load()}>{t('library.secrets.refresh')}</Button>
        </div>
        <dl className={styles.facts}>
          <div><dt>{t('library.secrets.mcp.capability')}</dt><dd data-secret-mcp-capability={state.capability}>{state.capability}</dd></div>
          <div><dt>{t('library.secrets.mcp.placementLabel')}</dt><dd data-secret-mcp-placement={state.placement}>{t(`library.secrets.mcp.placement.${state.placement}`)}</dd></div>
          <div><dt>{t('library.secrets.mcp.healthLabel')}</dt><dd data-secret-mcp-health={state.health}>{t(`library.secrets.mcp.health.${state.health}`)}{state.healthDetail && <small>{state.healthDetail}</small>}</dd></div>
          <div><dt>{t('library.secrets.mcp.installation')}</dt><dd data-secret-mcp-installation>{state.installationId ?? t('library.secrets.mcp.noInstallation')}</dd></div>
          {commandText && <div className={styles.commandRow}>
            <dt>{t('library.secrets.mcp.command')}</dt>
            <dd>
              <code data-secret-mcp-command>{commandText}</code>
              <Button size="sm" variant="ghost" title={t('library.secrets.mcp.copyCommand')} aria-label={t('library.secrets.mcp.copyCommand')} icon={<Icon name="copy" size={12} />} onClick={() => void copyText(commandText, 'library.secrets.mcp.commandCopied')} />
            </dd>
          </div>}
        </dl>
      </>}
      <div className={styles.fallback} data-secret-mcp-fallback>
        <div className={styles.fallbackHead}>
          <strong>{t('library.secrets.mcp.fallbackTitle')}</strong>
          <span className={styles.gap} />
          {fallback && <Button size="sm" variant="ghost" data-secret-mcp-copy disabled={busy} icon={<Icon name="copy" size={12} />} onClick={() => void copyFallback()}>{t('library.secrets.mcp.fallbackCopy')}</Button>}
        </div>
        <p className={styles.hint}>{t('library.secrets.mcp.fallbackHint')}</p>
        {fallback && <pre className={styles.code} data-secret-mcp-fallback-text>{fallback}</pre>}
        {!fallback && <p className={styles.hint} data-secret-mcp-fallback-empty>{t('library.secrets.mcp.fallbackEmpty')}</p>}
      </div>
    </div>}
  </section>;
}
