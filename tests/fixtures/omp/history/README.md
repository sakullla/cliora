# OMP history cases

`scripts/verify-omp-native.mjs` consumes every `tests/fixtures/omp/history/*.json`
case through `adapters::omp::verify::run_case(.., "history", ..)`. These are
declarations and product assertions, not native CLI evidence by themselves.

| Case | Action | Contract |
| --- | --- | --- |
| `session-v3.json` | `session` | Real 18.20.2 wire shape: 256-byte title slot, v3 header, two turns appended by `--resume`, four-way token split and local cost outside the shared pipeline. |
| `branch-compaction.json` | `session` | User title slot wins, only the active branch enters the transcript, compaction/branch summaries remain visible, an interrupted assistant turn and a title `model_usage` call still count locally. |
| `auto-title.json` | `session` | An `source: "auto"` title slot is read as the current title; the repository keeps one auto and one user slot fixture. |
| `damaged-record.json` | `session` | One malformed JSONL row marks the session partial without hiding the readable rows. |
| `unknown-version.json` | `unsupported` | A future `version` stays unavailable instead of being guessed. |
| `resume.json` | `resume` | A specified session uses `--resume <id>`; `--continue` is only the latest-session selector and Pi's `--session` never appears. |

The sanitized session bodies live in `tests/fixtures/history/omp-*`. The real
18.20.2 sample is documented in `docs/verification/omp-history.md`; all paths,
titles and message text in the fixture are neutral placeholders. Native
`usage.cost` is parsed and asserted in the Rust module, but the records page
labels its money figure `估算费用` and computes it from the user/known price
table rather than showing the native per-call amount.

An unknown version/header file is intentionally absent from the verified
session list. The records page shows the per-source reason from
`ScanStatus.detail` in the expanded source coverage area. A manual replay of the
real evidence is described below and automated by `replay-session.mjs`.

## Replaying the real session

The committed real fixture was produced by `omp/18.20.2` in an isolated `HOME`
against a local OpenAI-compatible endpoint. The replay tool keeps that process
out of the user's `~/.omp` and `~/.bun`:

```powershell
node tests/fixtures/omp/history/replay-session.mjs --omp <isolated omp executable>
```

It starts a local SSE endpoint, writes `config.yml`/`models.yml` into a
temporary home, runs the non-interactive turn, parses the generated session id
from the header, resumes that exact id, and prints the session path plus the
observed title/usage values. `--output <path>` copies the raw generated JSONL
for inspection; sanitize it before committing. The script does not contact a
paid provider and does not install OMP.
