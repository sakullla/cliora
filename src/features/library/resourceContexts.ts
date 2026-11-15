import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import type { Scope } from '../../types/native';
import type { McpTargetResult, SkillTargetResult } from '../../types/resources';
import i18n from '../../i18n';

type Target = { toolId: string; scope: Scope; projectPath: string | null; contextId?: string | null };
const scopeKey = (target: Target) => JSON.stringify([target.toolId, target.scope, target.projectPath]);

/** Per-target Skill write state, read from the native result instead of assumed.
 * `ok` is a real write; `unchanged` means native found the target already current. */
export type SkillWriteState = 'ok' | 'unchanged' | 'removed' | 'failed';
export function skillWriteState(result: SkillTargetResult): SkillWriteState {
  if (result.status === 'installed') return 'ok';
  if (result.status === 'already_current') return 'unchanged';
  if (result.status === 'removed') return 'removed';
  return 'failed';
}

/** Per-target MCP state of a committed draft. `unchanged` is a native run that
 * matched the file already (`already_matching`); a leftover preview status is
 * `unconfirmed`, never a write. */
export type McpWriteState = 'written' | 'unchanged' | 'removed' | 'failed' | 'unsupported' | 'unconfirmed';
export function mcpWriteState(result: McpTargetResult): McpWriteState {
  if (result.status === 'written') return result.detail === 'already_matching' ? 'unchanged' : 'written';
  if (result.status === 'removed') return 'removed';
  if (result.status === 'unsupported') return 'unsupported';
  if (result.status === 'failed') return 'failed';
  return 'unconfirmed';
}

export function useAccountLabels(remote = false) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    if (remote) return () => { live = false; };
    void native.listAccounts().then((accounts) => {
      if (!live || !Array.isArray(accounts)) return;
      const entries: [string, string][] = [];
      for (const account of accounts) {
        const name = account.identity?.email ? `${account.label} (${account.identity.email})` : account.label;
        if (account.context) entries.push([account.context.id, name]);
        for (const context of account.retiredContexts ?? []) entries.push([context.id, i18n.t('library.contexts.retired', { name })]);
      }
      setLabels(Object.fromEntries(entries));
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  return (id?: string | null) => id ? labels[id] ?? i18n.t('library.contexts.unavailable', { id: id.slice(0, 8) }) : i18n.t('library.contexts.default');
}

// Project files are shared by accounts. Their placement identity has no context,
// but writes must still carry the effective account read from the workspace.
export async function removalContext(target: Target) {
  if (target.scope === 'global') return target.contextId ?? null;
  const workspace = await native.getRegisteredToolWorkspace(target.toolId, target.scope, target.projectPath ?? undefined, true);
  return workspace.effectiveContextId ?? null;
}

type ContextResult = { status: 'pending' } | { status: 'resolved'; contextId: string | null } | { status: 'failed'; error: string };

export function useResourceContexts(tools: { id: string }[], placements: Target[], active: { scope: Scope; projectPath: string | null }) {
  const targets = [...tools.map((tool): Target => ({ toolId: tool.id, ...active })), ...placements];
  const stamp = JSON.stringify([...new Set(targets.map(scopeKey))].sort());
  const [state, setState] = useState<{ stamp: string; values: Record<string, ContextResult> }>({ stamp: '', values: {} });
  useEffect(() => {
    let live = true;
    setState({ stamp, values: {} });
    for (const key of JSON.parse(stamp) as string[]) {
      const [toolId, scope, path] = JSON.parse(key) as [string, Scope, string | null];
      const publish = (result: ContextResult) => {
        if (live) setState((previous) => ({ stamp, values: { ...previous.values, [key]: result } }));
      };
      void native.getRegisteredToolWorkspace(toolId, scope, path ?? undefined, true)
        .then((workspace) => {
          if (workspace.effectiveContextId !== null && typeof workspace.effectiveContextId !== 'string') throw new Error(i18n.t('library.contexts.missingContext'));
          publish({ status: 'resolved', contextId: workspace.effectiveContextId });
        })
        .catch((error: unknown) => publish({ status: 'failed', error: error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('library.contexts.readFailed') }));
    }
    return () => { live = false; };
  }, [stamp]);
  const result = (target: Target): ContextResult => state.stamp === stamp ? state.values[scopeKey(target)] ?? { status: 'pending' } : { status: 'pending' };
  const ready = (target: Target) => result(target).status === 'resolved';
  return {
    ready,
    stamp: JSON.stringify(state),
    result,
    context: (target: Target) => {
      const value = result(target);
      if (value.status !== 'resolved') throw new Error(i18n.t('library.contexts.notReady'));
      return value.contextId;
    },
    matches: (target: Target) => {
      const value = result(target);
      return value.status === 'resolved' && (target.scope === 'project' || (target.contextId ?? null) === value.contextId);
    },
    issues: (JSON.parse(stamp) as string[]).flatMap((key) => {
      const [toolId, scope, projectPath] = JSON.parse(key) as [string, Scope, string | null];
      const target = { toolId, scope, projectPath };
      const value = result(target);
      return value.status === 'resolved' ? [] : [{ key, ...target, detail: value.status === 'failed' ? value.error : i18n.t('library.contexts.loading') }];
    }),
  };
}
