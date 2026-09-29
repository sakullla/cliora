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

The desktop database lives in Tauri's per-user application data directory as `cliora.db`. Managed tool IDs, theme, named profiles, common inheritance, model cache, application bindings, and encrypted native transaction journals are stored there. CLI auth files are not copied into this database or exposed in the general native editor. Provider-directory API keys use the OS credential service through `src-tauri/src/credentials.rs`; the CLI itself still needs its own native login or a configured environment variable. The application does not install a background proxy or make its own process a prerequisite for the CLI to read the native configuration.

The desensitized native fixtures in `tests/fixtures/native` cover the Windows development host versions listed there. An ignored Rust test can probe the actual local CLI shims without reading private config: `cargo test --manifest-path src-tauri/Cargo.toml live_windows_probe_reports_real_versions --lib -- --ignored`. macOS and Linux native behavior and real CLI acceptance of every provider combination remain unverified.

## Module boundaries

- `src/types/domain.ts` and `src-tauri/src/domain.rs`: stable tool IDs and bootstrap types. Add feature DTOs on both sides before exposing a command.
- `src/lib/native.ts` and `src-tauri/src/commands.rs`: named typed IPC wrappers and command registration. Do not expose arbitrary filesystem paths or shell command strings as general IPC.
- `src-tauri/src/database.rs`: SQLite ownership and migrations. Future modules add versioned migrations and their own repositories rather than opening separate databases from UI commands.
- `src-tauri/src/credentials.rs`: protected system secret storage. Store only opaque credential IDs in SQLite; do not return secrets through settings bootstrap.

Design reference: [interactive preview](docs/design/cliora-preview.html). The preview contains example data. The application deliberately starts with no example sessions, projects, profiles, or usage figures.
