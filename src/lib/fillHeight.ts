import { useLayoutEffect, type RefObject } from 'react';

/**
 * Sizes a page region to the content area left below it, so a workbench reaches the
 * bottom of the window without making the outer page scroll.
 * `height` pins it (the region scrolls inside itself); `minHeight` lets a long region
 * grow and scroll with the page while a short one still reaches the bottom.
 * `mounted` re-binds the measurement when a conditionally rendered region appears.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, property: 'height' | 'minHeight' = 'height', mounted = true) {
  useLayoutEffect(() => {
    const section = ref.current;
    if (!section) return;
    const root = document.documentElement;
    const scroller = section.closest<HTMLElement>('.content') ?? root;
    let frame = 0;
    const update = () => {
      frame = 0;
      const scrollerTop = scroller === root ? 0 : scroller.getBoundingClientRect().top;
      const inner = section.closest<HTMLElement>('.content-inner');
      const pad = inner ? Number.parseFloat(getComputedStyle(inner).paddingBottom) || 0 : 0;
      const top = section.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
      const next = `${Math.max(0, Math.round(scroller.clientHeight - top - pad))}px`;
      if (section.style[property] !== next) section.style[property] = next;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (section.parentElement) observer.observe(section.parentElement);
    window.addEventListener('resize', schedule);
    return () => { if (frame) cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); };
  }, [ref, property, mounted]);
}
