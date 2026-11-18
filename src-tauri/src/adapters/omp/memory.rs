//! OMP memory: the `memory.backend` selector and the verified `local`
//! Markdown family.
//!
//! Evidence: the published `@oh-my-pi/pi-coding-agent` 18.20.2 sources
//! (`src/memory-backend/settings.ts`, `src/memory-backend/resolve.ts`,
//! `src/memories/index.ts`, `src/memories/settings.ts`, `src/hindsight/*`,
//! `src/mnemopi/config.ts`, `src/sharpshooter/paths.ts`, `@oh-my-pi/pi-utils`
//! `src/dirs.ts`) plus a real isolated `omp/18.20.2` (see
//! `docs/verification/omp-memory.md`).
//!
//! Verified facts:
//! - `memory.backend` is an enum with five values `off`, `local`, `hindsight`,
//!   `mnemopi`, `sharpshooter`; the default is `off`. `memories.enabled` is
//!   only a legacy migration input (`true` -> `local`, `false` -> `off`) used
//!   when `memory.backend` is absent. An unrecognised value makes the runtime
//!   fall back to the default `off` while the raw value stays in `config.yml`.
//! - `local` memory is per project: `<memories dir>/--<cwd with : / \ -> -->--`,
//!   lower-cased on Windows. `<memories dir>` is `<agent dir>/memories`; on
//!   Linux/macOS an initialised `$XDG_STATE_HOME/omp` (or its profile
//!   subdirectory) replaces the agent-dir prefix.
//! - `local` reads `MEMORY.md` and `memory_summary.md` (consolidation output),
//!   `learned.md` (`learn` tool lessons) and generated `skills/<name>/SKILL.md`.
//!   `memory://root` reads the summary, `memory://root/<file>` the others.
//! - `hindsight` keeps a remote bank plus `<agent dir>/hindsight-outbox`;
//!   `mnemopi` is a SQLite database at `<memories dir>/mnemopi/mnemopi.db`;
//!   `sharpshooter` stores per-project decision files and a queue under
//!   `<memories dir>/sharpshooter/<bank>`. None of them is a Markdown memory
//!   entry, so no directory or file is published for them.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::adapters::memory::{
    store_present, MemoryAdapter, MemoryDeclaration, MemoryFileChange, MemoryLayout,
    MemoryLayoutEntry, MemoryOperation, MemoryScope, MemoryStoreRef, MemorySwitchGroup,
    MemorySwitchState, MemoryTargetDimension,
};
use crate::native::adapter::Scope;
use crate::native::format::{self, FileKind};
use crate::native::transaction;

pub(crate) const UNVERIFIED_REASON: &str =
    "OMP 记忆后端（local Markdown、Hindsight 远程 bank、Mnemopi SQLite、Sharpshooter 决策文件）尚未发布";
pub(crate) const AVAILABLE_REASON: &str =
    "可查看 OMP 的 memory.backend 状态，并管理 local 后端 MEMORY.md、memory_summary.md、learned.md；非文件后端保持原生边界";

/// Static explanation for the management surface. The live backend value and
/// every per-backend boundary are reported by the switch group and the switch
/// state, so this text only describes the permanent boundary.
pub(crate) const LIMITATION: &str = "OMP 记忆按项目存放；只有 memory.backend=local 时提供本机 Markdown 管理。MEMORY.md 与 memory_summary.md 由合并流程生成、learned.md 由 learn 工具追加，skills/ 由合并流程生成（Cliora 不编辑生成 Skills）。Hindsight 是远程 bank 与 hindsight-outbox 投递队列，Mnemopi 是本机 SQLite，Sharpshooter 是项目决策文件与队列：都不作为通用 Markdown 记忆读取或编辑；非 local 后端会显示原生状态与磁盘上保留的文件，不会伪装成空的本地记忆。记忆界面的开关只在 local/off 之间切换，其它已验证值请在 OMP 配置或原生 CLI 设置；未识别值只报告、不被覆盖。切换后端只写 memory.backend，不删除、不重建任何记忆文件。";

const GROUP_ID: &str = "memory.backend";
const BACKEND_VALUE: &str = "local";
const BACKEND_OFF: &str = "off";
const CANONICAL_FILES: [(&str, &str); 3] = [
    ("MEMORY", "MEMORY.md"),
    ("learned", "learned.md"),
    ("memory_summary", "memory_summary.md"),
];
const OPERATIONS: &[MemoryOperation] = &[
    MemoryOperation::List,
    MemoryOperation::Open,
    MemoryOperation::Create,
    MemoryOperation::Edit,
    MemoryOperation::MasterSwitch,
];

const SETTINGS_ROLE: &str = "settings";

pub(crate) fn port() -> Option<&'static dyn MemoryAdapter> {
    Some(&MEMORY)
}

/// Descriptor-side reason published only while the memory surface is not
/// available. The owning declaration is published once the port is complete,
/// so this returns the recorded reason only for that unpublished state.
pub(crate) fn management_reason() -> &'static str {
    if crate::adapters::memory::publish(&MEMORY.declaration()).is_some() {
        ""
    } else {
        UNVERIFIED_REASON
    }
}

pub(crate) fn facet() -> crate::adapters::Facet {
    if management_reason().is_empty() {
        crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        }
    } else {
        crate::adapters::Facet {
            state: "planned",
            reason: UNVERIFIED_REASON,
        }
    }
}

pub(crate) static MEMORY: Memory = Memory;

pub(crate) struct Memory;

/// Effective native backend. The raw spelling matters for `Unknown`: it is
/// preserved and never normalised or rewritten.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Backend {
    Off,
    Local,
    Hindsight,
    Mnemopi,
    Sharpshooter,
    Unknown(String),
}

impl Backend {
    fn from_value(value: &str) -> Self {
        match value {
            BACKEND_OFF => Self::Off,
            BACKEND_VALUE => Self::Local,
            "hindsight" => Self::Hindsight,
            "mnemopi" => Self::Mnemopi,
            "sharpshooter" => Self::Sharpshooter,
            _ => Self::Unknown(value.to_owned()),
        }
    }

    fn is_local(&self) -> bool {
        matches!(self, Self::Local)
    }

    /// Human-readable storage boundary for the effective backend.
    fn storage(&self) -> &'static str {
        match self {
            Self::Off => "原生默认 off；本机 Markdown 文件保留但 OMP 不读取",
            Self::Local => "本机 Markdown（MEMORY.md、memory_summary.md、learned.md）",
            Self::Hindsight => {
                "远程 Hindsight bank（另含 hindsight-outbox 投递队列）；本机 Markdown 文件不参与"
            }
            Self::Mnemopi => "本机 Mnemopi SQLite 数据库；不读取本机 Markdown 记忆文件",
            Self::Sharpshooter => "按项目的 Sharpshooter 决策文件与队列；不读取 MEMORY.md 记忆族",
            Self::Unknown(_) => "未核实后端；OMP 18.20.2 忽略该值并使用默认 off",
        }
    }

    /// Native spelling shown in status text. An absent key or a legacy flag is
    /// already folded into the effective value by [`read`].
    fn label(&self) -> String {
        match self {
            Self::Off => BACKEND_OFF.into(),
            Self::Local => BACKEND_VALUE.into(),
            Self::Hindsight => "hindsight".into(),
            Self::Mnemopi => "mnemopi".into(),
            Self::Sharpshooter => "sharpshooter".into(),
            Self::Unknown(value) => value.clone(),
        }
    }

    fn status_detail(&self, home: &Path, legacy: bool) -> String {
        if matches!(self, Self::Local) {
            let mut detail = format!("当前后端：local（{}）", self.storage());
            if legacy {
                detail.push_str("；来自旧版 memories.enabled 迁移");
            }
            detail.push_str(
                "；OMP 直接读取 MEMORY.md、memory_summary.md 与 learned.md，Cliora 对这些文件的编辑会写回原文件",
            );
            detail.push_str("；只管理这三个文件，不编辑生成的 skills/，也不提供删除或单条启停");
            detail.push_str(&local_bank_note(home, true));
            return detail;
        }
        if let Self::Unknown(value) = self {
            return format!(
                "memory.backend 为未核实值 {value}；OMP 18.20.2 会忽略并使用默认 off，Cliora 保留原值不改写；选择“开”会被拒绝，请先在 OMP 原生配置中修复{}",
                local_bank_note(home, false)
            );
        }
        let mut detail = format!("当前后端：{}（{}）", self.label(), self.storage());
        if legacy {
            detail.push_str("；来自旧版 memories.enabled 迁移");
        }
        if matches!(self, Self::Off) {
            detail.push_str("；Cliora 不把磁盘上的旧 Markdown 文件当作当前记忆");
        } else {
            detail.push_str("；该数据由 OMP 原生后端管理，Cliora 不展示为本地 Markdown");
            detail.push_str("；记忆界面的开关只写 local/off，选择“开”会替换当前值");
        }
        detail.push_str(&local_bank_note(home, false));
        detail
    }

    /// Reason an operation is refused while this backend is not `local`.
    fn boundary(&self) -> String {
        format!(
            "OMP 当前记忆后端为 {}（{}）；只有 local 提供本机 Markdown 记忆，Cliora 不把该后端的数据当作通用 Markdown 条目，也不写入本机 Markdown 记忆",
            self.label(),
            self.storage()
        )
    }
}

/// One read of `config.yml`: the file, its exact text (baseline for a write)
/// and the effective backend.
struct Reading {
    path: PathBuf,
    text: String,
    exists: bool,
    backend: Backend,
    legacy: bool,
}

impl Reading {
    fn patch(&self, enabled: bool) -> Result<Option<MemoryFileChange>, String> {
        // Only `local` and `off` are Cliora's own switch values. An unknown
        // native value is never overwritten, not even by an explicit "on":
        // the user must repair it in the native configuration first.
        if let Backend::Unknown(value) = &self.backend {
            if enabled {
                return Err(format!(
                    "memory.backend 为未核实值 {value}；Cliora 不会覆盖未知值，请先在 OMP 原生配置中修复"
                ));
            }
        }
        // Any verified non-local backend is preserved when the switch is
        // turned off; turning it on is an explicit choice that writes `local`.
        if self.backend.is_local() == enabled {
            return Ok(None);
        }
        let target = if enabled { BACKEND_VALUE } else { BACKEND_OFF };
        let contents = if self.text.trim().is_empty() {
            format::render(
                FileKind::Yaml,
                &serde_json::json!({ "memory": { "backend": target } }),
            )
            .map_err(|error| format!("无法保存 OMP memory.backend，请重试：{error}"))?
        } else {
            format::set_path(
                FileKind::Yaml,
                &self.text,
                &["memory".to_owned(), "backend".to_owned()],
                Some(&Value::String(target.to_owned())),
            )
            .map_err(|error| format!("无法保存 OMP memory.backend，请重试：{error}"))?
        };
        if contents == self.text {
            return Ok(None);
        }
        Ok(Some(MemoryFileChange {
            path: self.path.clone(),
            baseline: self.exists.then(|| self.text.clone()),
            contents: Some(contents),
        }))
    }
}

/// The configuration file OMP reads for `memory.backend`. It is the same
/// `config.yml`/`config.yaml` the configuration capability resolves, so the
/// profile, `PI_CONFIG_DIR` and the active account context agree.
fn settings_path(home: &Path) -> Result<PathBuf, String> {
    let files = super::configuration::native_files(Scope::Global, home, None, true);
    files
        .iter()
        .find(|file| file.role == SETTINGS_ROLE)
        .map(|file| PathBuf::from(&file.path))
        .ok_or_else(|| {
            "OMP 记忆根目录未确定：请先修复 OMP_PROFILE / PI_PROFILE / PI_CONFIG_DIR".to_owned()
        })
}

fn agent_root(home: &Path) -> Result<PathBuf, String> {
    let path = settings_path(home)?;
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "OMP 记忆根目录无效".to_owned())
}

/// Read `memory.backend` without normalising or rewriting it. A damaged YAML
/// document is an error: it is never used as a blank starting point.
fn read(home: &Path) -> Result<Reading, String> {
    let path = settings_path(home)?;
    let exists = path.is_file();
    let text = transaction::read_native(&path)
        .map_err(|error| format!("无法读取 OMP memory.backend，请重试：{error}"))?;
    if !exists && !text.is_empty() {
        return Err("OMP config.yml 状态异常；未读取或改写 memory.backend".into());
    }
    let parsed = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        format::parse(FileKind::Yaml, &text).map_err(|_| {
            "OMP config.yml 无法解析；未读取或改写 memory.backend，请先修复原生文件".to_owned()
        })?
    };
    if !parsed.is_object() {
        return Err("OMP config.yml 顶层不是映射；未读取或改写 memory.backend".into());
    }
    let raw = parsed
        .get("memory")
        .and_then(|memory| memory.get("backend"));
    let legacy = parsed
        .get("memories")
        .and_then(|memories| memories.get("enabled"))
        .and_then(Value::as_bool);
    let (backend, legacy) = match raw {
        Some(Value::String(value)) => (Backend::from_value(value), false),
        Some(other) => {
            let raw = serde_json::to_string(other).unwrap_or_default();
            (Backend::Unknown(raw), false)
        }
        None => match legacy {
            Some(true) => (Backend::Local, true),
            Some(false) => (Backend::Off, false),
            None => (Backend::Off, false),
        },
    };
    Ok(Reading {
        path,
        text,
        exists,
        backend,
        legacy,
    })
}

fn backend(home: &Path) -> Result<Backend, String> {
    read(home).map(|reading| reading.backend)
}

/// `getMemoriesDir`: the agent dir, or the initialised XDG state directory on
/// Linux/macOS. The XDG choice only applies while the agent directory is the
/// resolver default; a `PI_CODING_AGENT_DIR` override pins the legacy path.
fn memories_root(
    agent: &Path,
    platform_unix: bool,
    xdg_state: Option<&Path>,
    profile: Option<&str>,
    overridden: bool,
) -> PathBuf {
    if !platform_unix || overridden {
        return agent.join("memories");
    }
    let Some(state) = xdg_state else {
        return agent.join("memories");
    };
    if !state.is_absolute() {
        return agent.join("memories");
    }
    let app = state.join("omp");
    if !app.is_dir() {
        return agent.join("memories");
    }
    match profile {
        Some(name) => {
            let profile_root = app.join("profiles").join(name);
            if profile_root.is_dir() {
                profile_root.join("memories")
            } else {
                agent.join("memories")
            }
        }
        None => app.join("memories"),
    }
}

fn environment_profile() -> Option<String> {
    std::env::var_os("OMP_PROFILE")
        .or_else(|| std::env::var_os("PI_PROFILE"))
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
}

fn environment_coding_agent_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .filter(|value| !value.as_os_str().is_empty())
}

fn memories_dir(home: &Path) -> Result<PathBuf, String> {
    let agent = agent_root(home)?;
    let profile = environment_profile();
    // `PI_CODING_AGENT_DIR` only relocates the default Profile; a named Profile
    // always uses its own agent dir, so the XDG choice still applies there.
    let overridden = profile.is_none() && environment_coding_agent_dir().is_some();
    let xdg_state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|value| !value.as_os_str().is_empty());
    Ok(memories_root(
        &agent,
        cfg!(any(target_os = "linux", target_os = "macos")),
        xdg_state.as_deref(),
        profile.as_deref(),
        overridden,
    ))
}

/// `encodeProjectPath(normalizeScopeCwd(cwd))`: lower-case on Windows, drop a
/// single leading separator and turn `:` `/` `\` into `-`. Windows verbatim
/// paths (`\\?\C:\...`, `\\?\UNC\...`) are folded back to the form OMP's Bun
/// runtime reports as the session cwd; otherwise Cliora's canonicalized project
/// directory would encode a `?` segment OMP never sees.
fn encode_project(project: &Path, windows: bool) -> String {
    let mut text = project.to_string_lossy().into_owned();
    if windows {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            text = format!(r"\\{rest}");
        } else if let Some(rest) = text.strip_prefix(r"\\?\") {
            text = rest.to_owned();
        }
        text = text.to_lowercase();
    }
    let stripped = text
        .strip_prefix('/')
        .or_else(|| text.strip_prefix('\\'))
        .unwrap_or(&text);
    let encoded: String = stripped
        .chars()
        .map(|character| match character {
            ':' | '/' | '\\' => '-',
            other => other,
        })
        .collect();
    format!("--{encoded}--")
}

fn project_root(home: &Path, project: &Path) -> Result<PathBuf, String> {
    let root = memories_dir(home)?;
    Ok(root.join(encode_project(project, cfg!(windows))))
}

/// A local memory bank is one encoded project directory. Anything else under
/// the memories root belongs to another backend (mnemopi/, sharpshooter/) or is
/// not a project bank at all.
fn is_bank_name(name: &str) -> bool {
    // `/` as the project cwd encodes to exactly `----` (length 4), so the
    // minimum is four characters rather than five.
    name.len() >= 4 && name.starts_with("--") && name.ends_with("--")
}

fn local_banks(root: &Path) -> Result<Vec<PathBuf>, String> {
    let read = match fs::read_dir(root) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "无法枚举 OMP local 记忆目录（{}）：{error}",
                root.display()
            ))
        }
    };
    let mut banks = Vec::new();
    for item in read {
        let item = item
            .map_err(|error| format!("无法枚举 OMP local 记忆目录（{}）：{error}", root.display()))?;
        let name = item.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_bank_name(name) {
            continue;
        }
        let directory = item.path();
        // Follow the entry to classify a directory (a junction stays a store
        // and is rejected later by the engine's reparse check, not hidden).
        if store_present(&directory) {
            banks.push(directory);
        }
    }
    banks.sort();
    Ok(banks)
}

/// Disk reality appended to the backend status. An `off`, remote or unknown
/// backend must never look like "no memory": the local Markdown files may still
/// be on disk, untouched and simply not loaded. The active `local` backend gets
/// the opposite phrasing so the same note never claims its own files are
/// unread.
fn local_bank_note(home: &Path, active: bool) -> String {
    let banks = memories_dir(home).and_then(|root| local_banks(&root));
    match banks {
        Ok(banks) if banks.is_empty() && active => {
            "；本机还没有 local Markdown 记忆文件".to_owned()
        }
        Ok(banks) if banks.is_empty() => "；本机没有已落盘的 local Markdown 记忆".to_owned(),
        Ok(banks) if active => format!(
            "；本机有 {} 个项目的 local Markdown 记忆文件",
            banks.len()
        ),
        Ok(banks) => format!(
            "；本机仍有 {} 个项目的 local Markdown 记忆文件，当前后端不读取，Cliora 不删除或重建",
            banks.len()
        ),
        Err(_) => "；无法枚举本机 local Markdown 记忆目录，请修复后重试".to_owned(),
    }
}

/// A store whose directory is not a project bank. Listing it fails with a
/// recoverable error instead of silently looking like an empty store.
fn status_store(directory: PathBuf, label: &str) -> MemoryStoreRef {
    MemoryStoreRef {
        scope: Scope::Project,
        project_path: None,
        label: label.to_owned(),
        directory,
    }
}

fn unavailable_store(home: &Path) -> MemoryStoreRef {
    status_store(
        home.join(".cliora-omp-memory-unavailable"),
        "OMP 记忆根目录无法解析",
    )
}

/// Build local stores from directory entry names. A mid-iteration error keeps
/// every store already found and appends one status store, so one broken root
/// entry cannot hide the valid banks.
fn stores_from_entries(
    root: &Path,
    entries: impl Iterator<Item = std::io::Result<std::ffi::OsString>>,
) -> Vec<MemoryStoreRef> {
    let mut stores = Vec::new();
    for entry in entries {
        let name = match entry {
            Ok(name) => name,
            Err(_) => {
                stores.push(status_store(
                    root.to_path_buf(),
                    "OMP 记忆根目录无法完整枚举",
                ));
                break;
            }
        };
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_bank_name(name) {
            continue;
        }
        let directory = root.join(name);
        if !store_present(&directory) {
            continue;
        }
        stores.push(MemoryStoreRef {
            scope: Scope::Project,
            // The encoded directory name is not invertible (a literal `-` and
            // a separator collapse to the same character), so the store
            // directory itself pins the native location.
            project_path: None,
            label: name.to_owned(),
            directory,
        });
    }
    stores.sort_by(|left, right| left.directory.cmp(&right.directory));
    stores
}

/// Restore the exact prior config text (or remove the fixture file) after a
/// verification case.
fn restore_config(path: &Path, previous: Option<String>) -> Result<(), String> {
    match previous {
        Some(text) => std::fs::write(path, text)
            .map_err(|error| format!("恢复 fixture config.yml 失败：{error}")),
        None => {
            let _ = std::fs::remove_file(path);
            Ok(())
        }
    }
}

fn canonical_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    if !directory
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_bank_name)
    {
        return Err(
            "OMP local 记忆目录未解析为项目存储；请修复配置或 memories 根目录后重试".to_owned(),
        );
    }
    CANONICAL_FILES
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, file)| directory.join(file))
        .ok_or_else(|| {
            "OMP local 记忆只有 MEMORY、memory_summary 与 learned 三个文件；其它文件不会被 OMP 读取".to_owned()
        })
}

fn require_local(home: &Path) -> Result<(), String> {
    let backend = backend(home)?;
    if backend.is_local() {
        Ok(())
    } else {
        Err(backend.boundary())
    }
}

impl MemoryAdapter for Memory {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: false,
                project: true,
            },
            targets: &[MemoryTargetDimension::Project],
            operations: OPERATIONS,
            unverified_reason: "",
            limitation: LIMITATION,
            // The project directory already resolves through the same profile
            // and account context as every other OMP native path.
            binds_account: false,
        }
    }

    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        match scope {
            Scope::Project => {
                let project = project.ok_or("请选择项目目录")?;
                require_local(home)?;
                project_root(home, project)
            }
            Scope::Global => {
                Err("OMP local 记忆按项目存放在 memories 下，没有全局 Markdown 记忆目录".into())
            }
        }
    }

    fn layout(&self) -> Option<&dyn MemoryLayout> {
        Some(self)
    }

    /// Only project banks (`--...--`) are local memory stores. A non-local
    /// backend publishes no store: its data lives in a remote bank, a SQLite
    /// database or a decision-file queue, never in a Markdown family. A backend
    /// or directory error is not an empty store: a status store is returned so
    /// the shared engine reports a recoverable failed source (or the aggregate
    /// carries the backend read error) instead of "no memory".
    fn existing_stores(&self, home: &Path) -> Vec<MemoryStoreRef> {
        let root = match memories_dir(home) {
            Ok(root) => root,
            Err(_) => return vec![unavailable_store(home)],
        };
        match backend(home) {
            Ok(backend) if !backend.is_local() => return Vec::new(),
            Ok(_) => {}
            Err(_) => return vec![status_store(root, "OMP 记忆后端状态无法读取")],
        }
        let read = match fs::read_dir(&root) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(_) => return vec![status_store(root, "OMP 记忆根目录无法枚举")],
        };
        stores_from_entries(
            &root,
            read.map(|item| item.map(|entry| entry.file_name())),
        )
    }
}

impl MemoryLayout for Memory {
    fn entries(&self, directory: &Path) -> Result<Vec<MemoryLayoutEntry>, String> {
        // A status store is never a project bank. Refusing it here keeps a
        // backend/directory error visible as a failed source instead of an
        // empty memory family.
        if !directory
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_bank_name)
        {
            return Err(
                "OMP local 记忆目录未解析为项目存储；请修复配置或 memories 根目录后重试"
                    .to_owned(),
            );
        }
        let read = match fs::read_dir(directory) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("无法列出 OMP local 记忆，请重试".into()),
        };
        let mut entries = Vec::new();
        for item in read {
            let item = item.map_err(|_| "无法列出 OMP local 记忆，请重试".to_owned())?;
            if !item
                .file_type()
                .map_err(|_| "无法列出 OMP local 记忆，请重试".to_owned())?
                .is_file()
            {
                continue;
            }
            let file = item.file_name();
            let Some(file) = file.to_str() else {
                continue;
            };
            let Some((id, _)) = CANONICAL_FILES
                .iter()
                .find(|(_, known)| *known == file)
            else {
                continue;
            };
            entries.push(MemoryLayoutEntry {
                id: (*id).to_owned(),
                path: item.path(),
            });
        }
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(entries)
    }

    fn entry_path(&self, directory: &Path, id: &str) -> Result<PathBuf, String> {
        canonical_path(directory, id)
    }

    /// The consolidation pipeline regenerates MEMORY.md and memory_summary.md
    /// from `raw_memories.md`-style inputs, so there is no entry index to
    /// mirror; learned.md is appended by the `learn` tool.
    fn index_after_save(
        &self,
        _directory: &Path,
        _id: &str,
        _text: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        Ok(None)
    }

    fn index_after_delete(
        &self,
        _directory: &Path,
        _id: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        Ok(None)
    }

    /// One `memory.backend` key governs every project bank.
    fn switch_shared(&self) -> bool {
        true
    }

    fn switch_groups(&self, home: &Path) -> Result<Vec<MemorySwitchGroup>, String> {
        let reading = read(home)?;
        Ok(vec![MemorySwitchGroup {
            id: GROUP_ID.into(),
            scope: Scope::Project,
            enabled: Some(reading.backend.is_local()),
            detail: reading.backend.status_detail(home, reading.legacy),
        }])
    }

    fn switch_group_patch(
        &self,
        home: &Path,
        group: &str,
        enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String> {
        if group != GROUP_ID {
            return Err("未知 OMP 记忆开关".into());
        }
        read(home)?.patch(enabled)
    }

    fn switch_state(&self, home: &Path, _directory: &Path) -> Result<MemorySwitchState, String> {
        let reading = read(home)?;
        let enabled = reading.backend.is_local();
        Ok(MemorySwitchState {
            enabled,
            detail: if enabled {
                String::new()
            } else {
                reading.backend.status_detail(home, reading.legacy)
            },
        })
    }

    fn switch_patch(
        &self,
        home: &Path,
        _directory: &Path,
        enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String> {
        read(home)?.patch(enabled)
    }
}

pub(crate) fn verify_case(
    case: &serde_json::Value,
    context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    use super::verify::CaseError;
    let action = case
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| CaseError::Failed("memory 用例缺少 action".into()))?;
    let mut checks: Vec<(String, bool, String)> = Vec::new();
    match action {
        "layout" => {
            let expect = case
                .get("expect")
                .and_then(Value::as_object)
                .ok_or_else(|| CaseError::Failed("layout 用例缺少 expect".into()))?;
            let placeholder = |value: &str| {
                value
                    .replace(
                        "{home}",
                        &context.home.display().to_string().replace('\\', "/"),
                    )
                    .replace(
                        "{project}",
                        &context.project.display().to_string().replace('\\', "/"),
                    )
            };
            let encoded = encode_project(&context.project, cfg!(windows));
            let expected = expect
                .get("project")
                .and_then(Value::as_str)
                .map(placeholder)
                .map(|value| value.replace("{encoded}", &encoded));
            let actual = project_root(&context.home, &context.project);
            match (actual, expected) {
                (Ok(actual), Some(expected)) => checks.push((
                    "项目记忆目录".into(),
                    actual.display().to_string().replace('\\', "/") == expected.replace('\\', "/"),
                    format!("实际 {}，期望 {expected}", actual.display()),
                )),
                (Ok(actual), None) => checks.push((
                    "项目记忆目录".into(),
                    false,
                    format!("用例没有 project 期望；实际 {}", actual.display()),
                )),
                (Err(error), Some(expected)) => {
                    checks.push(("项目记忆目录".into(), false, format!("期望 {expected}，实际错误 {error}")))
                }
                (Err(error), None) => checks.push(("项目记忆目录".into(), false, error)),
            }
            if let Some(expected) = expect.get("encoding").and_then(Value::as_str) {
                checks.push((
                    "项目目录编码".into(),
                    encoded == expected,
                    format!("实际 {encoded}，期望 {expected}"),
                ));
            }
            let global = Memory.directory(Scope::Global, &context.home, None);
            checks.push((
                "全局作用域不可用".into(),
                global.is_err(),
                global
                    .err()
                    .unwrap_or_else(|| "错误地发布了全局记忆目录".into()),
            ));
            let project = case
                .get("projectPath")
                .and_then(Value::as_str)
                .map(placeholder)
                .map(PathBuf::from)
                .unwrap_or_else(|| context.project.clone());
            for item in case
                .get("inputs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let profile = item.get("profile").and_then(Value::as_str);
                let config_dir = item
                    .get("configDir")
                    .and_then(Value::as_str)
                    .map(placeholder)
                    .map(PathBuf::from);
                let coding = item
                    .get("codingAgentDir")
                    .and_then(Value::as_str)
                    .map(placeholder)
                    .map(PathBuf::from);
                let expected_root = item
                    .get("expect")
                    .and_then(Value::as_str)
                    .map(placeholder)
                    .map(|value| value.replace("{encoded}", &encode_project(&project, cfg!(windows))));
                let expect_error = item
                    .get("expectError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let resolved = super::configuration::resolve_root(
                    &super::configuration::ResolutionInput {
                        home: &context.home,
                        profile,
                        config_dir: config_dir.as_deref(),
                        coding_agent_dir: coding.as_deref(),
                    },
                );
                if expect_error {
                    checks.push((
                        format!("记忆根目录 profile={profile:?} 被拒绝"),
                        resolved.is_err(),
                        resolved
                            .map(|root| root.root.display().to_string())
                            .unwrap_or_default(),
                    ));
                    continue;
                }
                let actual = resolved.map(|root| {
                    memories_root(
                        &root.root,
                        false,
                        None,
                        profile,
                        coding.is_some(),
                    )
                    .join(encode_project(&project, cfg!(windows)))
                });
                match (actual, expected_root) {
                    (Ok(actual), Some(expected)) => checks.push((
                        format!("记忆根目录 profile={profile:?}"),
                        actual.display().to_string().replace('\\', "/")
                            == expected.replace('\\', "/"),
                        format!("实际 {}，期望 {expected}", actual.display()),
                    )),
                    (Ok(actual), None) => checks.push((
                        format!("记忆根目录 profile={profile:?}"),
                        false,
                        format!("用例缺少 expect；实际 {}", actual.display()),
                    )),
                    (Err(error), _) => checks.push((
                        format!("记忆根目录 profile={profile:?}"),
                        false,
                        error,
                    )),
                }
            }
        }
        "backend" => {
            let path = settings_path(&context.home).map_err(CaseError::Failed)?;
            let previous = path.is_file().then(|| std::fs::read_to_string(&path).ok()).flatten();
            let cases = case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| CaseError::Failed("backend 用例缺少 cases".into()))?;
            let project_dir = project_root(&context.home, &context.project)
                .map_err(CaseError::Failed)?;
            let marker = project_dir.join("learned.md");
            let marker_text = "- fixture lesson kept across backend switches\n";
            for item in cases {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("backend case")
                    .to_owned();
                let config = item.get("config").and_then(Value::as_str).unwrap_or_default();
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if config.is_empty() {
                    let _ = std::fs::remove_file(&path);
                } else {
                    std::fs::write(&path, config).map_err(|error| {
                        CaseError::Failed(format!("无法写入 fixture config.yml：{error}"))
                    })?;
                }
                let _ = std::fs::remove_dir_all(&project_dir);
                if item.get("diskFiles").and_then(Value::as_bool) == Some(true) {
                    std::fs::create_dir_all(&project_dir).map_err(|error| {
                        CaseError::Failed(format!("无法创建 fixture 记忆目录：{error}"))
                    })?;
                    std::fs::write(&marker, marker_text)
                        .map_err(|error| CaseError::Failed(format!("无法写入 fixture 记忆：{error}")))?;
                }
                let expected = item.get("expect").and_then(Value::as_object);
                let enabled = expected
                    .and_then(|expect| expect.get("enabled"))
                    .and_then(Value::as_bool);
                let detail_contains = expected
                    .and_then(|expect| expect.get("detailContains"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let state = Memory.switch_state(&context.home, Path::new("/unused"));
                match (enabled, state) {
                    (Some(enabled), Ok(state)) => checks.push((
                        format!("{name}：开关状态"),
                        state.enabled == enabled,
                        format!("实际 {}，期望 {enabled}", state.enabled),
                    )),
                    (Some(_), Err(error)) => {
                        checks.push((format!("{name}：开关状态"), false, error))
                    }
                    (None, Ok(_)) => {}
                    (None, Err(error)) => checks.push((format!("{name}：开关状态"), false, error)),
                }
                if !detail_contains.is_empty() {
                    let groups = Memory.switch_groups(&context.home);
                    let detail = groups
                        .as_ref()
                        .ok()
                        .and_then(|groups| groups.first().map(|group| group.detail.clone()))
                        .unwrap_or_default();
                    checks.push((
                        format!("{name}：状态说明"),
                        detail.contains(detail_contains),
                        format!("实际 {detail}"),
                    ));
                }
                if let Some(enable) = item.get("enable").and_then(Value::as_bool) {
                    // A backend change must never touch memory data.
                    std::fs::create_dir_all(&project_dir).map_err(|error| {
                        CaseError::Failed(format!("无法创建 fixture 记忆目录：{error}"))
                    })?;
                    std::fs::write(&marker, marker_text)
                        .map_err(|error| CaseError::Failed(format!("无法写入 fixture 记忆：{error}")))?;
                    let change = Memory.switch_group_patch(&context.home, GROUP_ID, enable);
                    match change {
                        Ok(Some(change)) => {
                            if let Some(parent) = change.path.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            if let Some(contents) = &change.contents {
                                std::fs::write(&change.path, contents).map_err(|error| {
                                    CaseError::Failed(format!("无法写入 fixture config.yml：{error}"))
                                })?;
                            }
                            let expected_text = item
                                .get("expectFile")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if !expected_text.is_empty() {
                                let written = std::fs::read_to_string(&change.path).unwrap_or_default();
                                checks.push((
                                    format!("{name}：写入 memory.backend"),
                                    written.contains(expected_text),
                                    written.replace('\n', " "),
                                ));
                            }
                        }
                        Ok(None) => checks.push((
                            format!("{name}：无需写入"),
                            item.get("expectNoWrite").and_then(Value::as_bool) == Some(true),
                            "未产生写入".into(),
                        )),
                        Err(error) => checks.push((format!("{name}：写入 memory.backend"), false, error)),
                    }
                    checks.push((
                        format!("{name}：记忆数据保留"),
                        std::fs::read_to_string(&marker).ok().as_deref() == Some(marker_text),
                        marker.display().to_string(),
                    ));
                    let after = Memory.switch_state(&context.home, Path::new("/unused"));
                    let expected_after = item.get("expectBackend").and_then(Value::as_str);
                    if let Some(expected_after) = expected_after {
                        let detail = Memory
                            .switch_groups(&context.home)
                            .ok()
                            .and_then(|groups| groups.first().map(|group| group.detail.clone()))
                            .or_else(|| after.map(|state| state.detail).ok())
                            .unwrap_or_default();
                        checks.push((
                            format!("{name}：切换后后端"),
                            detail.contains(expected_after),
                            detail,
                        ));
                    }
                }
                let patch_off = item.get("patchOff").and_then(Value::as_bool) == Some(true);
                if patch_off {
                    let change = Memory.switch_group_patch(&context.home, GROUP_ID, false);
                    checks.push((
                        format!("{name}：非 local 值保持不变"),
                        change.map(|change| change.is_none()).unwrap_or(false),
                        "关闭非 local 后端不应写入 off".into(),
                    ));
                    let kept = std::fs::read_to_string(&path).unwrap_or_default();
                    checks.push((
                        format!("{name}：原生值未被改写"),
                        kept.contains(
                            item.get("configContains")
                                .and_then(Value::as_str)
                                .unwrap_or("memory"),
                        ),
                        kept.replace('\n', " "),
                    ));
                }
                if item.get("enableError").and_then(Value::as_bool) == Some(true) {
                    let outcome = Memory.switch_group_patch(&context.home, GROUP_ID, true);
                    checks.push((
                        format!("{name}：拒绝覆盖未知值"),
                        outcome.is_err(),
                        outcome
                            .err()
                            .unwrap_or_else(|| "错误地写入了 local".into()),
                    ));
                    let kept = std::fs::read_to_string(&path).unwrap_or_default();
                    checks.push((
                        format!("{name}：未知值在拒绝后仍保留"),
                        kept.contains(
                            item.get("configContains")
                                .and_then(Value::as_str)
                                .unwrap_or("memory"),
                        ),
                        kept.replace('\n', " "),
                    ));
                }
            }
            let _ = std::fs::remove_file(&marker);
            let _ = std::fs::remove_dir_all(&project_dir);
            restore_config(&path, previous).map_err(CaseError::Failed)?;
        }
        "entries" => {
            let project_dir = project_root(&context.home, &context.project)
                .map_err(CaseError::Failed)?;
            let path = settings_path(&context.home).map_err(CaseError::Failed)?;
            let previous = path.is_file().then(|| std::fs::read_to_string(&path).ok()).flatten();
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(
                &path,
                "memory:\n  backend: local\n",
            )
            .map_err(|error| CaseError::Failed(format!("无法写入 fixture config.yml：{error}")))?;
            let expected_ids: Vec<String> = case
                .get("expect")
                .and_then(|expect| expect.get("ids"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let _ = std::fs::remove_dir_all(&project_dir);
            std::fs::create_dir_all(&project_dir)
                .map_err(|error| CaseError::Failed(format!("无法创建 fixture 记忆目录：{error}")))?;
            for file in case
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let target = project_dir.join(file);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| CaseError::Failed(error.to_string()))?;
                }
                std::fs::write(&target, "# fixture\n")
                    .map_err(|error| CaseError::Failed(error.to_string()))?;
            }
            let listed = Memory.entries(&project_dir);
            match listed {
                Ok(entries) => {
                    let ids: Vec<String> = entries.into_iter().map(|entry| entry.id).collect();
                    checks.push((
                        "列出的文件".into(),
                        ids == expected_ids,
                        format!("实际 {ids:?}，期望 {expected_ids:?}"),
                    ));
                }
                Err(error) => checks.push(("列出的文件".into(), false, error)),
            }
            for (id, file) in CANONICAL_FILES {
                let actual = Memory.entry_path(&project_dir, id);
                let expected = project_dir.join(file);
                checks.push((
                    format!("{id} 文件映射"),
                    actual.as_ref().ok().map(PathBuf::as_path) == Some(expected.as_path()),
                    format!("实际 {actual:?}，期望 {}", expected.display()),
                ));
            }
            let foreign = Memory.entry_path(&project_dir, "notes");
            checks.push((
                "未知文件不是 OMP 记忆".into(),
                foreign.is_err(),
                foreign
                    .err()
                    .unwrap_or_else(|| "错误地接受了 notes".into()),
            ));
            let _ = std::fs::remove_dir_all(&project_dir);
            restore_config(&path, previous).map_err(CaseError::Failed)?;
        }
        "boundary" => {
            let project_dir = project_root(&context.home, &context.project)
                .map_err(CaseError::Failed)?;
            let path = settings_path(&context.home).map_err(CaseError::Failed)?;
            let previous = path.is_file().then(|| std::fs::read_to_string(&path).ok()).flatten();
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::create_dir_all(&project_dir)
                .map_err(|error| CaseError::Failed(format!("无法创建 fixture 记忆目录：{error}")))?;
            let marker = project_dir.join("MEMORY.md");
            std::fs::write(&marker, "# preserved\n")
                .map_err(|error| CaseError::Failed(error.to_string()))?;
            for backend in case
                .get("backends")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                std::fs::write(&path, format!("memory:\n  backend: {backend}\n"))
                    .map_err(|error| CaseError::Failed(format!("无法写入 fixture config.yml：{error}")))?;
                let directory = Memory.directory(Scope::Project, &context.home, Some(&context.project));
                checks.push((
                    format!("{backend}：不发布项目目录"),
                    directory
                        .as_ref()
                        .err()
                        .is_some_and(|error| error.contains(backend)),
                    format!("{directory:?}"),
                ));
                checks.push((
                    format!("{backend}：没有本机 Markdown 存储"),
                    Memory.existing_stores(&context.home).is_empty(),
                    "非 local 后端不发布项目存储".into(),
                ));
                let groups = Memory.switch_groups(&context.home);
                let detail = groups
                    .as_ref()
                    .ok()
                    .and_then(|groups| groups.first().map(|group| group.detail.clone()))
                    .unwrap_or_default();
                checks.push((
                    format!("{backend}：状态说明包含原生边界"),
                    detail.contains(backend),
                    detail,
                ));
                checks.push((
                    format!("{backend}：记忆文件保留"),
                    std::fs::read_to_string(&marker).ok().as_deref() == Some("# preserved\n"),
                    marker.display().to_string(),
                ));
            }
            let _ = std::fs::remove_dir_all(&project_dir);
            restore_config(&path, previous).map_err(CaseError::Failed)?;
        }
        other => {
            return Err(CaseError::Failed(format!(
                "未知的 OMP memory 用例 action：{other}；应为 layout/backend/entries/boundary"
            )))
        }
    }
    let failed = checks.iter().any(|(_, passed, _)| !passed);
    Ok(serde_json::json!({
        "action": action,
        "result": {
            "passed": !failed,
            "checks": checks
                .into_iter()
                .map(|(name, passed, detail)| serde_json::json!({ "name": name, "passed": passed, "detail": detail }))
                .collect::<Vec<_>>(),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::memory::MemoryOperation;
    use crate::adapters::Registry;
    use crate::credentials::CredentialStore;
    use crate::resources::memory::{
        list_all_memories, save_memory, set_memory_switch_group, MemorySave, MemoryTarget,
    };
    use std::collections::HashMap;

    struct MapStore(std::sync::Mutex<HashMap<String, String>>);
    impl CredentialStore for MapStore {
        fn put(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn get(&self, key: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or_else(|| "missing".into())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn write_config(home: &Path, text: &str) {
        let path = home.join(".omp").join("agent").join("config.yml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn project_fixture(home: &Path) -> (PathBuf, PathBuf) {
        let project = home.join("work").join("alpha");
        std::fs::create_dir_all(&project).unwrap();
        let root = project_root(home, &project).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        (project, root)
    }

    #[test]
    fn declaration_publishes_the_verified_project_surface() {
        let declaration = MEMORY.declaration();
        assert!(declaration.unverified_reason.is_empty());
        assert!(!declaration.scope.global);
        assert!(declaration.scope.project);
        assert!(!declaration.binds_account);
        assert_eq!(declaration.operations, OPERATIONS);
        assert!(declaration
            .operations
            .contains(&MemoryOperation::MasterSwitch));
        assert!(!declaration
            .operations
            .contains(&MemoryOperation::ItemEnable));
        assert!(!declaration.operations.contains(&MemoryOperation::Delete));
        assert!(declaration.limitation.contains("Hindsight"));
        assert!(declaration.limitation.contains("skills/"));
        assert!(crate::adapters::memory::publish(&declaration).is_some());
        assert_eq!(management_reason(), "");
        assert_eq!(facet().state, "available");
    }

    #[test]
    fn verified_backends_map_to_the_native_enum_and_legacy_flag() {
        assert_eq!(Backend::from_value("off"), Backend::Off);
        assert_eq!(Backend::from_value("local"), Backend::Local);
        assert_eq!(Backend::from_value("hindsight"), Backend::Hindsight);
        assert_eq!(Backend::from_value("mnemopi"), Backend::Mnemopi);
        assert_eq!(
            Backend::from_value("sharpshooter"),
            Backend::Sharpshooter
        );
        assert_eq!(
            Backend::from_value("future"),
            Backend::Unknown("future".into())
        );
        // Case matters: OMP accepts the declared spelling only.
        assert_eq!(
            Backend::from_value("Local"),
            Backend::Unknown("Local".into())
        );
        let temp = tempfile::tempdir().unwrap();
        let detail = Backend::Unknown("future".into()).status_detail(temp.path(), false);
        assert!(detail.contains("未核实值 future"));
        assert!(detail.contains("保留原值"));
        assert!(detail.contains("选择“开”会被拒绝"));
        let detail = Backend::Hindsight.status_detail(temp.path(), false);
        assert!(detail.contains("由 OMP 原生后端管理"));
        assert!(detail.contains("不展示为本地 Markdown"));
        assert!(detail.contains("选择“开”会替换当前值"));
        // The managed family reports its real state, never the other backends'
        // "not local Markdown / not read / will be replaced" clauses.
        let local = Backend::Local.status_detail(temp.path(), true);
        assert!(local.contains("当前后端：local"));
        assert!(local.contains("OMP 直接读取 MEMORY.md、memory_summary.md 与 learned.md"));
        assert!(local.contains("Cliora 对这些文件的编辑会写回原文件"));
        assert!(local.contains("只管理这三个文件"));
        assert!(local.contains("旧版 memories.enabled 迁移"));
        assert!(local.contains("本机还没有 local Markdown 记忆文件"));
        for forbidden in ["不展示为本地 Markdown", "当前后端不读取", "会替换当前值"] {
            assert!(!local.contains(forbidden), "{forbidden}: {local}");
        }
    }

    #[test]
    fn project_root_encodes_like_omp() {
        assert_eq!(
            encode_project(Path::new(r"C:\Users\Me\Project"), true),
            "--c--users-me-project--"
        );
        assert_eq!(
            encode_project(Path::new("/home/me/project"), false),
            "--home-me-project--"
        );
        // The filesystem root is the shortest bank: `----`.
        assert_eq!(encode_project(Path::new("/"), false), "----");
        // A leading separator is stripped exactly once, as OMP does; UNC
        // sessions therefore keep one leading dash for the remaining slash.
        assert_eq!(
            encode_project(Path::new(r"\\server\share"), true),
            "---server-share--"
        );
        // Cliora resolves project directories to Windows verbatim paths; OMP's
        // Bun runtime reports the plain form, so the prefix is folded away.
        assert_eq!(
            encode_project(Path::new(r"\\?\C:\Users\Me\Project"), true),
            "--c--users-me-project--"
        );
        assert_eq!(
            encode_project(Path::new(r"\\?\UNC\server\share"), true),
            "---server-share--"
        );
    }

    #[test]
    fn xdg_state_root_follows_the_verified_resolver() {
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join(".omp").join("agent");
        let state = temp.path().join("state");
        let profiles = state.join("omp").join("profiles").join("work");
        std::fs::create_dir_all(&agent).unwrap();
        // No initialised XDG root: the agent dir is used on every platform.
        assert_eq!(
            memories_root(&agent, true, Some(&state), None, false),
            agent.join("memories")
        );
        std::fs::create_dir_all(state.join("omp")).unwrap();
        assert_eq!(
            memories_root(&agent, true, Some(&state), None, false),
            state.join("omp").join("memories")
        );
        // A named profile only follows its own migrated directory.
        assert_eq!(
            memories_root(&agent, true, Some(&state), Some("work"), false),
            agent.join("memories")
        );
        std::fs::create_dir_all(&profiles).unwrap();
        assert_eq!(
            memories_root(&agent, true, Some(&state), Some("work"), false),
            profiles.join("memories")
        );
        // Windows and a pinned agent directory never take the XDG branch.
        assert_eq!(
            memories_root(&agent, false, Some(&state), None, false),
            agent.join("memories")
        );
        assert_eq!(
            memories_root(&agent, true, Some(&state), None, true),
            agent.join("memories")
        );
        // A relative XDG root is not usable from an arbitrary cwd.
        assert_eq!(
            memories_root(&agent, true, Some(Path::new("relative")), None, false),
            agent.join("memories")
        );
    }

    #[test]
    fn backend_switching_writes_only_the_native_key() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(
            home,
            "memory:\n  backend: local\nretry:\n  attempts: 3\ncustom: keep\n",
        );
        let reading = read(home).unwrap();
        assert!(reading.backend.is_local());
        assert!(reading.patch(true).unwrap().is_none());
        let change = reading.patch(false).unwrap().unwrap();
        assert_eq!(change.path, home.join(".omp").join("agent").join("config.yml"));
        assert_eq!(change.baseline.as_deref(), Some(reading.text.as_str()));
        let contents = change.contents.unwrap();
        assert!(contents.contains("backend: off"));
        assert!(contents.contains("attempts: 3"));
        assert!(contents.contains("custom: keep"));
        std::fs::write(&change.path, &contents).unwrap();
        let after = read(home).unwrap();
        assert_eq!(after.backend, Backend::Off);
        assert!(!after.legacy);
    }

    #[test]
    fn non_local_backends_are_preserved_and_never_replaced_by_off() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        for value in ["hindsight", "mnemopi", "sharpshooter", "future"] {
            write_config(home, &format!("memory:\n  backend: {value}\n"));
            let reading = read(home).unwrap();
            assert!(!reading.backend.is_local());
            assert!(
                reading.patch(false).unwrap().is_none(),
                "{value} must not be replaced by off"
            );
            let detail = reading.backend.status_detail(home, false);
            assert!(detail.contains(value), "{detail}");
            assert_eq!(
                std::fs::read_to_string(&reading.path).unwrap(),
                format!("memory:\n  backend: {value}\n"),
                "{value} raw value must stay untouched"
            );
        }
    }

    #[test]
    fn legacy_memories_enabled_is_the_effective_backend_until_written() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memories:\n  enabled: true\n");
        let reading = read(home).unwrap();
        assert_eq!(reading.backend, Backend::Local);
        assert!(reading.legacy);
        assert!(reading.patch(true).unwrap().is_none());
        let change = reading.patch(false).unwrap().unwrap();
        assert!(change.contents.unwrap().contains("backend: off"));
        // A false legacy flag is simply off.
        write_config(home, "memories:\n  enabled: false\n");
        let reading = read(home).unwrap();
        assert_eq!(reading.backend, Backend::Off);
        assert!(!reading.legacy);
        assert!(reading.patch(false).unwrap().is_none());
    }

    #[test]
    fn damaged_or_non_mapping_config_is_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory: [unterminated\n");
        let path = settings_path(home).unwrap();
        assert!(read(home).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "memory: [unterminated\n"
        );
        assert!(MEMORY.switch_group_patch(home, GROUP_ID, true).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "memory: [unterminated\n"
        );
        std::fs::write(&path, "- a\n- b\n").unwrap();
        assert!(read(home).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "- a\n- b\n");
        assert!(MEMORY
            .switch_group_patch(home, "another.group", true)
            .is_err());
    }

    #[test]
    fn empty_config_gets_a_minimal_memory_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        std::fs::create_dir_all(home.join(".omp").join("agent")).unwrap();
        std::fs::write(home.join(".omp").join("agent").join("config.yml"), "").unwrap();
        let change = MEMORY
            .switch_group_patch(home, GROUP_ID, true)
            .unwrap()
            .unwrap();
        assert_eq!(change.baseline.as_deref(), Some(""));
        let contents = change.contents.unwrap();
        assert!(contents.contains("memory:"));
        assert!(contents.contains("backend: local"));
        let parsed = format::parse(FileKind::Yaml, &contents).unwrap();
        assert_eq!(parsed["memory"]["backend"], "local");
    }

    #[test]
    fn existing_stores_enumerate_only_local_project_banks() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory:\n  backend: local\n");
        let (_, root) = project_fixture(home);
        std::fs::create_dir_all(root.join("skills").join("generated")).unwrap();
        std::fs::create_dir_all(memories_dir(home).unwrap().join("mnemopi")).unwrap();
        std::fs::create_dir_all(memories_dir(home).unwrap().join("sharpshooter")).unwrap();
        let stores = MEMORY.existing_stores(home);
        assert_eq!(stores.len(), 1);
        assert_eq!(stores[0].scope, Scope::Project);
        assert_eq!(stores[0].project_path, None);
        assert_eq!(stores[0].directory, root);
        assert!(stores[0].label.starts_with("--"));
        // A non-local backend publishes no store.
        write_config(home, "memory:\n  backend: hindsight\n");
        assert!(MEMORY.existing_stores(home).is_empty());
    }

    #[test]
    fn mid_iteration_entry_error_keeps_the_stores_already_found() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(root.join("--kept--")).unwrap();
        let entries = vec![
            Ok(std::ffi::OsString::from("--kept--")),
            Err(std::io::Error::other("boom")),
            Ok(std::ffi::OsString::from("--after--")),
        ];
        let stores = stores_from_entries(&root, entries.into_iter());
        assert!(
            stores
                .iter()
                .any(|store| store.directory == root.join("--kept--")),
            "{stores:?}"
        );
        assert!(
            stores
                .iter()
                .any(|store| store.label == "OMP 记忆根目录无法完整枚举"),
            "{stores:?}"
        );
        assert!(
            !stores
                .iter()
                .any(|store| store.directory == root.join("--after--")),
            "entries after the error are not read"
        );
    }

    #[test]
    fn layout_lists_only_the_native_memory_files() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("--fixture-project--");
        std::fs::create_dir_all(directory.join("skills").join("generated")).unwrap();
        for file in ["MEMORY.md", "memory_summary.md", "learned.md", "notes.md", "readme.txt"] {
            std::fs::write(directory.join(file), "# fixture\n").unwrap();
        }
        let entries = MEMORY.entries(&directory).unwrap();
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["MEMORY", "learned", "memory_summary"]);
        assert_eq!(
            MEMORY.entry_path(&directory, "MEMORY").unwrap(),
            directory.join("MEMORY.md")
        );
        assert_eq!(
            MEMORY.entry_path(&directory, "learned").unwrap(),
            directory.join("learned.md")
        );
        assert!(MEMORY.entry_path(&directory, "notes").is_err());
        assert!(MEMORY
            .entries(&temp.path().join("--missing--"))
            .unwrap()
            .is_empty());
        // `/` encodes to the four-character `----`; it is a valid bank.
        let root_bank = temp.path().join("----");
        std::fs::create_dir_all(&root_bank).unwrap();
        std::fs::write(root_bank.join("MEMORY.md"), "# root\n").unwrap();
        let ids: Vec<String> = MEMORY
            .entries(&root_bank)
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert_eq!(ids, ["MEMORY"]);
        assert_eq!(
            MEMORY.entry_path(&root_bank, "MEMORY").unwrap(),
            root_bank.join("MEMORY.md")
        );
        // A non-bank directory is a status store, never an empty family.
        assert!(MEMORY.entries(temp.path()).is_err());
        assert!(MEMORY.entry_path(temp.path(), "MEMORY").is_err());
        assert!(MEMORY
            .index_after_save(&directory, "MEMORY", "text")
            .unwrap()
            .is_none());
        assert!(MEMORY
            .index_after_delete(&directory, "MEMORY")
            .unwrap()
            .is_none());
    }

    #[test]
    fn directory_is_project_only_and_gated_by_the_edited_backend() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory:\n  backend: local\n");
        let (project, root) = project_fixture(home);
        assert_eq!(
            MEMORY
                .directory(Scope::Project, home, Some(&project))
                .unwrap(),
            root
        );
        assert!(MEMORY
            .directory(Scope::Project, home, None)
            .unwrap_err()
            .contains("项目目录"));
        assert!(MEMORY
            .directory(Scope::Global, home, None)
            .unwrap_err()
            .contains("没有全局"));
        write_config(home, "memory:\n  backend: mnemopi\n");
        let error = MEMORY
            .directory(Scope::Project, home, Some(&project))
            .unwrap_err();
        assert!(error.contains("mnemopi"), "{error}");
        assert!(error.contains("Markdown"), "{error}");
    }

    #[test]
    fn unknown_backend_never_accepts_an_enable_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory:\n  backend: future-backend\n");
        let reading = read(home).unwrap();
        let error = reading.patch(true).unwrap_err();
        assert!(error.contains("不会覆盖未知值"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&reading.path).unwrap(),
            "memory:\n  backend: future-backend\n"
        );
        // The off direction stays a no-op and keeps the raw value.
        assert!(reading.patch(false).unwrap().is_none());
        // A verified non-local backend can be replaced by an explicit "on".
        write_config(home, "memory:\n  backend: mnemopi\n");
        let change = read(home).unwrap().patch(true).unwrap().unwrap();
        assert!(change.contents.unwrap().contains("backend: local"));
    }

    #[test]
    fn non_local_status_reports_disk_reality_instead_of_an_empty_family() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory:\n  backend: local\n");
        let (project, root) = project_fixture(home);
        std::fs::write(root.join("MEMORY.md"), "# kept\n").unwrap();
        // The managed family reports its own readable/writable state and never
        // the other backends' "not local Markdown / not read" clauses.
        let local_group = MEMORY.switch_groups(home).unwrap().remove(0);
        assert_eq!(local_group.enabled, Some(true));
        assert!(local_group.detail.contains("本机有 1 个项目的 local Markdown 记忆文件"));
        assert!(local_group.detail.contains("OMP 直接读取 MEMORY.md"));
        for forbidden in ["不展示为本地 Markdown", "当前后端不读取", "会替换当前值"] {
            assert!(!local_group.detail.contains(forbidden), "{forbidden}");
        }
        write_config(home, "memory:\n  backend: off\n");
        let group = MEMORY.switch_groups(home).unwrap().remove(0);
        assert_eq!(group.enabled, Some(false));
        assert!(group.detail.contains("本机仍有 1 个项目的 local Markdown 记忆文件"));
        assert!(group.detail.contains("不把磁盘上的旧 Markdown 文件当作当前记忆"));
        assert!(MEMORY.existing_stores(home).is_empty());
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = Registry::builtins();
        let aggregate = list_all_memories(&db, &registry, home, "omp").unwrap();
        assert!(aggregate.entries.is_empty());
        assert!(aggregate.stores.is_empty());
        assert_eq!(
            aggregate.switch_groups.first().map(|group| group.enabled),
            Some(Some(false))
        );
        assert_eq!(
            std::fs::read_to_string(root.join("MEMORY.md")).unwrap(),
            "# kept\n"
        );
        assert!(!project.exists() || project.is_dir());
        // A verified remote backend adds the same disk note and an explicit
        // replacement warning, while a fresh home reports no local files.
        write_config(home, "memory:\n  backend: hindsight\n");
        let group = MEMORY.switch_groups(home).unwrap().remove(0);
        assert!(group.detail.contains("由 OMP 原生后端管理"));
        assert!(group.detail.contains("本机仍有 1 个项目"));
        std::fs::remove_dir_all(&root).unwrap();
        let group = MEMORY.switch_groups(home).unwrap().remove(0);
        assert!(group.detail.contains("本机没有已落盘的 local Markdown 记忆"));
    }

    #[test]
    fn unreadable_memories_root_is_a_failed_source_not_an_empty_list() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory:\n  backend: local\n");
        let root = memories_dir(home).unwrap();
        std::fs::create_dir_all(root.parent().unwrap()).unwrap();
        // A file where the memories directory belongs makes enumeration fail
        // deterministically on every platform.
        std::fs::write(&root, "not a directory").unwrap();
        let stores = MEMORY.existing_stores(home);
        assert_eq!(stores.len(), 1, "{stores:?}");
        assert_eq!(stores[0].directory, root);
        assert!(MEMORY.entries(&root).is_err());
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = Registry::builtins();
        let aggregate = list_all_memories(&db, &registry, home, "omp").unwrap();
        assert!(aggregate.entries.is_empty());
        assert_eq!(aggregate.failed_sources.len(), 1, "{:?}", aggregate.failed_sources);
        assert!(
            aggregate.failed_sources[0].reason.contains("记忆目录"),
            "{}",
            aggregate.failed_sources[0].reason
        );
    }

    #[cfg(windows)]
    #[test]
    fn one_unreadable_bank_does_not_hide_the_other_stores() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory:\n  backend: local\n");
        let (_, good) = project_fixture(home);
        std::fs::write(good.join("MEMORY.md"), "# kept\n").unwrap();
        let root = memories_dir(home).unwrap();
        let broken = root.join("--broken-project--");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&broken)
            .arg(&outside)
            .status();
        if !status.map(|status| status.success()).unwrap_or(false) {
            // Junction creation is unavailable in this environment; the engine
            // per-store failure path is covered by the shared memory tests.
            return;
        }
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = Registry::builtins();
        let aggregate = list_all_memories(&db, &registry, home, "omp").unwrap();
        assert!(
            aggregate.entries.iter().any(|entry| entry.id == "MEMORY"),
            "{:?}",
            aggregate.entries
        );
        assert_eq!(aggregate.failed_sources.len(), 1, "{:?}", aggregate.failed_sources);
        assert!(
            aggregate
                .failed_sources
                .iter()
                .any(|source| source.reason.contains("重解析点")),
            "{:?}",
            aggregate.failed_sources
        );
        assert!(aggregate.stores.iter().any(|store| store.directory == good.display().to_string()));
    }

    #[test]
    fn damaged_backend_config_blocks_the_aggregate_instead_of_looking_empty() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_config(home, "memory: [unterminated\n");
        let stores = MEMORY.existing_stores(home);
        assert_eq!(stores.len(), 1, "the read error must not become an empty scan");
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = Registry::builtins();
        let error = list_all_memories(&db, &registry, home, "omp").unwrap_err();
        assert!(error.contains("config.yml"), "{error}");
        assert!(MEMORY.switch_groups(home).is_err());
    }

    #[test]
    fn engine_roundtrip_switches_the_backend_without_touching_memory_data() {
        let temp = tempfile::tempdir().unwrap();
        // macOS temp dirs sit behind the /var → /private/var link; saving resolves the
        // project path, so the fixture uses the resolved home as well.
        let home = temp.path().canonicalize().unwrap();
        write_config(&home, "memory:\n  backend: local\n");
        let (project, root) = project_fixture(&home);
        std::fs::write(
            root.join("memory_summary.md"),
            "v1\n\n## Summary\n- old\n",
        )
        .unwrap();
        std::fs::write(root.join("learned.md"), "- lesson\n").unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = Registry::builtins();
        let store = MapStore(std::sync::Mutex::new(HashMap::new()));
        let aggregate = list_all_memories(&db, &registry, &home, "omp").unwrap();
        assert_eq!(aggregate.stores.len(), 1);
        assert!(aggregate.switch_shared);
        let group = aggregate.switch_groups.first().unwrap();
        assert_eq!(group.id, GROUP_ID);
        assert_eq!(group.enabled, Some(true));
        assert!(group.detail.contains("local"));
        let ids: Vec<&str> = aggregate
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(ids, ["learned", "memory_summary"]);
        let target = MemoryTarget {
            tool_id: "omp".into(),
            scope: Scope::Project,
            project_path: Some(project.display().to_string()),
            context_id: None,
            store_directory: None,
        };
        let saved = save_memory(
            &db,
            &store,
            &registry,
            &home,
            &MemorySave {
                target: target.clone(),
                id: "memory_summary".into(),
                text: "v1\n\n## Summary\n- new\n".into(),
                baseline: "v1\n\n## Summary\n- old\n".into(),
                confirm_external: false,
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("memory_summary.md")).unwrap(),
            "v1\n\n## Summary\n- new\n"
        );
        assert!(saved.path.replace('\\', "/").ends_with("/memory_summary.md"));
        // The switch writes the native key and keeps every memory file.
        set_memory_switch_group(
            &db,
            &store,
            &registry,
            &home,
            "omp",
            GROUP_ID,
            false,
        )
        .unwrap();
        let config = std::fs::read_to_string(home.join(".omp").join("agent").join("config.yml"))
            .unwrap();
        assert!(config.contains("backend: off"));
        assert_eq!(
            std::fs::read_to_string(root.join("memory_summary.md")).unwrap(),
            "v1\n\n## Summary\n- new\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("learned.md")).unwrap(),
            "- lesson\n"
        );
        set_memory_switch_group(&db, &store, &registry, &home, "omp", GROUP_ID, true).unwrap();
        let config = std::fs::read_to_string(home.join(".omp").join("agent").join("config.yml"))
            .unwrap();
        assert!(config.contains("backend: local"));
        // No engine-private record may leak into the native memory root.
        for entry in std::fs::read_dir(&root).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(!name.starts_with(".cliora-"), "{name} leaked");
        }
    }
}
