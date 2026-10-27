/** Keep native paths canonical internally and show ordinary drive/UNC paths to people. */
export function displayPath(value: string): string {
  return value.startsWith('\\\\?\\UNC\\') ? `\\\\${value.slice(8)}` : value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

/** Keep labels short without splitting a user-visible grapheme. */
export function compactText(value: string, limit: number): string {
  const text = value.trim();
  if (limit < 2) return text ? '…' : '';
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> };
  }).Segmenter;
  const units = Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment)
    : Array.from(text);
  return units.length <= limit ? text : `${units.slice(0, limit - 1).join('')}…`;
}

export function shortPath(value: string): string {
  const normal = displayPath(value);
  if (/^https?:\/\//i.test(normal)) return new URL(normal).hostname;
  const parts = normal.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${normal.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(normal.includes('\\') ? '\\' : '/')}` : normal;
}
