# OMP native verification fixtures

`scripts/verify-omp-native.mjs` consumes every `tests/fixtures/omp/<capability>/*.json`
file with this shape:

```json
{
  "capability": "lifecycle",
  "name": "human-readable case name",
  "case": { "...": "capability-specific declaration" }
}
```

- `capability` selects the owning adapter module. The script never needs editing
  when a capability adds its own fixtures; the adapter's `verify` dispatcher
  routes the case to that module.
- `capability` must equal the directory name. Resource cases live in
  `resources/` and select `mcp`, `skills`, `rules` or `agents` with `case.kind`;
  the dispatcher routes that kind to the owning module without renaming the
  capability.
- `case` is a declaration, never evidence. A case only becomes native evidence
  when the script pairs it with a real, isolated `omp` observation.
- Each capability directory is owned by the task that delivers it. Lifecycle
  cases live in `lifecycle/`.

`lifecycle` kinds:

| kind | meaning |
| --- | --- |
| `channels` | path → Bun / package / standalone / unknown classification |
| `version-policy` | accepted and rejected versions; the baseline is informational |
| `launch` | `--resume`/`--continue` arguments and YOLO rejection |
| `maintenance` | verified Bun/native commands, absent precompiled installer, official guidance |
| `bun` | a missing Bun reports a reason and never substitutes a source |

The baseline `18.20.2` is display information. Ordinary newer releases are
accepted without an upper bound; only a recorded breaking release (none today)
or an unidentifiable version is rejected.
