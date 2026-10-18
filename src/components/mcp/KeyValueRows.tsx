import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { duplicateKeys, isSensitiveKey, isValueReference, parseKeyValueLines, type KeyValueRow } from '../../lib/mcp';
import { Icon } from '../Icon';
import styles from './KeyValueRows.module.css';

export function KeyValueRows({ label, rows, onChange, single = false, maskSensitive = false, keyPlaceholder, valuePlaceholder, hint, disabled = false }: {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  single?: boolean;
  /** Masks literal values whose key looks like a secret; `${VAR}` references stay readable. */
  maskSensitive?: boolean;
  /** Example text for an empty cell. Rendered visibly different from typed values. */
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const list = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  const duplicates = single ? [] : duplicateKeys(rows);
  const filled = rows.filter((row) => (single ? row.value : row.key).trim()).length;
  const masking = maskSensitive && !single;
  const secret = (row: KeyValueRow) => masking && isSensitiveKey(row.key) && !!row.value && !isValueReference(row.value);
  const hasSecret = rows.some(secret);

  // A newly added row takes focus so the user types straight into it.
  useEffect(() => {
    const index = focusRow.current;
    if (index === null) return;
    focusRow.current = null;
    list.current?.querySelectorAll<HTMLElement>(':scope > [data-row]')[index]?.querySelector('input')?.focus();
  }, [rows.length]);

  function update(index: number, next: KeyValueRow) {
    onChange(rows.map((row, position) => position === index ? next : row));
  }
  function remap(map: (index: number) => number | null) {
    setRevealed((current) => new Set([...current].map(map).filter((index): index is number => index !== null)));
  }
  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    remap((value) => value === index ? target : value === target ? index : value);
    onChange(next);
  }
  function removeRow(index: number) {
    remap((value) => value === index ? null : value > index ? value - 1 : value);
    const next = rows.filter((_, position) => position !== index);
    onChange(next.length ? next : [{ key: '', value: '' }]);
  }
  function addRow() {
    focusRow.current = rows.length;
    onChange([...rows, { key: '', value: '' }]);
  }
  function toggleReveal(index: number) {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
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

  const note = hint ?? (hasSecret ? `${t('tools.mcp.maskedHint')}${t('tools.mcp.referenceHint')}` : null);

  return <div className={styles.rowsField} role="group" aria-label={label}>
    <div className={styles.rowsHead}>
      <span className={styles.rowsLabel}>{label}{filled > 0 && <span className={styles.count} aria-hidden="true">{filled}</span>}</span>
      <button type="button" className={styles.add} disabled={disabled} onClick={addRow}><Icon name="plus" size={12} />{t('tools.mcp.rowAdd')}</button>
    </div>
    <div className={styles.rows} ref={list}>
      {rows.map((row, index) => {
        const hidden = secret(row) && !revealed.has(index);
        const blank = !row.key.trim() && !row.value.trim();
        return <div className={styles.row} data-row data-single={single || undefined} data-blank={blank || undefined} key={index}>
          {!single && <input aria-label={t('tools.mcp.rowKey', { label, index: index + 1 })} aria-invalid={duplicates.includes(row.key.trim()) && !!row.key.trim() || undefined} value={row.key} placeholder={keyPlaceholder} disabled={disabled} spellCheck={false} autoComplete="off" onChange={(event) => update(index, { ...row, key: event.target.value })} onPaste={(event) => paste(index, event)} />}
          <span className={styles.value} data-secret={secret(row) || undefined}>
            <input aria-label={single ? t('tools.mcp.rowSingle', { label, index: index + 1 }) : t('tools.mcp.rowValue', { label, index: index + 1 })} data-masked={hidden || undefined} value={row.value} placeholder={valuePlaceholder} disabled={disabled} spellCheck={false} autoComplete="off" onChange={(event) => update(index, { ...row, value: event.target.value })} onPaste={(event) => paste(index, event)} />
            {secret(row) && <button type="button" className={styles.reveal} aria-label={hidden ? t('tools.mcp.rowReveal', { index: index + 1 }) : t('tools.mcp.rowHide', { index: index + 1 })} title={hidden ? t('tools.mcp.rowReveal', { index: index + 1 }) : t('tools.mcp.rowHide', { index: index + 1 })} aria-pressed={!hidden} onClick={() => toggleReveal(index)}><Icon name={hidden ? 'eye' : 'eyeOff'} size={14} /></button>}
          </span>
          <span className={styles.rowOps}>
            <button type="button" aria-label={t('tools.mcp.rowUp', { index: index + 1 })} title={t('tools.mcp.rowUp', { index: index + 1 })} disabled={disabled || index === 0} onClick={() => move(index, -1)}><span className={styles.up}><Icon name="arrowDown" size={14} /></span></button>
            <button type="button" aria-label={t('tools.mcp.rowDown', { index: index + 1 })} title={t('tools.mcp.rowDown', { index: index + 1 })} disabled={disabled || index === rows.length - 1} onClick={() => move(index, 1)}><Icon name="arrowDown" size={14} /></button>
            <button type="button" className={styles.remove} aria-label={t('tools.mcp.rowRemove', { index: index + 1 })} title={t('tools.mcp.rowRemove', { index: index + 1 })} disabled={disabled} onClick={() => removeRow(index)}><Icon name="close" size={14} /></button>
          </span>
        </div>;
      })}
    </div>
    {!!duplicates.length && <p className={styles.duplicate} role="alert">{t('tools.mcp.duplicateKey', { keys: duplicates.join('、') })}</p>}
    {note && <p className={styles.hint}>{note}</p>}
  </div>;
}
