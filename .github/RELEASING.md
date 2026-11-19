# CI and releases

Pull requests and pushes to `main` run `ci.yml` (frontend tests/build, Rust tests/Clippy, and the macOS target check).

Pushing a `v*` version tag starts `Release`. Before creating a draft or building installers, the workflow waits up to 60 minutes for the **same commit SHA** to pass the latest `ci.yml` push run on `main`. A successful PR, another branch, or another commit cannot authorize a release. The tested commit must still belong to main's history.

Failed, cancelled, skipped, or timed-out CI blocks release. Missing or pending CI waits until the deadline. After CI succeeds, rerun a failed release workflow if necessary. Code changes need a new commit and version tag; do not move existing release tags.

All build jobs check out the verified SHA. The existing platform signatures, installer checks, updater archives, and `latest.json` generation remain in place. Immediately before publication, the workflow verifies that the tag still points to that SHA. Incomplete releases stay as drafts; published versions are not overwritten.

Gate regression tests run in CI and locally with `node --test tests/native/release-gate.test.mjs`. No new repository secrets are required.

Rust compiler and rustdoc warnings fail CI and release builds. Clippy runs with `--all-targets -- -D warnings` on Linux, macOS and Windows; no lint step is allowed to fail.
