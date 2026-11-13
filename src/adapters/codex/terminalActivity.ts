/** Codex's configurable OSC title and current composer/footer, never scrollback.
 * Title items: https://learn.chatgpt.com/docs/config-file/config-reference
 * Unknown/custom layouts deliberately retain the shared output fallback.
 */
export function codexTerminalActivity({ title, lines }: { title: string; lines: readonly string[] }): boolean | null {
  // The interrupt hint is rendered for an active turn, including silent tools.
  if (lines.some((line) => /\besc\s+to\s+interrupt\b/i.test(line))) return true;
  // The normal composer with shortcut help is idle; replay, cursor movement,
  // animated welcome art and reprinting this screen are not assistant output.
  let prompt = -1;
  lines.forEach((line, index) => { if (/^\s*[›>](?:\s|$)/.test(line)) prompt = index; });
  if (prompt >= 0 && lines.slice(prompt + 1).some((line) => /\?\s+for shortcuts\b/i.test(line))) return false;
  // Recognize only dedicated leading status items, not words in a task name.
  if (/^\s*[\u2801-\u28ff](?:\s|$)/u.test(title)) return true;
  if (/^\s*[·•✓✔](?:\s|$)/u.test(title)) return false;
  return null;
}
