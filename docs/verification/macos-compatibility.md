# macOS compatibility checks — 2026-10-02

Host: macOS on Apple Silicon (`Darwin arm64`). Scope: macOS CLI discovery and
launch, MCP, Skills, and history resume. This is a source-level verification
record, not acceptance of a packaged desktop candidate.

## Observed on this host

With `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, the old process-only discovery finds
none of the installed tools. A login interactive zsh resolves Node.js, npm,
Codex, Claude Code, and Grok. The repaired Rust probe was run with that same
reduced PATH and successfully identified:

| Tool | Version | Installation |
| --- | --- | --- |
| Codex | 0.159.3 | npm under `~/.nvm` |
| Claude Code | 2.1.283 | npm under `~/.nvm` |
| Grok | 1.0.46 | `~/.grok/bin` |

Node.js/npm detection also passed. Pi and OpenCode were not installed on this
host; their actual local installation acceptance remains unverified.

The opt-in Rust probe only runs version commands and does not read native
configuration or session contents:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib live_macos_probe_recovers_cli_and_node_from_finder_environment -- --ignored --nocapture
```

## Automated regression checks

- 145 Rust tests passed with the network/model and WebDAV test modules excluded
  by `--skip native::models::tests:: --skip portable::sync::tests::`; one local
  discovery test was ignored by default. A full run before the final checks had
  11 failures because the restricted environment denied local server sockets.
- All seven macOS regression tests passed. Isolated fixture homes cover all five
  adapters: global/project MCP writes and reads, Skills installation, disable,
  enable and removal, and history indexing followed by resume-plan generation.
- The generated launch command was parsed by the real AppleScript interpreter
  and executed in `/bin/sh` against a harmless CLI fixture. Original directories,
  Unicode, spaces, quotes, backslashes, newlines, and literal shell substitutions
  were preserved. This test does not open a Terminal window.
- All 16 Node unit tests passed, including canonical macOS path aliases and
  rejection of evidence symlinks that escape the evidence directory.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --offline`
  completed successfully with existing repository warnings.
- `plutil -lint src-tauri/Info.plist src-tauri/entitlements.plist` passed.

## Remaining platform acceptance

The execution sandbox cannot access macOS GUI services: even a read-only
`osascript -e 'id of application "Terminal"'` fails with an invalid GUI service
connection and error `-1728`. Real Terminal startup, the Automation consent
dialog, and live CLI resume need testing from the rebuilt desktop app.

Frontend/desktop packaging was not completed: `npm ci` was blocked by network
access, and the offline cache lacks a required package. Node unit tests used the
exact cached TypeScript 5.9.3 package without changing the dependency lockfile.

The bundle now connects `entitlements.plist` and declares the Terminal automation
purpose. See [Tauri's bundle configuration](https://v2.tauri.app/distribute/macos-application-bundle/)
and [Apple's Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events).
