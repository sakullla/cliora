import { useEffect, useRef } from 'react';

/** Dismiss a disclosure panel without trapping focus or changing its native semantics. */
export function useDisclosure() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      const panel = ref.current;
      if (!panel?.open) return;
      const inside = event.target instanceof Node && panel.contains(event.target);
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape' || !inside || event.defaultPrevented) return;
        event.preventDefault();
      } else if (inside) return;
      if (panel.contains(document.activeElement)) panel.querySelector('summary')?.focus();
      panel.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, []);
  return ref;
}
