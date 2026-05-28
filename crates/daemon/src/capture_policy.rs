use crate::storage::Storage;
use browser_recall_replay::entities::Entity;
use browser_recall_replay::generate_slug_from_url;
use chrono::{Local, TimeZone};
use serde_json::Value;

const DEFAULT_URL_BLACKLIST: &[&str] = &["chrome://", "edge://", "about:"];

fn settings_bool(settings: Option<&Entity>, key: &str) -> Option<bool> {
    let Some(Entity::Settings(settings)) = settings else {
        return None;
    };
    settings.values.get(key).and_then(Value::as_bool)
}

fn settings_array<'a>(settings: Option<&'a Entity>, key: &str) -> Option<&'a Vec<Value>> {
    let Some(Entity::Settings(settings)) = settings else {
        return None;
    };
    settings.values.get(key).and_then(Value::as_array)
}

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

pub fn trim_title_from_settings(settings: Option<&Entity>, raw_title: &str, url: &str) -> String {
    let mut title = raw_title.to_string();
    if settings_bool(settings, "titleCleanupEnabled") == Some(false) {
        return title.trim().to_string();
    }
    for rule in settings_array(settings, "titleTrimRules")
        .into_iter()
        .flatten()
    {
        let prefix = rule.get("urlPrefix").and_then(Value::as_str).unwrap_or("");
        if prefix.is_empty() || !url.starts_with(prefix) {
            continue;
        }
        match rule.get("action").and_then(Value::as_str).unwrap_or("") {
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
    title.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn blacklist_prefixes(settings: Option<&Entity>) -> Vec<String> {
    if settings_bool(settings, "blacklistEnabled") == Some(false) {
        return DEFAULT_URL_BLACKLIST
            .iter()
            .map(|value| value.to_string())
            .collect();
    }
    settings_array(settings, "urlBlacklist")
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| {
            DEFAULT_URL_BLACKLIST
                .iter()
                .map(|value| value.to_string())
                .collect()
        })
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
    if !blacklist_prefixes(settings)
        .iter()
        .any(|prefix| url.starts_with(prefix))
    {
        return Ok(true);
    }

    let date_file = format!("{}.jsonl", date_key_from_timestamp(timestamp));
    let entries = storage
        .load_history_batch(&[date_file])
        .await
        .map_err(|error| error.to_string())?;
    if entries.iter().any(|entry| {
        entry
            .get("url")
            .and_then(Value::as_str)
            .map(|entry_url| entry_url == url)
            .unwrap_or(false)
    }) {
        return Ok(true);
    }

    let slug = generate_slug_from_url(url).map_err(|error| error.to_string())?;
    Ok(storage
        .load_entity(&format!("page:{slug}"))
        .await
        .map_err(|error| error.to_string())?
        .is_some())
}

fn date_key_from_timestamp(timestamp: i64) -> String {
    match Local.timestamp_millis_opt(timestamp).single() {
        Some(datetime) => datetime.format("%Y-%m-%d").to_string(),
        None => Local::now().format("%Y-%m-%d").to_string(),
    }
}
