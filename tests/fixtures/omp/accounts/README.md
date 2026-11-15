# OMP account verification fixtures

`scripts/verify-omp-native.mjs` consumes every
`tests/fixtures/omp/accounts/*.json` case with the shared shape documented in
`tests/fixtures/omp/lifecycle/README.md`.

Current cases:

| file | kind | meaning |
| --- | --- | --- |
| `read-only.json` | `read-only-policy` | the accounts port is published, but no provider has managed login, no login entry exists and the shared `agent.db` cannot be exported as a whole auth file |

## Evidence boundary

These cases are declarations. They check the product's read-only policy and do
not prove a real OAuth login:

- no real `agent.db` from any OAuth provider was available in this environment;
- no provider completed real identity, isolation, login, cancel, refresh and
  single-account logout evidence;
- therefore every OMP provider stays `managed_login = false`.

`sanitized-agent.db.sql` is a synthetic SQLite fixture used by Rust tests to
exercise parsing, WAL/SHM notes, corrupt rows, unknown schemas and the broker
hint. It contains no real credential and must not be treated as native account
acceptance. The unrelated `session_state` table exists so tests can prove that
other OMP state is never read or exported.
