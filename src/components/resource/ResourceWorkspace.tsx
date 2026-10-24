import { useEffect, useState, type Key, type KeyboardEvent, type ReactNode } from 'react';
import { GuideDialog } from '../GuideDialog';
import { Icon } from '../Icon';
import styles from './ResourceWorkspace.module.css';

export type ResourceWorkspaceProps<T> = {
  ariaLabel: string;
  title: string;
  description: string;
  headerActions?: ReactNode;
  context?: ReactNode;
  beforeList?: ReactNode;
  toolbar?: ReactNode;
  status?: ReactNode;
  items: T[];
  getItemKey: (item: T) => Key;
  getItemLabel: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  renderDetails: (item: T) => ReactNode;
  selectedKey: Key | null;
  onSelect: (item: T) => void;
  onCloseDetails: () => void;
  detailsLabel: string;
  closeDetailsLabel: string;
  empty?: ReactNode;
  footer?: ReactNode;
};

function useNarrowWorkspace() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function ResourceWorkspace<T>(props: ResourceWorkspaceProps<T>) {
  const { items, selectedKey } = props;
  const selected = items.find(item => props.getItemKey(item) === selectedKey) ?? null;
  const narrow = useNarrowWorkspace();

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(items.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const buttons = event.currentTarget.closest('ul')?.querySelectorAll<HTMLButtonElement>('[data-resource-select]');
    buttons?.[next]?.focus();
  }

  const details = selected && <div className={styles.detailsInner}>
    <div className={styles.detailsHeading}>
      <div><span className={styles.detailsEyebrow}>{props.detailsLabel}</span><h3>{props.getItemLabel(selected)}</h3></div>
      <button type="button" className={styles.iconButton} onClick={props.onCloseDetails} aria-label={props.closeDetailsLabel} title={props.closeDetailsLabel}><Icon name="close" size={17} /></button>
    </div>
    {props.renderDetails(selected)}
  </div>;

  return <section className={styles.workspace} aria-label={props.ariaLabel}>
    <header className={styles.header}>
      <div className={styles.heading}><h2>{props.title}</h2><p>{props.description}</p></div>
      {props.headerActions && <div className={styles.headerActions}>{props.headerActions}</div>}
    </header>
    {props.context && <div className={styles.context}>{props.context}</div>}
    {props.beforeList}
    {props.status}
    <div className={styles.body} data-has-details={selected && !narrow ? 'true' : 'false'}>
      <div className={styles.listPane}>
        {props.toolbar}
        {props.empty ?? (items.length > 0 && <ul className={styles.list} aria-label={props.title}>
          {items.map((item, index) => {
            const key = props.getItemKey(item);
            return <li key={key} className={styles.item} data-selected={key === selectedKey ? 'true' : 'false'}>
              <button type="button" data-resource-select className={styles.select} aria-pressed={key === selectedKey} onClick={() => props.onSelect(item)} onKeyDown={event => moveFocus(event, index)}>
                {props.renderItem(item)}
              </button>
            </li>;
          })}
        </ul>)}
      </div>
      {!narrow && selected && <aside className={styles.details} aria-label={props.detailsLabel}>{details}</aside>}
    </div>
    {narrow && <GuideDialog open={!!selected} title={selected ? props.getItemLabel(selected) : props.detailsLabel} onClose={props.onCloseDetails}>{details}</GuideDialog>}
    {props.footer}
  </section>;
}
