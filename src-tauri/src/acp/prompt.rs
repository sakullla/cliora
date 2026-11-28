//! What one prompt turn sends: the user's text and its attachments.
//!
//! - An image is sent as an `image` block only when the agent declared the
//!   image prompt capability, within a count and a size limit, and only in a
//!   few common formats. The host checks again what the view already checked.
//! - A file inside the session directory is embedded as a `resource` (its
//!   text) when the agent declared embedded context and the file is small UTF-8
//!   text, and otherwise referenced as a `resource_link`. A file outside the
//!   directory needs the same approval as an agent's own read (`access`), and
//!   Cliora's own data is refused whatever was granted (`safe_fs`).
//!
//! - An image file the user drops on the composer (a desktop drop delivers
//!   paths, not bytes) is read here so the tray can preview it and send it as
//!   an `image` block like a pasted one: same capability, formats and size
//!   limit, the file header must match its extension, and a file outside the
//!   directory needs the same approval.
//!
//! The timeline keeps only labels: image data and file contents never enter
//! the snapshot.

use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::access::AccessKind;
use super::timeline::AcpAttachmentLabel;
use super::{guard, Session};
use crate::safe_fs::{self, Expect};

/// The most images one prompt carries.
pub const MAX_IMAGES: usize = 8;
/// The largest image, decoded.
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// The most files one prompt carries.
pub const MAX_FILES: usize = 32;
/// The largest file embedded as text; anything larger is linked.
pub const MAX_EMBEDDED_BYTES: u64 = 512 * 1024;
/// Image formats an agent is sent.
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// One attachment of a prompt, as the view sends it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AcpAttachment {
    /// Image data the user pasted or dropped.
    Image { mime_type: String, data_base64: String },
    /// A file: absolute, or relative to the session directory.
    File { path: String },
}

/// The media type a file reference announces, for the common text formats.
fn file_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "csv" => "text/csv",
        "xml" => "application/xml",
        "js" | "mjs" | "cjs" | "jsx" => "text/javascript",
        "ts" | "tsx" | "mts" | "cts" => "text/x-typescript",
        "rs" => "text/x-rust",
        "py" => "text/x-python",
        "go" => "text/x-go",
        "sh" => "application/x-sh",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// An image file read for the composer's tray. The view turns it into the
/// same image attachment a paste produces.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpImageFile {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub size: u64,
}

/// The image format a file's extension names, among those an agent is sent.
pub fn image_type_of(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// Whether `bytes` start with the header of `mime`.
pub fn image_header_matches(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn too_large() -> String {
    format!("图片超过 {} MiB 上限", MAX_IMAGE_BYTES / (1024 * 1024))
}

/// A `file://` URI for a path the user knows (no verbatim prefix).
fn file_uri(path: &Path) -> Result<String, String> {
    let display = PathBuf::from(safe_fs::display(path));
    url::Url::from_file_path(&display)
        .map(|url| url.to_string())
        .map_err(|()| "无法为该文件生成地址".to_string())
}

impl Session {
    /// Refuse what can be refused before a turn exists: counts, the image
    /// capability, image formats and sizes, and malformed image data.
    pub(super) fn check_attachments(&self, attachments: &[AcpAttachment]) -> Result<(), String> {
        let images = attachments.iter().filter(|item| matches!(item, AcpAttachment::Image { .. })).count();
        let files = attachments.len() - images;
        if images > MAX_IMAGES {
            return Err(format!("一次最多附带 {MAX_IMAGES} 张图片"));
        }
        if files > 0 && self.remote() { return Err("远程 ACP 不读取本机路径附件".into()); }
        if files > MAX_FILES {
            return Err(format!("一次最多附带 {MAX_FILES} 个文件"));
        }
        if images > 0 && !guard(&self.agent).prompt_capabilities.image {
            return Err("该 agent 没有声明接受图片，不能附带图片".into());
        }
        for attachment in attachments {
            match attachment {
                AcpAttachment::Image { mime_type, data_base64 } => {
                    if !IMAGE_TYPES.contains(&mime_type.as_str()) {
                        return Err("只支持 PNG、JPEG、GIF 或 WebP 图片".into());
                    }
                    // Checked on the encoded length first, so an oversized
                    // payload is never decoded.
                    if data_base64.len() / 4 * 3 > MAX_IMAGE_BYTES + 3 {
                        return Err(format!("图片超过 {} MiB 上限", MAX_IMAGE_BYTES / (1024 * 1024)));
                    }
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data_base64.as_bytes())
                        .map_err(|_| "图片数据无效".to_string())?;
                    if bytes.is_empty() {
                        return Err("图片数据为空".into());
                    }
                    if bytes.len() > MAX_IMAGE_BYTES {
                        return Err(format!("图片超过 {} MiB 上限", MAX_IMAGE_BYTES / (1024 * 1024)));
                    }
                }
                AcpAttachment::File { path } => {
                    if path.trim().is_empty() {
                        return Err("附件文件路径为空".into());
                    }
                }
            }
        }
        Ok(())
    }

    /// The prompt's content blocks and the labels the timeline shows. Runs
    /// under the turn: a file outside the directory waits for its approval.
    pub(super) fn prompt_blocks(
        &self,
        text: &str,
        attachments: &[AcpAttachment],
    ) -> Result<(Vec<Value>, Vec<AcpAttachmentLabel>), String> {
        let mut blocks = Vec::new();
        let mut labels = Vec::new();
        if !text.is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
        let embed = guard(&self.agent).prompt_capabilities.embedded_context;
        for attachment in attachments {
            match attachment {
                AcpAttachment::Image { mime_type, data_base64 } => {
                    blocks.push(json!({ "type": "image", "mimeType": mime_type, "data": data_base64 }));
                    labels.push(AcpAttachmentLabel { kind: "image", name: mime_type.clone(), delivery: None });
                }
                AcpAttachment::File { path } => {
                    let (block, label) = self.file_block(path, embed)?;
                    blocks.push(block);
                    labels.push(label);
                }
            }
        }
        Ok((blocks, labels))
    }

    /// A requested path: absolute, or relative to the session directory.
    fn requested_path(&self, requested: &str) -> PathBuf {
        let given = Path::new(requested);
        // Relative to the directory as the user knows it: a canonical (verbatim)
        // session directory would not accept a joined `/`-separated path.
        let base = PathBuf::from(safe_fs::display(&self.directory));
        if given.is_absolute() {
            given.to_path_buf()
        } else {
            base.join(requested.replace('/', std::path::MAIN_SEPARATOR_STR))
        }
    }

    /// Read an image file the user dropped, for the tray's preview and an
    /// `image` block. Refused, with the reason, when the agent did not declare
    /// images, the format is not one an agent is sent, the header does not
    /// match the extension or the file is over the limit. Everything that can
    /// be refused is refused before an approval card is opened.
    pub(super) fn read_image(&self, requested: &str) -> Result<AcpImageFile, String> {
        if self.remote() { return Err("远程 ACP 不读取本机图片路径".into()); }
        if requested.trim().is_empty() {
            return Err("图片路径为空".into());
        }
        if guard(&self.writer).is_none() {
            return Err("会话已结束".into());
        }
        if !guard(&self.agent).prompt_capabilities.image {
            return Err("该 agent 没有声明接受图片，不能附带图片".into());
        }
        let requested_path = self.requested_path(requested);
        let mime = image_type_of(&requested_path).ok_or("只支持 PNG、JPEG、GIF 或 WebP 图片")?;
        let failed = |error: String| format!("无法附带图片 {requested}：{error}");
        // Size first: nobody is asked about a file that would be refused.
        let target = safe_fs::resolve_target(&self.directory, &requested_path, Expect::File).map_err(failed)?;
        let size = std::fs::metadata(target.path()).map_err(|error| failed(error.to_string()))?.len();
        if size > MAX_IMAGE_BYTES as u64 {
            return Err(too_large());
        }
        let (path, _) = self.approve_user_path(AccessKind::Read, Expect::File, &requested_path, requested).map_err(failed)?;
        let file = std::fs::File::open(&path).map_err(|error| failed(error.to_string()))?;
        // Bounded: a file that grew after the check is still refused.
        let mut bytes = Vec::new();
        file.take(MAX_IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| failed(error.to_string()))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(too_large());
        }
        if bytes.is_empty() {
            return Err("图片文件为空".into());
        }
        if !image_header_matches(mime, &bytes) {
            return Err("文件内容与扩展名不符，不是有效的图片".into());
        }
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or(requested).to_owned();
        Ok(AcpImageFile {
            name,
            mime_type: mime.to_owned(),
            size: bytes.len() as u64,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        })
    }

    /// One file as a content block: embedded text or a link.
    fn file_block(&self, requested: &str, embed: bool) -> Result<(Value, AcpAttachmentLabel), String> {
        let requested_path = self.requested_path(requested);
        let (path, _) = self
            .approve_path(AccessKind::Read, Expect::File, None, &requested_path)
            .map_err(|error| format!("无法附带文件 {requested}：{error}"))?;
        let metadata = std::fs::metadata(&path).map_err(|error| format!("无法读取文件 {requested}：{error}"))?;
        let uri = file_uri(&path)?;
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or(requested).to_owned();
        let shown = safe_fs::canonical_root(&self.directory)
            .ok()
            .and_then(|root| path.strip_prefix(&root).ok().map(|relative| relative.to_string_lossy().replace('\\', "/")))
            .unwrap_or_else(|| safe_fs::display(&path));
        let mime = file_mime(&path);
        if embed && metadata.len() <= MAX_EMBEDDED_BYTES {
            // Only text is embedded; anything else (binary, not UTF-8) is linked.
            if let Ok(text) = safe_fs::read_text(&path, None, None, MAX_EMBEDDED_BYTES) {
                let mut resource = json!({ "uri": uri, "text": text });
                resource["mimeType"] = Value::String(mime.unwrap_or("text/plain").to_owned());
                return Ok((
                    json!({ "type": "resource", "resource": resource }),
                    AcpAttachmentLabel { kind: "file", name: shown, delivery: Some("embedded") },
                ));
            }
        }
        let mut link = json!({ "type": "resource_link", "uri": uri, "name": name, "size": metadata.len() });
        if let Some(mime) = mime {
            link["mimeType"] = Value::String(mime.to_owned());
        }
        Ok((link, AcpAttachmentLabel { kind: "file", name: shown, delivery: Some("link") }))
    }
}
