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

// What may stand between a task and a trailing folder name. A bare hyphen also joins words
// inside folder names (`acme-svc-orders`), so it only counts as a separator after a space.
const SUFFIX_SEPARATOR = /^(.*\S)(?:\s*[|·•—–]\s*|\s+-\s*)$/;

/** Drop a trailing "| cliora", " - cliora" or "· cliora" when it repeats the session's folder. */
export function stripPlaceSuffix(title: string, places: string[]): string {
  const value = title.trim();
  const lower = value.toLowerCase();
  // Longest first, so a repository name that ends with a shorter worktree name wins.
  const names = [...new Set(places.map((place) => baseName(place.trim()).toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (lower.length <= name.length || !lower.endsWith(name)) continue;
    const match = SUFFIX_SEPARATOR.exec(value.slice(0, value.length - name.length));
    if (match) return match[1].trim();
  }
  return value;
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

/** A folder label split for middle truncation: `head` may shrink to an ellipsis, `tail` stays readable. */
export type PlaceParts = { head: string; tail: string };

/** Shortest head worth folding; below this a split only adds an ellipsis. */
const MIN_HEAD = 4;
/** Labels at least this long fold their head even when no sibling shares it. */
const LONG_LABEL = 16;
/** A lone long label keeps at least this much of its end visible. */
const MIN_TAIL = 8;

/** Segments that keep their trailing separator, so joining them restores the label. */
function segments(label: string): string[] {
  return label.match(/[^-_.\s/\\]+[-_.\s/\\]*|[-_.\s/\\]+/g) ?? [label];
}

/**
 * Split each folder label where it starts to differ from its siblings.
 *
 * Team checkouts usually share a long prefix (`acme-svc-orders`, `acme-svc-billing`), and end
 * truncation cuts exactly the part that tells them apart. Like VS Code's path shortening and
 * Finder's middle truncation, the shared, segment-aligned prefix becomes the foldable head and
 * the distinguishing rest stays visible. A long label with no sibling still folds its head so
 * the last segment survives a narrow rail. Identical labels name the same folder and split alike.
 */
export function placeParts(labels: string[]): Map<string, PlaceParts> {
  const unique = [...new Set(labels.filter(Boolean))];
  const result = new Map<string, PlaceParts>();
  for (const label of unique) {
    const parts = segments(label);
    const lower = label.toLowerCase();
    const others = unique.map((other) => other.toLowerCase()).filter((other) => other !== lower);
    let shared = 0;
    let prefix = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      const next = (prefix + parts[index]).toLowerCase();
      if (!others.some((other) => other.startsWith(next))) break;
      prefix += parts[index];
      shared = index + 1;
    }
    // No shared prefix: a long label keeps its last segments, at least MIN_TAIL characters.
    if (!shared && label.length >= LONG_LABEL && parts.length > 1) {
      shared = parts.length - 1;
      while (shared > 1 && parts.slice(shared).join('').length < MIN_TAIL) shared -= 1;
    }
    const head = parts.slice(0, shared).join('');
    result.set(label, head.length >= MIN_HEAD ? { head, tail: parts.slice(shared).join('') } : { head: '', tail: label });
  }
  return result;
}

/** Short folder label for the rail: the project name, or the directory's last segment. */
export function railPlace(projectName: string | undefined, directory: string | null | undefined): string {
  if (projectName) return projectName;
  return directory ? baseName(directory) : '';
}
