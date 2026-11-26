# Terminal activity adapters

`ToolUiAdapter.terminalActivity({ title, lines })` is an optional frontend capability,
registered in `src/adapters/index.ts` with the existing CLI UI adapter. It returns
`true` for active, `false` for idle, or `null` for insufficient evidence. `lines`
contains at most the final 12 current screen rows after xterm parses terminal
control sequences; it never contains the scrollback or a native credential file.

Implement CLI title/footer formats inside that CLI's `src/adapters/<cli>/`
directory. Shared terminal code must not select parsers by concrete CLI IDs.
This presentation capability changes no Rust/TypeScript IPC contract and makes
no claim about completion success, approval, or process lifetime. Exit and remote
transport state remain authoritative outside the activity indicator.

Codex currently recognizes its input composer plus shortcut footer and active-turn
interrupt hint, with leading title spinner/status glyphs as secondary evidence.
Customized or unrecognized layouts return `null`. The shared fallback observes
changed screen content, so cursor/OSC traffic and identical repaints alone do not
mean assistant output. Known active turns do not time out during silent tool work.

Official research: [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents configurable `tui.terminal_title` items and animations;
[CLI title customization](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
documents `/title`. [App Server status events](https://learn.chatgpt.com/docs/app-server)
describe an App Server connection, not arbitrary PTY byte output. Footer recognition
is an adapter heuristic, not an undocumented universal CLI protocol.

Parsing/title publication is coalesced on demand at 80ms, with no idle polling.
Only changed activity is published to React. Waiting-for-replay output shares
`PendingTerminalOutput` limits (512 KiB encoded data/session, 4 MiB globally,
256 chunks/session, 32 sessions), instead of an unbounded second queue.

For a new adapter, register this optional function and add native-format fixtures
for busy, idle, unknown, and repaints. Exercise it through the shared terminal;
adapters without it retain the generic content-change fallback. The workbench
tests cover Codex alongside a non-specialized CLI and the registry architecture
test guards against concrete-ID dispatch in `SessionTerminal`.
## Task evidence for the shared state

`ToolUiAdapter.terminalSemantics({ title, lines })` is a second optional frontend capability
from the same screen rows. It returns `{ attention, inputReady, screenKey }` or `null`:

- `attention` is `'approval'` or `'question'` only when the screen shows an interface that
  waits for a person. A bell or an unread failure supports "needs a look" without naming a kind.
- `inputReady` is `true` only for a recognized composer. A menu that consumes keys is not one,
  and neither is a screen whose interrupt hint shows an active turn.
- `screenKey` identifies the evidence, so a repaint of the same screen is not new evidence.

`src/features/sessions/sessionTaskState.ts` turns these facts, the native process and exit
state, the shared activity result, a verified Twiglane result and an explicit user mark into
one of `needsYou`, `readyReview`, `working`, `ended`, `error` or `unknown`. The rail, the
stage title, the split panes and the attention jump all read that one result, so a session
cannot read as working in one place and finished in another. The rules that keep it honest:

- An idle prompt is `unknown` (worded as waiting for input), never `readyReview` and never a
  success. `readyReview` needs an explicit mark or a returned review whose own key was re-read
  against real Git.
- A clean exit is `ended`; a non-zero exit is `error`. Neither claims that a task delivered.
- A remote transport that may still hold the session is `unknown`: the connection state is not
  a CLI failure and not a completion.
- Resumed output outranks a mark, and an interface waiting for a person outranks both.

Shared code never parses a screen by itself and never dispatches on a concrete CLI id. Codex
publishes the composer and its numbered approval menu; other CLIs currently publish nothing and
keep the generic `unknown` state with the manual paths, which is why the workbench can promise
"needs you" only where an adapter actually saw it.

## Command phases, program progress and colour replay

`src/features/sessions/terminalCommandState.ts` reads two OSC families from the terminal's own
parser and keeps one state per terminal instance; `SessionTerminal` registers the handlers, so two
split panes never share a phase:

- `OSC 133;A` starts a prompt, `B` starts the input line, `C` starts execution and `D;<code>` ends
  the command. The code counts only from 0 to 255; anything missing, oversized or non-numeric keeps
  the result *unknown* rather than turning it into a success.
- `OSC 9;4;<state>[;<percent>]` is program progress: `0` clears, `1` is a determined bar, `2` an
  error, `3` an indeterminate bar, `4` a warning. An unknown state, a percentage past 100 or a
  determined bar without a percentage is ignored, so a bad report never invents a position. Other
  `OSC 9` payloads are notifications and stay with xterm.

The state machine only moves forward. A late `B` does not turn an executing command back into an
editable line, and a `D` that no `C` preceded — or a `B` followed by `D` with nothing executed —
clears the mark instead of recording a result. A new `A` ends the previous cycle, so a failed
command does not stay on screen after the shell prompted again. Only state `0` clears a progress
bar: a command exit must not rewrite what the program itself reported.

The workbench projects this beside the shared task state, never inside it: `commandHint()` words one
fact (progress, a failing exit code, an unknown result, an executing command) and both the stage
title bar and the rail row show that wording. A command failure therefore cannot read as a failed
task, a full bar cannot read as a delivered task, and a progress error cannot ask for approval.
`sessionTaskState.ts` keeps deciding the task from process, transport, adapter and user evidence.
An ended session keeps its last command result but no progress bar, and a remote session whose
transport may still hold it shows the connection state instead of either.

### What a replay may and may not repeat

`OSC 4`/`104`/`10`/`11`/`12`/`110`/`111`/`112` keep xterm's live behaviour: a mixed
`OSC 4;1;#ff0000;2;?` sets one slot and answers one query. History is different, because those bytes
were already consumed once:

- `terminalReplaySanitizer.stripHistorySideEffects` runs over the replayed snapshot before xterm
  parses it. It removes `OSC 52` clipboard writes and replayed bells, and it keeps the settings of a
  mixed `OSC 4` while dropping its queries — in place, so the rows above and below keep the colour
  the program gave them. Historical queries therefore never reach the PTY, while a live query is
  answered exactly once by xterm.
- Replayed `133` and `9;4` marks are applied: the restored screen shows the recorded command result
  and progress. They are not re-announced.
- Device queries (DA, DSR, DECRQM, XTVERSION, DECRQSS, window reports) are still cancelled in the
  parser while a replay is parsed, because xterm would answer them through `onData`; a session that
  started moments ago keeps its answers, since a CLI may be waiting for the first one.
- A `BEL` terminator belongs to the control sequence and does not ring; a bare `BEL` does. The
  replayed bell is filtered by the same rule as the clipboard, so restoring a session is silent.

Colours come from `terminalTheme.ts`, so the reset baseline of each instance is the theme currently
selected for it: switching the terminal palette re-derives it, and `OSC 104` returns a slot to the new
default. Palette overrides a program sets at run time survive until the theme changes, as in xterm.

### Evidence and limits

The command-phase, progress, palette and replay rules are covered by
`tests/native/terminal-command-state.test.mjs`, `tests/native/terminal-replay-sanitizer.test.mjs`
and the `terminal command phases, progress and colours` block of
`tests/ui/workbench-terminal.spec.ts`, which drives the real xterm renderer through synthetic native
IPC. Those runs prove the shared parser, the projection and the PTY bytes the workbench would send;
they are not native platform evidence. No real PTY, ConPTY or SSH/tmux forwarder was sampled for this
change: a transport that filters the sequences simply leaves the terminal in its base state, and a CLI
that prints none keeps its existing adapter and screen evidence.
