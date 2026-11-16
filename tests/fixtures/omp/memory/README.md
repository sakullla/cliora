# OMP memory verification fixtures

`scripts/verify-omp-native.mjs` dispatches every file here through
`capability: "memory"` to `src-tauri/src/adapters/omp/memory.rs`. T6 owns this
directory; the verifier and `verify.rs` dispatcher are not edited.

These cases are product checks against the registered adapter. A passing case
is not native evidence: the real `omp/18.20.2` observations live in
`docs/verification/omp-memory.md`.

| File | Meaning |
| --- | --- |
| `layout.json` | the project memory root under the default agent dir, a named Profile, `PI_CONFIG_DIR` and `PI_CODING_AGENT_DIR`; invalid Profile names are rejected |
| `backend.json` | verified `memory.backend` values and legacy `memories.enabled` migration; switching writes only `memory.backend` and keeps memory files; unknown values reject an enable write; `off` reports the local files that stay on disk |
| `entries.json` | `local` lists only `MEMORY.md`, `memory_summary.md` and `learned.md`; `skills/` and foreign Markdown files are not entries |
| `boundary.json` | `off`, `hindsight`, `mnemopi`, `sharpshooter` and unknown values publish no Markdown store and leave native data untouched |

The verified facts behind these cases come from the published 18.20.2 sources
(`src/memory-backend/settings.ts`, `src/memories/index.ts`,
`@oh-my-pi/pi-utils` `src/dirs.ts`) and a real isolated `omp/18.20.2`
(`omp config get/set memory.backend`, `omp read memory://root`).
