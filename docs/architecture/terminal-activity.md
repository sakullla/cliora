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
