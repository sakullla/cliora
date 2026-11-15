# OMP plugin verification fixtures

`scripts/verify-omp-native.mjs` passes each file to
`adapters::omp::plugins::verify_case`. These are product declarations, not real
CLI evidence.

| File | Covers |
| --- | --- |
| `capability.json` | published install/update/enable/disable/uninstall/doctor actions, project scope and source vocabulary |
| `commands.json` | native `omp plugin` subcommands, `--scope project` for marketplace IDs, refusal of project npm/version-pin installs and project doctor |
| `residual.json` | a user lock entry whose package is missing, reported with a writable doctor recovery row |
| `project-overrides.json` | `.omp/plugin-overrides.json` read-only disable/feature state and no misleading project doctor row |

`tests/fixtures/plugins/omp-18.20.2-list.json` and
`tests/fixtures/plugins/omp-18.20.2-doctor.json` are sanitized real OMP 18.20.2
output shapes used by the Rust unit tests.
