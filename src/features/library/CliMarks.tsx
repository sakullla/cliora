import { ToolIcon } from '../../components/ToolIcon';
import type { Scope } from '../../types/native';
import styles from './LibraryPage.module.css';

export type CliMarkState = 'off' | 'current' | 'drifted' | 'unavailable';
export type Mark = { pressed: boolean; state: CliMarkState; status: string };

// Linux paths are case-sensitive: only fold case and separators on Windows.
const windowsHost = typeof navigator !== 'undefined' && /win/i.test(navigator.platform);

export function samePath(left: string | null | undefined, right: string | null | undefined) {
  const norm = (value: string) => windowsHost
    ? value.replace(/^\\\\\?\\/i, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : value.replace(/[\\/]+$/, '');
  if (!left || !right) return !left && !right;
  return norm(left) === norm(right);
}

export function scopeLabel(scope: Scope, projectPath: string | null, projects: { name: string; path: string | null }[]) {
  if (scope !== 'project') return '全局';
  return projects.find((item) => samePath(item.path, projectPath))?.name ?? projectPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目';
}

export function ScopeMarks<T extends { toolId: string; scope: Scope; projectPath: string | null; contextId?: string | null }>({ label, tools, places, projects, busy, mark, onToggle, accountContexts = false, contextLabel = () => '账号' }: {
  label: string;
  accountContexts?: boolean;
  contextLabel?: (id: string | null) => string;
  tools: { id: string; name: string }[];
  places: T[];
  projects: { name: string; path: string | null }[];
  busy?: boolean;
  mark: (place: T | undefined) => Mark;
  onToggle: (toolId: string, scope: Scope, projectPath: string | null, contextId: string | null) => void;
}) {
  const placeKey = (item: T) => JSON.stringify([item.scope, item.projectPath, accountContexts ? item.contextId ?? null : null]);
  const keys = [...new Set(places.map(placeKey))];
  const rows = (keys.length ? keys : ['default']).map((key) => {
    const sample = places.find((item) => placeKey(item) === key);
    const scope: Scope = sample?.scope ?? 'global';
    const projectPath = sample?.projectPath ?? null;
    const contextId = accountContexts ? sample?.contextId ?? null : null;
    return { key, scope, projectPath, contextId, name: `${scopeLabel(scope, projectPath, projects)}${contextId ? ` · ${contextLabel(contextId)}` : ''}`, items: places.filter((item) => placeKey(item) === key) };
  });
  return <div className={styles.scopeLines}>{rows.map((row) => <div className={styles.scopeLine} key={row.key}><span className={styles.scopeName}>{row.name}</span><div className={styles.cliMarks} role="group" aria-label={`${label} · ${row.name}`}>{tools.filter((tool) => !row.contextId || row.items.some((place) => place.toolId === tool.id)).map((tool) => {
    const item = mark(row.items.find((place) => place.toolId === tool.id));
    return <button type="button" key={tool.id} aria-pressed={item.pressed} aria-label={`${tool.name} · ${item.status}`} title={`${row.name} · ${tool.name} · ${item.status}`} data-state={item.state} disabled={busy} onClick={() => onToggle(tool.id, row.scope, row.projectPath, row.contextId)}><ToolIcon toolId={tool.id} size={20} /></button>;
  })}</div></div>)}</div>;
}
