import type { ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { duplicateKeys, parseKeyValueLines, type KeyValueRow } from '../../lib/mcp';
import { Icon } from '../Icon';
import styles from './KeyValueRows.module.css';

export function KeyValueRows({ label, rows, onChange, single = false, keyPlaceholder, valuePlaceholder, disabled = false }: {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  single?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const duplicates = single ? [] : duplicateKeys(rows);

  function update(index: number, next: KeyValueRow) {
    onChange(rows.map((row, position) => position === index ? next : row));
  }
  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }
  function removeRow(index: number) {
    onChange(rows.filter((_, position) => position !== index));
  }
  function addRow() {
    onChange([...rows, { key: '', value: '' }]);
  }
  function paste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text/plain');
    if (!text.includes('\n') && single) return;
    const parsed = single ? null : parseKeyValueLines(text);
    if (!single && (!parsed || !parsed.length)) return;
    event.preventDefault();
    const inserted: KeyValueRow[] = single
      ? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((value) => ({ key: '', value }))
      : parsed ?? [];
    const next = [...rows];
    const current = next[index];
    if (current && !current.key.trim() && !current.value.trim()) next.splice(index, 1, ...inserted);
    else next.splice(index + 1, 0, ...inserted);
    onChange(next);
  }

  return <div className={styles.rowsField} role="group" aria-label={label}>
    <div className={styles.rowsHead}>
      <span>{label}</span>
      <button type="button" className={styles.add} disabled={disabled} onClick={addRow}><Icon name="plus" size={12} strokeWidth={2.2} />{t('tools.mcp.rowAdd')}</button>
    </div>
    <div className={styles.rows}>
      {rows.map((row, index) => <div className={styles.row} data-single={single || undefined} key={index}>
        {!single && <input aria-label={t('tools.mcp.rowKey', { label, index: index + 1 })} aria-invalid={duplicates.includes(row.key.trim()) && !!row.key.trim() || undefined} value={row.key} placeholder={keyPlaceholder} disabled={disabled} onChange={(event) => update(index, { ...row, key: event.target.value })} onPaste={(event) => paste(index, event)} />}
        <input aria-label={single ? t('tools.mcp.rowSingle', { label, index: index + 1 }) : t('tools.mcp.rowValue', { label, index: index + 1 })} value={row.value} placeholder={valuePlaceholder} disabled={disabled} onChange={(event) => update(index, { ...row, value: event.target.value })} onPaste={(event) => paste(index, event)} />
        <span className={styles.rowOps}>
          <button type="button" aria-label={t('tools.mcp.rowUp', { index: index + 1 })} title={t('tools.mcp.rowUp', { index: index + 1 })} disabled={disabled || index === 0} onClick={() => move(index, -1)}><span className={styles.up}><Icon name="arrowDown" size={13} /></span></button>
          <button type="button" aria-label={t('tools.mcp.rowDown', { index: index + 1 })} title={t('tools.mcp.rowDown', { index: index + 1 })} disabled={disabled || index === rows.length - 1} onClick={() => move(index, 1)}><Icon name="arrowDown" size={13} /></button>
          <button type="button" aria-label={t('tools.mcp.rowRemove', { index: index + 1 })} title={t('tools.mcp.rowRemove', { index: index + 1 })} disabled={disabled} onClick={() => removeRow(index)}><Icon name="close" size={13} /></button>
        </span>
      </div>)}
    </div>
    {!!duplicates.length && <p className={styles.duplicate} role="alert">{t('tools.mcp.duplicateKey', { keys: duplicates.join('、') })}</p>}
  </div>;
}
