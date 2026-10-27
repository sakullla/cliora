/**
 * Terminal titles are whatever the CLI or its host shell last wrote with OSC 0/2. Some of
 * them carry no task information (the shell's own window title, an executable path), and
 * many CLIs append the folder name that the rail already shows on the second line.
 */

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
  return title.toLowerCase() === toolName.trim().toLowerCase() ? '' : title;
}

/** Short folder label for the rail: the project name, or the directory's last segment. */
export function railPlace(projectName: string | undefined, directory: string | null | undefined): string {
  if (projectName) return projectName;
  return directory ? baseName(directory) : '';
}
