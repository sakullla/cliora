import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import type { AdapterDescriptor } from '../../types/native';
import type { RemoteProject, RemoteTarget } from '../../types/remote';
import { GuideDialog } from '../../components/GuideDialog';
import { toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import styles from './RemoteProjectDialog.module.css';

const DIRECTORY_CACHE_MS = 20_000;
const directoryCache = new Map<string, { at: number; items: string[] }>();

function directoryCacheKey(targetId: string, parent: string) {
  return `${targetId}\n${parent}`;
}

function readDirectoryCache(targetId: string, parent: string): string[] | null {
  const hit = directoryCache.get(directoryCacheKey(targetId, parent));
  if (!hit || Date.now() - hit.at > DIRECTORY_CACHE_MS) return null;
  return hit.items;
}

function writeDirectoryCache(targetId: string, parent: string, items: string[]) {
  directoryCache.set(directoryCacheKey(targetId, parent), { at: Date.now(), items });
}

export function RemoteProjectDialog({
  open,
  targets,
  projects,
  tools,
  initialTargetId,
  initialPath,
  onClose,
  onSaved,
}: {
  open: boolean;
  targets: RemoteTarget[];
  projects: RemoteProject[];
  tools: AdapterDescriptor[];
  initialTargetId?: string;
  initialPath?: string;
  onClose: () => void;
  onSaved: (project: RemoteProject) => void;
}) {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState(initialTargetId ?? targets[0]?.id ?? '');
  const [name, setName] = useState('');
  const [path, setPath] = useState(initialPath ?? '');
  const [parent, setParent] = useState('/');
  const [directories, setDirectories] = useState<string[]>([]);
  const [toolId, setToolId] = useState('');
  const [busy, setBusy] = useState<'list' | 'mkdir' | 'save' | ''>('');
  const [message, setMessage] = useState('');

  const target = targets.find((item) => item.id === targetId) ?? null;
  const targetProjects = useMemo(() => projects.filter((item) => item.targetId === targetId), [projects, targetId]);
  const toolOptionsList = useMemo(() => toolOptions(tools), [tools]);
  // Host lists are rebuilt on every workbench render. Re-applying that array
  // used to put the default path back while the user was still typing.
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      openedFor.current = null;
      return;
    }
    const token = `${initialTargetId ?? ''}|${initialPath ?? ''}`;
    const nextTarget = targets.find((item) => item.id === (initialTargetId || targetId)) ?? targets[0];
    if (openedFor.current === token) {
      if (!targetId && nextTarget) {
        setTargetId(nextTarget.id);
        setPath(initialPath || nextTarget.defaultPath || '');
        setParent(nextTarget.defaultPath || '/');
      }
      return;
    }
    openedFor.current = token;
    setTargetId(nextTarget?.id ?? '');
    setName('');
    setPath(initialPath || nextTarget?.defaultPath || '');
    setParent(nextTarget?.defaultPath || '/');
    setToolId('');
    setMessage('');
  }, [open, initialPath, initialTargetId, targets, targetId]);

  useEffect(() => {
    if (!open || !targetId || !parent.trim() || target?.authMethod === 'password') return;
    let active = true;
    const parentPath = parent.trim();
    const cached = readDirectoryCache(targetId, parentPath);
    if (cached) setDirectories(cached);
    else setBusy('list');
    void native.listRemoteDirectories(targetId, parentPath).then((items) => {
      const next = Array.isArray(items) ? items : [];
      writeDirectoryCache(targetId, parentPath, next);
      if (active) setDirectories(next);
    }).catch((error) => {
      if (active) setMessage(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [open, parent, targetId, target?.authMethod]);

  function chooseTarget(value: string) {
    const next = targets.find((item) => item.id === value);
    setTargetId(value);
    setPath(next?.defaultPath ?? '');
    setParent(next?.defaultPath ?? '/');
    setName('');
    setMessage('');
  }

  function chooseExisting(value: string) {
    if (!value) return;
    setPath(value);
    if (!name.trim()) setName(value.split('/').filter(Boolean).pop() ?? '');
  }

  async function refreshDirectories() {
    if (!targetId || !parent.trim()) return;
    if (target?.authMethod === 'password') { setMessage(t('home.remote.passwordDirectoryHint')); return; }
    setBusy('list'); setMessage('');
    try {
      const parentPath = parent.trim();
      const items = await native.listRemoteDirectories(targetId, parentPath);
      const next = Array.isArray(items) ? items : [];
      writeDirectoryCache(targetId, parentPath, next);
      setDirectories(next);
    }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  }

  async function createDirectory() {
    const next = path.trim();
    if (!targetId || !next) return;
    if (target?.authMethod === 'password') { setMessage(t('home.remote.passwordDirectoryHint')); return; }
    setBusy('mkdir'); setMessage('');
    try {
      await native.createRemoteDirectory(targetId, next);
      setMessage(t('home.remote.directoryCreated'));
      await refreshDirectories();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  }

  async function save() {
    const nextPath = path.trim();
    if (!targetId || !nextPath) return;
    setBusy('save'); setMessage('');
    const existing = projects.find((item) => item.targetId === targetId && item.path === nextPath);
    try {
      const saved = await native.saveRemoteProject({
        id: existing?.id ?? '',
        targetId,
        name: name.trim() || nextPath.split('/').filter(Boolean).pop() || t('home.remote.defaultName'),
        path: nextPath,
        preferredTool: toolId || existing?.preferredTool || null,
        updatedAt: 0,
      });
      onSaved(saved);
      onClose();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  }

  return <GuideDialog open={open} title={t('home.remote.dialogTitle')} hint={t('home.remote.dialogHint')} wide onClose={onClose}>
    <div className={styles.dialog}>
      {message && <p className={styles.message} role="status">{message}</p>}
      {!targets.length ? <div className={styles.empty}><Icon name="globe" size={20} /><span>{t('home.remote.noTargets')}</span></div> : <>
        <label className={styles.field}><span>{t('home.remote.target')}</span><select value={targetId} onChange={(event) => chooseTarget(event.target.value)}><option value="">{t('home.remote.pickTarget')}</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.user}@{item.host}</option>)}</select></label>
        {target && <div className={styles.targetMeta}><Icon name="globe" size={14} /><span>{target.user}@{target.host}:{target.port}</span><span>{target.defaultPath || '/'}</span></div>}
        <div className={styles.directoryCard}>
          <div className={styles.cardHeader}><div><strong>{t('home.remote.directoryTitle')}</strong><small>{t('home.remote.directoryHint')}</small></div><Button size="sm" variant="ghost" icon={<Icon name="refresh" size={14} />} disabled={!targetId || busy !== ''} onClick={() => void refreshDirectories()}>{t('home.remote.refreshDirectories')}</Button></div>
          <div className={styles.directoryRow}>
            <label className={styles.field}><span>{t('home.remote.savedDirectory')}</span><select value="" onChange={(event) => chooseExisting(event.target.value)} disabled={!targetId || busy !== ''}><option value="">{directories.length || targetProjects.length ? t('home.remote.chooseDirectory') : t('home.remote.noDirectories')}</option>{directories.map((item) => <option key={item} value={item}>{item}</option>)}{targetProjects.map((item) => <option key={`saved:${item.id}`} value={item.path}>{item.path} · {t('home.remote.saved')}</option>)}</select></label>
            <label className={styles.field}><span>{t('home.remote.path')}</span><input value={path} spellCheck={false} autoComplete="off" onChange={(event) => setPath(event.target.value)} placeholder={t('home.remote.pathPlaceholder')} /></label>
          </div>
          {target?.authMethod === 'password' && <small className={styles.fieldHint}>{t('home.remote.passwordDirectoryHint')}</small>}
          <Button size="sm" className={styles.createDirectory} disabled={!targetId || !path.trim() || busy !== '' || target?.authMethod === 'password'} onClick={() => void createDirectory()}>{busy === 'mkdir' ? t('home.remote.creatingDirectory') : t('home.remote.createDirectory')}</Button>
        </div>
        <div className={styles.grid}>
          <label className={styles.field}><span>{t('home.remote.name')}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('home.remote.namePlaceholder')} /></label>
          <label className={styles.field}><span>{t('home.remote.tool')}</span><select value={toolId} onChange={(event) => setToolId(event.target.value)}><option value="">{t('home.remote.chooseLater')}</option>{toolOptionsList.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        </div>
        <div className={styles.actions}><Button onClick={onClose}>{t('common.dialog.cancel')}</Button><Button variant="primary" loading={busy === 'save'} disabled={!targetId || !path.trim() || busy !== ''} onClick={() => void save()}>{busy === 'save' ? t('home.remote.saving') : t('home.remote.save')}</Button></div>
      </>}
    </div>
  </GuideDialog>;
}
