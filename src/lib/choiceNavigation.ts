import type { KeyboardEvent } from 'react';

/** Match visual order and keep each tab/radio group to one keyboard stop. */
export function navigateChoices(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const current = choices.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !choices.length) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
  choices[next].focus();
  choices[next].click();
}

/** A vertical list that is one Tab stop: ↑/↓/Home/End move focus only; Enter/Space activate natively. */
export function navigateList(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const current = items.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !items.length) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
}
