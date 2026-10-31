import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { GuideDialog } from '../../components/GuideDialog';
import { Button, Card, Toolbar } from '../../components/ui';
import { StatusBanner } from '../../components/StatusBanner';
import { confirmAction } from '../../lib/confirm';
import type { RemoteTarget, RemoteWriteReceipt } from '../../types/remote';
import { beginWriteReceiptInspection, captureWriteReceiptVersions, clearWriteFault, rememberListedWriteReceipt, rememberWriteReceipt, unresolvedWrite, useWriteFaults, useWriteReceipts } from './writeReceipts';

const text = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

export function RemoteWriteRecovery({ target }: { target: RemoteTarget | null }) {
  const { t } = useTranslation();
  const receipts = useWriteReceipts();
  const faults = useWriteFaults();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const loading = useRef<AbortController | null>(null);
  const current = receipts.filter(item => item.targetId === target?.id);
  const fault = faults.find(item => item.targetId === target?.id);

  async function load(discover = false) {
    if (!target) return;
    if (fault && fault.targetRevision !== target.updatedAt) { setError(t('common.remoteWrite.identityChanged')); return; }
    loading.current?.abort();
    const controller = new AbortController(); loading.current = controller;
    const version = ++generation.current;
    const receiptVersions = captureWriteReceiptVersions();
    setBusy(true); setError('');
    try {
      const values = await native.listRemoteWriteReceipts(target.id, { targetRevision: target.updatedAt, signal: controller.signal });
      if (Array.isArray(values)) {
        // Results retain their original host even if the visible target changed.
        for (const value of values) rememberListedWriteReceipt(value, receiptVersions);
        clearWriteFault(target.id, target.updatedAt);
        if (discover && generation.current === version && values.some(unresolvedWrite)) setOpen(true);
      }
    } catch (error) { if (generation.current === version) setError(text(error)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  useEffect(() => {
    const onWrite = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const receipt = detail?.error?.remote?.receipt as RemoteWriteReceipt | undefined;
      if (receipt) rememberWriteReceipt(receipt);
      if (detail?.targetId === target?.id && receipt && unresolvedWrite(receipt)) { setOpen(true); setError(text(detail.error)); }
    };
    window.addEventListener('cliora:remote-write', onWrite);
    return () => window.removeEventListener('cliora:remote-write', onWrite);
  }, [target?.id]);
  useEffect(() => {
    setOpen(false); setError(''); setBusy(false); generation.current++;
    return () => { generation.current++; loading.current?.abort(); };
  }, [target?.id, target?.updatedAt]);
  useEffect(() => {
    if (fault && fault.targetRevision === target?.updatedAt) void load(true);
    // Discovery is triggered only by a persisted write failure, never normal navigation.
  }, [fault, target?.id, target?.updatedAt]);
  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent).detail?.targetId !== target?.id) return;
      setOpen(true); void load();
    };
    window.addEventListener('cliora:remote-write-recovery', onOpen);
    return () => window.removeEventListener('cliora:remote-write-recovery', onOpen);
  });

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
  return <GuideDialog open={open} title={t('common.remoteWrite.title')} hint={t('common.remoteWrite.hint')} wide onClose={() => setOpen(false)}>
      <>
        <p>{target.name} · {target.user}@{target.host}:{target.port}</p>
        {error && <StatusBanner tone="error">{error}</StatusBanner>}
        <Toolbar actions={<Button size="sm" disabled={busy} onClick={() => void load()}>{t('common.remoteWrite.refresh')}</Button>} />
        {!current.length && <p>{t('common.remoteWrite.empty')}</p>}
        {current.map(receipt => <Card padding="compact" key={receipt.id} data-write-receipt={receipt.id}>
          <StatusBanner tone={unresolvedWrite(receipt) ? 'warning' : 'success'}>{t(`common.remoteWrite.outcomes.${receipt.outcome}`, { defaultValue: receipt.outcome })}</StatusBanner>
          <code>{receipt.id}</code>
          <p>{t('common.remoteWrite.revision', { revision: receipt.targetRevision })}</p>
          {receipt.items.map(item => <p key={item.path}>
            <code>{item.path}</code><br />
            <span>{t(`common.remoteWrite.states.${item.state}`, { defaultValue: item.state })}{item.observed && ` · ${t(`common.remoteWrite.observed.${item.observed}`)}`}</span>
          </p>)}
          {!unresolvedWrite(receipt) && receipt.items.some(item => item.observed === 'conflict') && <p>{t('common.remoteWrite.historicalChange')}</p>}
          <Toolbar actions={<>
            <Button size="sm" disabled={busy || target.updatedAt !== receipt.targetRevision} onClick={() => void inspect(receipt, false)}>{t('common.remoteWrite.inspect')}</Button>
            <Button size="sm" disabled={busy || target.updatedAt !== receipt.targetRevision || receipt.items.some(item => !item.observed) || (!unresolvedWrite(receipt) && (receipt.outcome !== 'committed' || receipt.items.some(item => item.observed === 'conflict')))} onClick={() => void inspect(receipt, true)}>{t('common.remoteWrite.restore')}</Button>
          </>} />
          {target.updatedAt !== receipt.targetRevision && <p>{t('common.remoteWrite.identityChanged')}</p>}
        </Card>)}
      </>
    </GuideDialog>;
}
