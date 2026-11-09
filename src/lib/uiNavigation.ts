import { useCallback, useLayoutEffect, useRef } from 'react';

/** Only the shell scroller lives here; terminal and record readers own their own positions. */
export function usePageScroll(key: string, intent: number) {
  const positions = useRef(new Map<string, number>());
  const cancelRestore = useRef<() => void>(() => {});
  const currentKey = useRef(key);
  const previousIntent = useRef(intent);
  const restoringPosition = useRef(false);

  useLayoutEffect(() => {
    const main = document.querySelector<HTMLElement>('main.content');
    const content = main?.firstElementChild;
    if (!main || !content) return;
    currentKey.current = key;
    const target = positions.current.get(key) ?? 0;
    let restoring = previousIntent.current === intent;
    restoringPosition.current = restoring;
    previousIntent.current = intent;
    let frame = 0;
    const remember = () => { if (!restoring) positions.current.set(key, main.scrollTop); };
    const stop = () => {
      restoring = false;
      restoringPosition.current = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      positions.current.set(key, main.scrollTop);
    };
    const restore = () => {
      if (!restoring) return;
      main.scrollTop = Math.min(target, Math.max(0, main.scrollHeight - main.clientHeight));
      // A remounted home or a lazy page may still be loading. Keep the desired position
      // until its content arrives, but never fight a user's new scroll or interaction.
      if (main.scrollTop >= target - 1) stop();
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    });
    observer.observe(content);
    cancelRestore.current = stop;
    main.addEventListener('scroll', remember, { passive: true });
    main.addEventListener('wheel', stop, { passive: true });
    main.addEventListener('pointerdown', stop);
    main.addEventListener('keydown', stop);
    restore();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      main.removeEventListener('scroll', remember);
      main.removeEventListener('wheel', stop);
      main.removeEventListener('pointerdown', stop);
      main.removeEventListener('keydown', stop);
    };
  }, [key, intent]);

  const save = useCallback(() => {
    const main = document.querySelector<HTMLElement>('main.content');
    if (main && !restoringPosition.current) positions.current.set(currentKey.current, main.scrollTop);
  }, []);
  const cancel = useCallback(() => cancelRestore.current(), []);
  return { save, cancel };
}
