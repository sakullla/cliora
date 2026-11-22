//! Canonical prompt secret reference syntax.
//!
//! A reference is the complete token `{{cliora-secret:<uuid>}}`. Only the exact
//! canonical form is recognized: similar text, other delimiters or a non-UUID
//! payload stay ordinary prompt content. The UUID is stored lowercase so the
//! same secret keeps one reference across edits and platforms.

const OPEN: &str = "{{cliora-secret:";
const CLOSE: &str = "}}";
/// Resolution is bounded so a maximum-size body cannot turn one edit into
/// thousands of credential lookups.
const MAX_REFERENCES: usize = 256;

/// Helpers accept either the id or the complete reference printed by list.
pub fn argument_id(argument: &str) -> Result<String, &'static str> {
    let id = argument.strip_prefix(OPEN).and_then(|token| token.strip_suffix(CLOSE)).unwrap_or(argument);
    uuid::Uuid::parse_str(id).map(|id| id.to_string()).map_err(|_| "需要秘密标识或完整的栖点秘密引用")
}

/// The credential id used for a secret's value. It is derived from the secret id
/// and is never the prompt body or the display alias.
pub fn credential_id(secret_id: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(secret_id).map_err(|_| "秘密标识无效".to_string())?;
    Ok(format!("prompt-secret-{id}"))
}

/// The exact token users insert into a prompt body.
pub fn format(secret_id: &str) -> String {
    let id = uuid::Uuid::parse_str(secret_id)
        .map(|id| id.to_string())
        .unwrap_or_else(|_| secret_id.to_owned());
    format!("{OPEN}{id}{CLOSE}")
}

/// Referenced secret ids in body order, without duplicates. Non-canonical text is
/// ignored so unrelated content keeps working as ordinary prompt text.
pub fn references(body: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find(OPEN) {
        rest = &rest[start + OPEN.len()..];
        let Some(end) = rest.find(CLOSE) else { break };
        let candidate = &rest[..end];
        rest = &rest[end + CLOSE.len()..];
        let Ok(id) = uuid::Uuid::parse_str(candidate) else { continue };
        let id = id.to_string();
        if !found.contains(&id) {
            found.push(id);
            if found.len() == MAX_REFERENCES {
                break;
            }
        }
    }
    found
}
