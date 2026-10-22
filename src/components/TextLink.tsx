import { useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

/**
 * An inline anchor that stays inside a text selection.
 * A click copies or opens; a drag that moves the pointer selects through the words.
 */
export function TextLink({ href, className, title, missing, children, onActivate }: {
  href: string;
  className?: string;
  title?: string;
  missing?: boolean;
  children?: ReactNode;
  onActivate?: () => void;
}) {
  const origin = useRef<{ x: number; y: number } | null>(null);
  function pointerDown(event: PointerEvent<HTMLAnchorElement>) {
    origin.current = { x: event.clientX, y: event.clientY };
  }
  function click(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (missing || !onActivate) return;
    const start = origin.current;
    const moved = !!start && (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4);
    const selected = window.getSelection();
    if (moved || (selected && !selected.isCollapsed)) return;
    onActivate();
  }
  return <a href={href} className={className} title={title} draggable={false} aria-disabled={missing || undefined} data-missing={missing || undefined} onPointerDown={pointerDown} onClick={click} onAuxClick={(event) => event.preventDefault()}>{children}</a>;
}
