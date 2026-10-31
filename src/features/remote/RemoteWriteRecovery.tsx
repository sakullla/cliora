import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { GuideDialog } from '../../components/GuideDialog';
import { Button } from '../../components/ui';
import { StatusBanner } from '../../components/StatusBanner';
import { confirmAction } from '../../lib/confirm';
import type { RemoteTarget, RemoteWriteReceipt } from '../../types/remote';
import { beginWriteReceiptInspection, captureWriteReceiptVersions, rememberListedWriteReceipt, rememberWriteReceipt, unresolvedWrite, useWriteReceipts } from './writeReceipts';
import styles from './RemoteWriteRecovery.module.css';

const text = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

export function RemoteWriteRecovery({ target }: { target: RemoteTarget | null }) {
  const { t } = useTranslation();
  const receipts = useWriteReceipts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const current = receipts.filter(item => item.targetId === target?.id);
  const unresolved = current.filter(unresolvedWrite);

  async function load() {
    if (!target) return;
    const version = ++generation.current;
    const receiptVersions = captureWriteReceiptVersions();
    setBusy(true); setError('');
    try {
      const values = await native.listRemoteWriteReceipts(target.id, { targetRevision: target.updatedAt });
      if (generation.current === version && Array.isArray(values)) for (const value of values) rememberListedWriteReceipt(value, receiptVersions);
    } catch (error) { if (generation.current === version) setError(text(error)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  useEffect(() => {
    const onWrite = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const receipt = detail?.error?.remote?.receipt as RemoteWriteReceipt | undefined;
      if (receipt) rememberWriteReceipt(receipt);
      if (detail?.targetId === target?.id && receipt) { setOpen(true); setError(text(detail.error)); }
    };
    window.addEventListener('cliora:remote-write', onWrite);
    return () => window.removeEventListener('cliora:remote-write', onWrite);
  }, [target?.id]);
  useEffect(() => { setOpen(false); setError(''); setBusy(false); generation.current++; }, [target?.id, target?.updatedAt]);

  async function inspect(receipt: RemoteWriteReceipt, rollback: boolean) {
    if (!target || target.updatedAt !== receipt.targetRevision) { setError(t('common.remoteWrite.identityChanged')); return; }
    if (rollback && !await confirmAction(t('common.remoteWrite.restoreConfirm'))) return;
    const finish = beginWriteReceiptInspection(receipt.id);
    if (!finish) return;
    const version = ++generation.current; setBusy(true); setError('');
    try {
      // This targets the original host revision, even if the visible page changes.
      const value = await native.inspectRemoteWrite(receipt.targetId, receipt.id, rollback, { targetRevision: receipt.targetRevision }, receipt);
      rememberWriteReceipt(value);
    } catch (error) { if (generation.current === version) setError(text(error)); }
    finally { finish(); if (generation.current === version) setBusy(false); }
  }
  if (!target) return null;
  return <div className={styles.root}>
    {unresolved.length > 0 && <StatusBanner tone="warning" action={<Button size="sm" onClick={() => { setOpen(true); void load(); }}>{t('common.remoteWrite.open')}</Button>}>{t('common.remoteWrite.unknown')}</StatusBanner>}
    {unresolved.length === 0 && <Button size="sm" onClick={() => { setOpen(true); void load(); }}>{t('common.remoteWrite.open')}</Button>}
    <GuideDialog open={open} title={t('common.remoteWrite.title')} hint={t('common.remoteWrite.hint')} wide onClose={() => setOpen(false)}>
      <div className={styles.body}>
        <p>{target.name} · {target.user}@{target.host}:{target.port}</p>
        {error && <StatusBanner tone="error">{error}</StatusBanner>}
        <Button size="sm" disabled={busy} onClick={() => void load()}>{t('common.remoteWrite.refresh')}</Button>
        {!current.length && <p>{t('common.remoteWrite.empty')}</p>}
        {current.map(receipt => <article className={styles.receipt} key={receipt.id} data-write-receipt={receipt.id}>
          <strong>{t(`common.remoteWrite.outcomes.${receipt.outcome}`, { defaultValue: receipt.outcome })}</strong>
          <code>{receipt.id}</code>
          <p>{t('common.remoteWrite.revision', { revision: receipt.targetRevision })}</p>
          {receipt.items.map(item => <div className={styles.item} key={item.path}>
            <code>{item.path}</code>
            <span>{t(`common.remoteWrite.states.${item.state}`, { defaultValue: item.state })}{item.observed && ` · ${t(`common.remoteWrite.observed.${item.observed}`)}`}</span>
          </div>)}
          <div className={styles.actions}>
            <Button size="sm" disabled={busy || target.updatedAt !== receipt.targetRevision} onClick={() => void inspect(receipt, false)}>{t('common.remoteWrite.inspect')}</Button>
            <Button size="sm" disabled={busy || target.updatedAt !== receipt.targetRevision || receipt.items.some(item => !item.observed)} onClick={() => void inspect(receipt, true)}>{t('common.remoteWrite.restore')}</Button>
          </div>
          {target.updatedAt !== receipt.targetRevision && <p>{t('common.remoteWrite.identityChanged')}</p>}
        </article>)}
      </div>
    </GuideDialog>
  </div>;
}
