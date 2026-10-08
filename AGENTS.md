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

## UI Capture

`scripts/capture-ui.mjs` is the UI capture tool. It opens the Vite preview in Playwright, installs synthetic native IPC, walks the screens, and writes a gallery. Use it to check layout after a UI change. The pictures are not a local project and are not native platform acceptance. A running desktop window is separate: `scripts/drive-records.mjs` can capture it only when that process exposes a local WebView2 CDP endpoint. Do not resize or cover the Cliora window to produce these Playwright captures; the script sets its own viewport.

Start a frontend first. `npm run dev -- --port 14736` matches the default preview. While `npm run tauri dev` is already running, point the script at that server instead. Browser mode has no native storage; the script supplies the fixtures.

```powershell
$env:CLIORA_PREVIEW_URL = 'http://127.0.0.1:1420'
node scripts/capture-ui.mjs --skills --theme light --size 1360
```

- `--theme all|light|dark` chooses the theme. The default is `all`.
- `--size all|1360,900,640` chooses widths. The default is `all`.
- `--skills` captures the Skill list and the SKILL.md editor.
- `--connections`, `--records`, `--sessions`, and `--features` capture those areas. `--workflows` is an alias of `--features`.
- `--list` prints feature scenario names. `--only 'kimi-*'` limits those scenarios. It does not filter `--skills`.
- `CLIORA_CAPTURE_OUT` sets the output directory. The default is `docs/verification/ui`.
- `CLIORA_PREVIEW_URL` sets the preview. The default is `http://127.0.0.1:14736`.

The Skill fixture treats the directory name as the skill. `crud-page` has a mismatched frontmatter name and an empty description. `lark-apps` is markdown without frontmatter. Both stay on the list as 本机目录 and open an editor. `code-review` is a managed package and opens the same editor with 启用 Skill. 放进资料库 is only on an external directory. The editor capture types into SKILL.md and expects 保存 to become enabled. A name or description mismatch is not 暂不可读取.

Each run checks horizontal overflow and page errors, then writes `index.html`, `README.md`, and `capture-ui[-mode]-manifest.json`. A narrow run replaces the gallery in the output directory, so set `CLIORA_CAPTURE_OUT` when the existing full gallery should stay.

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
