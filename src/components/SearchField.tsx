import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export function SearchField({ label, value, onChange, placeholder, title, pageSearch = false, className, type = 'text' }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  title?: string;
  pageSearch?: boolean;
  className?: string;
  type?: 'text' | 'search';
}) {
  const { t } = useTranslation();
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Escape' || !value) return;
    event.preventDefault();
    event.stopPropagation();
    onChange('');
  }
  return <span className={className ? `search-field ${className}` : 'search-field'}>
    <input type={type} aria-label={label} data-page-search={pageSearch ? '' : undefined} title={title} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} />
    {value && <button type="button" className="search-clear" aria-label={t('common.search.clear')} onClick={() => onChange('')}><Icon name="close" size={12} strokeWidth={2.2} /></button>}
  </span>;
}
