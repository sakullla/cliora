/**
 * Terminal titles are whatever the CLI or its host shell last wrote with OSC 0/2. Some of
 * them carry no task information (the shell's own window title, an executable path), and
 * many CLIs append the folder name that the rail already shows on the second line.
 */

// Leading activity glyphs CLIs animate in their window title: Codex braille spinners (⠋),
// Claude Code stars and half circles (✳ ✶ ✻ ◐ ◓), Gemini diamonds (◇ ✦), bullets and emoji.
const ACTIVITY_PREFIX = /^(?:[\u2800-\u28ff\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\u00b7\u2022\u2219\u22c5*\ufe0e\ufe0f\u200d\s]|\p{Extended_Pictographic})+/u;

/**
 * Split the animated status glyph a CLI prepends to its title from the task text. The glyph
 * advances many times a second, so only `text` may feed hover tooltips: a changing `title`
 * attribute makes the native tooltip restart on every frame, which shows as flicker.
 */
export function splitActivityGlyph(title: string): { glyph: string; text: string } {
  const value = title.trim();
  const match = ACTIVITY_PREFIX.exec(value);
  if (!match) return { glyph: '', text: value };
  const text = value.slice(match[0].length).trim();
  // A title made only of glyphs keeps them as its text.
  return text ? { glyph: match[0].replace(/\s+/g, ' ').trim(), text } : { glyph: '', text: value };
}

const SHELL_TITLES = /^(?:(?:administrator|管理员)\s*[:：]\s*)?(?:windows\s+powershell|powershell(?:\s+\d+(?:\.\d+)*)?|pwsh|command\s+prompt|命令提示符|cmd(?:\.exe)?|bash|zsh|fish|sh|wsl|ubuntu|git\s+bash|mingw64)$/i;
const PATH_LIKE = /^(?:[a-z]:[\\/]|\\\\|~[\\/]|\/)[^\s]*$|\.exe$/i;

/** True when a title only names the hosting shell or a path and says nothing about the task. */
export function isShellWindowTitle(title: string): boolean {
  const value = title.trim();
  return !value || SHELL_TITLES.test(value) || PATH_LIKE.test(value);
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Drop a trailing "| cliora", "- cliora" or "· cliora" when it repeats the session's folder. */
export function stripPlaceSuffix(title: string, places: string[]): string {
  const names = places.map((place) => baseName(place.trim()).toLowerCase()).filter(Boolean);
  const match = /^(.*\S)\s*[|·•—–-]\s*([^|·•—–-]+)$/.exec(title.trim());
  if (!match) return title.trim();
  return names.includes(match[2].trim().toLowerCase()) ? match[1].trim() : title.trim();
}

/** The task title the rail shows, or '' when the terminal title adds nothing. */
export function railTaskTitle(raw: string, toolName: string, places: string[]): string {
  const title = stripPlaceSuffix(raw, places);
  if (!title || isShellWindowTitle(title)) return '';
  const lower = title.toLowerCase();
  // Many CLIs title the window with the folder name, which the rail and header already show.
  if (places.some((place) => baseName(place.trim()).toLowerCase() === lower)) return '';
  return lower === toolName.trim().toLowerCase() ? '' : title;
}

/** Short folder label for the rail: the project name, or the directory's last segment. */
export function railPlace(projectName: string | undefined, directory: string | null | undefined): string {
  if (projectName) return projectName;
  return directory ? baseName(directory) : '';
}
