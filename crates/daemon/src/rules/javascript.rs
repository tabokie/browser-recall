use super::PageData;
use rquickjs::{Context, Function, Runtime};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
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
        match regex::Regex::new(&pattern) {
            Ok(re) if re.is_match(fn_source) => {
                errors.push(format!("Banned global detected: {name}"));
            }
            Ok(_) => {}
            Err(error) => errors.push(format!("Could not validate banned global {name}: {error}")),
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

pub(super) fn execute_function_rule(
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
    if (parsed.error) throw new TypeError(parsed.error);
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
        let parse_url = Function::new(ctx.clone(), |input: String| {
            match ParsedUrl::parse(&input) {
                Ok(parsed) => serde_json::to_string(&parsed).map_err(|error| {
                    rquickjs::Error::new_from_js_message(
                        "ParsedUrl",
                        "JSON string",
                        error.to_string(),
                    )
                }),
                Err(error) => Ok(serde_json::json!({ "error": error.to_string() }).to_string()),
            }
        })?;
        ctx.globals().set("__brParseUrl", parse_url)?;
        ctx.eval::<bool, _>(script)
    });

    runtime.set_interrupt_handler(None);
    result.map_err(|error| error.to_string())
}

pub(super) fn compile_function_rule(config: &BTreeMap<String, Value>) -> Result<(), String> {
    if config.len() != 2 || !config.contains_key("description") || !config.contains_key("fnSource")
    {
        return Err(
            "Function rule config must contain exactly description and fnSource".to_string(),
        );
    }
    let description = config
        .get("description")
        .and_then(Value::as_str)
        .ok_or_else(|| "Function rule requires a string description".to_string())?;
    if description.trim().is_empty() {
        return Err("Function rule description must not be empty".to_string());
    }
    let fn_source = config
        .get("fnSource")
        .and_then(Value::as_str)
        .ok_or_else(|| "Function rule requires string fnSource".to_string())?;
    if fn_source.trim().is_empty() {
        return Err("Function rule fnSource must not be empty".to_string());
    }
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
