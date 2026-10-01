# Repository Guidelines

## Project Structure & Module Organization

Cliora is a React/TypeScript desktop CLI manager powered by Tauri 2 and Rust.

- `src/features/`: feature UI; `src/components/`: shared components; `src/lib/`: helpers and typed native IPC; `src/types/`: frontend contracts.
- `src-tauri/src/`: backend commands, SQLite, credentials, CLI adapters, launch, history, and sync services.
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

Keep CLI-specific mappings in adapters. Update TypeScript and Rust contracts together when changing IPC. Use the shared database and versioned migrations. Store managed secrets in the system credential store; never commit real keys or private native configurations.
