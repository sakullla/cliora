import { useCallback, useRef, useState } from 'react';
import i18n from '../../i18n';
import { native } from '../../lib/native';
import type { RemoteProject, RemoteTarget } from '../../types/remote';
import { RemoteFolderPicker } from './RemoteFolderPicker';

/** Remote paths are POSIX: one leading slash, no trailing slash except the root. */
export function normalizeRemotePath(path: string): string {
  const trimmed = path.trim().replace(/\/{2,}/g, '/');
  if (!trimmed) return '';
  const clean = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  return clean || '/';
}

export function remoteJoin(parent: string, name: string): string {
  const base = normalizeRemotePath(parent);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export function remoteParent(path: string): string {
  const clean = normalizeRemotePath(path);
  const index = clean.lastIndexOf('/');
  return index <= 0 ? '/' : clean.slice(0, index);
}

export function remoteBaseName(path: string): string {
  return normalizeRemotePath(path).split('/').filter(Boolean).pop() ?? '';
}

/** Where browsing starts: the host's configured default path, else the login user's usual home. */
export function remoteStartPath(target: Pick<RemoteTarget, 'defaultPath' | 'user'>): string {
  const configured = normalizeRemotePath(target.defaultPath ?? '');
  if (configured && !configured.startsWith('~')) return configured;
  return target.user === 'root' ? '/root' : `/home/${target.user}`;
}

/**
 * A remote session always runs inside a saved remote project: the session index and reattachment
 * key on it. Picking a folder reuses the record for that host and path, or adds one named after the
 * folder, the same way adding a local project takes the folder name.
 */
export async function ensureRemoteProject(targetId: string, path: string, toolId?: string | null, known: RemoteProject[] = []): Promise<RemoteProject> {
  const clean = normalizeRemotePath(path);
  const match = (items: RemoteProject[]) => items.find((item) => item.targetId === targetId && normalizeRemotePath(item.path) === clean);
  const existing = match(known) ?? match(await native.listRemoteProjects(targetId).catch(() => [] as RemoteProject[]));
  if (existing) return existing;
  return native.saveRemoteProject({ id: '', targetId, name: remoteBaseName(clean) || i18n.t('home.remote.defaultName'), path: clean, preferredTool: toolId || null, updatedAt: 0 });
}

// Like the local launch directory, the remote one is remembered for this app session per host and CLI.
const rememberedDirs = new Map<string, string>();
const lastDirs = new Map<string, string>();
export const rememberedRemoteDir = (targetId: string, toolId: string) => rememberedDirs.get(`${targetId}|${toolId}`);
export const lastRemoteDir = (targetId: string) => lastDirs.get(targetId);
export function rememberRemoteDir(targetId: string, toolId: string, path: string) {
  rememberedDirs.set(`${targetId}|${toolId}`, path);
  lastDirs.set(targetId, path);
}
export function forgetRemoteDir(targetId: string, toolId: string) { rememberedDirs.delete(`${targetId}|${toolId}`); }

type PickRequest = { targetId: string; initialPath?: string; title?: string };

/** One picker per consumer: `pick` resolves with the chosen remote path, or null when cancelled. */
export function useRemoteFolderPicker() {
  const [request, setRequest] = useState<PickRequest | null>(null);
  const resolver = useRef<((path: string | null) => void) | null>(null);
  const pick = useCallback((targetId: string, options: Omit<PickRequest, 'targetId'> = {}) => new Promise<string | null>((resolve) => {
    resolver.current?.(null);
    resolver.current = resolve;
    setRequest({ targetId, ...options });
  }), []);
  const settle = (path: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(path);
  };
  const element = <RemoteFolderPicker open={!!request} targetId={request?.targetId ?? ''} initialPath={request?.initialPath} title={request?.title} onClose={() => settle(null)} onPick={(path) => settle(path)} />;
  return { pick, element, picking: !!request };
}
