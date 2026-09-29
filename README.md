# Cliora · 栖点

Cliora is a local desktop manager for AI command line tools. The current desktop shell has five pages, persistent managed-tool and theme settings, SQLite storage, and a system credential-store boundary. The native tool service now probes the installed Codex, Claude Code, Grok Build, Pi, and OpenCode CLIs with bounded `--version` commands; stores multiple named profiles and per-tool common configuration; parses TOML, JSON, and JSONC; and applies supported-version native changes through an encrypted backup/recovery journal. A provider model directory uses real `GET /models` requests, caches results, and keeps manual model entry available when the directory fails. It never calls a paid inference endpoint for discovery.

The scoped React tool and home components live in `src/features/tools` and `src/features/home`. They are not yet mounted by the five-page shell; that integration is a later workflow task. The running shell still shows honest placeholders for native configuration and startup. Launching CLIs, tray switching, sessions, migration, and sync are not implemented here. Native write capability is gated to documented version families; a version probe alone does not prove every generated provider setting is accepted by the CLI. Other versions remain read-only/unknown until verified.

## Run

Install Node.js and Rust plus the [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm ci
npm run tauri dev
```

For the frontend only, use `npm run dev`. Browser mode explicitly reports that native storage and credentials are unavailable; its settings controls cannot claim to save to the desktop database.

Checks:

```sh
npx playwright install chromium-headless-shell
npm run verify
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --no-bundle
```

The desktop database lives in Tauri's per-user application data directory as `cliora.db`. Managed tool IDs, theme, named profiles, common inheritance, model cache, application bindings, and encrypted native transaction journals are stored there. Profile drafts and ordinary workspace snapshots do not contain native API key values; the keyring holds profile secrets and application bindings hold only fingerprints. Applying a supported profile writes the selected secret into the CLI's own native authentication field through the same backed-up transaction as other settings. The resulting native file necessarily contains a credential, so secret-bearing replacements use user-restricted permissions (Unix 0600; on Windows, a restricted ACL). The CLI can then run directly after Cliora exits. The Rust-only child credential helper remains available for future launch integration. Saving a draft without applying it does not change the CLI's native authentication. A user can explicitly open the complete current JSON/TOML in the native editor; the ordinary workspace load does not return its contents.

The tools component distinguishes local format validation, HTTP directory connectivity, and an optional minimal model request. Only the last stage invokes inference and requires an explicit confirmation because it may incur usage charges. Installer sources are shown only when the CLI shim or known native location provides evidence; an unknown installation gets official instructions instead of an assumed upgrade method. Install/upgrade commands are copied for the user to run in their terminal, with a separate recheck action; this task does not perform package-manager installs or track installer progress.

Existing native files can be loaded into a new named draft in one action. Known native keys migrate to the system credential store before the draft is saved, while recognized provider, model and wire-format fields and unrelated native fields remain editable. The user can also explicitly open and edit the full current native file; that source takes precedence over form fields for that save, and the key is removed from the stored draft before application writes it back to the CLI's native field. Known-version tools offer a small set of official API address/format presets without inventing a model or credential. Codex's native reasoning-effort field has a structured control that edits TOML while preserving unrelated text. The form's connection fields overlay the saved draft; the merged preview does not reveal native keys.

The desensitized native fixtures in `tests/fixtures/native` cover the Windows development host versions listed there. An ignored Rust test can probe the actual local CLI shims without reading private config: `cargo test --manifest-path src-tauri/Cargo.toml live_windows_probe_reports_real_versions --lib -- --ignored`. macOS and Linux native behavior and real CLI acceptance of every provider combination remain unverified.

## Module boundaries

- `src/types/domain.ts` and `src-tauri/src/domain.rs`: stable tool IDs and bootstrap types. Add feature DTOs on both sides before exposing a command.
- `src/lib/native.ts` and `src-tauri/src/commands.rs`: named typed IPC wrappers and command registration. Do not expose arbitrary filesystem paths or shell command strings as general IPC.
- `src-tauri/src/database.rs`: SQLite ownership and migrations. Future modules add versioned migrations and their own repositories rather than opening separate databases from UI commands.
- `src-tauri/src/credentials.rs`: protected system secret storage. Store only opaque credential IDs in SQLite; do not return secrets through settings bootstrap.

Design reference: [interactive preview](docs/design/cliora-preview.html). The preview contains example data. The application deliberately starts with no example sessions, projects, profiles, or usage figures.
