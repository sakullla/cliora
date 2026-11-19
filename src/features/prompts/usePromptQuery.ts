import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { useRemoteIdentity } from '../../lib/remoteReads';
import type { PromptContext, PromptPage, PromptQuery } from '../../types/prompts';

export const PROMPTS_CHANGED = 'cliora:prompts-changed';
export function notifyPromptsChanged() { window.dispatchEvent(new Event(PROMPTS_CHANGED)); }
const empty: PromptPage = { items: [], total: 0, nextOffset: null, tags: [] };
// Summary-only fallback shared across entry points. Body reads and insertions remain bound
// to the caller's sourceKey/sequence. Never reuse a different host, scope, or query.
const snapshots = new Map<string, PromptPage>();
export function promptContextKey(context: PromptContext) { return JSON.stringify([context.targetId || 'local', context.workspaceId || '', context.repositoryId || '']); }
/** `keepPrevious` keeps the last settled page of the same source on screen while a changed
 * scope/filter loads (`placeholder`), so a list never collapses and regrows between two reads. */
export function usePromptQuery(context: PromptContext, query: PromptQuery, active = true, identity = '', options: { keepPrevious?: boolean } = {}) {
  const { t } = useTranslation();
  const contextKey = promptContextKey({ ...context, workspaceId: context.workspaceId ?? query.workspaceId ?? null, repositoryId: context.repositoryId ?? query.repositoryId ?? null });
  const remoteIdentity = useRemoteIdentity(context.targetId ?? 'local');
  const familyKey = JSON.stringify([contextKey, remoteIdentity, identity]);
  const scopeKey = JSON.stringify([contextKey, remoteIdentity, identity, query.scopeFilter ?? null, !!query.includeOtherScopes]);
  const key = JSON.stringify([scopeKey, query]);
  const snapshotKey = JSON.stringify([contextKey, remoteIdentity, {
    search: query.search ?? '', tags: query.tags ?? [], scopeFilter: query.scopeFilter ?? null,
    includeOtherScopes: !!query.includeOtherScopes, favoritesOnly: !!query.favoritesOnly,
    recentOnly: !!query.recentOnly, offset: query.offset ?? 0, limit: query.limit || 40,
  }]);
  const [result, setResult] = useState<{ key: string; scopeKey: string; familyKey: string; page: PromptPage } | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [pending, setPending] = useState('');
  const [generation, setGeneration] = useState(0);
  const sequence = useRef(0);
  const refreshed = useRef(0);
  useEffect(() => { const changed = () => setGeneration(value => value + 1); window.addEventListener(PROMPTS_CHANGED, changed); return () => window.removeEventListener(PROMPTS_CHANGED, changed); }, []);
  useEffect(() => {
    if (!active) return;
    const request = ++sequence.current;
    const controller = new AbortController();
    setPending(key);
    const timer = setTimeout(() => {
      const fresh = generation !== refreshed.current; refreshed.current = generation;
      let stale = false;
      void native.queryPrompts(context, query, { signal: controller.signal, fresh, onFreshness: state => { stale = state.stale; } }).then(page => {
        if (controller.signal.aborted || sequence.current !== request) return;
        if (!page || !Array.isArray(page.items) || typeof page.total !== 'number') throw new Error(t('prompts.readFailed'));
        snapshots.delete(snapshotKey); snapshots.set(snapshotKey, page);
        while (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value!);
        setResult({ key, scopeKey, familyKey, page }); setError(stale ? { key, text: t('prompts.stale') } : null);
      }).catch(value => {
        if (!controller.signal.aborted && sequence.current === request) {
          const cached = snapshots.get(snapshotKey);
          if (cached) setResult({ key, scopeKey, familyKey, page: cached });
          setError({ key, text: formatFailure(value, t('prompts.readFailed'), t('prompts.retry')) });
        }
      }).finally(() => { if (!controller.signal.aborted && sequence.current === request) setPending(''); });
    }, query.search ? 180 : 0);
    return () => { controller.abort(); clearTimeout(timer); sequence.current++; };
  }, [active, key, generation, t]);
  const currentError = error?.key === key ? error.text : '';
  // Failed filters may retain a clearly stale snapshot of this same source/scope, never
  // another host or project. Its total is not a hit count for the unsuccessful new query.
  const stale = !!currentError && result?.scopeKey === scopeKey;
  const loading = active && (pending === key || (result?.key !== key && error?.key !== key));
  // Never another host, project or caller identity: only the same source's previous query.
  const placeholder = !!options.keepPrevious && loading && !currentError && !!result && result.key !== key && result.familyKey === familyKey;
  return { loaded: result?.key === key, stale, placeholder, page: result?.key === key || stale || placeholder ? result!.page : empty, error: currentError, loading, reload: () => setGeneration(value => value + 1), key };
}
