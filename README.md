# Cliora · 栖点

Cliora is a local desktop manager for AI command line tools. This repository is being built in stages. The current application foundation provides five full pages, a persistent managed-tool selection and theme, typed Tauri commands, SQLite storage, and an OS credential-store boundary. It does **not** yet read or modify CLI configuration, launch CLIs, index sessions, or import data. Those pages show honest empty states until the corresponding native modules are connected.

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

The desktop database lives in Tauri's per-user application data directory as `cliora.db`. Managed tool IDs and theme are stored there. The application does not copy CLI auth files into this database. Future secret references use `src-tauri/src/credentials.rs`, which uses the OS credential service and never falls back to a plain-text file.

## Module boundaries

- `src/types/domain.ts` and `src-tauri/src/domain.rs`: stable tool IDs and bootstrap types. Add feature DTOs on both sides before exposing a command.
- `src/lib/native.ts` and `src-tauri/src/commands.rs`: named typed IPC wrappers and command registration. Do not expose arbitrary filesystem paths or shell command strings as general IPC.
- `src-tauri/src/database.rs`: SQLite ownership and migrations. Future modules add versioned migrations and their own repositories rather than opening separate databases from UI commands.
- `src-tauri/src/credentials.rs`: protected system secret storage. Store only opaque credential IDs in SQLite; do not return secrets through settings bootstrap.

Design reference: [interactive preview](docs/design/cliora-preview.html). The preview contains example data. The application deliberately starts with no example sessions, projects, profiles, or usage figures.
