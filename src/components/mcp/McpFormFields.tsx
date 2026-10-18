import { useEffect, useId, useState, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { mcpCommandLine, mcpDraftIssues, parseMcpServerJson, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import type { McpDraft, McpTransport } from '../../types/resources';
import { Icon } from '../Icon';
import { KeyValueRows } from './KeyValueRows';
import styles from './McpFormFields.module.css';

const transports: Array<{ value: McpTransport; label: string; icon: 'terminal' | 'globe' }> = [
  { value: 'stdio', label: 'stdio', icon: 'terminal' },
  { value: 'http', label: 'HTTP', icon: 'globe' },
];

export function McpFormFields({ draft, onChange, envRows, onEnvRowsChange, headerRows, onHeaderRowsChange, disabled = false, showIssues = false, onImport, initialPasteOpen = false, title }: {
  draft: McpDraft;
  onChange: (draft: McpDraft) => void;
  envRows: KeyValueRow[];
  onEnvRowsChange: (rows: KeyValueRow[]) => void;
  headerRows: KeyValueRow[];
  onHeaderRowsChange: (rows: KeyValueRow[]) => void;
  disabled?: boolean;
  /** Reveals empty-field issues after a save attempt; malformed names show while typing. */
  showIssues?: boolean;
  /** Enables JSON paste import (toggle box and pasting JSON into the name field). */
  onImport?: (parsed: McpParsedServer) => void;
  initialPasteOpen?: boolean;
  title?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [pasteOpen, setPasteOpen] = useState(initialPasteOpen);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [pasteNotice, setPasteNotice] = useState('');
  const [urlBlurred, setUrlBlurred] = useState(false);
  useEffect(() => {
    if (!pasteNotice) return;
    const timer = window.setTimeout(() => setPasteNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [pasteNotice]);
  const issues = mcpDraftIssues(draft);
  const nameIssue = issues.name === 'nameInvalid' || (showIssues && issues.name) ? issues.name : undefined;
  const commandIssue = showIssues ? issues.command : undefined;
  const urlIssue = showIssues || (urlBlurred && draft.url.trim()) ? issues.url : undefined;
  const preview = draft.transport === 'stdio' ? mcpCommandLine(draft.command, draft.args) : '';

  function imported(parsed: McpParsedServer) {
    onImport?.(parsed);
    setPasteNotice(parsed.total > 1 ? t('tools.mcp.pastedMore', { name: parsed.name, count: parsed.total - 1 }) : t('tools.mcp.pasted'));
  }
  function applyPaste() {
    const parsed = parseMcpServerJson(pasteText);
    if (!parsed) { setPasteError(t('library.resources.pasteImportError')); return; }
    imported(parsed);
    setPasteText('');
    setPasteError('');
    setPasteOpen(false);
  }
  function pasteIntoName(event: ClipboardEvent<HTMLInputElement>) {
    if (!onImport) return;
    const text = event.clipboardData.getData('text/plain');
    if (!/[{:]/.test(text)) return;
    const parsed = parseMcpServerJson(text);
    if (!parsed) return;
    event.preventDefault();
    imported(parsed);
  }

  return <div className={styles.form}>
    {(onImport || title) && <div className={styles.formHead}>
      {title ? <h3>{title}</h3> : <span />}
      {pasteNotice && <span className={styles.pasteNotice} role="status"><Icon name="check" size={14} />{pasteNotice}</span>}
      {onImport && <button type="button" className={styles.pasteToggle} aria-expanded={pasteOpen} disabled={disabled} onClick={() => { setPasteOpen((value) => !value); setPasteError(''); setPasteNotice(''); }}><Icon name="clipboard" size={14} />{t('library.resources.pasteImport')}</button>}
    </div>}
    {onImport && pasteOpen && <div className={styles.pasteBox}>
      <p>{t('library.resources.pasteImportHint')}</p>
      <textarea aria-label={t('library.resources.pasteImportAria')} rows={4} value={pasteText} spellCheck={false} onChange={(event) => setPasteText(event.target.value)} placeholder={'{"mcpServers":{"name":{"command":"npx","args":["-y","pkg"]}}}'} />
      {pasteError && <p className={styles.fieldError} role="alert">{pasteError}</p>}
      <div className={styles.pasteActions}><button type="button" onClick={() => { setPasteOpen(false); setPasteError(''); }}>{t('library.resources.back')}</button><button type="button" className={styles.primary} disabled={!pasteText.trim()} onClick={applyPaste}>{t('library.resources.pasteImportApply')}</button></div>
    </div>}
    <div className={styles.identity}>
      <label className={styles.field}>{t('tools.mcp.name')}
        <input aria-label={t('tools.mcp.nameAria')} aria-invalid={!!nameIssue || undefined} aria-describedby={nameIssue ? `${id}-name` : undefined} value={draft.name} disabled={disabled} spellCheck={false} autoComplete="off" onChange={(event) => onChange({ ...draft, name: event.target.value })} onPaste={pasteIntoName} placeholder={t('tools.mcp.namePlaceholder')} />
        {nameIssue && <small id={`${id}-name`} className={styles.fieldError}>{t(`tools.mcp.issue.${nameIssue}`)}</small>}
      </label>
      <div className={styles.typeField}><span>{t('tools.mcp.type')}</span>
        <div className={styles.typeSwitch} role="radiogroup" aria-label={t('tools.mcp.transport')}>{transports.map((item) => <button key={item.value} type="button" aria-pressed={draft.transport === item.value} disabled={disabled} onClick={() => onChange({ ...draft, transport: item.value })}><Icon name={item.icon} size={14} />{item.label}</button>)}</div>
      </div>
    </div>
    <p className={styles.transportHint}>{draft.transport === 'stdio' ? t('tools.mcp.stdioHint') : t('tools.mcp.httpHint')}</p>
    {draft.transport === 'stdio' ? <>
      <label className={styles.field}>{t('tools.mcp.command')}
        <input className={styles.mono} aria-label={t('tools.mcp.command')} aria-invalid={!!commandIssue || undefined} aria-describedby={commandIssue ? `${id}-command` : undefined} value={draft.command} disabled={disabled} spellCheck={false} autoComplete="off" onChange={(event) => onChange({ ...draft, command: event.target.value })} placeholder={t('tools.mcp.commandPlaceholder')} />
        {commandIssue && <small id={`${id}-command`} className={styles.fieldError}>{t(`tools.mcp.issue.${commandIssue}`)}</small>}
      </label>
      <KeyValueRows single label={t('tools.mcp.args')} rows={draft.args.length ? draft.args.map((value) => ({ key: '', value })) : [{ key: '', value: '' }]} disabled={disabled} onChange={(rows) => onChange({ ...draft, args: rows.map((row) => row.value) })} valuePlaceholder={t('tools.mcp.argPlaceholder')} />
      {preview && <div className={styles.preview}><span>{t('tools.mcp.commandPreview')}</span><code>{preview}</code></div>}
      <KeyValueRows maskSensitive label={t('tools.mcp.env')} rows={envRows} disabled={disabled} onChange={onEnvRowsChange} keyPlaceholder={t('tools.mcp.envKeyPlaceholder')} valuePlaceholder={t('tools.mcp.envValuePlaceholder')} />
    </> : <>
      <label className={styles.field}>URL
        <input className={styles.mono} aria-label={t('tools.mcp.urlAria')} aria-invalid={!!urlIssue || undefined} aria-describedby={urlIssue ? `${id}-url` : undefined} value={draft.url} disabled={disabled} spellCheck={false} autoComplete="off" inputMode="url" onBlur={() => setUrlBlurred(true)} onChange={(event) => onChange({ ...draft, url: event.target.value })} placeholder={t('tools.mcp.urlPlaceholder')} />
        {urlIssue && <small id={`${id}-url`} className={styles.fieldError}>{t(`tools.mcp.issue.${urlIssue}`)}</small>}
      </label>
      <KeyValueRows maskSensitive label={t('tools.mcp.headers')} rows={headerRows} disabled={disabled} onChange={onHeaderRowsChange} keyPlaceholder={t('tools.mcp.headerKeyPlaceholder')} valuePlaceholder={t('tools.mcp.headerValuePlaceholder')} />
    </>}
  </div>;
}
