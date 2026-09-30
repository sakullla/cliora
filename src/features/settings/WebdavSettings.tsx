import { useEffect, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { ConflictPreview, SyncStatus, WebdavSetup } from '../../types/portable';
import styles from './MigrationSettings.module.css';

export function WebdavSettings({ active, editing, onEdit }: { active: boolean; editing: boolean; onEdit: (editing: boolean) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [setup, setSetup] = useState<WebdavSetup>({ endpoint: '', username: '', authPassword: '', encryptionPassword: '', previousEncryptionPassword: '', enabled: true });
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<Record<string, ConflictPreview>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const latest = useRef(''); latest.current = JSON.stringify([status, previews, active]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    void native.getWebdavStatus().then((next) => {
      if (!alive) return;
      setStatus(next);
      if (next.endpoint) setSetup((old) => ({ ...old, endpoint: next.endpoint ?? '', enabled: next.enabled }));
    }).catch((reason: { message?: string }) => { if (alive) setError(reason.message ?? '无法读取同步状态'); });
    return () => { alive = false; };
  }, [active]);

  async function configure() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.configureWebdav(setup);
      setStatus(next); onEdit(false);
      setSetup({ endpoint: next.endpoint ?? '', username: '', authPassword: '', encryptionPassword: '', previousEncryptionPassword: '', enabled: next.enabled });
      setMessage('连接已验证，凭据保存在本机系统凭据服务中。');
      if (next.enabled) setStatus(await native.syncWebdavNow());
    } catch (reason) { setError((reason as { message?: string }).message ?? 'WebDAV 配置失败'); }
    finally { setBusy(false); }
  }

  async function toggleEnabled() {
    if (busy || !status) return;
    setBusy(true); setError('');
    try { setStatus(await native.setWebdavEnabled(!status.enabled)); }
    catch (reason) { setError((reason as { message?: string }).message ?? '无法修改同步状态'); }
    finally { setBusy(false); }
  }

  async function syncNow() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.syncWebdavNow(); setStatus(next);
      setPreviews({});
      setMessage(`同步完成：上传 ${next.uploaded} 项、接收 ${next.downloaded} 项${next.conflicts.length ? `，${next.conflicts.length} 项待处理` : ''}。`);
    } catch (reason) {
      setError((reason as { message?: string }).message ?? '同步失败');
      void native.getWebdavStatus().then(setStatus).catch(() => {});
    } finally { setBusy(false); }
  }

  async function resolve(key: string, versionId: string | null, deleted: boolean) {
    if (busy) return;
    const started = latest.current;
    if (versionId && !await confirmAction(deleted ? '此项本机资料会删除。' : '用这个远端版本替换本机资料？活动 CLI 配置不会自动切换。', () => mounted.current && latest.current === started, { title: deleted ? '接受远端删除？' : '使用远端版本？', confirmLabel: deleted ? '删除本机资料' : '替换本机资料', destructive: deleted })) return;
    setBusy(true); setError(''); setMessage('');
    try { setStatus(await native.resolveWebdavConflict(key, versionId));
      setPreviews((old) => { const next = { ...old }; delete next[key]; return next; });
      setMessage('冲突已处理，其他资料保持不变。'); }
    catch (reason) { setError((reason as { message?: string }).message ?? '冲突处理失败'); }
    finally { setBusy(false); }
  }

  async function previewConflict(key: string) {
    if (busy) return;
    setBusy(true); setError('');
    try { const next = await native.previewWebdavConflict(key); setPreviews((old) => ({ ...old, [key]: next })); }
    catch (reason) { setError((reason as { message?: string }).message ?? '无法读取冲突内容'); }
    finally { setBusy(false); }
  }

  return <section className="settings-group">
    <div className="setting-intro"><h2>WebDAV 同步</h2><p>同步加密后的配置和资料。填写服务器地址和账号密码；另一台设备用同一连接信息即可恢复。</p></div>
    {error && <div className={styles.inlineError} role="alert">{error}</div>}
    {message && <div className={styles.inlineMessage} role="status">{message}</div>}
    {status?.configured ? <>
      <div className="setting-row"><span><strong>{status.endpoint}</strong><small>{status.lastSuccess ? `上次成功 ${new Date(status.lastSuccess * 1000).toLocaleString()}` : '尚未完成同步'}{status.pendingChanges ? ` · ${status.pendingChanges} 项待同步` : ''}{status.lastError ? ` · 上次失败：${status.lastError}` : ''}</small></span>
        <button className="button" type="button" disabled={busy} onClick={() => void toggleEnabled()}>{status.enabled ? '暂停同步' : '启用同步'}</button></div>
      <div className={styles.action}><button className="button primary" type="button" disabled={busy} onClick={() => void syncNow()}>{busy ? '正在同步…' : '立即同步'}</button>
        <button className="button" type="button" disabled={busy} onClick={() => onEdit(true)}>修改连接或凭据</button></div>
    </> : <div className="setting-row"><span><strong>尚未连接</strong><small>配置一次，在多台设备间同步加密资料</small></span><button className="button" type="button" onClick={() => onEdit(true)}>配置 WebDAV</button></div>}
    <div className={styles.webdavForm} hidden={!editing}>
      <label>WebDAV 目录地址<input type="url" value={setup.endpoint} placeholder="https://dav.example.com/cliora/" onChange={(event) => setSetup({ ...setup, endpoint: event.target.value })} /></label>
      <label>用户名<input value={setup.username} autoComplete="username" onChange={(event) => setSetup({ ...setup, username: event.target.value })} /></label>
      <label>WebDAV 密码<input type="password" value={setup.authPassword} autoComplete="new-password" placeholder="建议使用至少 12 位的应用专用密码" onChange={(event) => setSetup({ ...setup, authPassword: event.target.value })} /></label>
      <details className={styles.advanced}><summary>单独设置加密口令</summary><label>新的独立加密口令<input type="password" value={setup.encryptionPassword} autoComplete="new-password" placeholder="留空则使用 WebDAV 密码" onChange={(event) => setSetup({ ...setup, encryptionPassword: event.target.value })} /></label><label>旧加密口令<input type="password" value={setup.previousEncryptionPassword} autoComplete="off" placeholder="换设备且旧口令与连接密码不同时填写" onChange={(event) => setSetup({ ...setup, previousEncryptionPassword: event.target.value })} /></label></details>
      <small>默认用连接密码解锁远端加密空间，并在本机系统凭据服务保存。掌握服务器连接密码的一方可能解锁资料；请使用独立、安全的 WebDAV 账号或应用专用密码。</small>
      <div className={styles.action}><button type="button" className="button primary" disabled={!nativeAvailable || busy || !setup.endpoint || !setup.username || !setup.authPassword || (setup.authPassword.length < 12 && setup.encryptionPassword.length < 12)} onClick={() => void configure()}>验证并保存</button>
        <button type="button" className="button" disabled={busy} onClick={() => onEdit(false)}>取消</button></div>
    </div>
    {!!status?.conflicts.length && <div className={styles.conflicts}><h3>待处理的同步冲突</h3><p>同一项在不同设备上有改动，或一边删除。版本均保留在远端，选择要继续使用的内容。</p>
      {status.conflicts.map((conflict) => <div className={styles.conflict} key={conflict.key}><strong>{conflict.label}</strong><small>{conflict.key} · {conflict.remoteVersions} 个远端版本</small>
        {!previews[conflict.key] ? <button className="button" type="button" disabled={busy} onClick={() => void previewConflict(conflict.key)}>查看内容并选择</button> : <>
          <div className={styles.version}><strong>本机</strong><p>{previews[conflict.key].localSummary}</p><button className="button" type="button" disabled={busy} onClick={() => void resolve(conflict.key, null, false)}>保留本机</button></div>
          {previews[conflict.key].versions.map((version) => <div className={styles.version} key={version.id}><strong>远端 {version.id.slice(0, 8)}</strong><p>{version.summary}</p>
            <button className="button" type="button" disabled={busy} onClick={() => void resolve(conflict.key, version.id, version.deleted)}>{version.deleted ? '接受删除' : '使用这个远端版本'}</button></div>)}
        </>}</div>)}
    </div>}
  </section>;
}
