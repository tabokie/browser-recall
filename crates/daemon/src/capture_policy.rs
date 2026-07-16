use crate::storage::Storage;
use browser_recall_replay::entities::Entity;
use browser_recall_replay::generate_slug_from_url;
use chrono::{Local, TimeZone};
use serde_json::Value;

const INTERNAL_URL_PREFIXES: &[&str] = &["chrome://", "edge://", "about:"];

fn strip_balanced_segments(input: &str, open: char, close: char) -> String {
    let mut output = String::with_capacity(input.len());
    let mut depth = 0usize;
    for ch in input.chars() {
        if ch == open {
            depth += 1;
            output.push(' ');
        } else if ch == close && depth > 0 {
            depth -= 1;
            output.push(' ');
        } else if depth == 0 {
            output.push(ch);
        }
    }
    output
}

pub fn trim_title_from_settings(
    settings: Option<&Entity>,
    raw_title: &str,
    url: &str,
) -> Result<String, String> {
    let values = crate::settings::values_from_entity(settings)?;
    let mut title = raw_title.to_string();
    if values["titleCleanupEnabled"] == Value::Bool(false) {
        return Ok(title.trim().to_string());
    }
    let rules = values["titleTrimRules"]
        .as_array()
        .ok_or_else(|| "titleTrimRules must be an array".to_string())?;
    for rule in rules {
        let prefix = rule["urlPrefix"]
            .as_str()
            .ok_or_else(|| "titleTrimRules urlPrefix must be a string".to_string())?;
        if prefix.is_empty() || !url.starts_with(prefix) {
            continue;
        }
        match rule["action"]
            .as_str()
            .ok_or_else(|| "titleTrimRules action must be a string".to_string())?
        {
            "remove_after_pipe" => {
                if let Some(index) = title.find('|').filter(|index| *index > 0) {
                    title.truncate(index);
                }
            }
            "remove_brackets" => title = strip_balanced_segments(&title, '[', ']'),
            "remove_parens" => title = strip_balanced_segments(&title, '(', ')'),
            _ => {}
        }
    }
    Ok(title.split_whitespace().collect::<Vec<_>>().join(" "))
}

pub fn blacklist_prefixes(settings: Option<&Entity>) -> Result<Vec<String>, String> {
    let values = crate::settings::values_from_entity(settings)?;
    if values["blacklistEnabled"] == Value::Bool(false) {
        return Ok(INTERNAL_URL_PREFIXES
            .iter()
            .map(|value| value.to_string())
            .collect());
    }
    values["urlBlacklist"]
        .as_array()
        .ok_or_else(|| "urlBlacklist must be an array".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "urlBlacklist must contain strings only".to_string())
        })
        .collect()
}

pub async fn should_record_visit(
    storage: &Storage,
    settings: Option<&Entity>,
    url: &str,
    timestamp: i64,
    bypass_blacklist: bool,
) -> Result<bool, String> {
    if bypass_blacklist {
        return Ok(true);
    }
    if !blacklist_prefixes(settings)?
        .iter()
        .any(|prefix| url.starts_with(prefix))
    {
        return Ok(true);
    }

    let date_file = format!("{}.jsonl", date_key_from_timestamp(timestamp)?);
    let entries = storage
        .load_history_batch(&[date_file])
        .await
        .map_err(|error| error.to_string())?;
    if entries
        .iter()
        .any(|entry| entry.get("url").and_then(Value::as_str) == Some(url))
    {
        return Ok(true);
    }

    let slug = generate_slug_from_url(url).map_err(|error| error.to_string())?;
    Ok(storage
        .load_entity(&format!("page:{slug}"))
        .await
        .map_err(|error| error.to_string())?
        .is_some())
}

fn date_key_from_timestamp(timestamp: i64) -> Result<String, String> {
    Local
        .timestamp_millis_opt(timestamp)
        .single()
        .map(|datetime| datetime.format("%Y-%m-%d").to_string())
        .ok_or_else(|| "timestamp is out of range".to_string())
}
