# Cliora / Twiglane project workspace v1

A business project is a named repository set. This contract is shared by both products; it does not replace either application's private native directory or credential data.

## File and identities

A UTF-8 `*.dev-workspace.json` file is selected explicitly. Its maximum encoded size is 8 MiB (a read protection, not a repository count promise). JSON properties use camelCase; unknown properties and schema versions are rejected without overwriting the original.

The normative valid sample is `tests/fixtures/workspaces/valid-v1.json` in Cliora. `invalid-version.json` must be rejected by both implementations. `path-cases-v1.json` is the shared table of accepted/rejected absolute location forms. Consumers should copy these fixtures verbatim and assert the same parse/serialization rules.

- `schemaVersion`: exactly integer `1`.
- `workspaceId`: UUID; names are never identity.
- `name`: trimmed nonempty name, at most 160 Unicode characters, no control characters.
- `revision`: integer from 1 through JavaScript safe-integer maximum (9,007,199,254,740,991); increments on each successful shared mutation.
- `repositories`: array of `{id, name, locations}`. IDs are unique UUIDs within the project.
- `locations`: array of `{hostId, path}`. The hostId is a UUID; path is an absolute POSIX, Windows drive or UNC path, contains no control characters and is at most 16,384 encoded bytes. Host/path pairs cannot repeat within the file. A foreign-platform absolute path is a location hint, not a locally executable path. POSIX paths have a single leading `/`; Windows drive paths require an ASCII letter, colon and root separator (`C:\repo` or `C:/repo`). Double-leading separators are UNC and require both nonempty server and share components. Extended canonical Windows disk forms (`\\?\C:\repo` and `\\?\UNC\server\share\repo`) are accepted; other device namespaces, drive-relative `C:repo`, non-letter drives and incomplete UNC roots are rejected. Local binding and launch additionally require the receiving platform's `Path::is_absolute` before canonicalization, so a foreign syntax cannot resolve relative to its working directory.

The file contains no credentials, tokens, CLI configuration, prompt bodies, or commands. A repository can be explicitly referenced from multiple projects. A linked worktree is another working location for the same verified Git common directory, never another business project. Submodules are distinct repositories.

## Local host provenance

Both applications use the same file at `dirs::data_local_dir()/sakullla/workspace-identity/host-id`. On macOS this is the current user's `~/Library/Application Support/sakullla/workspace-identity/host-id`; other platforms use their corresponding local data directory. The content is one UUID, generated once using a CSPRNG. Never derive it from a hostname, account ID, credential, Git URL or directory name.

The identity directory has mode 0700 and created files have mode 0600 on Unix. Initialize under the `host-id.lock` sidecar file lock; while held, read an existing valid token, or atomically create a random token only if absent. A corrupt or unreadable token is an error, never a reason to generate a replacement. Lock contention is a retryable busy result. Windows uses the user's local app data boundary.

Matching hostId is necessary but not sufficient for local use: canonicalize and verify the selected directory/Git identity before launching or performing Git operations. Foreign hosts remain visible as unavailable locations and require explicit local reassociation. Sharing this provenance token does not grant filesystem access.

## Atomic edits and conflicts

Canonicalize an existing source file before linking it. For a new file, canonicalize its parent and keep the chosen file name. The stable lock file is the full canonical file name plus `.lock`; it is never the replaced target inode. Both implementations acquire an exclusive OS file lock (Rust `File::try_lock`), then reread the source while holding the lock. Busy locks return a retryable error.

Each local projection retains the exact SHA-256 digest of source bytes and revision. Before mutation the file's workspaceId, revision and digest must match the caller's observed values. On disagreement, return conflict without writing. Before publication, validate all predictable local membership/identity conflicts and the local expected revision under a private-store write transaction or equivalent writer serialization, kept through publication and projection. A rejected known conflict must leave shared bytes and revision unchanged. Serialize the updated manifest, create a private temporary file in the same directory, flush and sync it, then atomically replace the target. Keep the sidecar lock through publication and projection update. Unlock explicitly before dropping the guard: a concurrent Unix child-process fork may temporarily inherit the same open file description, so dropping only the parent descriptor need not release the lock. Never unlink the sidecar after unlock, as another process may already hold an open descriptor.

Location projection is scoped to each workspace/repository membership: refreshing a manifest replaces that membership’s location references, while retaining locations still referenced by other workspaces. Removed locations cannot remain launchable through the refreshed membership. Locations without any member reference are retired: they cannot participate in common-directory identity matching or reserve their former host/path for a repository. Retain historical context separately or clear the retired row's live path claim, so a newly created repository at the old path receives its own identity. Active references in other projects remain protected.

After file publication the private database/cache projection can be retried idempotently from the manifest. If projection fails, report “file saved, local projection pending”; do not falsely say nothing was saved and do not replay the mutation. Source missing, corrupt or newer-schema errors keep the last readable projection with a visible stale/error state, and prohibit stale overwrites.

Ordinary refresh rejects a lower revision or changed content at the same revision; explicit re-preview and adoption is required to accept such a replacement. This prevents an older peer snapshot silently rolling back local membership.

Initial attach has a preview containing full manifest, canonical path and byte digest. Acceptance checks the digest again. An existing workspace UUID with different content needs explicit replace/adopt confirmation. Same-name different-UUID projects remain separate. Directory membership changes do not move or delete source code and do not invoke native profile application.

## UI and integration

Each product supports creating a local business project, publishing it to a new file, previewing/attaching an existing file, refreshing the linked file and editing membership. A linked project's revisions are reloaded when opened, on focus, or on explicit refresh. The sharing UI explains that the other product should open this same file, and reports updates/invalid locations separately from Git status.

The optional `cliora://workspace?v=1&file=<absolute-path>` / `twiglane://workspace?v=1&file=<absolute-path>` entry only requests a preview. It never auto-adopts a new definition or executes Git. URLs contain exactly v/file, no duplicate fields, fragment, userinfo, port, relative path or raw control characters. Review links retain their separate versioned contract. Ordinary project refresh needs no repeated attach confirmation. An incoming preview is consumed when handed to the page; after closing or accepting it, later navigation must not recreate that preview from a retained parent intent.

## Failure semantics

- Missing directory: retain member and report unavailable; do not open a different repository.
- Duplicate local path associated with another stable repository ID: retain existing binding and report association conflict.
- Removal: remove a project membership only; preserve code, checkout, commit drafts and session history.
- Wrong schema, invalid JSON, stale revision, failed lock, unreadable source: preserve source and cached data, with a retry/refresh path.
- Shared definitions contain no application-private runtime state; each application remains usable when the other is not installed.
