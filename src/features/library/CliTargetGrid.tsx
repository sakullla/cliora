import { ToolIcon } from '../../components/ToolIcon';
import styles from './LibraryPage.module.css';

/** Shared CLI checkbox grid. The accessible name stays the tool name. */
export function CliTargetGrid({ tools, selected, onToggle, disabled, titleFor }: {
  tools: Array<{ id: string; name: string }>;
  selected: readonly string[];
  onToggle: (id: string, checked: boolean) => void;
  disabled?: (id: string) => boolean;
  titleFor?: (id: string) => string | undefined;
}) {
  return <div className={styles.targets}>{tools.map((tool) => {
    const hint = titleFor?.(tool.id);
    return <label key={tool.id} title={hint ? `${tool.name} · ${hint}` : tool.name}>
      <ToolIcon toolId={tool.id} size={22} />
      <span className={styles.targetName}>{tool.name}</span>
      <input type="checkbox" disabled={disabled?.(tool.id) ?? false} checked={selected.includes(tool.id)} onChange={(event) => onToggle(tool.id, event.target.checked)} />
    </label>;
  })}</div>;
}
