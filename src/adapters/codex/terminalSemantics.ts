import type { TerminalSemantics } from '../contract';

/** Codex numbers its approval choices and marks the focused one with \u203a. */
const optionLine = /^\s*(?:[\u203a>]\s*)?(\d+)\.\s*(.+?)\s*$/u;
const questionLine = /\?\s*$/;

function normalize(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\s+$/g, ''));
}

/**
 * Codex's approval menu and its composer, read from the current screen only.
 *
 * An approval block is a numbered choice list that names both a yes and a no option, under a
 * question. Fenced code or a plan written by the model can also be numbered, so a list alone is
 * not evidence. A composer is the \u203a prompt followed by the shortcut footer, and it never
 * counts while the interrupt hint shows an active turn: keys then go to the running turn, not
 * into the composer. Everything else is unknown rather than guessed.
 */
export function codexTerminalSemantics({ lines }: { title: string; lines: readonly string[] }): TerminalSemantics | null {
  const screen = normalize(lines);
  const screenKey = screen.map((line) => line.replace(/\s+/g, ' ').trim()).join('\n');
  if (screen.some((line) => /\besc\s+to\s+interrupt\b/i.test(line))) {
    return { attention: null, inputReady: false, screenKey };
  }
  const choices = screen.map((line) => line.match(optionLine)).filter((match): match is RegExpMatchArray => !!match);
  const hasYes = choices.some((match) => /\byes\b/i.test(match[2]));
  const hasNo = choices.some((match) => /\bno\b/i.test(match[2]));
  const lastChoice = choices.reduce((last, match) => Math.max(last, Number(match[1])), 0);
  const asked = screen.some((line) => questionLine.test(line) && !optionLine.test(line));
  if (choices.length >= 2 && hasYes && hasNo && lastChoice === choices.length && asked) {
    return { attention: 'approval', inputReady: false, screenKey };
  }
  let prompt = -1;
  screen.forEach((line, index) => { if (/^\s*[\u203a>](?:\s|$)/.test(line)) prompt = index; });
  const composer = prompt >= 0 && screen.slice(prompt + 1).some((line) => /\?\s+for\s+shortcuts\b/i.test(line));
  // A stray approval word or an unused title is not a composer; only the whole footer counts.
  if (composer) return { attention: null, inputReady: true, screenKey };
  return null;
}