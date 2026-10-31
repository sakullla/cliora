import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBanner } from '../components/StatusBanner';
import { getRemoteIdentity, native, subscribeRemoteIdentity } from './native';
import { RemoteDraftVersions, type RemoteFreshness, type RemoteOperationOptions } from './remoteOperations';

// Argument positions belong to IPC methods, never concrete CLI identities.
const readOptions: Record<string, number> = {
  listRemoteRulePlacements: 1, listRemoteLibraryItems: 3, listRemoteDirectories: 2,
  probeRemoteCli: 2, probeRemoteClis: 2, getRemoteToolStore: 4,
  getRemoteResourceStore: 3, listRemoteResourceStores: 3,
  listRemoteNativeHistory: 2, listRemoteNativeHistorySnapshot: 2, getRemoteNativeHistory: 2,
};

const writeOptions: Record<string, number> = {
  saveRemoteLibraryItem: 2, deleteRemoteLibraryItem: 3, syncRemoteRuleClients: 4,
  saveRemoteToolStore: 5, deleteRemoteToolProfile: 3,
  saveRemoteResourceStore: 4, importRemoteSkillDirectory: 3,
};

export const RemoteReadVisibility = createContext(true);

export function useRemoteIdentity(targetId?: string | null) {
  return useSyncExternalStore(subscribeRemoteIdentity, () => getRemoteIdentity(targetId));
}

/** A page owns subscriptions, not the shared native flight. Preserve drafts
 * while refreshing lists; dispose subscriptions on context change or hiding. */
export function useRemoteReads(targetId?: string | null, context = '', active = true) {
  const visible = useContext(RemoteReadVisibility);
  active = active && visible;
  const identity = useRemoteIdentity(targetId);
  const [snapshot, setSnapshot] = useState({ key: '', stale: false, at: 0 });
  const current = useRef('');
  const key = JSON.stringify([identity, context, active]);
  current.current = key;
  const writes = useMemo(() => new RemoteDraftVersions(), [identity]);
  useEffect(() => { writes.rebaseAction(); }, [writes, context]);
  const owner = useMemo(() => ({ controller: new AbortController(), resources: new Map<string, RemoteFreshness>(), writes }), [key]);
  useEffect(() => {
    // StrictMode replays effects; replace an already disposed controller.
    if (owner.controller.signal.aborted) owner.controller = new AbortController();
    if (!active) owner.controller.abort();
    return () => owner.controller.abort();
  }, [owner, active]);
  const api = useMemo(() => new Proxy(native, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      const writePosition = typeof property === 'string' ? writeOptions[property] : undefined;
      if (writePosition !== undefined && targetId && targetId !== 'local') return async (...args: unknown[]) => {
        const options = args[writePosition] as RemoteOperationOptions | undefined;
        args[writePosition] = { ...options, expectedFiles: owner.writes.expected(), onVersions: (versions: Record<string, string>) => {
          owner.writes.committed(versions);
          options?.onVersions?.(versions);
        } };
        const result = await original(...args);
        return result;
      };
      const position = typeof property === 'string' ? readOptions[property] : undefined;
      if (position === undefined || !targetId || targetId === 'local') return original;
      return async (...args: unknown[]) => {
        const options = args[position] as RemoteOperationOptions | undefined;
        const signal = options?.signal ? AbortSignal.any([owner.controller.signal, options.signal]) : owner.controller.signal;
        const resource = JSON.stringify([identity, property, args.slice(0, position)]);
        const report = (state: RemoteFreshness) => {
          if (signal.aborted || current.current !== key) return;
          state = { ...state, at: state.at || (state.stale ? owner.resources.get(resource)?.at ?? 0 : 0) };
          owner.resources.set(resource, state);
          const values = [...owner.resources.values()];
          setSnapshot({ key, stale: values.some(value => value.stale), at: Math.max(0, ...values.map(value => value.at)) });
          options?.onFreshness?.(state);
        };
        args[position] = { ...options, signal, onFreshness: report, onVersions: (versions: Record<string, string>) => {
          if (!signal.aborted && current.current === key) owner.writes.observe(versions);
          options?.onVersions?.(versions);
        } };
        try {
          const value = await original(...args);
          if (signal.aborted || current.current !== key) throw { message: '远程读取已取消', reason: 'cancelled' };
          return value;
        } catch (error) {
          if (!signal.aborted && current.current === key) {
            report({ stale: true, at: owner.resources.get(resource)?.at ?? 0 });
          }
          throw error;
        }
      };
    },
  }), [owner, targetId, key]);
  const status = snapshot.key === key ? snapshot : { stale: false, at: 0 };
  return { native: api, status, identity, active, signal: owner.controller.signal, bindWriteDraft: (token: string | null) => writes.bind(token), beginWriteAction: () => writes.beginAction(), rebaseWriteAction: () => writes.rebaseAction() };
}

export function RemoteReadStatus({ state }: { state: ReturnType<typeof useRemoteReads> }) {
  const { t } = useTranslation();
  return state.status.stale && state.status.at > 0
    ? <StatusBanner tone="warning">{t('common.remoteRead.stale')}</StatusBanner> : null;
}
