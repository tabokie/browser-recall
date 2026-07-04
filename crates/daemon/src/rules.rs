use browser_recall_replay::entities::{ListEntity, RuleEntity};
use rquickjs::{Context, Function, Runtime};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tracing::warn;
use url::Url;

const BANNED_GLOBALS: &[&str] = &[
    "fetch",
    "chrome",
    "window",
    "document",
    "navigator",
    "globalThis",
    "eval",
    "Function",
    "setTimeout",
    "setInterval",
    "WebSocket",
    "Worker",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "importScripts",
];
const MAX_FN_SOURCE_BYTES: usize = 10_240;
const RULE_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageData {
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
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

pub fn page_data_from_raw_entry(entry: &Value) -> Option<PageData> {
    let object = entry.as_object()?;
    let url = object.get("url")?.as_str()?.to_string();
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let body = object
        .get("bodyPreview")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            object
                .get("body")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Some(PageData { title, url, body })
}

pub fn list_matches_page(list: &ListEntity, page: &PageData) -> bool {
    list.rules.iter().any(|rule| match_rule(rule, page))
}

pub fn match_list_rules_strict(
    list: &ListEntity,
    page: &PageData,
) -> Result<Vec<RuleMatch>, String> {
    let mut results = Vec::new();
    for rule in &list.rules {
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
        "function" => compile_function_rule(&rule.config),
        _ => Ok(()),
    }
}

fn validate_keyword_rule(rule: &RuleSpec) -> Result<(), String> {
    for key in rule.config.keys() {
        if key != "pattern" {
            return Err(format!("Unsupported keyword rule field: {key}"));
        }
    }
    Ok(())
}

pub fn validate_fn_rule_source(fn_source: &str) -> ValidationResult {
    let mut errors = Vec::new();

    if fn_source.len() > MAX_FN_SOURCE_BYTES {
        errors.push(format!(
            "Function source exceeds 10KB limit ({} bytes)",
            fn_source.len()
        ));
    }

    for name in BANNED_GLOBALS {
        let pattern = format!(r"\b{}\b", regex::escape(name));
        let re = regex::Regex::new(&pattern).expect("banned-global regex");
        if re.is_match(fn_source) {
            errors.push(format!("Banned global detected: {name}"));
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

fn match_rule(rule: &RuleEntity, page: &PageData) -> bool {
    match rule.rule_type.as_str() {
        "keyword" => match_keyword_rule(&rule.config, page),
        "function" => match execute_function_rule(&rule.config, page) {
            Ok(result) => result,
            Err(error) => {
                warn!(rule_id = rule.id.as_str(), error = %error, "function rule evaluation failed");
                false
            }
        },
        _ => false,
    }
}

fn evaluate_rule_strict(
    rule_type: &str,
    config: &BTreeMap<String, Value>,
    page: &PageData,
) -> Result<bool, String> {
    match rule_type {
        "keyword" => Ok(match_keyword_rule(config, page)),
        "function" => execute_function_rule(config, page),
        _ => Ok(false),
    }
}

fn match_keyword_rule(config: &BTreeMap<String, Value>, page: &PageData) -> bool {
    let pattern = config
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if pattern.is_empty() {
        return false;
    }

    if pattern.starts_with('/') && pattern.ends_with('/') && pattern.len() >= 2 {
        let expression = format!("(?i){}", &pattern[1..pattern.len() - 1]);
        let Ok(regex) = regex::Regex::new(&expression) else {
            return false;
        };
        return regex.is_match(&page.title);
    }

    let needle = pattern.to_lowercase();
    page.title.to_lowercase().contains(&needle)
}

fn execute_function_rule(
    config: &BTreeMap<String, Value>,
    page: &PageData,
) -> Result<bool, String> {
    let fn_source = config
        .get("fnSource")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing fnSource".to_string())?;
    compile_function_rule(config)?;

    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    runtime.set_memory_limit(1 << 20);
    runtime.set_max_stack_size(256 * 1024);
    let started_at = Instant::now();
    runtime.set_interrupt_handler(Some(Box::new(move || started_at.elapsed() > RULE_TIMEOUT)));

    let context = Context::full(&runtime).map_err(|error| error.to_string())?;
    let page_json = serde_json::to_string(page).map_err(|error| error.to_string())?;
    let script = format!(
        r#""use strict";
const page = {page_json};
const __parseUrl = globalThis.__brParseUrl;
class URL {{
  constructor(input) {{
    const parsed = JSON.parse(__parseUrl(String(input)));
    this.href = String(input);
    this.pathname = parsed.pathname;
    this.search = parsed.search;
    this.hash = parsed.hash;
    this.searchParams = {{
      has(name) {{
        return parsed.searchParams.some((pair) => pair[0] === String(name));
      }},
      get(name) {{
        const match = parsed.searchParams.find((pair) => pair[0] === String(name));
        return match ? match[1] : null;
      }},
    }};
  }}
}}
Boolean((function(page) {{
{fn_source}
}})(page));
"#
    );

    let result = context.with(|ctx| {
        let parse_url = Function::new(ctx.clone(), |input: String| -> String {
            match ParsedUrl::parse(&input) {
                Ok(parsed) => serde_json::to_string(&parsed).unwrap_or_else(|_| "{}".to_string()),
                Err(_) => "{\"pathname\":\"\",\"search\":\"\",\"hash\":\"\",\"searchParams\":[]}"
                    .to_string(),
            }
        })?;
        ctx.globals().set("__brParseUrl", parse_url)?;
        ctx.eval::<bool, _>(script)
    });

    runtime.set_interrupt_handler(None);
    result.map_err(|error| error.to_string())
}

fn compile_function_rule(config: &BTreeMap<String, Value>) -> Result<(), String> {
    let fn_source = config
        .get("fnSource")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing fnSource".to_string())?;
    let validation = validate_fn_rule_source(fn_source);
    if !validation.valid {
        return Err(validation.errors.join("; "));
    }

    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    let context = Context::full(&runtime).map_err(|error| error.to_string())?;
    let script = format!(
        r#""use strict";
void (function(page) {{
{fn_source}
}});
"#
    );
    context
        .with(|ctx| ctx.eval::<(), _>(script))
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
struct ParsedUrl {
    pathname: String,
    search: String,
    hash: String,
    #[serde(rename = "searchParams")]
    search_params: Vec<(String, String)>,
}

impl ParsedUrl {
    fn parse(input: &str) -> Result<Self, url::ParseError> {
        let parsed = Url::parse(input)?;
        Ok(Self {
            pathname: parsed.path().to_string(),
            search: parsed
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default(),
            hash: parsed
                .fragment()
                .map(|fragment| format!("#{fragment}"))
                .unwrap_or_default(),
            search_params: parsed.query_pairs().into_owned().collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        list_matches_page, page_data_from_raw_entry, validate_fn_rule_source, validate_rule,
        PageData, RuleSpec,
    };
    use browser_recall_replay::entities::{ListEntity, RuleEntity};
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};

    fn list_with_rule(rule: RuleEntity) -> ListEntity {
        ListEntity {
            slug: "reading".to_string(),
            name: "Reading".to_string(),
            owner: Some("test-device".to_string()),
            pins: Vec::new(),
            rules: vec![rule],
            timestamps: HashMap::new(),
            deleted: false,
            deleted_ts: None,
        }
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
                title: "Example".to_string(),
                url: "https://example.com/page".to_string(),
                body: Some("Hello world".to_string()),
            }
        );
    }

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
                title: "All About Cats".to_string(),
                url: "https://example.com/page".to_string(),
                body: None,
            }
        ));
        assert!(!list_matches_page(
            &list,
            &PageData {
                title: "No title match".to_string(),
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
                title: "Example".to_string(),
                url: "https://example.com/".to_string(),
                body: None,
            }
        ));
        assert!(!list_matches_page(
            &list,
            &PageData {
                title: "Search".to_string(),
                url: "https://example.com/?q=rust".to_string(),
                body: None,
            }
        ));
    }
}
