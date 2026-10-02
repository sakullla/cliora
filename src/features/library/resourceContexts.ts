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

export function useResourceContexts(tools: { id: string }[], placements: Target[]) {
  const targets = [...tools.map((tool): Target => ({ toolId: tool.id, scope: 'global', projectPath: null })), ...placements];
  const stamp = JSON.stringify([...new Set(targets.map(scopeKey))].sort());
  const [state, setState] = useState<{ stamp: string; values: Record<string, string | null> }>({ stamp: '', values: {} });
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    void Promise.all((JSON.parse(stamp) as string[]).map(async (key) => {
      const [toolId, scope, path] = JSON.parse(key) as [string, Scope, string | null];
      const workspace = await native.getRegisteredToolWorkspace(toolId, scope, path ?? undefined, true);
      return [key, workspace.effectiveContextId ?? null] as const;
    })).then((entries) => { if (live) setState({ stamp, values: Object.fromEntries(entries) }); })
      .catch(() => { if (live) setError('无法读取当前账号，请重新打开分发窗口。'); });
    return () => { live = false; };
  }, [stamp]);
  return {
    ready: state.stamp === stamp,
    stamp: JSON.stringify(state),
    error,
    context: (target: Target) => state.values[scopeKey(target)] ?? null,
    matches: (target: Target) => target.scope === 'project' || (target.contextId ?? null) === state.values[scopeKey(target)],
  };
}
