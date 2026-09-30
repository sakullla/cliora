/** Keep native paths canonical internally and show ordinary drive/UNC paths to people. */
export function displayPath(value: string): string {
  return value.startsWith('\\\\?\\UNC\\') ? `\\\\${value.slice(8)}` : value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

export function shortPath(value: string): string {
  const normal = displayPath(value);
  if (/^https?:\/\//i.test(normal)) return new URL(normal).hostname;
  const parts = normal.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${normal.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(normal.includes('\\') ? '\\' : '/')}` : normal;
}
