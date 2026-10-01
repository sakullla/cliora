import { ToolIcon } from '../../components/ToolIcon';
import type { Scope } from '../../types/native';
import styles from './LibraryPage.module.css';

export type CliMarkState = 'off' | 'current' | 'drifted' | 'unavailable';
export type Mark = { pressed: boolean; state: CliMarkState; status: string };

export function samePath(left: string | null | undefined, right: string | null | undefined) {
  const norm = (value: string) => value.replace(/^\\\\\?\\/i, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (!left || !right) return !left && !right;
  return norm(left) === norm(right);
}

export function scopeLabel(scope: Scope, projectPath: string | null, projects: { name: string; path: string | null }[]) {
  if (scope !== 'project') return '全局';
  return projects.find((item) => samePath(item.path, projectPath))?.name ?? projectPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目';
}

export function ScopeMarks<T extends { toolId: string; scope: Scope; projectPath: string | null }>({ label, tools, places, projects, busy, mark, onToggle }: {
  label: string;
  tools: { id: string; name: string }[];
  places: T[];
  projects: { name: string; path: string | null }[];
  busy?: boolean;
  mark: (place: T | undefined) => Mark;
  onToggle: (toolId: string, scope: Scope, projectPath: string | null) => void;
}) {
  const keys = [...new Set(places.map((item) => item.scope === 'project' ? `project:${item.projectPath ?? ''}` : 'global'))];
  const rows = (keys.length ? keys : ['global']).map((key) => {
    const sample = places.find((item) => (item.scope === 'project' ? `project:${item.projectPath ?? ''}` : 'global') === key);
    const scope: Scope = key === 'global' ? 'global' : 'project';
    const projectPath = sample?.projectPath ?? null;
    return { key, scope, projectPath, name: scopeLabel(scope, projectPath, projects), items: places.filter((item) => (item.scope === 'project' ? `project:${item.projectPath ?? ''}` : 'global') === key) };
  });
  return <div className={styles.scopeLines}>{rows.map((row) => <div className={styles.scopeLine} key={row.key}><span className={styles.scopeName}>{row.name}</span><div className={styles.cliMarks} role="group" aria-label={`${label} · ${row.name}`}>{tools.map((tool) => {
    const item = mark(row.items.find((place) => place.toolId === tool.id));
    return <button type="button" key={tool.id} aria-pressed={item.pressed} aria-label={`${tool.name} · ${item.status}`} title={`${row.name} · ${tool.name} · ${item.status}`} data-state={item.state} disabled={busy} onClick={() => onToggle(tool.id, row.scope, row.projectPath)}><ToolIcon toolId={tool.id} size={20} /></button>;
  })}</div></div>)}</div>;
}
