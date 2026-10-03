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
