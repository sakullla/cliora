/** Keep a just-opened form or sheet in view inside the scrolling editor. */
export function reveal(node: HTMLElement | null) {
  if (!node || typeof node.scrollIntoView !== 'function') return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => node.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }));
}
