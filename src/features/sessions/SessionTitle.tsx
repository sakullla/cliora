import { splitActivityGlyph } from './railTitle';
import styles from './SessionWorkbench.module.css';

/**
 * A terminal title with its animated CLI glyph in a fixed-width slot, so spinner frames of
 * different widths do not shift the task text. Tooltips must use `stableTitle` instead.
 */
export function SessionTitle({ title }: { title: string }) {
  const { glyph, text } = splitActivityGlyph(title);
  if (!glyph) return <>{text}</>;
  return <><span className={styles.titleGlyph}>{glyph}</span> {text}</>;
}

/** The title without its animated glyph: safe for `title` attributes and other hover text. */
export function stableTitle(title: string): string {
  return splitActivityGlyph(title).text;
}
