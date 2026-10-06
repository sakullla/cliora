import { navigateChoices } from '../lib/choiceNavigation';

export function Tabs<T extends string>({ items, value, onChange, label }: { items: [T, string][]; value: T; onChange: (value: T) => void; label: string }) {
  return <div className="tabs" role="tablist" aria-label={label} onKeyDown={navigateChoices}>{items.map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={value === id} tabIndex={value === id ? 0 : -1} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{text}</button>)}</div>;
}
