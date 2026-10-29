use super::*;

fn codes(text: &str, dir: &str) -> Vec<&'static str> {
    analyze(text, dir).issues.iter().map(|issue| issue.code).collect()
}

fn skill(fields: &str) -> String {
    format!("---\n{fields}\n---\n# Body\n")
}

#[test]
fn folded_and_literal_descriptions_read_as_text() {
    let folded = analyze("---\nname: pdf\ndescription: >\n  Extract PDF text\n  and fill forms.\n---\nbody\n", "pdf");
    assert_eq!(folded.description, "Extract PDF text and fill forms.");
    assert!(folded.issues.is_empty(), "{:?}", folded.issues);
    assert_eq!(folded.body_line, 6);
    let literal = analyze("---\nname: pdf\ndescription: |\n  one\n  two\n---\n", "pdf");
    assert_eq!(literal.description, "one\ntwo");
}

#[test]
fn quoted_and_escaped_values_drop_their_quotes() {
    let manifest = analyze("---\r\nname: \"pdf\"\r\ndescription: \"Say \\\"hi\\\"\\tnow\"\r\nlicense: 'it''s MIT'\r\n---\r\nbody\r\n", "pdf");
    assert_eq!(manifest.name.as_deref(), Some("pdf"));
    assert_eq!(manifest.description, "Say \"hi\"\tnow");
    assert_eq!(manifest.license.as_deref(), Some("it's MIT"));
    assert_eq!(manifest.body_line, 5);
}

#[test]
fn unquoted_colon_values_parse_after_one_compatibility_retry() {
    let manifest = analyze(&skill("name: pdf\ndescription: Use this skill when: the user asks about PDFs"), "pdf");
    assert_eq!(manifest.description, "Use this skill when: the user asks about PDFs");
    assert!(manifest.issues.is_empty(), "{:?}", manifest.issues);
}

#[test]
fn missing_or_broken_frontmatter_never_fails() {
    let bare = analyze("# just markdown\n", "lark-apps");
    assert_eq!(bare.issues.iter().map(|issue| issue.code).collect::<Vec<_>>(), ["frontmatter_missing"]);
    assert_eq!(bare.description, "");
    assert_eq!(bare.body_line, 0);

    let broken = analyze("---\nname: [unclosed\ndescription: x\n---\nbody\n", "x");
    assert_eq!(broken.issues.iter().map(|issue| issue.code).collect::<Vec<_>>(), ["yaml_invalid"]);
    assert!(broken.name.is_none() && broken.description.is_empty());
    assert_eq!(broken.body_line, 0, "an unreadable header leaves the whole file as body");

    assert_eq!(codes("---\nname: x\n", "x"), ["yaml_invalid"], "an unterminated header is not valid");
    assert_eq!(codes("---\n- a\n- b\n---\n", "x"), ["yaml_invalid"], "a header must be a mapping");
}

#[test]
fn optional_fields_metadata_allowed_tools_and_extra_are_reported() {
    let manifest = analyze(&skill("name: pdf-processing\ndescription: Extract PDFs.\nlicense: Apache-2.0\ncompatibility: Requires git\nmetadata:\n  author: example-org\n  version: \"1.0\"\nallowed-tools: Bash(git:*)  Read\ndisable-model-invocation: true"), "pdf-processing");
    assert!(manifest.issues.is_empty(), "{:?}", manifest.issues);
    assert_eq!(manifest.license.as_deref(), Some("Apache-2.0"));
    assert_eq!(manifest.compatibility.as_deref(), Some("Requires git"));
    assert_eq!(manifest.metadata, vec![
        ManifestField { key: "author".into(), value: "example-org".into() },
        ManifestField { key: "version".into(), value: "1.0".into() },
    ]);
    assert_eq!(manifest.allowed_tools, ["Bash(git:*)", "Read"]);
    assert_eq!(manifest.extra, vec![ManifestField { key: "disable-model-invocation".into(), value: "true".into() }]);

    let minimal = analyze(&skill("name: pdf\ndescription: d"), "pdf");
    assert!(minimal.license.is_none() && minimal.metadata.is_empty() && minimal.allowed_tools.is_empty() && minimal.extra.is_empty());
}

#[test]
fn each_single_violation_reports_only_its_issue() {
    for name in ["PDF-Processing", "-pdf", "pdf--processing"] {
        assert_eq!(codes(&skill(&format!("name: {name}\ndescription: d")), name), ["name_invalid"], "{name}");
    }
    let long_name = "a".repeat(65);
    assert_eq!(codes(&skill(&format!("name: {long_name}\ndescription: d")), &long_name), ["name_invalid"]);
    assert_eq!(codes(&skill("name: pdf"), "pdf"), ["description_missing"]);
    assert_eq!(codes(&skill("name: pdf\ndescription:"), "pdf"), ["description_missing"]);
    assert_eq!(codes(&skill("description: d"), "pdf"), ["name_missing"]);
    assert_eq!(codes(&skill("name: other\ndescription: d"), "pdf"), ["name_mismatch"]);

    let description = "d".repeat(1025);
    let manifest = analyze(&skill(&format!("name: pdf\ndescription: {description}")), "pdf");
    assert_eq!(manifest.issues, vec![SkillIssue { code: "description_too_long", limit: Some(1024), actual: Some(1025) }]);
    assert_eq!(codes(&skill(&format!("name: pdf\ndescription: {}", "d".repeat(1024))), "pdf"), Vec::<&str>::new());

    let compatibility = "c".repeat(501);
    let manifest = analyze(&skill(&format!("name: pdf\ndescription: d\ncompatibility: {compatibility}")), "pdf");
    assert_eq!(manifest.issues, vec![SkillIssue { code: "compatibility_too_long", limit: Some(500), actual: Some(501) }]);
    assert_eq!(manifest.compatibility.as_deref(), Some(compatibility.as_str()), "a long requirement is kept, not dropped");
    assert_eq!(codes(&skill("name: pdf\ndescription: d\ncompatibility: \"\""), "pdf"), ["compatibility_empty"]);

    assert_eq!(codes(&skill("name: pdf\ndescription: d\nmetadata:\n  version: 1.0"), "pdf"), ["metadata_invalid"]);
    assert_eq!(codes(&skill("name: pdf\ndescription: d\nmetadata: plain"), "pdf"), ["metadata_invalid"]);
    let numeric = analyze(&skill("name: pdf\ndescription: d\nmetadata:\n  version: 1.0"), "pdf");
    assert_eq!(numeric.metadata, vec![ManifestField { key: "version".into(), value: "1.0".into() }]);

    let body = "line\n".repeat(497);
    let long_file = format!("---\nname: pdf\ndescription: d\n---\n{body}");
    let manifest = analyze(&long_file, "pdf");
    assert_eq!(manifest.issues, vec![SkillIssue { code: "too_many_lines", limit: Some(500), actual: Some(501) }]);
    assert_eq!(codes(&format!("---\nname: pdf\ndescription: d\n---\n{}", "line\n".repeat(496)), "pdf"), Vec::<&str>::new());
}

#[test]
fn mismatched_name_and_empty_description_are_two_issues() {
    assert_eq!(codes("---\nname: other-name\ndescription:\n---\n# page\n", "crud-page"), ["name_mismatch", "description_missing"]);
    assert_eq!(codes("---\nname: Other\ndescription: d\n---\n", "crud-page"), ["name_invalid", "name_mismatch"]);
}

#[test]
fn name_rule_matches_the_specification() {
    assert!(valid_name("pdf-processing") && valid_name("a") && valid_name(&"a".repeat(64)));
    assert!(!valid_name("") && !valid_name(&"a".repeat(65)) && !valid_name("a_b") && !valid_name("é"));
}
