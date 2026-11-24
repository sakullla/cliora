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

Install Node.js, Rust 1.90+ (required by the deep-link and single-instance plugins), and platform-specific Tauri prerequisites, then run `npm ci`.

The app registers the `cliora://` scheme through the deep-link plugin; `cliora://review` is the inbound side of `docs/integrations/twiglane-review-v2.md`. Windows development builds and Linux register the scheme at runtime, macOS only through an installed bundle, so scheme registration is not verified by a build.

- `npm run tauri dev`: run the desktop application.
- `npm run dev`: run the frontend only; native storage is unavailable in browser mode.
- `npm run build`: type-check TypeScript and build with Vite.
- `npx playwright install chromium-headless-shell`: install the browser test prerequisite.
- `npm run verify:projects`: reuse the current build (rebuild when inputs change) and run the business-project, large picker, and dialog menu regressions.
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

Run `node scripts/verify-ui-captures.mjs` to build and capture the entire desktop gallery with one preview server. It writes `docs/verification/product-ui-ux/index.html`. Use `--skip-build` with a current build, `--only workbench,memory` to focus the gallery, or `--list` to see all areas. The default uses 1360px, distributes representative states across both themes, and runs two areas at a time. Set `CLIORA_CAPTURE_JOBS=1` to run serially or `CLIORA_PRODUCT_CAPTURE_OUT` to save a focused run separately. `--size 1360,720` adds a compatibility sample, while `--full` on the verification runner restores the historical compatibility matrix.

Start a frontend first. `npm run dev -- --port 14736` matches the default preview. While `npm run tauri dev` is already running, point the script at that server instead. Browser mode has no native storage; the script supplies the fixtures.

```powershell
$env:CLIORA_PREVIEW_URL = 'http://127.0.0.1:1420'
node scripts/capture-ui.mjs --skills --theme light --size 1360
```

- `--theme all|light|dark` chooses the theme. The default is `all`.
- With no area selector, the direct script captures page overviews. Dedicated areas choose representative screens by default. Add `--full` for additional states and variants.
- `--size all|1360,900,720` chooses widths. The default is desktop width `1360`; smaller widths are opt-in compatibility checks. The native window minimum is 720px. `640` is not a normal desktop scenario and only runs when explicitly passed or when `CLIORA_CAPTURE_640=1` / `--compat-640` is set.
- `--projects` captures one project list per requested width, rotating the selected themes. A width sweep shows the overview at its largest width and the worktree fallback at smaller widths. A single width shows the fallback. The batch and manifest previews are captured once each at the largest width. Use `node scripts/capture-product-ux.mjs --only projects` after building to start a preview and record just this gallery.
- `--skills` captures the Skill list, the SKILL.md reading view, and the SKILL.md editor.
- `--connections`, `--records`, `--sessions`, and `--features` capture those areas. `--workflows` is an alias of `--features`.
- `--mcp` samples tool detail and write conflict, library targets, and batch import preview.
- `--list` prints page and feature scenario names. `--only settings` captures only Settings; `--only 'tools,library,sessions,usage,settings'` selects page overviews; `--only 'kimi-*'` limits feature scenarios. It does not filter `--skills`.
- `CLIORA_CAPTURE_OUT` sets the output directory. The default is `docs/verification/ui`.
- `CLIORA_PREVIEW_URL` sets the preview. The default is `http://127.0.0.1:14736`.

The Skill fixture treats the directory name as the skill. `crud-page` has a mismatched frontmatter name and an empty description. `lark-apps` is markdown without frontmatter. Both stay on the list as 本机目录; they open in reading mode and switch to the editor with 编辑. `code-review` is a managed package and opens the same editor with 启用 Skill. 放进资料库 is only on an external directory. The editor capture types into SKILL.md and expects 保存 to become enabled. A name or description mismatch is not 暂不可读取.

The workbench gallery samples active and ended sessions, large worktree selection, quick input and find, new session, restore, remote disconnect, and the empty launchpad. `--full` adds platform and error variants. `--only 'workbench-restore-*'` captures just that area, and `--performance` runs the remote-stream measurement once.

Memory samples the grouped list, editing, partial reads, switches, and read-only entries. Sync samples setup, healthy and failed status, conflicts, local-only data, and sync results. Both accept `--full` or a scenario-level `--only`. The rule distribution gallery samples partial failure, conflicts, and readback recovery. The cross-app review roundtrip is a separate command because it uses both previews. Its default captures three moments from the roundtrip, and `--full` records each intermediate state in both themes.

Each run checks horizontal overflow and page errors, then writes `index.html`, `README.md`, and a mode-specific manifest. A successful nonempty run removes obsolete PNGs listed in that gallery's previous manifest; unrelated files remain. A narrow run replaces the gallery in the output directory, so set `CLIORA_CAPTURE_OUT` when the existing full gallery should stay.

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
- Keep prompt secrets inside `src-tauri/src/secrets/`. A prompt body holds only `{{cliora-secret:<uuid>}}`. Values live behind the shared `CredentialStore` boundary. Keep them out of SQLite, search/previews, clipboard copies, export bundles, WebDAV sync, remote-host context, logs, audit rows and errors. The broker checks the live installation and its explicit grant on each access. Fixed scripts require their executor grant. “Let AI use” binds a selected secret to the built-in approved-read operation of the dedicated local AI installation. It permits a desktop approval request and is revocable. Inserting or syncing a reference alone grants nothing. Controlled use runs a fixed executor without a shell and masks its output. Only a desktop-approved raw read may return values to the caller. One approval can cover several references. Only an explicit session decision permits repeat reads of those references in the same live local workbench CLI session or MCP connection and installation. External terminal reads require approval per request. A failed batch returns no values. Record a closed-set audit entry for each reference.
- The MCP stdio helper and the CLI helper reach that broker over the per-user local IPC transport (0700 domain socket on Unix, current-user DACL named pipe on Windows) and never open the database. Adapters own their native MCP mapping (`mcp_location`); shared services own the per-target `cliora-secrets-<toolId>` installation through the existing preview/commit/CAS flow, and shared UI reads the secret MCP capability from registry descriptors instead of branching on a CLI id.
- `SecretMcpCapability` is evidence, not a claim: a configuration mapping, a successful write, a protocol probe or a CLI name cannot publish `supported`. Only a complete live acceptance record in `src-tauri/src/adapters/secret_access.rs` does, cross-checked against `docs/verification/secret-access.md`; without one the target stays `unverified` and the UI keeps the CLI fallback built from local metadata. The live verification (`CLIORA_LIVE_SECRET_TESTS`, `CLIORA_LIVE_SECRET_PLAN`, `CLIORA_LIVE_SECRET_TOOLS`, `CLIORA_LIVE_SECRET_CANARY`) is explicit because it may incur inference cost; ordinary unit and browser tests must run without a CLI or a model and use synthetic canaries only.

Update TypeScript and Rust contracts together when changing IPC. Use the shared database and versioned migrations. Store managed secrets through the shared credential boundary (private local files on macOS, the system credential store elsewhere); never commit real keys or private native configurations.
