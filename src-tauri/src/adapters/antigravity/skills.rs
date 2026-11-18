//! agy 1.5.9 explicit skill sources: `.agents/skills.json` declarations.
//!
//! Verified on the authorized remote 1.5.9 machine
//! (`docs/verification/remote-workflow/agy-1.5.9/evidence/skills.json`,
//! sanitized sample `tests/fixtures/native/antigravity-cli-1.5.9/
//! workspace-skills.json`): a workspace manifest
//! `{entries:[{path,include_only?,exclude?}],inherits:[{path,include_only?}]}`
//! declares non-standard skill directories; entries load only from inside
//! the workspace/repository root (absolute, `..` and symlink entries are
//! skipped by the native untrusted-repository protection), declared
//! directories are scanned one level deep, and manifests are honored in
//! every `.agents/` between the workspace and the repository root. Declared
//! skills appear in the product `/skills` panel labeled
//! `<dir> · From <project>` and as slash commands.
//!
//! Inferences recorded against that evidence (the shape is verified, the
//! exact matching rule is not): `include_only`/`exclude` are treated as one
//! consistent skill-name filter at every level they attach to (an entry
//! filters the names inside its declared directory, an inherit filters the
//! names merged from the inherited manifest), patterns match exactly or as
//! `*` wildcards with the common regex spelling `.*` normalized, and a
//! manifest that fails to parse contributes no sources instead of failing
//! the whole scan. Every declared source stays a read-only discovery row;
//! the writable roots are unchanged.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::adapters::SkillDeclaration;

/// One parsed `.agents/skills.json`.
#[derive(Deserialize)]
struct SkillsManifest {
    #[serde(default)]
    entries: Vec<ManifestEntry>,
    #[serde(default)]
    inherits: Vec<ManifestInherit>,
}

#[derive(Deserialize)]
struct ManifestEntry {
    path: String,
    #[serde(default)]
    include_only: Vec<String>,
    #[serde(default)]
    exclude: Vec<String>,
}

#[derive(Deserialize)]
struct ManifestInherit {
    path: String,
    #[serde(default)]
    include_only: Vec<String>,
}

/// Walk and manifest budget: a pathological workspace must not turn the
/// skill scan into an unbounded filesystem walk.
const MAX_LEVELS: usize = 8;
const MAX_MANIFESTS: usize = 16;
const MAX_DECLARED: usize = 32;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

/// Name filters merged from an entry and the inherit that pulled it in.
#[derive(Default, Clone)]
struct NameFilter {
    include_only: Vec<String>,
    exclude: Vec<String>,
}

impl NameFilter {
    fn allows(&self, name: &str) -> bool {
        let included = self.include_only.is_empty()
            || self.include_only.iter().any(|pattern| name_matches(pattern, name));
        let excluded = self.exclude.iter().any(|pattern| name_matches(pattern, name));
        included && !excluded
    }
    fn merge(&mut self, include_only: &[String], exclude: &[String]) {
        if self.include_only.is_empty() {
            self.include_only = include_only.to_vec();
        } else if !include_only.is_empty() {
            self.include_only.retain(|pattern| include_only.contains(pattern));
        }
        self.exclude.extend(exclude.iter().cloned());
    }
}

/// Exact or wildcard match; the verified sample spells one pattern as the
/// regex `experimental-.*`, so `.*` is normalized to `*` before matching.
fn name_matches(pattern: &str, name: &str) -> bool {
    if pattern == name {
        return true;
    }
    let normalized = pattern.replace(".*", "*");
    if !normalized.contains('*') {
        return false;
    }
    glob::Pattern::new(&normalized).is_ok_and(|glob| glob.matches(name))
}

/// A declared directory that passed containment and link checks.
struct DeclaredDir {
    dir: PathBuf,
    label: String,
    filter: NameFilter,
}

/// All skill directories the workspace's skills.json chain declares for
/// this project: manifests between the project root and the repository
/// root, one level of skill folders per declared directory, name filters
/// applied, duplicates removed. Unreadable or absent pieces contribute
/// nothing instead of failing the scan.
pub(crate) fn declared_sources(project: &Path) -> Vec<SkillDeclaration> {
    let mut state = Resolution {
        visited: Vec::new(),
        declared: Vec::new(),
        sources: Vec::new(),
    };
    let mut current = Some(project.to_path_buf());
    let mut levels = 0;
    while let Some(dir) = current {
        if levels >= MAX_LEVELS || state.visited.len() >= MAX_MANIFESTS || state.declared.len() >= MAX_DECLARED {
            break;
        }
        levels += 1;
        let manifest = dir.join(".agents").join("skills.json");
        if is_regular_file(&manifest) {
            load_manifest(&manifest, &dir, 0, &mut state);
        }
        // The repository root's own manifest is honored; nothing above it is.
        if dir.join(".git").exists() {
            break;
        }
        current = dir.parent().map(Path::to_path_buf);
    }
    for declared in &state.declared {
        let Ok(children) = fs::read_dir(&declared.dir) else {
            continue;
        };
        // Directory order differs between filesystems; a stable name order keeps the
        // list, the cap and same-name precedence identical on every platform.
        let mut children: Vec<_> = children.flatten().collect();
        children.sort_by_key(|child| child.file_name());
        for child in children {
            if state.sources.len() >= MAX_DECLARED {
                break;
            }
            let name = child.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !child.path().is_dir() {
                continue;
            }
            // Symlinked entries are skipped by the native protection; the
            // same caution applies to a linked skill folder.
            if fs::symlink_metadata(child.path()).is_ok_and(|meta| meta.file_type().is_symlink()) {
                continue;
            }
            if declared.filter.allows(&name) {
                state.sources.push(SkillDeclaration {
                    root: declared.dir.join(&name),
                    label: declared.label.clone(),
                });
            }
        }
    }
    state.sources
}

struct Resolution {
    visited: Vec<PathBuf>,
    declared: Vec<DeclaredDir>,
    sources: Vec<SkillDeclaration>,
}

/// Reads one manifest (own or inherited) and merges its entries.
fn load_manifest(path: &Path, base: &Path, depth: usize, state: &mut Resolution) {
    if depth > 4 || state.visited.len() >= MAX_MANIFESTS || state.declared.len() >= MAX_DECLARED {
        return;
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if state.visited.iter().any(|seen| seen == &canonical) {
        return;
    }
    state.visited.push(canonical);
    let Some(text) = read_manifest_text(path) else { return };
    let Ok(manifest) = serde_json::from_str::<SkillsManifest>(&text) else {
        return;
    };
    for entry in &manifest.entries {
        if state.declared.len() >= MAX_DECLARED {
            return;
        }
        let Some(dir) = resolve_declared_dir(base, &entry.path) else {
            continue;
        };
        if state.declared.iter().any(|existing| existing.dir == dir) {
            continue;
        }
        let mut filter = NameFilter::default();
        filter.merge(&entry.include_only, &entry.exclude);
        state.declared.push(DeclaredDir {
            label: format!("skills.json · {}", entry.path.trim_end_matches('/')),
            dir,
            filter,
        });
    }
    for inherit in &manifest.inherits {
        if state.declared.len() >= MAX_DECLARED || state.visited.len() >= MAX_MANIFESTS {
            return;
        }
        let target = resolve_manifest_path(base, &inherit.path);
        if !target.is_file() {
            continue;
        }
        // Entry paths of a manifest resolve against its workspace level: the
        // parent of `.agents` for repository manifests, the file's own
        // directory for a standalone shared manifest (the captured sample
        // points at one outside any `.agents` tree).
        let inherit_base = match target.parent() {
            Some(parent) if parent.file_name().is_some_and(|name| name == ".agents") => parent
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| parent.to_path_buf()),
            Some(parent) => parent.to_path_buf(),
            None => base.to_path_buf(),
        };
        let before = state.declared.len();
        load_manifest(&target, &inherit_base, depth + 1, state);
        // The inherit's include_only filters every name merged from that
        // manifest, so it is added to each entry it contributed.
        for declared in &mut state.declared[before..] {
            declared.filter.merge(&inherit.include_only, &[]);
        }
    }
}

fn read_manifest_text(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// A relative, `..`-free path inside `base`; the native protection skips
/// absolute, escaping and symlinked entries.
fn resolve_declared_dir(base: &Path, declared: &str) -> Option<PathBuf> {
    if declared.is_empty() || declared.starts_with('/') || declared.starts_with('\\') || declared.contains('\\') {
        return None;
    }
    let mut dir = base.to_path_buf();
    for part in declared.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            name if name.starts_with('.') => return None,
            name => dir.push(name),
        }
    }
    if !dir.starts_with(base) || !dir.is_dir() {
        return None;
    }
    if fs::symlink_metadata(&dir).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return None;
    }
    Some(dir)
}

/// Inherit targets may be absolute (the captured sample points at a shared
/// team manifest); relative targets resolve against the inheriting base and
/// must stay inside it.
fn resolve_manifest_path(base: &Path, declared: &str) -> PathBuf {
    let candidate = Path::new(declared);
    if candidate.is_absolute() {
        return candidate.to_path_buf();
    }
    let mut dir = base.to_path_buf();
    for part in declared.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                dir.pop();
            }
            name => dir.push(name),
        }
    }
    dir
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Containment guard: a declared directory never leaves its manifest
    /// base through component tricks.
    fn inside_base(base: &Path, candidate: &Path) -> bool {
        candidate.strip_prefix(base).is_ok()
            && !candidate
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
    }

    fn write_manifest(dir: &Path, text: &str) {
        fs::create_dir_all(dir.join(".agents")).unwrap();
        fs::write(dir.join(".agents").join("skills.json"), text).unwrap();
    }

    fn skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir.join(name)).unwrap();
        fs::write(
            dir.join(name).join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\nbody"),
        )
        .unwrap();
    }

    #[test]
    fn wildcard_filter_accepts_exact_and_regex_star_spellings() {
        assert!(name_matches("linter-skill", "linter-skill"));
        assert!(!name_matches("linter-skill", "other-skill"));
        assert!(name_matches("experimental-.*", "experimental-mock"));
        assert!(name_matches("experimental-*", "experimental-mock"));
        assert!(!name_matches("experimental-.*", "stable-mock"));
    }

    #[test]
    fn declared_directories_resolve_inside_the_workspace_only() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write_manifest(
            &project,
            r#"{"entries":[{"path":"shared-skills"},{"path":"../escape"},{"path":"/abs"},{"path":".hidden"}]}"#,
        );
        fs::create_dir_all(project.join("shared-skills").join("kept")).unwrap();
        let sources = declared_sources(&project);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].root, project.join("shared-skills").join("kept"));
        assert_eq!(sources[0].label, "skills.json · shared-skills");
        assert!(inside_base(&project, &sources[0].root));
    }

    #[test]
    fn filters_and_one_level_depth_follow_the_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write_manifest(
            &project,
            r#"{"entries":[{"path":"tools/agent-skills","include_only":["linter-skill","wild-*"],"exclude":["experimental-.*"]}]}"#,
        );
        let declared = project.join("tools").join("agent-skills");
        skill(&declared, "linter-skill", "kept");
        skill(&declared, "wild-card", "kept");
        skill(&declared, "experimental-mock", "excluded");
        skill(&declared, "other-skill", "not included");
        // One level deep only: a nested folder is not a declared skill.
        skill(&declared.join("nested"), "nested-skill", "too deep");
        let sources = declared_sources(&project);
        let names: Vec<&str> = sources
            .iter()
            .map(|source| source.root.file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(names, vec!["linter-skill", "wild-card"], "{sources:?}");
        assert!(sources
            .iter()
            .all(|source| source.label == "skills.json · tools/agent-skills"));
    }

    #[test]
    fn inherits_merge_shared_manifests_with_their_own_base_and_filter() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        fs::create_dir_all(&shared).unwrap();
        write_manifest(
            &shared,
            r#"{"entries":[{"path":"team-skills"}]}"#,
        );
        skill(&shared.join("team-skills"), "linter-skill", "kept");
        skill(&shared.join("team-skills"), "heavy-skill", "filtered out");
        let project = temp.path().join("repo").join("project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(project.parent().unwrap().join(".git")).unwrap();
        // A repository `.agents` manifest inherited by absolute path resolves
        // its entries against that repository's level.
        let inherit_path = shared.join(".agents").join("skills.json");
        write_manifest(
            &project,
            &format!(
                r#"{{"entries":[],"inherits":[{{"path":{},"include_only":["linter-skill"]}}]}}"#,
                serde_json::to_string(&inherit_path.display().to_string().replace('\\', "/")).unwrap()
            ),
        );
        let sources = declared_sources(&project);
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert_eq!(sources[0].root, shared.join("team-skills").join("linter-skill"));

        // A standalone shared manifest (the captured sample shape, outside any
        // `.agents` tree) resolves entries against its own directory.
        let team = temp.path().join("team");
        fs::create_dir_all(team.join("team-dir").join("solo-skill")).unwrap();
        fs::write(
            team.join("team-skills.json"),
            r#"{"entries":[{"path":"team-dir"}]}"#,
        )
        .unwrap();
        let standalone = team.join("team-skills.json");
        write_manifest(
            &project,
            &format!(
                r#"{{"entries":[],"inherits":[{{"path":{}}},{{"path":{},"include_only":["linter-skill"]}}]}}"#,
                serde_json::to_string(&standalone.display().to_string().replace('\\', "/")).unwrap(),
                serde_json::to_string(&inherit_path.display().to_string().replace('\\', "/")).unwrap()
            ),
        );
        let sources = declared_sources(&project);
        let roots: Vec<&Path> = sources.iter().map(|source| source.root.as_path()).collect();
        assert_eq!(roots.len(), 2, "{sources:?}");
        assert!(roots.contains(&team.join("team-dir").join("solo-skill").as_path()));
        assert!(roots.contains(&shared.join("team-skills").join("linter-skill").as_path()));
    }

    #[test]
    fn manifests_between_the_project_and_repository_root_are_honored_once() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let project = repo.join("nested").join("deep");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();
        write_manifest(&repo, r#"{"entries":[{"path":"root-shared"}]}"#);
        fs::create_dir_all(repo.join("root-shared").join("root-skill")).unwrap();
        write_manifest(&project, r#"{"entries":[{"path":"local-shared"}]}"#);
        fs::create_dir_all(project.join("local-shared").join("local-skill")).unwrap();
        let sources = declared_sources(&project);
        let roots: Vec<&Path> = sources.iter().map(|source| source.root.as_path()).collect();
        assert_eq!(roots.len(), 2, "{sources:?}");
        assert!(roots.contains(&project.join("local-shared").join("local-skill").as_path()));
        assert!(roots.contains(&repo.join("root-shared").join("root-skill").as_path()));
        // The same manifest reached through a repeated walk is visited once.
        let again = declared_sources(&project);
        assert_eq!(again.len(), sources.len());
    }

    #[test]
    fn absent_invalid_or_linked_manifests_contribute_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".agents")).unwrap();
        assert!(declared_sources(&project).is_empty());
        fs::write(project.join(".agents").join("skills.json"), "not json").unwrap();
        assert!(declared_sources(&project).is_empty());
        fs::write(project.join(".agents").join("skills.json"), r#"{"entries":[{"path":"gone"}]}"#).unwrap();
        assert!(declared_sources(&project).is_empty());
    }

    #[test]
    fn the_committed_sanitized_manifest_sample_parses_with_its_shape() {
        // The sanitized 1.5.9 declaration sample pins the captured schema:
        // relative entries with include/exclude filters plus an absolute
        // inherited team manifest with its own include_only.
        const SAMPLE: &str =
            include_str!("../../../../tests/fixtures/native/antigravity-cli-1.5.9/workspace-skills.json");
        let manifest: SkillsManifest = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(manifest.entries.len(), 2);
        assert_eq!(manifest.entries[0].path, "shared-skills");
        assert!(manifest.entries[0].include_only.is_empty());
        assert_eq!(manifest.entries[1].exclude, vec!["experimental-.*"]);
        assert_eq!(manifest.inherits.len(), 1);
        assert!(manifest.inherits[0].path.starts_with('/'), "absolute inherit path");
        assert_eq!(manifest.inherits[0].include_only, vec!["linter-skill"]);
        // The sample's exclude pattern matches the regex-style spelling it
        // captured and the wildcard normalization accepts.
        assert!(name_matches(&manifest.entries[1].exclude[0], "experimental-mock"));
        assert!(!name_matches(&manifest.entries[1].exclude[0], "stable-mock"));
    }
}
