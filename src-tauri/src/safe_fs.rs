//! Shared, product-neutral file primitives for content another program asks
//! Cliora to read or write on its behalf (an ACP agent today).
//!
//! What this module guarantees:
//!
//! - A path is classified against a root *after* both are made canonical, so a
//!   symbolic link, a Windows junction or a `..` that leaves the root is
//!   reported as outside, never as inside.
//! - Paths that name something other than a file on a local disk are refused
//!   before any filesystem call: relative or drive-relative paths, device
//!   namespaces, verbatim and network paths, NTFS alternate data streams and
//!   reserved device names.
//! - Cliora's own data directories (database, credentials, sessions) are
//!   refused whatever the caller was granted, so no grant — not even YOLO — can
//!   make a stored secret readable through these primitives.
//! - Reads require a regular file and valid UTF-8 and are bounded; writes are
//!   atomic replacements in the same directory that keep the original
//!   permissions and report the previous content for a diff.
//!
//! Nothing here knows a product id. Older, scattered helpers elsewhere in the
//! crate are not migrated yet.

use std::ffi::OsString;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Largest file a text read accepts.
pub const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
/// Largest previous content a write keeps for its diff.
pub const MAX_PREVIOUS_BYTES: u64 = 2 * 1024 * 1024;
/// The refusal for anything under a protected directory.
pub const PROTECTED_MESSAGE: &str = "该路径位于 Cliora 自身的数据目录，任何授权下都不允许访问";

static PROTECTED: LazyLock<Mutex<Vec<PathBuf>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Where a path lands relative to a root, by its canonical target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    Inside(PathBuf),
    Outside(PathBuf),
}

impl Resolved {
    pub fn path(&self) -> &Path {
        match self {
            Self::Inside(path) | Self::Outside(path) => path,
        }
    }

    pub fn inside(&self) -> bool {
        matches!(self, Self::Inside(_))
    }
}

/// What a write replaced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteOutcome {
    /// The previous text, when the file existed, was UTF-8 and small enough.
    pub old: Option<String>,
    /// The file existed before the write.
    pub existed: bool,
    /// The file existed but its content was too large or not text, so no diff
    /// can be shown.
    pub old_omitted: bool,
}

/// Register a directory that no grant may reach. The application data
/// directories are registered at start-up.
pub fn protect(root: &Path) {
    let mut roots = PROTECTED.lock().unwrap_or_else(|error| error.into_inner());
    let root = root.to_path_buf();
    if !roots.contains(&root) {
        roots.push(root);
    }
}

/// The protected directories as registered.
pub fn protected_roots() -> Vec<PathBuf> {
    PROTECTED.lock().unwrap_or_else(|error| error.into_inner()).clone()
}

/// Each root as given and in its canonical form, so a canonical target and a
/// path as written are both compared against the same directory.
fn with_canonical(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .flat_map(|root| {
            let canonical = std::fs::canonicalize(root).ok();
            std::iter::once(root.clone()).chain(canonical)
        })
        .collect()
}

/// Whether `path` lies under one of `roots` (or is one of them), comparing
/// with each root's canonical form too.
pub fn is_protected(path: &Path, roots: &[PathBuf]) -> bool {
    with_canonical(roots).iter().any(|root| within(path, root))
}

#[cfg(windows)]
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "conin$", "conout$", "clock$", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Refuse a path that is not an absolute path to a local file before touching
/// the filesystem.
pub fn check_syntax(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy();
    if text.is_empty() || text.len() > 32 * 1024 {
        return Err("路径为空或过长".into());
    }
    if text.chars().any(char::is_control) {
        return Err("路径包含无效字符".into());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        for component in path.components() {
            match component {
                Component::Prefix(prefix) => match prefix.kind() {
                    Prefix::Disk(_) => {}
                    Prefix::DeviceNS(_) => return Err("不支持设备路径".into()),
                    Prefix::UNC(..) | Prefix::VerbatimUNC(..) => return Err("不支持网络共享路径".into()),
                    Prefix::Verbatim(_) | Prefix::VerbatimDisk(_) => return Err("不支持 \\\\?\\ 形式的路径".into()),
                },
                Component::Normal(name) => {
                    let name = name.to_string_lossy();
                    if name.contains(':') {
                        return Err("不支持文件数据流路径".into());
                    }
                    let stem = name.split('.').next().unwrap_or_default().trim_end().to_ascii_lowercase();
                    if RESERVED_NAMES.contains(&stem.as_str()) {
                        return Err("不支持设备名称作为文件名".into());
                    }
                }
                _ => {}
            }
        }
        if matches!(path.components().next(), Some(Component::Prefix(_))) && !path.is_absolute() {
            return Err("请使用完整的盘符路径".into());
        }
    }
    if !path.is_absolute() {
        return Err("只接受绝对路径".into());
    }
    Ok(())
}

/// Component-wise prefix test. Windows paths compare without case.
fn within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let lower = |path: &Path| -> Vec<String> {
            path.components()
                .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
                .collect()
        };
        let path = lower(path);
        let root = lower(root);
        path.len() >= root.len() && path[..root.len()] == root[..]
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

/// The canonical form of a path that may not exist yet: the nearest existing
/// ancestor is made canonical (resolving every link and junction on the way)
/// and the missing tail is appended. A missing tail may only hold plain names:
/// `..` past a component that does not exist cannot be resolved physically.
pub fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    let components: Vec<Component<'_>> = path.components().collect();
    for split in (1..=components.len()).rev() {
        let head: PathBuf = components[..split].iter().collect();
        match std::fs::canonicalize(&head) {
            Ok(mut base) => {
                let tail: Vec<OsString> = components[split..]
                    .iter()
                    .map(|component| match component {
                        Component::Normal(name) => Ok(name.to_os_string()),
                        _ => Err("路径中不存在的部分不能包含 . 或 ..".to_string()),
                    })
                    .collect::<Result<_, _>>()?;
                for name in tail {
                    base.push(name);
                }
                return Ok(base);
            }
            // A missing component, or a file standing where a directory would
            // be, ends the existing part of the path.
            Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => continue,
            Err(error) => return Err(format!("无法解析路径：{error}")),
        }
    }
    Err("无法解析路径：没有可访问的上级目录".into())
}

/// A canonical target that still names a device is refused.
fn check_target(target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if let Some(Component::Prefix(prefix)) = target.components().next() {
            if matches!(prefix.kind(), Prefix::DeviceNS(_) | Prefix::UNC(..) | Prefix::VerbatimUNC(..)) {
                return Err("该路径指向设备或网络位置，不能访问".into());
            }
        }
    }
    #[cfg(not(windows))]
    let _ = target;
    Ok(())
}

/// Canonical root of a session directory.
pub fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(root).map_err(|error| format!("无法解析会话目录：{error}"))
}

/// Classify `path` against `root`. Refused paths (bad syntax, device targets,
/// Cliora's own data) return an error whatever the caller is allowed to do.
pub fn resolve_within(root: &Path, path: &Path) -> Result<Resolved, String> {
    resolve_within_protected(root, path, &protected_roots())
}

/// `resolve_within` with an explicit protected set.
pub fn resolve_within_protected(root: &Path, path: &Path, protected: &[PathBuf]) -> Result<Resolved, String> {
    check_syntax(path)?;
    let root = canonical_root(root)?;
    let target = canonical_target(path)?;
    check_target(&target)?;
    if is_protected(&target, protected) || is_protected(path, protected) {
        return Err(PROTECTED_MESSAGE.into());
    }
    Ok(if within(&target, &root) { Resolved::Inside(target) } else { Resolved::Outside(target) })
}

/// The file must exist and be a regular file (a link is followed first).
fn regular_file(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::metadata(path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => "文件不存在".to_string(),
        _ => format!("无法读取文件信息：{error}"),
    })?;
    if !metadata.is_file() {
        return Err("目标不是普通文件".into());
    }
    Ok(metadata)
}

/// Read a UTF-8 text file, optionally from a 1-based line and for at most
/// `limit` lines. Line endings are kept as they are in the file.
pub fn read_text(path: &Path, line: Option<u64>, limit: Option<u64>, max_bytes: u64) -> Result<String, String> {
    let metadata = regular_file(path)?;
    if metadata.len() > max_bytes {
        return Err(format!("文件超过 {} MiB 读取上限", max_bytes / (1024 * 1024)));
    }
    let bytes = std::fs::read(path).map_err(|error| format!("无法读取文件：{error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?;
    if line.is_none() && limit.is_none() {
        return Ok(text);
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let lines = text.split_inclusive('\n').skip(start);
    Ok(match limit {
        Some(limit) => lines.take(limit as usize).collect(),
        None => lines.collect(),
    })
}

/// Replace a file atomically with `text`: the new content is written to a
/// temporary file in the same directory and renamed over the target, so a
/// reader never sees half a file. The previous permissions are kept.
pub fn write_text_atomic(path: &Path, text: &str) -> Result<WriteOutcome, String> {
    let parent = path.parent().ok_or("目标没有上级目录")?;
    let existing = match std::fs::symlink_metadata(path) {
        Ok(_) => Some(regular_file(path)?),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(format!("无法读取文件信息：{error}")),
    };
    let (old, old_omitted) = match &existing {
        Some(metadata) if metadata.len() <= MAX_PREVIOUS_BYTES => match std::fs::read(path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => (Some(text), false),
                Err(_) => (None, true),
            },
            Err(error) => return Err(format!("无法读取原文件：{error}")),
        },
        Some(_) => (None, true),
        None => (None, false),
    };
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建上级目录：{error}"))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| format!("无法在目标目录创建临时文件：{error}"))?;
    temporary
        .write_all(text.as_bytes())
        .and_then(|()| temporary.flush())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("无法写入临时文件：{error}"))?;
    if let Some(metadata) = &existing {
        std::fs::set_permissions(temporary.path(), metadata.permissions())
            .map_err(|error| format!("无法保留原文件权限：{error}"))?;
    }
    temporary
        .persist(path)
        .map_err(|error| format!("无法替换目标文件：{}", error.error))?;
    Ok(WriteOutcome { old, existed: existing.is_some(), old_omitted })
}

/// A path for display: the verbatim prefix Windows canonicalization adds is
/// dropped so the user reads the path they know.
pub fn display(path: &Path) -> String {
    let text = path.display().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return rest.to_owned();
        }
    }
    text
}

#[cfg(test)]
#[path = "../../tests/launch/safe_fs.rs"]
mod tests;
