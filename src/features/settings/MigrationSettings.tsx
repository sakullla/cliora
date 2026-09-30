import { useEffect, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { PortableItem, PortablePreview } from '../../types/portable';
import styles from './MigrationSettings.module.css';
import { WebdavSettings } from './WebdavSettings';

const KIND: Record<string, string> = {
  preferences: '偏好', profile: '命名配置', common: '通用配置', project: '项目',
  library: '资料', mcp: 'MCP', skill: 'Skill',
};

export function MigrationSettings({ active, onImported }: { active: boolean; onImported?: () => void }) {
  const [items, setItems] = useState<PortableItem[]>([]);
  const [exportSelected, setExportSelected] = useState<string[]>([]);
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [preview, setPreview] = useState<PortablePreview | null>(null);
  const [importSelected, setImportSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    void native.listPortableItems().then((next) => {
      if (!alive) return;
      setItems(next);
      setExportSelected((old) => old.length ? old : next.map((item) => item.key));
    }).catch((reason: { message?: string }) => { if (alive) setError(reason.message ?? '无法读取可迁移资料'); });
    return () => { alive = false; };
  }, [active]);

  function toggle(key: string, values: string[], update: (next: string[]) => void) {
    update(values.includes(key) ? values.filter((value) => value !== key) : [...values, key]);
  }

  async function exportBundle() {
    if (busy || exportPassword.length < 12 || !exportSelected.length) return;
    const destination = await save({ title: '保存加密配置包',
      defaultPath: `cliora-${new Date().toISOString().slice(0, 10)}.cliora`,
      filters: [{ name: '栖点加密配置包', extensions: ['cliora'] }] });
    if (!destination) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const count = await native.exportPortableBundle(destination, exportPassword, exportSelected);
      setMessage(`已导出 ${count} 项资料。请单独保存口令；配置包不包含本机登录状态和会话记录。`);
      setExportPassword('');
    } catch (reason) { setError((reason as { message?: string }).message ?? '导出失败'); }
    finally { setBusy(false); }
  }

  async function importBundle() {
    if (busy || !importPassword) return;
    const source = await open({ title: '打开加密配置包', multiple: false,
      filters: [{ name: '栖点加密配置包', extensions: ['cliora'] }] });
    if (typeof source !== 'string') return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.previewPortableBundle(source, importPassword);
      setPreview(next);
      setImportSelected(next.items.filter((item) => item.status === 'new').map((item) => item.key));
      setImportPassword('');
    } catch (reason) { setError((reason as { message?: string }).message ?? '无法读取配置包'); }
    finally { setBusy(false); }
  }

  async function cancelPreview() {
    await native.cancelPortablePreview().catch(() => {});
    setPreview(null); setImportSelected([]);
  }

  async function applyPreview() {
    if (!preview || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const count = await native.applyPortableBundle(preview.previewId, importSelected);
      setPreview(null); setImportSelected([]);
      setMessage(`已恢复 ${count} 项资料。项目目录需要在首页重新关联，CLI 原生配置可在工具页检查后应用。`);
      onImported?.();
      const next = await native.listPortableItems();
      setItems(next); setExportSelected(next.map((item) => item.key));
    } catch (reason) { setError((reason as { message?: string }).message ?? '导入失败'); }
    finally { setBusy(false); }
  }

  return <div className={styles.page}>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {message && <div className={styles.message} role="status">{message}</div>}
    <section className="settings-group">
      <div className="setting-intro"><h2>导出加密配置包</h2><p>选好要带走的资料，设置一个至少 12 位的口令。API 密钥包含在加密包内；本机登录、会话和使用记录不包含。</p></div>
      <div className={styles.list} aria-label="选择导出资料">
        {items.map((item) => <label className={styles.item} key={item.key}><input type="checkbox" checked={exportSelected.includes(item.key)}
          onChange={() => toggle(item.key, exportSelected, setExportSelected)} disabled={busy} />
          <span><strong>{item.label}</strong><small>{KIND[item.kind] ?? item.kind}{item.pendingFields.length ? ' · 含换设备后待关联内容' : ''}</small></span></label>)}
        {!items.length && <p className={styles.empty}>当前没有可迁移的资料。</p>}
      </div>
      <div className={styles.action}><label>配置包口令 <input type="password" value={exportPassword} autoComplete="new-password" placeholder="至少 12 位" onChange={(event) => setExportPassword(event.target.value)} /></label>
        <button type="button" className="button primary" disabled={!nativeAvailable || busy || exportPassword.length < 12 || !exportSelected.length} onClick={() => void exportBundle()}>导出配置包</button></div>
    </section>
    <section className="settings-group">
      <div className="setting-intro"><h2>从配置包恢复</h2><p>先解锁并预览。新资料默认选中；与本机不同的资料由你逐项决定是否替换。</p></div>
      {!preview ? <div className={styles.action}><label>配置包口令 <input type="password" value={importPassword} autoComplete="current-password" placeholder="输入导出时的口令" onChange={(event) => setImportPassword(event.target.value)} /></label>
        <button type="button" className="button" disabled={!nativeAvailable || busy || !importPassword} onClick={() => void importBundle()}>选择配置包并预览</button></div> : <>
        <div className={styles.list} aria-label="导入预览">{preview.items.map((item) => <label className={styles.item} key={item.key}>
          <input type="checkbox" checked={importSelected.includes(item.key)} disabled={busy || item.status === 'same'} onChange={() => toggle(item.key, importSelected, setImportSelected)} />
          <span><strong>{item.label}</strong><small>{KIND[item.kind] ?? item.kind} · {item.status === 'new' ? '新增' : item.status === 'same' ? '已存在且相同' : '与本机不同，勾选后替换'}
            {item.pendingFields.length ? ` · 待关联：${item.pendingFields.join('、')}` : ''}</small></span></label>)}</div>
        <div className={styles.action}><span className={styles.hint}>{preview.pendingProjects ? `${preview.pendingProjects} 个项目目录需在新设备重新关联` : '恢复后不会自动切换活动配置'}</span>
          <button type="button" className="button" disabled={busy} onClick={() => void cancelPreview()}>取消</button>
          <button type="button" className="button primary" disabled={busy || !importSelected.length} onClick={() => void applyPreview()}>确认恢复 {importSelected.length} 项</button></div>
      </>}
    </section>
    <WebdavSettings active={active} />
  </div>;
}
