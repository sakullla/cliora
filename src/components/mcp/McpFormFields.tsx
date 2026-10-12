import { useTranslation } from 'react-i18next';
import type { KeyValueRow } from '../../lib/mcp';
import type { McpDraft } from '../../types/resources';
import { KeyValueRows } from './KeyValueRows';
import styles from './McpFormFields.module.css';

export function McpFormFields({ draft, onChange, envRows, onEnvRowsChange, headerRows, onHeaderRowsChange, disabled = false }: {
  draft: McpDraft;
  onChange: (draft: McpDraft) => void;
  envRows: KeyValueRow[];
  onEnvRowsChange: (rows: KeyValueRow[]) => void;
  headerRows: KeyValueRow[];
  onHeaderRowsChange: (rows: KeyValueRow[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return <div className={styles.fields}>
    <label className={styles.span}>{t('tools.mcp.name')}<input aria-label={t('tools.mcp.nameAria')} value={draft.name} disabled={disabled} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder={t('tools.mcp.namePlaceholder')} /></label>
    <div className={`${styles.typeField} ${styles.span}`}><span>{t('tools.mcp.type')}</span><div className={styles.typeSwitch} role="radiogroup" aria-label={t('tools.mcp.transport')}>{([['http', 'HTTP'], ['stdio', 'stdio']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.transport === value} disabled={disabled} onClick={() => onChange({ ...draft, transport: value })}>{label}</button>)}</div></div>
    {draft.transport === 'stdio' ? <>
      <label className={styles.span}>{t('tools.mcp.command')}<input aria-label={t('tools.mcp.command')} value={draft.command} disabled={disabled} onChange={(event) => onChange({ ...draft, command: event.target.value })} placeholder="npx" /></label>
      <div className={styles.span}><KeyValueRows single label={t('tools.mcp.args')} rows={draft.args.length ? draft.args.map((value) => ({ key: '', value })) : [{ key: '', value: '' }]} disabled={disabled} onChange={(rows) => onChange({ ...draft, args: rows.map((row) => row.value) })} valuePlaceholder="-y" /></div>
      <div className={styles.span}><KeyValueRows label={t('tools.mcp.env')} rows={envRows} disabled={disabled} onChange={onEnvRowsChange} keyPlaceholder="API_TOKEN" valuePlaceholder="${API_TOKEN}" /></div>
    </> : <>
      <label className={styles.span}>URL<input aria-label={t('tools.mcp.urlAria')} value={draft.url} disabled={disabled} onChange={(event) => onChange({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
      <div className={styles.span}><KeyValueRows label={t('tools.mcp.headers')} rows={headerRows} disabled={disabled} onChange={onHeaderRowsChange} keyPlaceholder="Authorization" valuePlaceholder="Bearer ${API_TOKEN}" /></div>
    </>}
  </div>;
}
