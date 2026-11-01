import type { ToolUiAdapter } from './contract';

/** Literal paths for a prompt. No newlines, terminal escapes or shell expansion. */
export function quoteAttachmentPath(path: string): string {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid attachment path');
  // Drive/UNC paths work with forward slashes in native CLI file readers and
  // avoid treating Windows separators as shell escapes on paste.
  if (/^(?:[a-z]:\\|\\\\)/i.test(path)) path = path.replace(/\\/g, '/');
  return /[\s"'&()^;|<>$`\\]/.test(path) ? `"${path.replace(/["\\$`]/g, '\\$&')}"` : path;
}

export function attachmentPastes(adapter: ToolUiAdapter, paths: string[]): string[] {
  // Unknown adapters receive literal file references, without claiming native
  // image attachment support or invoking an unverified keyboard command.
  paths.forEach(quoteAttachmentPath);
  return adapter.attachmentPastes?.(paths) ?? [paths.map(quoteAttachmentPath).join(' ')];
}
