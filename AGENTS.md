# Repository Guidelines

## Project Structure & Module Organization

Cliora is a React/TypeScript desktop CLI manager powered by Tauri 2 and Rust.

- `src/features/`: feature UI; `src/components/`: shared components; `src/lib/`: helpers and typed native IPC; `src/types/`: frontend contracts.
- `src/adapters/`: the single frontend adapter package.
- `src-tauri/src/adapters/`: the single backend adapter package: registry, capability ports, CLI implementations, and quota providers.
- `src-tauri/src/`: backend commands, SQLite, credentials, launch, history, and sync services.
- `tests/ui/`: Playwright specs; `tests/native/`: Node tests; other `tests/` subdirectories and `src-tauri/tests/`: Rust test sources. Sanitized inputs live in `tests/fixtures/`.
- `src/assets/tools/` and `src-tauri/icons/`: visual assets. `scripts/` contains verification utilities; `docs/` holds design and verification material.

## Build, Test, and Development Commands

Install Node.js, Rust 1.88+, and platform-specific Tauri prerequisites, then run `npm ci`.

- `npm run tauri dev`: run the desktop application.
- `npm run dev`: run the frontend only; native storage is unavailable in browser mode.
- `npm run build`: type-check TypeScript and build with Vite.
- `npx playwright install chromium-headless-shell`: install the browser test prerequisite.
- `npm run verify`: run Node tests, Playwright tests, and the frontend build.
- `npm run test:unit:all`: run Rust library tests, then Node tests.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run Rust tests.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`: run the Rust lint check used in CI.
- `npm run tauri build -- --no-bundle`: build a desktop executable.

## Coding Style & Naming Conventions

Match existing code: two-space indentation, single quotes, and semicolons in TypeScript; four-space indentation and snake_case functions/modules in Rust. Use PascalCase React component filenames and colocated `*.module.css` styles. TypeScript enables strict and unused-code checks. No ESLint or Prettier configuration is present.

## Testing Guidelines

Use `*.spec.ts` for Playwright tests and `*.test.mjs` for Node tests. Add regression coverage for changed behavior and sanitized fixtures for CLI formats. No numeric coverage threshold is configured. Browser mocks do not establish native platform acceptance; record actual platform evidence separately.

## Commit & Pull Request Guidelines

Recent history uses `fix:` and `feat:` prefixes, often with Chinese summaries. Keep commits focused. PRs should explain behavior changes, link relevant issues, list validation results, and include screenshots for UI changes. Identify unverified platform behavior explicitly.

## Architecture & Security

Adapter architecture is a mandatory repository constraint:

- Keep adapter implementations under **at most two module/package roots**: `src-tauri/src/adapters/` for Rust and `src/adapters/` for TypeScript. These are module packages within the existing application; do not add a Cargo/npm workspace merely to relocate code.
- Group each CLI and quota supplier in its own directory within those roots. Its paths, native commands/protocols, schemas, parsers, configuration mappings, query templates, and authentication/session environment variables (including `remove_environment`) belong there.
- Shared services and UI consume capability interfaces and registry metadata. Do not dispatch on concrete CLI/provider IDs in commands, account/resource/usage services, or shared UI.
- Register implementations at a composition root. Adding a CLI or supplier must not require editing service switch statements or adding parallel hardcoded ID catalogs.
- Split independent capabilities (configuration/launch, accounts, plugins, agents, official quota, third-party quota). Unsupported capabilities are absent or explicitly unavailable with a reason; do not silently substitute providers/authentication.
- Expose management support through registry descriptors and hide unsupported tabs/actions. Preserve errors and recovery controls for supported capabilities that temporarily fail; do not infer support from CLI names in shared UI.
- Discover existing CLI logins through the account adapter's native-directory/observation ports. Keep read-only native login snapshots separate from managed account records: never automatically adopt, copy credentials, refresh tokens, or expose logout controls merely to display a login. Native paths and environment overrides remain adapter-owned; return sanitized identity/status only.
- Tested CLI releases are evidence, not exact version locks. Adapters own compatibility ranges and known breakage exclusions; allow ordinary patch/minor updates and validate native capabilities/responses. Do not replace CLI version policy with protocol/template/schema version checks, which remain exact.
- Keep state machines, concurrency/cancellation, safe filesystem/process primitives, credential access policy, cache/scheduling, and transaction/backup logic in shared services. Adapters must not bypass these protections.
- Keep domain/IPC contracts independent of concrete implementations, synchronize Rust/TypeScript changes, document extension points, and test registry-based extension when changing adapter contracts.

Update TypeScript and Rust contracts together when changing IPC. Use the shared database and versioned migrations. Store managed secrets in the system credential store; never commit real keys or private native configurations.
