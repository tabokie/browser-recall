use browser_recall_replay::entities::ListEntity;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[cfg(all(feature = "javascript-list-rules", not(feature = "mac-app-store")))]
mod javascript;
#[cfg(all(feature = "javascript-list-rules", not(feature = "mac-app-store")))]
pub use javascript::{validate_fn_rule_source, ValidationResult};

pub const JAVASCRIPT_LIST_RULES_ENABLED: bool = cfg!(all(
    feature = "javascript-list-rules",
    not(feature = "mac-app-store")
));
pub const JAVASCRIPT_RULE_UNAVAILABLE: &str = "JavaScript list rules are unavailable in this build";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageData {
    pub title: Option<String>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleSpec {
    pub rule_type: String,
    pub config: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuleMatch {
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    pub r#match: bool,
}

pub fn page_data_from_raw_entry(entry: &Value) -> Result<PageData, String> {
    let object = entry
        .as_object()
        .ok_or_else(|| "Rule page data must be an object".to_string())?;
    let url = object
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Rule page data requires a string url".to_string())?
        .to_string();
    let title = match object.get("title") {
        Some(Value::String(title)) => Some(title.clone()),
        Some(Value::Null) => None,
        Some(_) | None => return Err("Rule page data requires a string or null title".to_string()),
    };
    if object.contains_key("body") {
        return Err("Rule page data does not accept legacy body; use bodyPreview".to_string());
    }
    let body_value = object.get("bodyPreview");
    let body = match body_value {
        Some(Value::String(body)) => Some(body.clone()),
        Some(Value::Null) | None => None,
        Some(_) => return Err("Rule page body must be a string or null".to_string()),
    };
    Ok(PageData { title, url, body })
}

pub fn match_list_rules_strict(
    list: &ListEntity,
    page: &PageData,
) -> Result<Vec<RuleMatch>, String> {
    let mut results = Vec::new();
    for rule in &list.rules {
        if !JAVASCRIPT_LIST_RULES_ENABLED && rule.rule_type == "function" {
            continue;
        }
        let matched = evaluate_rule_strict(&rule.rule_type, &rule.config, page)?;
        if matched {
            results.push(RuleMatch {
                rule_id: rule.id.clone(),
                r#match: true,
            });
        }
    }
    Ok(results)
}

pub fn preview_rule(rule: &RuleSpec, page: &PageData) -> Result<bool, String> {
    evaluate_rule_strict(&rule.rule_type, &rule.config, page)
}

pub fn validate_rule(rule: &RuleSpec) -> Result<(), String> {
    match rule.rule_type.as_str() {
        "keyword" => validate_keyword_rule(rule),
        #[cfg(all(feature = "javascript-list-rules", not(feature = "mac-app-store")))]
        "function" => javascript::compile_function_rule(&rule.config),
        #[cfg(not(all(feature = "javascript-list-rules", not(feature = "mac-app-store"))))]
        "function" => Err(JAVASCRIPT_RULE_UNAVAILABLE.to_string()),
        unknown => Err(format!("Unsupported rule type: {unknown}")),
    }
}

fn validate_keyword_rule(rule: &RuleSpec) -> Result<(), String> {
    for key in rule.config.keys() {
        if key != "pattern" {
            return Err(format!("Unsupported keyword rule field: {key}"));
        }
    }
    let pattern = rule
        .config
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| "Keyword rule requires a string pattern".to_string())?;
    if pattern.trim().is_empty() {
        return Err("Keyword rule pattern must not be empty".to_string());
    }
    if pattern.starts_with('/') && pattern.ends_with('/') && pattern.len() >= 2 {
        regex::Regex::new(&format!("(?i){}", &pattern[1..pattern.len() - 1]))
            .map_err(|error| format!("Invalid keyword regular expression: {error}"))?;
    }
    Ok(())
}

fn evaluate_rule_strict(
    rule_type: &str,
    config: &BTreeMap<String, Value>,
    page: &PageData,
) -> Result<bool, String> {
    validate_rule(&RuleSpec {
        rule_type: rule_type.to_string(),
        config: config.clone(),
    })?;
    match rule_type {
        "keyword" => match_keyword_rule(config, page),
        #[cfg(all(feature = "javascript-list-rules", not(feature = "mac-app-store")))]
        "function" => javascript::execute_function_rule(config, page),
        unknown => Err(format!("Unsupported rule type: {unknown}")),
    }
}

fn match_keyword_rule(config: &BTreeMap<String, Value>, page: &PageData) -> Result<bool, String> {
    let Some(title) = &page.title else {
        return Ok(false);
    };
    let pattern = config
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| "Keyword rule requires a string pattern".to_string())?;

    if pattern.starts_with('/') && pattern.ends_with('/') && pattern.len() >= 2 {
        let expression = format!("(?i){}", &pattern[1..pattern.len() - 1]);
        let Ok(regex) = regex::Regex::new(&expression) else {
            return Ok(false);
        };
        return Ok(regex.is_match(title));
    }

    let needle = pattern.to_lowercase();
    Ok(title.to_lowercase().contains(&needle))
}

#[cfg(test)]
mod tests {
    #[cfg(all(feature = "javascript-list-rules", not(feature = "mac-app-store")))]
    use super::validate_fn_rule_source;
    use super::{
        match_list_rules_strict, page_data_from_raw_entry, validate_rule, PageData, RuleSpec,
    };
    use browser_recall_replay::entities::{ListEntity, RuleEntity};
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};

    fn list_with_rule(rule: RuleEntity) -> ListEntity {
        ListEntity {
            slug: "reading".to_string(),
            name: "Reading".to_string(),
            owner: "test-device".to_string(),
            pins: Vec::new(),
            rules: vec![rule],
            timestamps: HashMap::new(),
            deleted: false,
            deleted_ts: None,
        }
    }

    fn list_matches_page(list: &ListEntity, page: &PageData) -> bool {
        !match_list_rules_strict(list, page)
            .expect("valid test rule")
            .is_empty()
    }

    #[test]
    fn extracts_page_data_from_visit_entry() {
        let page = page_data_from_raw_entry(&json!({
            "action": "visit_page",
            "url": "https://example.com/page",
            "title": "Example",
            "bodyPreview": "Hello world"
        }))
        .expect("page data");

        assert_eq!(
            page,
            PageData {
                title: Some("Example".to_string()),
                url: "https://example.com/page".to_string(),
                body: Some("Hello world".to_string()),
            }
        );
    }

    #[test]
    fn rejects_legacy_rule_body_field() {
        let error = page_data_from_raw_entry(&json!({
            "url": "https://example.com/page",
            "title": "Example",
            "body": "legacy body"
        }))
        .expect_err("legacy body field must be rejected");

        assert!(error.contains("body"));
    }

    #[cfg(all(feature = "javascript-list-rules", not(feature = "mac-app-store")))]
    #[test]
    fn validates_banned_globals_for_function_rules() {
        let result = validate_fn_rule_source("fetch('https://example.com'); return true;");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| error.contains("fetch")));
    }

    #[test]
    fn keyword_rules_match_title_only() {
        let list = list_with_rule(RuleEntity {
            id: "rule-k-1".to_string(),
            rule_type: "keyword".to_string(),
            config: BTreeMap::from([("pattern".to_string(), json!("cats"))]),
            created_at: 1,
        });

        assert!(list_matches_page(
            &list,
            &PageData {
                title: Some("All About Cats".to_string()),
                url: "https://example.com/page".to_string(),
                body: None,
            }
        ));
        assert!(!list_matches_page(
            &list,
            &PageData {
                title: Some("No title match".to_string()),
                url: "https://example.com/page".to_string(),
                body: Some("Cats are here".to_string()),
            }
        ));
    }

    #[test]
    fn keyword_rule_validation_rejects_fields_config() {
        let result = validate_rule(&RuleSpec {
            rule_type: "keyword".to_string(),
            config: BTreeMap::from([
                ("pattern".to_string(), json!("ai")),
                ("fields".to_string(), json!(["title"])),
            ]),
        });

        assert!(result.is_err());
    }

    #[test]
    fn keyword_rule_validation_rejects_case_sensitive_config() {
        let result = validate_rule(&RuleSpec {
            rule_type: "keyword".to_string(),
            config: BTreeMap::from([
                ("pattern".to_string(), json!("ai")),
                ("caseSensitive".to_string(), json!(true)),
            ]),
        });

        assert!(result.is_err());
    }

    #[test]
    fn rule_validation_rejects_incomplete_or_unknown_rules() {
        for config in [
            BTreeMap::new(),
            BTreeMap::from([("pattern".to_string(), json!(""))]),
            BTreeMap::from([("pattern".to_string(), json!(42))]),
            BTreeMap::from([("pattern".to_string(), json!("/[invalid/"))]),
        ] {
            assert!(validate_rule(&RuleSpec {
                rule_type: "keyword".to_string(),
                config,
            })
            .is_err());
        }

        assert!(validate_rule(&RuleSpec {
            rule_type: "future-rule".to_string(),
            config: BTreeMap::new(),
        })
        .is_err());

        for config in [
            BTreeMap::from([("fnSource".to_string(), json!("return true;"))]),
            BTreeMap::from([
                ("description".to_string(), json!("")),
                ("fnSource".to_string(), json!("return true;")),
            ]),
            BTreeMap::from([
                ("description".to_string(), json!("Description")),
                ("fnSource".to_string(), json!("")),
            ]),
        ] {
            assert!(validate_rule(&RuleSpec {
                rule_type: "function".to_string(),
                config,
            })
            .is_err());
        }
    }

    #[cfg(all(feature = "javascript-list-rules", not(feature = "mac-app-store")))]
    #[test]
    fn function_rules_match_with_url_polyfill() {
        let list = list_with_rule(RuleEntity {
            id: "rule-f-1".to_string(),
            rule_type: "function".to_string(),
            config: BTreeMap::from([
                ("description".to_string(), json!("Hub pages")),
                (
                    "fnSource".to_string(),
                    json!(
                        "const u = new URL(page.url);\nreturn u.pathname === '/' && !u.searchParams.has('q');"
                    ),
                ),
            ]),
            created_at: 1,
        });

        assert!(list_matches_page(
            &list,
            &PageData {
                title: Some("Example".to_string()),
                url: "https://example.com/".to_string(),
                body: None,
            }
        ));
        assert!(!list_matches_page(
            &list,
            &PageData {
                title: Some("Search".to_string()),
                url: "https://example.com/?q=rust".to_string(),
                body: None,
            }
        ));
    }
}
