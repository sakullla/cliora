import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@xterm/xterm';
import styles from './SessionWorkbench.module.css';

export function TerminalScrollbar({ terminal, viewport, onUserScroll }: {
  terminal: Terminal | null;
  viewport: HTMLElement | null;
  onUserScroll?: () => void;
}) {
  const { t } = useTranslation();
  const dragPointer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  if (!terminal || !viewport || terminal.buffer.active.type !== 'normal') return null;
  const maxScroll = viewport.scrollHeight - viewport.clientHeight;
  const total = terminal.buffer.active.baseY;
  if (total < 1 || maxScroll <= 0) return null;

  const ratio = Math.max(0, Math.min(1, viewport.scrollTop / maxScroll));
  const trackHeight = Math.max(0, viewport.clientHeight - 8);
  const thumbHeight = Math.min(trackHeight, Math.max(28, viewport.clientHeight / viewport.scrollHeight * trackHeight));
  const thumbTop = (trackHeight - thumbHeight) * ratio;

  function scrollAt(clientY: number, track: HTMLElement) {
    if (!viewport || !terminal) return;
    const rect = track.getBoundingClientRect();
    const next = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    // Scroll the buffer by row. Setting scrollTop to the host's max lands past
    // the last row and the redraw paints the previous frame over the new one.
    terminal.scrollToLine(Math.round(next * total));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    onUserScroll?.();
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragPointer.current = event.pointerId;
    setDragging(true);
    scrollAt(event.clientY, event.currentTarget);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (dragPointer.current !== event.pointerId) return;
    event.preventDefault();
    scrollAt(event.clientY, event.currentTarget);
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (dragPointer.current !== event.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragPointer.current = null;
    setDragging(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!viewport || !terminal) return;
    if (!['Home', 'End', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) return;
    onUserScroll?.();
    if (event.key === 'Home') terminal.scrollToTop();
    else if (event.key === 'End') terminal.scrollToBottom();
    else if (event.key === 'ArrowUp') terminal.scrollLines(-1);
    else if (event.key === 'ArrowDown') terminal.scrollLines(1);
    else if (event.key === 'PageUp') terminal.scrollPages(-1);
    else terminal.scrollPages(1);
    event.preventDefault();
    event.stopPropagation();
  }

  return <div className={styles.terminalScrollTrack} role="scrollbar" aria-label={t('sessions.terminalScrollbar')} aria-controls={viewport.id || undefined} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(total * ratio)} tabIndex={0} data-dragging={dragging || undefined}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onKeyDown={onKeyDown}>
    <span className={styles.terminalScrollThumb} aria-hidden="true" style={{ height: thumbHeight, transform: `translateY(${thumbTop}px)` }} />
  </div>;
}
