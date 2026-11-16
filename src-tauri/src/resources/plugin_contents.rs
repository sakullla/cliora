//! Read and (adapter-declared) controlled edit of what a native plugin
//! bundles: its manifest summary and the agents, skills, commands, hooks, MCP
//! servers and other files it ships.
//!
//! Everything starts from a fresh native scan of the bound target. The UI names a
//! plugin by id and, for file reads, a path; both are resolved against that scan, so
//! only files inside the plugin's own root or its declared resource paths are read.
//! Nothing here runs plugin code or follows a path outside those bases. Writes are
//! limited to resource kinds the adapter declares editable ([`PluginAdapter::
//! editable_resource_kinds`]): the edit is validated by the adapter's schema
//! contract first, then planned as a text patch and applied by the shared
//! transaction service (baseline conflict detection + encrypted backup), never
//! by this module's own filesystem calls.
use super::plugins::{scan_resources, PluginEntry, PluginTarget};
use crate::adapters::plugins::PluginAdapter;
use crate::credentials::CredentialStore;
use crate::database::Database;
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

/// Bounds keep a large or hostile package from stalling the page.
const MAX_ITEMS: usize = 400;
const MAX_DEPTH: usize = 3;
const MAX_DIR_ENTRIES: usize = 2_000;
const HEAD_BYTES: u64 = 16 * 1024;
const MAX_READ_BYTES: u64 = 512 * 1024;
const MANIFESTS: [&str; 4] = [".claude-plugin/plugin.json", "plugin.json", ".codex-plugin/plugin.json", "package.json"];

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub description: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    pub keywords: Vec<String>,
    /// Repository-relative manifest location, when one was found.
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginItem {
    /// The resource kind it came from (`agents`, `skills`, `commands`, `hooks`, `mcp`, …).
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    /// The file a reader opens (a skill's `SKILL.md`, an MCP or hooks document).
    pub path: String,
    /// The item's own location: a skill's directory, otherwise the file itself.
    pub location: String,
    pub format: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContents {
    pub plugin_id: String,
    pub root: Option<String>,
    pub manifest: PluginManifest,
    pub items: Vec<PluginItem>,
    /// True when the item bound was reached; the UI says the list is partial.
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    pub path: String,
    pub content: String,
    pub format: String,
    pub truncated: bool,
    /// True only when the adapter declared this resource kind editable, the
    /// entry is writable, and the file is exactly that declared resource.
    pub editable: bool,
}

/// Resolve the plugin adapter behind a target (the scan already required it).
fn adapter_for(target: &PluginTarget) -> Result<&'static dyn PluginAdapter, String> {
    crate::adapters::plugins::get_registered(&crate::adapters::Registry::builtins(), &target.tool_id)
}

pub fn inspect(db: &Database, home: &Path, target: &PluginTarget, plugin_id: &str) -> Result<PluginContents, String> {
    let adapter = adapter_for(target)?;
    let entry = find(db, home, target, plugin_id)?;
    Ok(contents(adapter, &entry))
}

pub fn read_file(db: &Database, home: &Path, target: &PluginTarget, plugin_id: &str, path: &str) -> Result<PluginFile, String> {
    let adapter = adapter_for(target)?;
    let entry = find(db, home, target, plugin_id)?;
    let file = contained(&entry, Path::new(path))?;
    if !file.is_file() {
        return Err("只能查看插件内的文件".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(&file).map_err(|error| format!("无法读取插件文件：{error}"))?.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes).map_err(|error| format!("无法读取插件文件：{error}"))?;
    let truncated = bytes.len() as u64 > MAX_READ_BYTES;
    bytes.truncate(MAX_READ_BYTES as usize);
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        return Err("这是二进制文件，无法以文本查看".into());
    }
    Ok(PluginFile { path: file.display().to_string(), content: String::from_utf8_lossy(&bytes).into_owned(), format: format_of(&file), truncated, editable: editable_resource(&entry, adapter, &file).is_some() })
}

/// The editable declared resource whose file this path is, when there is one.
fn editable_resource(entry: &PluginEntry, adapter: &dyn PluginAdapter, resolved: &Path) -> Option<super::plugins::PluginResource> {
    if entry.read_only {
        return None;
    }
    let kinds = adapter.editable_resource_kinds();
    entry
        .resources
        .iter()
        .find(|resource| kinds.contains(&resource.kind.as_str()) && fs::canonicalize(&resource.path).is_ok_and(|path| path == resolved))
        .cloned()
}

/// Save an edited bundled-resource file through the shared transaction
/// service. The write path is adapter-declared (`editable_resource_kinds`),
/// schema-validated before any write, gated to the adapter's verified install
/// line (`version`, resolved by the caller's probe like every other plugin
/// mutation), and applied as a text patch with baseline conflict detection and
/// an encrypted backup — the original file is untouched by every rejection.
#[allow(clippy::too_many_arguments)]
pub fn save_file(
    db: &Database,
    credentials: &dyn CredentialStore,
    home: &Path,
    target: &PluginTarget,
    plugin_id: &str,
    path: &str,
    original: &str,
    edited: &str,
    version: &str,
) -> Result<crate::native::transaction::ApplyOutcome, String> {
    let adapter = adapter_for(target)?;
    // Serialize against lifecycle operations so an edit never races an
    // install/uninstall on the same tree.
    let _operation = super::plugins::operation_lock()?;
    if !adapter.version_policy().accepts(version) {
        return Err(format!(
            "插件参考核验版本 {}；当前 {version} 不满足原生契约范围 {}，包内资源不可编辑",
            adapter.capability().version,
            adapter.version_policy().accepted_text()
        ));
    }
    // The authoritative scan (with the package digest): a broken or externally
    // changed package is read-only and never receives a write.
    let entry = super::plugins::scan(db, home, target)?
        .entries
        .into_iter()
        .find(|entry| entry.id == plugin_id)
        .ok_or_else(|| "未找到该插件，请重新扫描".to_string())?;
    if entry.read_only {
        return Err("此插件只读，包内文件不可编辑".into());
    }
    let file = contained(&entry, Path::new(path))?;
    if !file.is_file() {
        return Err("只能编辑插件内的文件".into());
    }
    let resource = editable_resource(&entry, adapter, &file)
        .ok_or_else(|| "此插件资源不可编辑（适配器未声明受控写入）".to_string())?;
    let current = crate::native::transaction::read_native(&file)?;
    let contents = if current == original {
        edited.to_owned()
    } else {
        crate::native::format::merge_edits(crate::native::format::FileKind::for_name(&file.display().to_string())?, original, edited, &current)?
    };
    // Adapter-owned contract check before anything is planned or written.
    adapter.validate_resource_text(&resource.kind, &contents)?;
    crate::native::transaction::apply_text(
        db,
        credentials,
        &[crate::native::transaction::TextPatch { path: file, baseline: current, contents, sensitive: false }],
        |_tx| Ok(()),
    )
}

/// A path inside the plugin, for revealing it in the file manager.
pub fn locate(db: &Database, home: &Path, target: &PluginTarget, plugin_id: &str, path: Option<&str>) -> Result<PathBuf, String> {
    let entry = find(db, home, target, plugin_id)?;
    match path {
        Some(path) => contained(&entry, Path::new(path)),
        None => bases(&entry).into_iter().next().ok_or_else(|| "插件没有提供安装位置".into()),
    }
}

fn find(db: &Database, home: &Path, target: &PluginTarget, plugin_id: &str) -> Result<PluginEntry, String> {
    scan_resources(db, home, target)?
        .entries
        .into_iter()
        .find(|entry| entry.id == plugin_id)
        .ok_or_else(|| "未找到该插件，请重新扫描".into())
}

/// Canonical directories a read may touch: the install root and each declared resource.
fn bases(entry: &PluginEntry) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    let mut push = |path: &Path| {
        let base = if path.is_file() { path.parent().map(Path::to_path_buf) } else { Some(path.to_path_buf()) };
        if let Some(Ok(base)) = base.map(fs::canonicalize) {
            if !bases.contains(&base) { bases.push(base); }
        }
    };
    if let Some(root) = entry.root.as_deref() { push(Path::new(root)); }
    for resource in &entry.resources { push(Path::new(&resource.path)); }
    bases
}

fn contained(entry: &PluginEntry, path: &Path) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(path).map_err(|_| "文件不存在或已移动，请重新扫描".to_string())?;
    if bases(entry).iter().any(|base| resolved.starts_with(base)) { Ok(resolved) } else { Err("路径不在该插件内".into()) }
}

pub(crate) fn contents(adapter: &dyn PluginAdapter, entry: &PluginEntry) -> PluginContents {
    let mut items = Vec::new();
    let mut truncated = false;
    let mut seen = Vec::<String>::new();
    for resource in &entry.resources {
        // A resource file listed twice (a root manifest and a component path) is shown once.
        if seen.contains(&resource.path) { continue; }
        seen.push(resource.path.clone());
        collect(adapter, &resource.kind, Path::new(&resource.path), &mut items, &mut truncated);
        if truncated { break; }
    }
    PluginContents { plugin_id: entry.id.clone(), root: entry.root.clone(), manifest: entry.root.as_deref().map(|root| manifest(Path::new(root))).unwrap_or_default(), items, truncated }
}

fn push(items: &mut Vec<PluginItem>, truncated: &mut bool, item: PluginItem) -> bool {
    if items.len() >= MAX_ITEMS { *truncated = true; return false; }
    items.push(item);
    true
}

fn collect(adapter: &dyn PluginAdapter, kind: &str, path: &Path, items: &mut Vec<PluginItem>, truncated: &mut bool) {
    if path.is_file() {
        file_items(adapter, kind, path, items, truncated);
        return;
    }
    if !path.is_dir() { return; }
    if kind == "skills" {
        // A skill resource is either one skill directory or a folder of them.
        if path.join("SKILL.md").is_file() { skill(path, items, truncated); return; }
        for child in children(path) {
            if child.join("SKILL.md").is_file() && !skill(&child, items, truncated) { return; }
        }
        return;
    }
    walk(adapter, kind, path, 0, items, truncated);
}

fn walk(adapter: &dyn PluginAdapter, kind: &str, dir: &Path, depth: usize, items: &mut Vec<PluginItem>, truncated: &mut bool) {
    if depth > MAX_DEPTH { return; }
    for child in children(dir) {
        if child.is_dir() {
            walk(adapter, kind, &child, depth + 1, items, truncated);
        } else {
            file_items(adapter, kind, &child, items, truncated);
        }
        if *truncated { return; }
    }
}

/// Visible entries in name order; hidden files and dependency folders are skipped.
fn children(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(dir) else { return vec![] };
    let mut list: Vec<PathBuf> = read
        .take(MAX_DIR_ENTRIES)
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
            !name.starts_with('.') && name != "node_modules" && name != "__pycache__"
        })
        .collect();
    list.sort();
    list
}

fn file_items(adapter: &dyn PluginAdapter, kind: &str, path: &Path, items: &mut Vec<PluginItem>, truncated: &mut bool) {
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_ascii_lowercase();
    let display = path.display().to_string();
    if name.ends_with(".json") && (kind == "mcp" || name.contains("mcp")) {
        if let Some(servers) = json_object(path).and_then(|value| value.get("mcpServers").cloned().or(Some(value))).and_then(|value| value.as_object().cloned()) {
            for (server, spec) in servers {
                let summary = spec.get("command").and_then(Value::as_str).map(|command| {
                    let args: Vec<&str> = spec.get("args").and_then(Value::as_array).map(|args| args.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                    std::iter::once(command).chain(args).collect::<Vec<_>>().join(" ")
                }).or_else(|| spec.get("url").and_then(Value::as_str).map(str::to_string));
                if !push(items, truncated, PluginItem { kind: "mcp".into(), name: server, description: summary, path: display.clone(), location: display.clone(), format: "json".into() }) { return; }
            }
            return;
        }
    }
    if name.ends_with(".json") && (kind == "hooks" || name.starts_with("hooks")) {
        if let Some(document) = json_object(path) {
            // Adapter-owned hooks schemas parse their own document first; the
            // generic walker below keeps the historical Claude-style
            // `{"hooks": {event: [handlers]}}` wrapper for everyone else.
            if let Some(rows) = adapter.hooks_items(&document, &display) {
                for row in rows {
                    if !push(items, truncated, row) { return; }
                }
                return;
            }
            if let Some(events) = document.get("hooks").cloned().or(Some(document)).and_then(|value| value.as_object().cloned()) {
                for (event, handlers) in events {
                    let count = handlers.as_array().map(|list| list.len()).unwrap_or(1);
                    if !push(items, truncated, PluginItem { kind: "hooks".into(), name: event, description: Some(count.to_string()), path: display.clone(), location: display.clone(), format: "json".into() }) { return; }
                }
                return;
            }
        }
    }
    let format = format_of(path);
    let (title, description) = if format == "markdown" { frontmatter(&head(path)) } else { (None, None) };
    let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default().to_string();
    push(items, truncated, PluginItem { kind: kind.into(), name: title.unwrap_or(stem), description, path: display.clone(), location: display, format });
}

fn skill(dir: &Path, items: &mut Vec<PluginItem>, truncated: &mut bool) -> bool {
    let file = dir.join("SKILL.md");
    let (title, description) = frontmatter(&head(&file));
    let name = title.unwrap_or_else(|| dir.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string());
    push(items, truncated, PluginItem { kind: "skills".into(), name, description, path: file.display().to_string(), location: dir.display().to_string(), format: "markdown".into() })
}

fn head(path: &Path) -> String {
    let mut bytes = Vec::new();
    if let Ok(file) = fs::File::open(path) { let _ = file.take(HEAD_BYTES).read_to_end(&mut bytes); }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn json_object(path: &Path) -> Option<Value> {
    let mut text = String::new();
    fs::File::open(path).ok()?.take(MAX_READ_BYTES).read_to_string(&mut text).ok()?;
    serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
}

/// `name` and `description` from a leading YAML block; anything malformed yields none.
pub(crate) fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---").filter(|rest| rest.starts_with('\n') || rest.starts_with("\r\n")) else { return (None, None) };
    let Some(end) = rest.find("\n---") else { return (None, None) };
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&rest[..end]) else { return (None, None) };
    let field = |key: &str| value.get(key).and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    (field("name"), field("description"))
}

fn manifest(root: &Path) -> PluginManifest {
    for relative in MANIFESTS {
        let path = root.join(relative);
        let Some(value) = json_object(&path) else { continue };
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        let author = value.get("author").and_then(|author| author.as_str().map(str::to_string).or_else(|| author.get("name").and_then(Value::as_str).map(str::to_string)));
        let homepage = text("homepage").or_else(|| value.get("repository").and_then(|repo| repo.as_str().map(str::to_string).or_else(|| repo.get("url").and_then(Value::as_str).map(str::to_string))));
        let keywords = value.get("keywords").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).take(12).collect()).unwrap_or_default();
        return PluginManifest { description: text("description"), author, homepage: homepage.filter(|url| url.starts_with("https://") || url.starts_with("http://")), license: text("license"), keywords, path: Some(path.display().to_string()) };
    }
    PluginManifest::default()
}

fn format_of(path: &Path) -> String {
    match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("md" | "mdc" | "markdown") => "markdown",
        Some("json" | "jsonc") => "json",
        Some("toml") => "toml",
        Some("yaml" | "yml") => "yaml",
        Some("js" | "mjs" | "cjs" | "ts") => "javascript",
        _ => "text",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::plugins::PluginResource;
    use crate::adapters::plugins::{PluginAdapter, PluginCapability};

    /// An adapter with no hooks schema and no editable resources: the shared
    /// generic walkers apply unchanged.
    struct BareAdapter;
    impl PluginAdapter for BareAdapter {
        fn capability(&self) -> PluginCapability {
            PluginCapability { version: "", sources: "", actions: Vec::new(), project: false, detail: "" }
        }
        fn command_args(&self, _action: &str, _source: &str, _project: bool) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
    }

    fn entry(root: &Path, resources: &[(&str, &str)]) -> PluginEntry {
        PluginEntry {
            id: "sample@market".into(), name: "Sample".into(), source: "sample@market".into(), version: Some("1.0.0".into()), scope: "user".into(), enabled: Some(true), state: "installed_load_unknown".into(), policy: String::new(), read_only: false,
            root: Some(root.display().to_string()),
            resources: resources.iter().map(|(kind, path)| PluginResource { kind: (*kind).into(), path: root.join(path).display().to_string(), owner_id: "sample@market".into() }).collect(),
        }
    }

    #[test]
    fn contents_name_each_bundled_item_and_read_only_inside_the_plugin() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sample");
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(root.join(".claude-plugin/plugin.json"), r#"{"name":"sample","description":"Review helpers","author":{"name":"Example"},"homepage":"https://example.test/sample","keywords":["review"]}"#).unwrap();
        fs::create_dir_all(root.join("agents/nested")).unwrap();
        fs::write(root.join("agents/reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\n---\nBody").unwrap();
        fs::write(root.join("agents/nested/plain.md"), "No frontmatter").unwrap();
        fs::create_dir_all(root.join("skills/lint")).unwrap();
        fs::write(root.join("skills/lint/SKILL.md"), "---\nname: lint-check\ndescription: Runs lint\n---\n").unwrap();
        fs::create_dir_all(root.join("skills/not-a-skill")).unwrap();
        fs::create_dir_all(root.join("hooks")).unwrap();
        fs::write(root.join("hooks/hooks.json"), r#"{"hooks":{"PreToolUse":[{},{}],"Stop":[{}]}}"#).unwrap();
        fs::write(root.join(".mcp.json"), r#"{"mcpServers":{"docs":{"command":"npx","args":["-y","docs-server"]},"remote":{"url":"https://example.test/mcp"}}}"#).unwrap();
        let plugin = entry(&root, &[("agents", "agents"), ("skills", "skills"), ("hooks", "hooks"), ("mcp", ".mcp.json")]);

        let found = contents(&BareAdapter, &plugin);
        assert!(!found.truncated);
        assert_eq!(found.manifest.description.as_deref(), Some("Review helpers"));
        assert_eq!(found.manifest.author.as_deref(), Some("Example"));
        assert_eq!(found.manifest.homepage.as_deref(), Some("https://example.test/sample"));
        let named: Vec<(String, String, Option<String>)> = found.items.iter().map(|item| (item.kind.clone(), item.name.clone(), item.description.clone())).collect();
        assert_eq!(named, vec![
            ("agents".into(), "plain".into(), None),
            ("agents".into(), "reviewer".into(), Some("Reviews code".into())),
            ("skills".into(), "lint-check".into(), Some("Runs lint".into())),
            ("hooks".into(), "PreToolUse".into(), Some("2".into())),
            ("hooks".into(), "Stop".into(), Some("1".into())),
            ("mcp".into(), "docs".into(), Some("npx -y docs-server".into())),
            ("mcp".into(), "remote".into(), Some("https://example.test/mcp".into())),
        ]);
        let skill = found.items.iter().find(|item| item.kind == "skills").unwrap();
        assert!(skill.path.ends_with("SKILL.md"));
        assert_eq!(Path::new(&skill.location), root.join("skills/lint"));

        // Reads stay inside the plugin's root and declared resources.
        assert!(contained(&plugin, &root.join("agents/reviewer.md")).is_ok());
        let outside = temp.path().join("secret.txt");
        fs::write(&outside, "secret").unwrap();
        assert!(contained(&plugin, &outside).is_err());
        assert!(contained(&plugin, &root.join("agents/../../secret.txt")).is_err());
        assert!(contained(&plugin, &root.join("missing.md")).is_err());
    }

    #[test]
    fn adapter_owned_hooks_schemas_replace_the_generic_wrapper_rows() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("agy-kit");
        fs::create_dir_all(&root).unwrap();
        // The agy named-hooks shape: one row per hook with events and the
        // disabled marker, and the file itself is the editable resource.
        fs::write(root.join("hooks.json"), r#"{"probe-hook":{"PostToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"./h.sh"}]}]},"off-hook":{"enabled":false,"SessionStart":[{"type":"command","command":"/bin/true"}]}}"#).unwrap();
        let plugin = entry(&root, &[("hooks", "hooks.json")]);

        let found = contents(&crate::adapters::antigravity::Antigravity, &plugin);
        let rows: Vec<(String, Option<String>)> = found.items.iter().map(|item| (item.name.clone(), item.description.clone())).collect();
        assert_eq!(rows, vec![
            ("probe-hook".into(), Some("PostToolUse".into())),
            ("off-hook".into(), Some("SessionStart · 已停用".into())),
        ]);
        // The claude-style wrapper keeps the generic per-event rows for an
        // adapter without its own parser.
        fs::write(root.join("hooks.json"), r#"{"hooks":{"Stop":[{}]}}"#).unwrap();
        let found = contents(&BareAdapter, &plugin);
        assert_eq!(found.items[0].name, "Stop");
        // The agy adapter hands a wrapper document back to the same fallback.
        let found = contents(&crate::adapters::antigravity::Antigravity, &plugin);
        assert_eq!(found.items[0].name, "Stop");
    }

    #[test]
    fn large_packages_are_bounded_and_marked_partial() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("big");
        fs::create_dir_all(root.join("commands")).unwrap();
        for index in 0..(MAX_ITEMS + 5) { fs::write(root.join(format!("commands/c{index:04}.md")), "x").unwrap(); }
        let found = contents(&BareAdapter, &entry(&root, &[("commands", "commands")]));
        assert_eq!(found.items.len(), MAX_ITEMS);
        assert!(found.truncated);
    }

    #[test]
    fn frontmatter_reads_name_and_description_only_from_a_leading_block() {
        assert_eq!(frontmatter("---\nname: a\ndescription: b\n---\nbody"), (Some("a".into()), Some("b".into())));
        assert_eq!(frontmatter("---\r\nname: a\r\n---\r\n"), (Some("a".into()), None));
        assert_eq!(frontmatter("body\n---\nname: a\n---"), (None, None));
        assert_eq!(frontmatter("---\nname: [unclosed\n---"), (None, None));
    }

    #[derive(Default)]
    struct MemoryStore(std::cell::RefCell<std::collections::BTreeMap<String, String>>);
    impl crate::credentials::CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0.borrow().get(id).cloned().ok_or_else(|| "missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(id);
            Ok(())
        }
    }

    fn copy_tree(source: &Path, target: &Path) {
        fs::create_dir_all(target).unwrap();
        for row in fs::read_dir(source).unwrap() {
            let row = row.unwrap();
            let name = row.file_name();
            if row.path().is_dir() {
                copy_tree(&row.path(), &target.join(name));
            } else {
                fs::copy(row.path(), target.join(name)).unwrap();
            }
        }
    }

    /// A committed-fixture agy install under a temp home: the plugin-root
    /// hooks.json is the editable resource and every other bundled file is
    /// not.
    fn agy_install(home: &Path) -> PluginTarget {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/native/antigravity-cli-1.5.9/plugin");
        let installed = home.join(".gemini").join("config").join("plugins").join("probe-kit");
        copy_tree(&fixture, &installed);
        PluginTarget { tool_id: "antigravity".into(), scope: crate::native::adapter::Scope::Global, project_path: None, context_id: None }
    }

    #[test]
    fn plugin_file_edits_are_schema_checked_transacted_and_conflict_detected() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let target = agy_install(home);
        let db = crate::database::Database::open(&home.join("edit.db")).unwrap();
        let store = MemoryStore::default();
        let hooks_path = home.join(".gemini").join("config").join("plugins").join("probe-kit").join("hooks.json");
        let original = fs::read_to_string(&hooks_path).unwrap();
        let target_ref = &target;

        // The committed fixture sample is exactly the editable resource…
        let file = read_file(&db, home, target_ref, "probe-kit", &hooks_path.display().to_string()).unwrap();
        assert!(file.editable, "插件根 hooks.json 应为适配器声明的可编辑资源");
        // …while other bundled files of the same plugin are not.
        let agents_dir = home.join(".gemini").join("config").join("plugins").join("probe-kit").join("agents");
        let agent_file = fs::read_dir(&agents_dir).unwrap().next().unwrap().unwrap().path();
        let file = read_file(&db, home, target_ref, "probe-kit", &agent_file.display().to_string()).unwrap();
        assert!(!file.editable, "未声明的资源不可编辑");

        // A valid edit writes through the shared transaction.
        let edited = original.replace("\"./fixture-hook.sh\"", "\"./renamed-hook.sh\"");
        let outcome = save_file(&db, &store, home, target_ref, "probe-kit", &hooks_path.display().to_string(), &original, &edited, "1.5.9").unwrap();
        assert!(!outcome.changed_files.is_empty());
        assert!(fs::read_to_string(&hooks_path).unwrap().contains("./renamed-hook.sh"));

        // An invalid structure is rejected before any write and the file is
        // unchanged.
        let before = fs::read_to_string(&hooks_path).unwrap();
        let broken = before.replace("\"PostToolUse\"", "\"SessionEnd\"");
        let error = save_file(&db, &store, home, target_ref, "probe-kit", &hooks_path.display().to_string(), &before, &broken, "1.5.9").unwrap_err();
        assert!(error.contains("不支持的事件"), "{error}");
        assert_eq!(fs::read_to_string(&hooks_path).unwrap(), before);
        // Invalid JSON never reaches the file either.
        let error = save_file(&db, &store, home, target_ref, "probe-kit", &hooks_path.display().to_string(), &before, "{not json", "1.5.9").unwrap_err();
        assert!(error.contains("有效 JSON"), "{error}");
        assert_eq!(fs::read_to_string(&hooks_path).unwrap(), before);

        // An external edit elsewhere merges (both changes survive); an
        // external edit of the same region is a conflict that never
        // overwrites the disk file. The external text keeps the original
        // layout and only appends a new hook, so the two edits touch
        // different regions.
        let trimmed = before.trim_end();
        let external = format!(
            "{},\n  \"extra-hook\": {{\"Stop\": []}}\n}}",
            &trimmed[..trimmed.len() - 1]
        );
        fs::write(&hooks_path, &external).unwrap();
        let second = before.replace("\"./renamed-hook.sh\"", "\"./second-hook.sh\"");
        save_file(&db, &store, home, target_ref, "probe-kit", &hooks_path.display().to_string(), &before, &second, "1.5.9").unwrap();
        let merged = fs::read_to_string(&hooks_path).unwrap();
        assert!(merged.contains("./second-hook.sh"), "{merged}");
        assert!(merged.contains("extra-hook"), "{merged}");

        let conflicted = merged.replace("\"./second-hook.sh\"", "\"./external-hook.sh\"");
        fs::write(&hooks_path, &conflicted).unwrap();
        let third = merged.replace("\"./second-hook.sh\"", "\"./third-hook.sh\"");
        let error = save_file(&db, &store, home, target_ref, "probe-kit", &hooks_path.display().to_string(), &merged, &third, "1.5.9").unwrap_err();
        assert!(error.contains("外部修改"), "{error}");
        assert_eq!(fs::read_to_string(&hooks_path).unwrap(), conflicted);

        // The verified-line gate refuses an out-of-range install before
        // touching anything.
        let error = save_file(&db, &store, home, target_ref, "probe-kit", &hooks_path.display().to_string(), &conflicted, &edited, "1.3.1").unwrap_err();
        assert!(error.contains("1.3.1"), "{error}");
        assert_eq!(fs::read_to_string(&hooks_path).unwrap(), conflicted);
    }
}
