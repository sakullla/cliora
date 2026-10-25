import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isSensitiveKey, isValueReference, mcpCommandLine } from '../../lib/mcp';
import type { McpDefinition, NativeMcpEntry } from '../../types/resources';
import { Icon } from '../Icon';
import styles from './McpDetails.module.css';

function Values({ label, values }: { label: string; values: Record<string, string> }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const entries = Object.entries(values).filter(([key]) => key.trim());
  if (!entries.length) return <p className={styles.none}>{t('tools.mcp.detailNoValues')}</p>;
  return <dl className={styles.values} aria-label={label}>{entries.map(([key, value]) => {
    const sensitive = isSensitiveKey(key) && !!value && !isValueReference(value);
    const shown = !sensitive || revealed.has(key);
    return <div className={styles.value} key={key}>
      <dt>{key}{sensitive && <Icon name="lock" size={11} />}</dt>
      <dd><code>{shown ? value : '••••••••••••'}</code>{sensitive && <button type="button" className={styles.reveal} aria-label={t(shown ? 'tools.mcp.detailHide' : 'tools.mcp.detailReveal', { key })} title={t(shown ? 'tools.mcp.detailHide' : 'tools.mcp.detailReveal', { key })} onClick={() => setRevealed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}><Icon name={shown ? 'eyeOff' : 'eye'} size={14} /></button>}</dd>
    </div>;
  })}</dl>;
}

export function McpDetails({ item, children }: { item: McpDefinition | NativeMcpEntry; children?: ReactNode }) {
  const { t } = useTranslation();
  const enabled = 'enabled' in item ? item.enabled : null;
  return <div className={styles.details}>
    <div className={styles.summary}>
      <span className={styles.transport} data-transport={item.transport}><Icon name={item.transport === 'http' ? 'globe' : 'terminal'} size={15} />{item.transport === 'http' ? 'HTTP' : 'stdio'}</span>
      {enabled !== null && <span className={styles.enabled} data-on={enabled || undefined}>{enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</span>}
      {'protectedValues' in item && item.protectedValues && <span className={styles.protected}><Icon name="lock" size={12} />{t('tools.mcp.detailProtected')}</span>}
      <span className={styles.commandPreview} title={mcpCommandLine(item.command, item.args) || item.url || ''}><code>{item.transport === 'http' ? item.url || '—' : mcpCommandLine(item.command, item.args) || '—'}</code></span>
    </div>
    <section className={styles.section}>
      <h4>{t('library.resources.connectionSection')}</h4>
      <dl className={styles.fields}>
        <div><dt>{t('tools.mcp.name')}</dt><dd>{item.name}</dd></div>
        {item.transport === 'stdio' ? <>
          <div><dt>{t('tools.mcp.command')}</dt><dd><code>{item.command || '—'}</code></dd></div>
          <div><dt>{t('tools.mcp.args')}</dt><dd>{item.args.length ? <ol className={styles.args}>{item.args.map((arg, index) => <li key={index}><code>{arg}</code></li>)}</ol> : '—'}</dd></div>
        </> : <div><dt>{t('tools.mcp.urlAria')}</dt><dd><code>{item.url || '—'}</code></dd></div>}
      </dl>
    </section>
    {children}
    <section className={styles.section}>
      <h4>{t(item.transport === 'stdio' ? 'tools.mcp.env' : 'tools.mcp.headers')}</h4>
      <Values key={`${'id' in item ? item.id : item.name}:${item.transport === 'stdio' ? 'env' : 'headers'}`} label={t(item.transport === 'stdio' ? 'tools.mcp.env' : 'tools.mcp.headers')} values={item.transport === 'stdio' ? item.env : item.headers} />
    </section>
  </div>;
}
