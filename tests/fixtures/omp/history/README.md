# OMP history cases

`scripts/verify-omp-native.mjs` consumes every `tests/fixtures/omp/history/*.json`
case through `adapters::omp::verify::run_case(.., "history", ..)`. These are
declarations and product assertions, not native CLI evidence by themselves.

| Case | Action | Contract |
| --- | --- | --- |
| `session-v3.json` | `session` | Real 18.20.2 wire shape: 256-byte title slot, v3 header, two turns appended by `--resume`, four-way token split and local cost outside the shared pipeline. |
| `branch-compaction.json` | `session` | User title slot wins, only the active branch enters the transcript, compaction/branch summaries remain visible, an interrupted assistant turn and a title `model_usage` call still count locally. |
| `damaged-record.json` | `session` | One malformed JSONL row marks the session partial without hiding the readable rows. |
| `unknown-version.json` | `unsupported` | A future `version` stays unavailable instead of being guessed. |
| `resume.json` | `resume` | A specified session uses `--resume <id>`; `--continue` is only the latest-session selector and Pi's `--session` never appears. |

The sanitized session bodies live in `tests/fixtures/history/omp-*`. The real
18.20.2 sample is documented in `docs/verification/omp-history.md`; all paths,
titles and message text in the fixture are neutral placeholders.
