//! Reusable prompt contracts. Rules keep the existing library/native distribution behavior.
use crate::database::Database;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_BODY: usize = 1_000_000;
const MAX_INPUT: usize = 8 * 1024 * 1024;
const MAX_BATCH: usize = 2_000;
const MAX_PAGE: usize = 100;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PromptScope {
    #[default]
    Global,
    Workspace {
        workspace_id: String,
    },
    Repository {
        repository_id: String,
    },
    Unresolved {
        legacy_project_id: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptMetadata {
    pub scope: PromptScope,
    pub tags: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptDraft {
    pub id: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub scope: PromptScope,
    #[serde(default)]
    pub tags: Vec<String>,
    pub expected_version: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDocument {
    pub id: String,
    pub title: String,
    pub body: String,
    pub scope: PromptScope,
    pub tags: Vec<String>,
    pub version: u64,
    pub updated_at: u64,
    pub legacy_project_id: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptUsage {
    pub favorite: bool,
    pub last_used: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub scope: PromptScope,
    pub tags: Vec<String>,
    pub version: u64,
    pub updated_at: u64,
    pub favorite: bool,
    pub last_used: u64,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptQuery {
    pub workspace_id: Option<String>,
    pub repository_id: Option<String>,
    pub search: String,
    pub tags: Vec<String>,
    pub scope_filter: Option<PromptScope>,
    pub include_other_scopes: bool,
    pub favorites_only: bool,
    pub recent_only: bool,
    pub offset: usize,
    pub limit: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPage {
    pub items: Vec<PromptSummary>,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub tags: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchAction {
    Create,
    Replace,
    Reclassify,
    Skip,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchItem {
    pub item_id: String,
    pub action: BatchAction,
    pub draft: PromptDraft,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptBatch {
    pub operation_id: String,
    pub items: Vec<BatchItem>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchStatus {
    Saved,
    Skipped,
    Conflict,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemResult {
    pub item_id: String,
    pub status: BatchStatus,
    pub id: Option<String>,
    pub version: Option<u64>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub operation_id: String,
    pub items: Vec<BatchItemResult>,
    pub write_applied: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchReceipt {
    pub input_digest: String,
    pub result: BatchItemResult,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMatch {
    pub id: String,
    pub title: String,
    pub scope: PromptScope,
    pub version: u64,
    pub same_body: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchMatch {
    pub item_id: String,
    pub title: String,
    pub same_body: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub item: BatchItem,
    pub matches: Vec<ImportMatch>,
    pub batch_matches: Vec<ImportBatchMatch>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub operation_id: String,
    pub rows: Vec<ImportRow>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ImportInput {
    pub json_text: String,
    pub files: Vec<String>,
    pub scope: PromptScope,
    pub tags: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportedPrompt {
    title: String,
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    scope: Option<PromptScope>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemotePromptState {
    pub schema_version: u32,
    pub metadata: BTreeMap<String, PromptMetadata>,
    pub receipts: BTreeMap<String, BatchReceipt>,
}
impl Default for RemotePromptState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            metadata: BTreeMap::new(),
            receipts: BTreeMap::new(),
        }
    }
}

fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}
fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
pub fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_secs())
        .unwrap_or(0)
}
pub fn legacy_tags(category: &str) -> Vec<String> {
    category
        .split([',', '，', '、'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
pub fn normalize_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > 80 || tag.chars().any(char::is_control) {
            return Err("标签过长或含控制字符".into());
        }
        if seen.insert(tag.to_lowercase()) {
            result.push(tag.to_owned());
        }
    }
    if result.len() > 32 {
        return Err("标签数量过多，请精简后重试".into());
    }
    Ok(result)
}
/// Legacy categories allowed any trimmed string up to 80 characters, before the
/// new per-tag/count rules. Only preserve vectors representable by that old format.
fn legacy_tag_shape(tags: &[String]) -> bool {
    let category = tags.join(",");
    category.chars().count() <= 80 && legacy_tags(&category) == tags
}
fn normalize_preserving_tags(draft: &PromptDraft, previous: Option<&[String]>) -> Result<PromptDraft, String> {
    if previous.is_some_and(|tags| tags == draft.tags && legacy_tag_shape(tags)) {
        let mut without_tags = draft.clone();
        without_tags.tags.clear();
        let mut normalized = normalize_draft(&without_tags)?;
        normalized.tags = draft.tags.clone();
        Ok(normalized)
    } else {
        normalize_draft(draft)
    }
}
pub fn normalize_draft(draft: &PromptDraft) -> Result<PromptDraft, String> {
    let mut result = draft.clone();
    result.title = result.title.trim().into();
    result.tags = normalize_tags(&result.tags)?;
    if result.title.is_empty() || result.title.chars().count() > 160 {
        return Err("标题需为 1 至 160 个字符".into());
    }
    if result.body.len() > MAX_BODY {
        return Err("正文不能超过 1 MB".into());
    }
    if result
        .expected_version
        .is_some_and(|v| v == 0 || v >= 9_007_199_254_740_991)
    {
        return Err("提示词版本无效".into());
    }
    Ok(result)
}
fn validate_scope(conn: &Connection, scope: &PromptScope) -> Result<(), String> {
    let present = match scope {
        PromptScope::Global => true,
        PromptScope::Workspace { workspace_id } => conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE id=?1)",
                [workspace_id],
                |r| r.get(0),
            )
            .map_err(sql)?,
        PromptScope::Repository { repository_id } => conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_members WHERE repository_id=?1)",
                [repository_id],
                |r| r.get(0),
            )
            .map_err(sql)?,
        PromptScope::Unresolved { .. } => {
            return Err("请先为提示词选择有效范围，未解析归属的正文仍被保留".into())
        }
    };
    if !present {
        return Err("提示词所属项目或仓库已不可用，请重新选择范围".into());
    }
    Ok(())
}
pub fn validate_draft_scope(db: &Database, draft: &PromptDraft) -> Result<(), String> {
    db.with_read_connection(|conn| validate_scope(conn, &draft.scope))
}
pub fn validate_query_context(db: &Database, query: &PromptQuery) -> Result<(), String> {
    if let (Some(workspace), Some(repo)) = (&query.workspace_id, &query.repository_id) {
        let belongs:bool=db.with_read_connection(|conn|conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=?1 AND repository_id=?2)",params![workspace,repo],|r|r.get(0)).map_err(sql))?;
        if !belongs {
            return Err("当前仓库已不属于所选项目，请刷新会话归属".into());
        }
    }
    Ok(())
}
/// Exact legacy IDs resolve through T1's map; no title/path inference and no global fallback.
pub fn ensure_metadata(db: &Database) -> Result<(), String> {
    db.with_connection(|conn|{
        let tx=conn.transaction().map_err(sql)?;
        tx.execute("INSERT INTO prompt_metadata(library_id,scope_json,tags_json) SELECT id,CASE WHEN project_id IS NULL THEN json_object('kind','global') ELSE json_object('kind','unresolved','legacyProjectId',project_id) END,NULL FROM library_items WHERE kind='prompt' ON CONFLICT DO NOTHING",[]).map_err(sql)?;
        let rows={let mut q=tx.prepare("SELECT m.library_id,m.scope_json,m.tags_json,l.category FROM prompt_metadata m JOIN library_items l ON l.id=m.library_id").map_err(sql)?;let rows=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?))).map_err(sql)?;rows.collect::<Result<Vec<_>,_>>().map_err(sql)?};
        for (id,scope_text,tags,category) in rows{
            let scope:PromptScope=serde_json::from_str(&scope_text).map_err(|_|"提示词范围记录损坏，原记录已保留")?;
            let mut next=scope.clone();
            if let PromptScope::Unresolved{legacy_project_id}=&scope{
                let workspace:Option<String>=tx.query_row("SELECT m.workspace_id FROM workspace_legacy_map m JOIN workspace_projects w ON w.id=m.workspace_id WHERE m.project_id=?1",[legacy_project_id],|r|r.get(0)).optional().map_err(sql)?;
                if let Some(workspace_id)=workspace{next=PromptScope::Workspace{workspace_id};}
            }
            if next!=scope||tags.is_none(){let normalized=if let Some(tags)=tags{serde_json::from_str::<Vec<String>>(&tags).map_err(|_|"提示词标签记录损坏")?}else{legacy_tags(&category)};tx.execute("UPDATE prompt_metadata SET scope_json=?2,tags_json=?3 WHERE library_id=?1",params![id,json(&next)?,json(&normalized)?]).map_err(sql)?;}
        }
        tx.commit().map_err(sql)
    })
}
fn metadata(conn: &Connection, id: &str) -> Result<PromptMetadata, String> {
    let (scope, tags): (String, String) = conn
        .query_row(
            "SELECT scope_json,COALESCE(tags_json,'[]') FROM prompt_metadata WHERE library_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    Ok(PromptMetadata {
        scope: serde_json::from_str(&scope).map_err(|_| "提示词范围记录损坏")?,
        tags: serde_json::from_str(&tags).map_err(|_| "提示词标签记录损坏")?,
    })
}
fn document(conn: &Connection, id: &str) -> Result<PromptDocument, String> {
    let mut doc=conn.query_row("SELECT id,title,body,version,updated_at,project_id FROM library_items WHERE id=?1 AND kind='prompt'",[id],|r|Ok(PromptDocument{id:r.get(0)?,title:r.get(1)?,body:r.get(2)?,version:r.get::<_,i64>(3)?.max(0)as u64,updated_at:r.get::<_,i64>(4)?.max(0)as u64,legacy_project_id:r.get(5)?,scope:PromptScope::Global,tags:vec![]})).optional().map_err(sql)?.ok_or("提示词已不存在")?;
    let meta = metadata(conn, id)?;
    doc.scope = meta.scope;
    doc.tags = meta.tags;
    Ok(doc)
}
pub fn get(db: &Database, id: &str, expected: Option<u64>) -> Result<PromptDocument, String> {
    ensure_metadata(db)?;
    db.with_read_connection(|conn| {
        let doc = document(conn, id)?;
        if expected.is_some_and(|v| v != doc.version) {
            return Err("提示词已更新，请重新选择后预览".into());
        }
        Ok(doc)
    })
}
pub fn all_documents(db: &Database) -> Result<Vec<PromptDocument>, String> {
    ensure_metadata(db)?;
    db.with_read_connection(|conn| {
        let mut q = conn
            .prepare("SELECT id FROM library_items WHERE kind='prompt'")
            .map_err(sql)?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        ids.iter().map(|id| document(conn, id)).collect()
    })
}
pub fn export_metadata(db: &Database) -> Result<BTreeMap<String, PromptMetadata>, String> {
    ensure_metadata(db)?;
    db.with_read_connection(|conn| {
        let mut q = conn
            .prepare("SELECT library_id FROM prompt_metadata")
            .map_err(sql)?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        ids.into_iter()
            .map(|id| metadata(conn, &id).map(|meta| (id, meta)))
            .collect()
    })
}
/// Used by versioned portable restore; missing scope targets and valid legacy tag
/// representations are retained for explicit repair. New writes validate before this call.
pub fn restore_metadata(conn: &Connection, id: &str, meta: &PromptMetadata) -> Result<(), String> {
    let tags = if legacy_tag_shape(&meta.tags) { meta.tags.clone() } else { normalize_tags(&meta.tags)? };
    conn.execute("INSERT INTO prompt_metadata(library_id,scope_json,tags_json) VALUES(?1,?2,?3) ON CONFLICT(library_id) DO UPDATE SET scope_json=excluded.scope_json,tags_json=excluded.tags_json",params![id,json(&meta.scope)?,json(&tags)?]).map_err(sql)?;
    Ok(())
}
pub fn usage(db: &Database, host: &str) -> Result<BTreeMap<String, PromptUsage>, String> {
    db.with_read_connection(|conn| {
        let mut q = conn
            .prepare("SELECT prompt_id,favorite,last_used FROM prompt_usage WHERE host_id=?1")
            .map_err(sql)?;
        let rows = q
            .query_map([host], |r| {
                Ok((
                    r.get(0)?,
                    PromptUsage {
                        favorite: r.get(1)?,
                        last_used: r.get::<_, i64>(2)?.max(0) as u64,
                    },
                ))
            })
            .map_err(sql)?;
        rows.collect::<Result<_, _>>().map_err(sql)
    })
}
pub fn record_usage(
    db: &Database,
    host: &str,
    id: &str,
    favorite: Option<bool>,
    used: bool,
) -> Result<(), String> {
    db.with_connection(|conn|{conn.execute("INSERT INTO prompt_usage(host_id,prompt_id,favorite,last_used) VALUES(?1,?2,?3,?4) ON CONFLICT(host_id,prompt_id) DO UPDATE SET favorite=CASE WHEN ?5 THEN excluded.favorite ELSE prompt_usage.favorite END,last_used=CASE WHEN ?6 THEN excluded.last_used ELSE prompt_usage.last_used END",params![host,id,favorite.unwrap_or(false),if used{timestamp()as i64}else{0},favorite.is_some(),used]).map_err(sql)?;Ok(())})
}
pub fn scope_matches(scope: &PromptScope, query: &PromptQuery) -> bool {
    if let Some(filter) = &query.scope_filter {
        return scope == filter;
    }
    query.include_other_scopes
        || match scope {
            PromptScope::Global => true,
            PromptScope::Workspace { workspace_id } => {
                query.workspace_id.as_ref() == Some(workspace_id)
            }
            PromptScope::Repository { repository_id } => {
                query.repository_id.as_ref() == Some(repository_id)
            }
            PromptScope::Unresolved { .. } => false,
        }
}
pub fn query_documents(
    documents: &[PromptDocument],
    usage: &BTreeMap<String, PromptUsage>,
    query: &PromptQuery,
) -> PromptPage {
    let needle = query.search.trim().to_lowercase();
    let mut matches = documents
        .iter()
        .filter(|doc| {
            let used = usage.get(&doc.id).cloned().unwrap_or_default();
            scope_matches(&doc.scope, query)
                && (!query.favorites_only || used.favorite)
                && (!query.recent_only || used.last_used > 0)
                && query
                    .tags
                    .iter()
                    .all(|tag| doc.tags.iter().any(|v| v.eq_ignore_ascii_case(tag)))
                && (needle.is_empty()
                    || doc.title.to_lowercase().contains(&needle)
                    || doc.body.to_lowercase().contains(&needle)
                    || doc
                        .tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&needle)))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| {
        let ua = usage.get(&a.id).cloned().unwrap_or_default();
        let ub = usage.get(&b.id).cloned().unwrap_or_default();
        ub.favorite
            .cmp(&ua.favorite)
            .then(ub.last_used.cmp(&ua.last_used))
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.title.cmp(&b.title))
            .then(a.id.cmp(&b.id))
    });
    let tags: Vec<String> = matches
        .iter()
        .flat_map(|doc| doc.tags.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let total = matches.len();
    let limit = if query.limit == 0 {
        40
    } else {
        query.limit.min(MAX_PAGE)
    };
    let offset = query.offset.min(total);
    let items = matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|doc| {
            let usage = usage.get(&doc.id).cloned().unwrap_or_default();
            PromptSummary {
                id: doc.id.clone(),
                title: doc.title.clone(),
                preview: {
                    let mut preview: String = doc.body.chars().take(160).collect();
                    if doc.body.chars().nth(160).is_some() {
                        preview.push('…');
                    }
                    preview
                },
                scope: doc.scope.clone(),
                tags: doc.tags.clone(),
                version: doc.version,
                updated_at: doc.updated_at,
                favorite: usage.favorite,
                last_used: usage.last_used,
            }
        })
        .collect::<Vec<_>>();
    let next = offset + items.len();
    PromptPage {
        items,
        total,
        next_offset: (next < total).then_some(next),
        tags,
    }
}
pub fn query(db: &Database, query: &PromptQuery) -> Result<PromptPage, String> {
    validate_query_context(db, query)?;
    ensure_metadata(db)?;
    let filter = query.scope_filter.as_ref().map(json).transpose()?;
    let tags = json(&query.tags)?;
    let limit = if query.limit == 0 {
        40
    } else {
        query.limit.min(MAX_PAGE)
    };
    let condition=" FROM library_items l JOIN prompt_metadata m ON m.library_id=l.id LEFT JOIN prompt_usage u ON u.prompt_id=l.id AND u.host_id='local' WHERE l.kind='prompt'
      AND (?1 IS NULL OR m.scope_json=?1)
      AND (?1 IS NOT NULL OR ?2 OR json_extract(m.scope_json,'$.kind')='global'
        OR (json_extract(m.scope_json,'$.kind')='workspace' AND json_extract(m.scope_json,'$.workspaceId')=?3)
        OR (json_extract(m.scope_json,'$.kind')='repository' AND json_extract(m.scope_json,'$.repositoryId')=?4))
      AND (?5='' OR instr(lower(l.title||char(10)||l.body||char(10)||m.tags_json),lower(?5))>0)
      AND NOT EXISTS(SELECT 1 FROM json_each(?6) wanted WHERE NOT EXISTS(SELECT 1 FROM json_each(m.tags_json) present WHERE lower(present.value)=lower(wanted.value)))
      AND (NOT ?7 OR COALESCE(u.favorite,0)=1) AND (NOT ?8 OR COALESCE(u.last_used,0)>0)";
    db.with_read_connection(|conn|{
        let total:i64=conn.query_row(&format!("SELECT count(*){condition}"),params![filter,query.include_other_scopes,query.workspace_id,query.repository_id,query.search.trim(),tags,query.favorites_only,query.recent_only],|r|r.get(0)).map_err(sql)?;
        let total=total.max(0)as usize;let offset=query.offset.min(total);
        let facet_condition=condition.replace(" WHERE l.kind", " JOIN json_each(m.tags_json) facet WHERE l.kind");
        let mut facets=conn.prepare(&format!("SELECT DISTINCT facet.value{facet_condition} ORDER BY facet.value")).map_err(sql)?;
        let tag_rows=facets.query_map(params![filter,query.include_other_scopes,query.workspace_id,query.repository_id,query.search.trim(),tags,query.favorites_only,query.recent_only],|row|row.get::<_,String>(0)).map_err(sql)?;
        let facet_tags=tag_rows.collect::<Result<Vec<_>,_>>().map_err(sql)?;
        let mut statement=conn.prepare(&format!("SELECT l.id,l.title,substr(l.body,1,160)||CASE WHEN length(l.body)>160 THEN '…' ELSE '' END,m.scope_json,m.tags_json,l.version,l.updated_at,COALESCE(u.favorite,0),COALESCE(u.last_used,0){condition} ORDER BY COALESCE(u.favorite,0) DESC,COALESCE(u.last_used,0) DESC,l.updated_at DESC,l.title COLLATE NOCASE,l.id LIMIT ?9 OFFSET ?10")).map_err(sql)?;
        let rows=statement.query_map(params![filter,query.include_other_scopes,query.workspace_id,query.repository_id,query.search.trim(),tags,query.favorites_only,query.recent_only,limit as i64,offset as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,bool>(7)?,r.get::<_,i64>(8)?))).map_err(sql)?;
        let mut items=Vec::new();for row in rows{let(id,title,preview,scope,tags,version,updated_at,favorite,last_used)=row.map_err(sql)?;items.push(PromptSummary{id,title,preview,scope:serde_json::from_str(&scope).map_err(|_|"提示词范围记录损坏")?,tags:serde_json::from_str(&tags).map_err(|_|"提示词标签记录损坏")?,version:version.max(0)as u64,updated_at:updated_at.max(0)as u64,favorite,last_used:last_used.max(0)as u64});}
        let next=offset+items.len();Ok(PromptPage{items,total,next_offset:(next<total).then_some(next),tags:facet_tags})
    })
}

fn save_in(
    tx: &Transaction<'_>,
    draft: &PromptDraft,
    create_id: Option<&str>,
) -> Result<PromptDocument, String> {
    let previous = draft.id.as_ref().map(|id| metadata(tx, id)).transpose()?;
    let draft = normalize_preserving_tags(draft, previous.as_ref().map(|meta| meta.tags.as_slice()))?;
    validate_scope(tx, &draft.scope)?;
    let id = draft
        .id
        .clone()
        .or_else(|| create_id.map(str::to_owned))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let changed = if let Some(version) = draft.expected_version {
        if draft.id.is_none() {
            return Err("修改提示词需要原条目标识".into());
        }
        tx.execute("UPDATE library_items SET title=?2,body=?3,version=version+1,updated_at=?4 WHERE id=?1 AND kind='prompt' AND version=?5",params![id,draft.title,draft.body,timestamp()as i64,version as i64]).map_err(sql)?
    } else {
        if draft.id.is_some() {
            return Err("修改提示词需要原版本，不能覆盖保存".into());
        }
        tx.execute("INSERT INTO library_items(id,kind,title,body,category,project_id,version,updated_at) VALUES(?1,'prompt',?2,?3,'',NULL,1,?4)",params![id,draft.title,draft.body,timestamp()as i64]).map_err(sql)?
    };
    if changed != 1 {
        return Err("提示词已在其他窗口更改，请重新读取后再保存".into());
    }
    restore_metadata(
        tx,
        &id,
        &PromptMetadata {
            scope: draft.scope,
            tags: draft.tags,
        },
    )?;
    document(tx, &id)
}
pub fn save(db: &Database, draft: &PromptDraft) -> Result<PromptDocument, String> {
    ensure_metadata(db)?;
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let doc = save_in(&tx, draft, None)?;
        tx.commit().map_err(sql)?;
        Ok(doc)
    })
}
pub fn validate_batch(batch: &PromptBatch) -> Result<(), String> {
    Uuid::parse_str(&batch.operation_id).map_err(|_| "批次标识无效")?;
    if batch.items.len() > MAX_BATCH {
        return Err("单次批量条目过多，请分批导入".into());
    }
    let mut ids = HashSet::new();
    for item in &batch.items {
        Uuid::parse_str(&item.item_id).map_err(|_| "条目标识无效")?;
        if !ids.insert(&item.item_id) {
            return Err("批次含重复条目标识".into());
        }
    }
    Ok(())
}
pub fn item_digest(item: &BatchItem) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(json(item)?.as_bytes())))
}
fn failed(item: &BatchItem, error: String) -> BatchItemResult {
    BatchItemResult {
        item_id: item.item_id.clone(),
        status: if error.contains("更改") || error.contains("版本") || error.contains("已保存")
        {
            BatchStatus::Conflict
        } else {
            BatchStatus::Failed
        },
        id: item.draft.id.clone(),
        version: None,
        error: Some(error),
    }
}
pub fn replay_receipt(
    item: &BatchItem,
    receipt: Option<&BatchReceipt>,
) -> Result<Option<BatchItemResult>, String> {
    if let Some(receipt) =
        receipt.filter(|r| matches!(r.result.status, BatchStatus::Saved | BatchStatus::Skipped))
    {
        if receipt.input_digest != item_digest(item)? {
            return Err("该批次条目已保存或跳过，请用新批次提交其他修改".into());
        }
        return Ok(Some(receipt.result.clone()));
    }
    Ok(None)
}
fn apply_local_item(
    db: &Database,
    operation: &str,
    item: &BatchItem,
) -> Result<BatchItemResult, String> {
    db.with_connection(|conn|{
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql)?;
        let prior:Option<(String,String)>=tx.query_row("SELECT input_digest,result_json FROM prompt_batch_items WHERE operation_id=?1 AND item_id=?2",params![operation,item.item_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
        let receipt=prior.map(|(input_digest,result)|serde_json::from_str(&result).map(|result|BatchReceipt{input_digest,result})).transpose().map_err(|_|"批次回执无法读取，未重复写入")?;
        if let Some(result)=replay_receipt(item,receipt.as_ref())?{return Ok(result);}
        let result=if item.action==BatchAction::Skip{BatchItemResult{item_id:item.item_id.clone(),status:BatchStatus::Skipped,id:None,version:None,error:None}}else{
            if (item.action==BatchAction::Create&&item.draft.id.is_some())||(matches!(item.action,BatchAction::Replace|BatchAction::Reclassify)&&(item.draft.id.is_none()||item.draft.expected_version.is_none())){return Err("批次操作与目标条目不一致".into());}
            let mut effective=item.draft.clone();
            if item.action==BatchAction::Reclassify{let old=document(&tx,effective.id.as_deref().ok_or("批量归类缺少目标")?)?;effective.title=old.title;effective.body=old.body;}
            let doc=save_in(&tx,&effective,Some(&item.item_id))?;
            BatchItemResult{item_id:item.item_id.clone(),status:BatchStatus::Saved,id:Some(doc.id),version:Some(doc.version),error:None}
        };
        tx.execute("INSERT INTO prompt_batch_items(operation_id,item_id,input_digest,result_json) VALUES(?1,?2,?3,?4) ON CONFLICT(operation_id,item_id) DO UPDATE SET input_digest=excluded.input_digest,result_json=excluded.result_json",params![operation,item.item_id,item_digest(item)?,json(&result)?]).map_err(sql)?;
        tx.commit().map_err(sql)?;Ok(result)
    })
}
pub fn apply_batch(db: &Database, batch: &PromptBatch) -> Result<BatchResult, String> {
    validate_batch(batch)?;
    ensure_metadata(db)?;
    let items = batch
        .items
        .iter()
        .map(|item| {
            apply_local_item(db, &batch.operation_id, item)
                .unwrap_or_else(|error| failed(item, error))
        })
        .collect();
    Ok(BatchResult {
        operation_id: batch.operation_id.clone(),
        items,
        write_applied: true,
    })
}

fn read_import_text(reader: impl Read, remaining: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take(remaining as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("导入文件读取失败：{error}"))?;
    if bytes.len() > remaining {
        return Err("导入内容超过 8 MiB，请分批处理".into());
    }
    String::from_utf8(bytes).map_err(|error| format!("导入文件需为 UTF-8：{error}"))
}

pub fn preview_import(
    input: ImportInput,
    existing: &[PromptDocument],
) -> Result<ImportPreview, String> {
    let mut raw = Vec::new();
    let mut bytes = input.json_text.len();
    if bytes > MAX_INPUT || input.files.len() > MAX_BATCH {
        return Err("导入内容过大，请分批处理".into());
    }
    if !input.json_text.trim().is_empty() {
        raw.extend(
            serde_json::from_str::<Vec<ImportedPrompt>>(&input.json_text)
                .map_err(|e| format!("导入 JSON 需为提示词数组：{e}"))?,
        );
    }
    for file in input.files {
        let path = Path::new(&file);
        let file =
            std::fs::File::open(path).map_err(|error| format!("无法读取 {file}：{error}"))?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        let remaining = MAX_INPUT.saturating_sub(bytes);
        if !metadata.is_file() || metadata.len() > remaining as u64 {
            return Err("导入文件不是普通文本或超过大小限制".into());
        }
        // The open file may grow after metadata was observed; enforce the limit on bytes read.
        let body = read_import_text(file, remaining)?;
        bytes = bytes.saturating_add(body.len());
        match path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "json" => raw.extend(
                serde_json::from_str::<Vec<ImportedPrompt>>(&body)
                    .map_err(|e| format!("JSON 文件需为提示词数组：{e}"))?,
            ),
            "md" | "markdown" | "txt" => raw.push(ImportedPrompt {
                title: path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Prompt")
                    .into(),
                body,
                tags: vec![],
                scope: None,
            }),
            _ => return Err("请选择 JSON、Markdown 或文本文件".into()),
        }
    }
    if bytes > MAX_INPUT || raw.len() > MAX_BATCH {
        return Err("导入内容过大，请分批处理".into());
    }
    let mut rows: Vec<ImportRow> = raw
        .into_iter()
        .map(|entry| {
            let draft = PromptDraft {
                id: None,
                title: entry.title,
                body: entry.body,
                scope: entry.scope.unwrap_or_else(|| input.scope.clone()),
                tags: if entry.tags.is_empty() {
                    input.tags.clone()
                } else {
                    entry.tags
                },
                expected_version: None,
            };
            let normalized = normalize_draft(&draft);
            let error = normalized.as_ref().err().cloned();
            let draft = normalized.unwrap_or(draft);
            let matches = existing
                .iter()
                .filter(|item| {
                    item.title.eq_ignore_ascii_case(&draft.title) || item.body == draft.body
                })
                .map(|item| ImportMatch {
                    id: item.id.clone(),
                    title: item.title.clone(),
                    scope: item.scope.clone(),
                    version: item.version,
                    same_body: item.body == draft.body,
                })
                .collect();
            ImportRow {
                item: BatchItem {
                    item_id: Uuid::new_v4().to_string(),
                    action: BatchAction::Create,
                    draft,
                },
                matches,
                batch_matches: vec![],
                error,
            }
        })
        .collect();
    // Keep incoming matches separate: they have no stored ID/version and cannot be
    // replacement targets. Stable item IDs still let users keep copies or skip rows.
    let keys: Vec<_> = rows.iter().map(|row| (
        row.item.draft.title.to_ascii_lowercase(),
        format!("{:x}", Sha256::digest(row.item.draft.body.as_bytes())),
    )).collect();
    let mut titles: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut bodies: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, (title, body)) in keys.iter().enumerate() {
        titles.entry(title).or_default().push(index);
        bodies.entry(body).or_default().push(index);
    }
    for (index, (title, body)) in keys.iter().enumerate() {
        // A bounded sample is sufficient to flag duplicates without returning millions
        // of repeated matches when a maximum-sized import contains identical entries.
        let mut seen = HashSet::new();
        rows[index].batch_matches = titles[title.as_str()].iter().take(9)
            .chain(bodies[body.as_str()].iter().take(9))
            .filter(|&&other| other != index && seen.insert(other))
            .take(8).map(|&other| ImportBatchMatch {
                item_id: rows[other].item.item_id.clone(), title: rows[other].item.draft.title.clone(),
                same_body: rows[other].item.draft.body == rows[index].item.draft.body,
            }).collect();
    }
    Ok(ImportPreview {
        operation_id: Uuid::new_v4().to_string(),
        rows,
    })
}

pub fn remote_document(
    item: &crate::library::LibraryItem,
    state: &RemotePromptState,
) -> PromptDocument {
    let meta = state
        .metadata
        .get(&item.id)
        .cloned()
        .unwrap_or_else(|| PromptMetadata {
            scope: item
                .project_id
                .as_ref()
                .map(|id| PromptScope::Unresolved {
                    legacy_project_id: id.clone(),
                })
                .unwrap_or_default(),
            tags: legacy_tags(&item.category),
        });
    PromptDocument {
        id: item.id.clone(),
        title: item.title.clone(),
        body: item.body.clone(),
        scope: meta.scope,
        tags: meta.tags,
        version: item.version,
        updated_at: item.updated_at,
        legacy_project_id: item.project_id.clone(),
    }
}
pub fn apply_remote_item(
    items: &mut Vec<crate::library::LibraryItem>,
    state: &mut RemotePromptState,
    operation: &str,
    item: &BatchItem,
) -> Result<BatchItemResult, String> {
    if state.schema_version != 1 {
        return Err("远程提示词格式版本不受支持，未写入".into());
    }
    let key = format!("{operation}:{}", item.item_id);
    if let Some(result) = replay_receipt(item, state.receipts.get(&key))? {
        return Ok(result);
    }
    let result = if item.action == BatchAction::Skip {
        BatchItemResult {
            item_id: item.item_id.clone(),
            status: BatchStatus::Skipped,
            id: None,
            version: None,
            error: None,
        }
    } else {
        let mut effective = item.draft.clone();
        if item.action == BatchAction::Reclassify {
            let old = items
                .iter()
                .find(|old| {
                    Some(&old.id) == effective.id.as_ref()
                        && old.kind == crate::library::LibraryKind::Prompt
                })
                .ok_or("提示词已不存在")?;
            effective.title = old.title.clone();
            effective.body = old.body.clone();
        }
        let previous = items.iter().find(|old| Some(&old.id) == effective.id.as_ref()
            && old.kind == crate::library::LibraryKind::Prompt)
            .map(|old| remote_document(old, state));
        let draft = normalize_preserving_tags(&effective, previous.as_ref().map(|old| old.tags.as_slice()))?;
        if (item.action == BatchAction::Create && draft.id.is_some())
            || (matches!(item.action, BatchAction::Replace | BatchAction::Reclassify)
                && (draft.id.is_none() || draft.expected_version.is_none()))
        {
            return Err("批次操作与目标条目不一致".into());
        }
        let saved = if let Some(id) = &draft.id {
            let stored = items
                .iter_mut()
                .find(|i| &i.id == id && i.kind == crate::library::LibraryKind::Prompt)
                .ok_or("提示词已不存在")?;
            if draft.expected_version != Some(stored.version) {
                return Err("提示词已在其他窗口更改，请重新读取后再保存".into());
            }
            stored.title = draft.title;
            stored.body = draft.body;
            stored.version += 1;
            stored.updated_at = timestamp();
            stored.clone()
        } else {
            if items.iter().any(|i| i.id == item.item_id) {
                return Err("提示词标识已存在，缺少已确认回执，未重复写入".into());
            }
            let stored = crate::library::LibraryItem {
                id: item.item_id.clone(),
                kind: crate::library::LibraryKind::Prompt,
                title: draft.title,
                body: draft.body,
                category: String::new(),
                project_id: None,
                version: 1,
                updated_at: timestamp(),
            };
            items.push(stored.clone());
            stored
        };
        state.metadata.insert(
            saved.id.clone(),
            PromptMetadata {
                scope: draft.scope,
                tags: draft.tags,
            },
        );
        BatchItemResult {
            item_id: item.item_id.clone(),
            status: BatchStatus::Saved,
            id: Some(saved.id),
            version: Some(saved.version),
            error: None,
        }
    };
    state.receipts.insert(
        key,
        BatchReceipt {
            input_digest: item_digest(item)?,
            result: result.clone(),
        },
    );
    Ok(result)
}
pub fn remote_failure(item: &BatchItem, error: String) -> BatchItemResult {
    failed(item, error)
}

#[cfg(test)]
#[path = "../../tests/resources/prompts.rs"]
mod tests;
