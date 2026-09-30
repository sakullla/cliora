use std::collections::{BTreeMap, HashSet};

use jsonc_parser::ast::Value as AstValue;
use jsonc_parser::cst::{CstInputValue, CstRootNode};
use jsonc_parser::{parse_to_ast, parse_to_serde_value, CollectOptions, ParseOptions};
use serde_json::{Map, Value};
use toml_edit::{DocumentMut, Item, Table};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileKind {
    Toml,
    Json,
    Jsonc,
}

impl FileKind {
    pub fn for_name(name: &str) -> Result<Self, String> {
        if name.ends_with(".toml") {
            Ok(Self::Toml)
        } else if name.ends_with(".jsonc") {
            Ok(Self::Jsonc)
        } else if name.ends_with(".json") {
            Ok(Self::Json)
        } else {
            Err("不支持的原生文件格式".into())
        }
    }
}

fn options(kind: FileKind) -> ParseOptions {
    ParseOptions {
        allow_comments: kind == FileKind::Jsonc,
        allow_trailing_commas: kind == FileKind::Jsonc,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
        allow_bare_decimal_point_numbers: false,
        allow_non_finite_numbers: false,
        allow_extended_string_escapes: false,
    }
}

fn reject_duplicate_keys(value: &AstValue<'_>) -> Result<(), String> {
    match value {
        AstValue::Object(object) => {
            let mut seen = HashSet::new();
            for prop in &object.properties {
                let name = prop.name.as_str();
                if !seen.insert(name) {
                    return Err(format!("重复的配置键：{name}"));
                }
                reject_duplicate_keys(&prop.value)?;
            }
        }
        AstValue::Array(array) => {
            for element in &array.elements {
                reject_duplicate_keys(element)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn parse(kind: FileKind, text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let value = match kind {
        FileKind::Toml => {
            text.parse::<DocumentMut>()
                .map_err(|e| format!("TOML 格式错误：{e}"))?;
            let parsed: toml::Value =
                toml::from_str(text).map_err(|e| format!("TOML 格式错误：{e}"))?;
            serde_json::to_value(parsed).map_err(|_| "无法解析 TOML 内容".to_string())?
        }
        FileKind::Json | FileKind::Jsonc => {
            let opts = options(kind);
            let ast = parse_to_ast(text, &CollectOptions::default(), &opts)
                .map_err(|e| format!("JSON 格式错误：{e}"))?;
            if let Some(value) = &ast.value {
                reject_duplicate_keys(value)?;
            }
            let parsed: Value =
                parse_to_serde_value(text, &opts).map_err(|e| format!("JSON 格式错误：{e}"))?;
            parsed
        }
    };
    if !value.is_object() {
        return Err("配置文件顶层必须是对象".into());
    }
    Ok(value)
}

fn input_value(value: &Value) -> Result<CstInputValue, String> {
    Ok(match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(v) => CstInputValue::Bool(*v),
        Value::Number(v) => CstInputValue::Number(v.to_string()),
        Value::String(v) => CstInputValue::String(v.clone()),
        Value::Array(items) => {
            CstInputValue::Array(items.iter().map(input_value).collect::<Result<_, _>>()?)
        }
        Value::Object(items) => CstInputValue::Object(
            items
                .iter()
                .map(|(key, value)| Ok((key.clone(), input_value(value)?)))
                .collect::<Result<_, String>>()?,
        ),
    })
}

fn toml_item(value: &Value) -> Result<Item, String> {
    Ok(match value {
        Value::Null => return Err("TOML 不支持 null 值".into()),
        Value::Bool(v) => toml_edit::value(*v),
        Value::String(v) => toml_edit::value(v.as_str()),
        Value::Number(v) if v.is_i64() => toml_edit::value(v.as_i64().unwrap()),
        Value::Number(v) if v.is_u64() => {
            toml_edit::value(i64::try_from(v.as_u64().unwrap()).map_err(|_| "TOML 数字超出范围")?)
        }
        Value::Number(v) => toml_edit::value(v.as_f64().ok_or("无效数字")?),
        Value::Array(items) => {
            if !items.is_empty() && items.iter().all(Value::is_object) {
                let mut array=toml_edit::ArrayOfTables::new();
                for item in items { array.push(toml_item(item)?.as_table().cloned().ok_or("TOML 表数组无效")?); }
                return Ok(Item::ArrayOfTables(array));
            }
            let mut array = toml_edit::Array::new();
            for item in items {
                let converted = toml_item(item)?;
                array.push(converted.as_value().cloned().ok_or("TOML 数组只能包含值")?);
            }
            Item::Value(toml_edit::Value::Array(array))
        }
        Value::Object(items) => {
            let mut table = Table::new();
            for (name, item) in items {
                table.insert(name, toml_item(item)?);
            }
            Item::Table(table)
        }
    })
}

pub fn set_path(
    kind: FileKind,
    text: &str,
    path: &[String],
    value: Option<&Value>,
) -> Result<String, String> {
    if path.is_empty() || path.iter().any(|part| part.is_empty()) {
        return Err("配置字段路径不能为空".into());
    }
    // Never use an invalid file as a blank starting point.
    let existing = parse(kind, text)?;
    let mut parent = &existing;
    for segment in &path[..path.len() - 1] {
        match parent.get(segment) {
            Some(child) if child.is_object() => parent = child,
            Some(_) => return Err("配置路径中存在非对象字段，不能覆盖".into()),
            None if value.is_none() => return Ok(text.to_string()),
            None => break,
        }
    }
    match kind {
        FileKind::Toml => {
            let mut doc: DocumentMut = if text.trim().is_empty() {
                DocumentMut::new()
            } else {
                text.parse().map_err(|e| format!("TOML 格式错误：{e}"))?
            };
            let mut table = doc.as_table_mut();
            for part in &path[..path.len() - 1] {
                if !table.contains_key(part) {
                    table.insert(part, Item::Table(Table::new()));
                }
                table = table
                    .get_mut(part)
                    .and_then(Item::as_table_mut)
                    .ok_or("配置路径不是 TOML 表")?;
            }
            let key = path.last().unwrap();
            match value {
                Some(value) => {
                    table.insert(key, toml_item(value)?);
                }
                None => {
                    table.remove(key);
                }
            }
            let output = doc.to_string();
            parse(kind, &output)?;
            Ok(output)
        }
        FileKind::Json | FileKind::Jsonc => {
            let starting = if text.trim().is_empty() { "{}" } else { text };
            let root = CstRootNode::parse(starting, &options(kind))
                .map_err(|e| format!("JSON 格式错误：{e}"))?;
            let mut object = root.object_value_or_set();
            for part in &path[..path.len() - 1] {
                object = object.object_value_or_set(part);
            }
            let key = path.last().unwrap();
            match value {
                Some(value) => {
                    if let Some(prop) = object.get(key) {
                        prop.set_value(input_value(value)?);
                    } else {
                        object.append(key, input_value(value)?);
                    }
                }
                None => {
                    if let Some(prop) = object.get(key) {
                        prop.remove();
                    }
                }
            }
            let output = root.to_string();
            parse(kind, &output)?;
            Ok(output)
        }
    }
}

/// Rebase independent text edits without rewriting comments or formatting.
/// Overlapping text or same-field changes remain explicit conflicts.
pub fn merge_edits(kind: FileKind, original: &str, edited: &str, current: &str) -> Result<String, String> {
    let before = parse(kind, original)?;
    let own = parse(kind, edited)?;
    let disk = parse(kind, current)?;
    if current == original || current == edited { return Ok(edited.into()); }
    if edited == original { return Ok(current.into()); }
    fn check(base: Option<&Value>, own: Option<&Value>, disk: Option<&Value>, path: &str) -> Result<(), String> {
        if base == own { return Ok(()); }
        if let (Some(Value::Object(a)), Some(Value::Object(b)), Some(Value::Object(c))) = (base, own, disk) {
            for key in a.keys().chain(b.keys()).collect::<std::collections::BTreeSet<_>>() {
                check(a.get(key), b.get(key), c.get(key), &format!("{path}/{key}"))?;
            }
            return Ok(());
        }
        if disk != base && disk != own { return Err(format!("配置字段 {path} 已被外部修改；你的编辑已保留，未覆盖原文件")); }
        Ok(())
    }
    check(Some(&before), Some(&own), Some(&disk), "")?;
    let base: Vec<_> = original.split_inclusive('\n').collect();
    fn region<'a>(base: &[&str], changed: &'a str) -> (usize, usize, Vec<&'a str>) {
        let lines: Vec<_> = changed.split_inclusive('\n').collect();
        let start = base.iter().zip(&lines).take_while(|(a,b)| a == b).count();
        let suffix = base[start..].iter().rev().zip(lines[start..].iter().rev()).take_while(|(a,b)| a == b).count();
        (start, base.len() - suffix, lines[start..lines.len()-suffix].to_vec())
    }
    let mut changes = [region(&base, edited), region(&base, current)];
    changes.sort_by_key(|change| change.0);
    let (a,b) = (&changes[0], &changes[1]);
    if a.1 > b.0 || a.0 == b.0 {
        return Err("配置同一段内容已被外部修改；你的编辑已保留，未覆盖原文件".into());
    }
    let merged = [base[..a.0].concat(), a.2.concat(), base[a.1..b.0].concat(), b.2.concat(), base[b.1..].concat()].concat();
    parse(kind, &merged)?;
    Ok(merged)
}

/// Objects merge by field, arrays and scalars replace. `suppressed` removes inherited fields.
pub fn resolve(
    common: &Value,
    own: &Value,
    suppressed: &[String],
) -> Result<(Value, BTreeMap<String, String>), String> {
    if !common.is_object() || !own.is_object() {
        return Err("配置顶层必须是对象".into());
    }
    let mut sources = BTreeMap::new();
    let mut result = common.clone();
    collect_sources(common, "", "通用配置", &mut sources);
    'suppression: for pointer in suppressed {
        let parts: Vec<&str> = pointer.split('/').filter(|v| !v.is_empty()).collect();
        if let Some((last, parents)) = parts.split_last() {
            let mut cursor = &mut result;
            for parent in parents {
                let Some(next) = cursor.get_mut(*parent) else {
                    continue 'suppression;
                };
                cursor = next;
            }
            if let Some(map) = cursor.as_object_mut() {
                map.remove(*last);
            }
            sources.insert(pointer.clone(), "不应用通用字段".into());
        }
    }
    merge_into(&mut result, own, "", &mut sources);
    Ok((result, sources))
}

fn collect_sources(value: &Value, path: &str, label: &str, output: &mut BTreeMap<String, String>) {
    if let Value::Object(map) = value {
        for (key, value) in map {
            let child = format!("{path}/{key}");
            collect_sources(value, &child, label, output);
        }
    } else {
        output.insert(path.to_string(), label.to_string());
    }
}

fn merge_into(target: &mut Value, own: &Value, path: &str, sources: &mut BTreeMap<String, String>) {
    if let (Value::Object(target_map), Value::Object(own_map)) = (&mut *target, own) {
        for (key, value) in own_map {
            let child = format!("{path}/{key}");
            if let Some(existing) = target_map.get_mut(key) {
                merge_into(existing, value, &child, sources);
            } else {
                target_map.insert(key.clone(), value.clone());
                collect_sources(value, &child, "命名配置", sources);
            }
        }
    } else {
        *target = own.clone();
        sources.retain(|key, _| !key.starts_with(&format!("{path}/")));
        collect_sources(own, path, "命名配置", sources);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn concurrent_edits_merge_separate_fields_and_preserve_native_comments() {
        let original = "# retain comment\nmodel = \"old\"\n\n[ui]\ncompact = false\n";
        let edited = original.replace("\"old\"", "\"new\"");
        let current = original.replace("false", "true");
        let merged = merge_edits(FileKind::Toml, original, &edited, &current).unwrap();
        assert!(merged.contains("# retain comment"));
        assert_eq!(parse(FileKind::Toml, &merged).unwrap(), json!({"model":"new","ui":{"compact":true}}));
        let original = "{\n // user comment\n \"model\": \"old\",\n \"flag\": false\n}\n";
        let merged = merge_edits(FileKind::Jsonc, original, &original.replace("old", "new"), &original.replace("false", "true")).unwrap();
        assert!(merged.contains("// user comment"));
        assert_eq!(parse(FileKind::Jsonc, &merged).unwrap(), json!({"model":"new","flag":true}));
    }

    #[test]
    fn concurrent_overlapping_or_invalid_edits_never_overwrite_either_side() {
        let original = "{\"model\":\"old\",\"flag\":false}";
        assert!(merge_edits(FileKind::Json, original, &original.replace("old", "mine"), &original.replace("old", "theirs")).unwrap_err().contains("model"));
        assert!(merge_edits(FileKind::Json, original, &original.replace("old", "mine"), &original.replace("false", "true")).is_err(), "same-line text changes remain conservatively unresolved");
        assert!(merge_edits(FileKind::Json, original, "{", original).is_err());
        assert!(merge_edits(FileKind::Json, original, "{\"a\":1,\"a\":2}", original).is_err());
        assert_eq!(merge_edits(FileKind::Json, original, original, &original.replace("old", "theirs")).unwrap(), original.replace("old", "theirs"));
    }

    #[test]
    fn jsonc_edit_preserves_comments_and_other_provider() {
        let text = "{\n  // keep me\n  \"provider\": { \"other\": {\"model\": \"old\"} },\n  \"mcp\": {\"a\": 1}\n}";
        let output = set_path(
            FileKind::Jsonc,
            text,
            &["provider".into(), "mine".into(), "model".into()],
            Some(&json!("new")),
        )
        .unwrap();
        assert!(output.contains("// keep me"));
        assert_eq!(
            parse(FileKind::Jsonc, &output)
                .unwrap()
                .pointer("/provider/other/model"),
            Some(&json!("old"))
        );
        assert_eq!(
            parse(FileKind::Jsonc, &output).unwrap().pointer("/mcp/a"),
            Some(&json!(1))
        );
    }

    #[test]
    fn invalid_and_duplicate_json_never_become_empty_config() {
        assert!(parse(FileKind::Json, "{\"a\":1,\"a\":2}").is_err());
        assert!(set_path(FileKind::Json, "{", &["model".into()], Some(&json!("x"))).is_err());
        assert!(parse(FileKind::Json, "{\"a\":1,}").is_err());
    }

    #[test]
    fn inheritance_respects_false_zero_empty_arrays_and_suppression() {
        let common = json!({"model":"a","flag":true,"count":7,"name":"base","items":[1,2]});
        let own = json!({"flag":false,"count":0,"name":"","items":[]});
        let (merged, source) = resolve(&common, &own, &["/model".into()]).unwrap();
        assert_eq!(merged, json!({"flag":false,"count":0,"name":"","items":[]}));
        assert_eq!(source.get("/flag").map(String::as_str), Some("命名配置"));
        let (merged, _) = resolve(
            &json!({"model":"base"}),
            &json!({"model":"own"}),
            &["/model".into()],
        )
        .unwrap();
        assert_eq!(merged["model"], "own");
    }

    #[test]
    fn nested_edit_never_replaces_unrelated_scalar_parent() {
        let original = "{\"provider\": \"manual\"}";
        assert!(set_path(
            FileKind::Json,
            original,
            &["provider".into(), "mine".into()],
            Some(&json!(1))
        )
        .is_err());
        assert_eq!(
            set_path(
                FileKind::Json,
                original,
                &["missing".into(), "child".into()],
                None
            )
            .unwrap(),
            original
        );
    }

    #[test]
    fn versioned_native_fixtures_parse_and_keep_unmanaged_fields() {
        let examples = [
            (
                FileKind::Toml,
                include_str!("../../../tests/fixtures/native/codex-0.158.0.toml"),
                "/features/image_generation",
            ),
            (
                FileKind::Json,
                include_str!("../../../tests/fixtures/native/claude-2.1.283.json"),
                "/customUserField/leave",
            ),
            (
                FileKind::Toml,
                include_str!("../../../tests/fixtures/native/grok-1.0.41.toml"),
                "/ui/compact_mode",
            ),
            (
                FileKind::Jsonc,
                include_str!("../../../tests/fixtures/native/pi-0.87.1-models.jsonc"),
                "/providers/existing/models/0/id",
            ),
            (
                FileKind::Jsonc,
                include_str!("../../../tests/fixtures/native/opencode-1.18.33.jsonc"),
                "/mcp/local/type",
            ),
        ];
        for (kind, source, preserved) in examples {
            let before = parse(kind, source).unwrap();
            let changed =
                set_path(kind, source, &["cliora_test".into()], Some(&json!("new"))).unwrap();
            let after = parse(kind, &changed).unwrap();
            assert_eq!(before.pointer(preserved), after.pointer(preserved));
            assert_eq!(after["cliora_test"], "new");
        }
    }
}
