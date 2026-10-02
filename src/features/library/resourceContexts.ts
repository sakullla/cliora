import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import type { Scope } from '../../types/native';

type Target = { toolId: string; scope: Scope; projectPath: string | null; contextId?: string | null };
const scopeKey = (target: Target) => JSON.stringify([target.toolId, target.scope, target.projectPath]);

export function useAccountLabels() {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void native.listAccounts().then((accounts) => {
      if (!live || !Array.isArray(accounts)) return;
      const entries: [string, string][] = [];
      for (const account of accounts) {
        const name = account.identity?.email ? `${account.label} (${account.identity.email})` : account.label;
        if (account.context) entries.push([account.context.id, name]);
        for (const context of account.retiredContexts ?? []) entries.push([context.id, `${name} · 旧登录`]);
      }
      setLabels(Object.fromEntries(entries));
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  return (id?: string | null) => id ? labels[id] ?? `不可用上下文 ${id.slice(0, 8)}` : '默认配置';
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
          if (workspace.effectiveContextId !== null && typeof workspace.effectiveContextId !== 'string') throw new Error('工作区缺少有效账号上下文');
          publish({ status: 'resolved', contextId: workspace.effectiveContextId });
        })
        .catch((error: unknown) => publish({ status: 'failed', error: error && typeof error === 'object' && 'message' in error ? String(error.message) : '无法读取账号上下文' }));
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
      if (value.status !== 'resolved') throw new Error('目标账号上下文尚不可用');
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
      return value.status === 'resolved' ? [] : [{ key, ...target, detail: value.status === 'failed' ? value.error : '正在读取账号上下文…' }];
    }),
  };
}
