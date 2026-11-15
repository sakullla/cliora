# OMP resource verification fixtures

`scripts/verify-omp-native.mjs` dispatches every file here through
`capability: "resources"` and then by `case.kind` to the owning module:
`mcp`, `skills`, `rules` or `agents`. T4 owns this directory; the verifier and
`verify.rs` dispatcher are not edited.

These cases are product checks against the registered adapter. A real `omp`
observation is separate native evidence, not implied by a passing fixture.

| File | Meaning |
| --- | --- |
| `mcp-layout.json` | user/project `mcp.json` paths and the `mcpServers` table |
| `mcp-documents.json` | stdio/http/sse documents keep type, enabled and transport fields |
| `mcp-overlay.json` | external enable/disable only changes OMP's `disabledServers`/`enabledServers` |
| `mcp-validation.json` | unknown type, missing command/url and command+url stay per-entry visible |
| `skills-layout.json` | user/project `skills` roots and `AGENTS.md` rule files |
| `skills-switch.json` | `disabledExtensions` adds/removes only `skill:<name>` |
| `skills-observations.json` | generated and foreign skill roots are read-only observations |
| `rules-context.json` | OMP native context rule paths |
| `agents-capability.json` | Markdown support and preserved frontmatter template |
| `agents-layout.json` | user/project agent roots and bundled names |
| `agents-toggle.json` | disable/enable only changes `task.disabledAgents` |
