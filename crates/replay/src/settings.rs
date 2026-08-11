use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::entities::Entity;

pub const PERSISTENT_SETTINGS_KEYS: &[&str] = &[
    "theme",
    "colorScheme",
    "localeOverride",
    "historyFileBatch",
    "captureSnapshotVideo",
    "blacklistEnabled",
    "urlBlacklist",
    "titleCleanupEnabled",
    "titleTrimRules",
    "syncEnabled",
    "syncMethod",
    "syncRepoUrl",
    "syncRetentionDays",
];

pub fn default_values() -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("theme".to_string(), json!("light")),
        ("colorScheme".to_string(), json!("amber")),
        ("localeOverride".to_string(), json!("system")),
        ("historyFileBatch".to_string(), json!(10)),
        ("captureSnapshotVideo".to_string(), json!(false)),
        ("blacklistEnabled".to_string(), json!(true)),
        (
            "urlBlacklist".to_string(),
            json!(["chrome://", "edge://", "about:"]),
        ),
        ("titleCleanupEnabled".to_string(), json!(false)),
        ("titleTrimRules".to_string(), json!([])),
        ("syncEnabled".to_string(), json!(false)),
        ("syncMethod".to_string(), json!("github")),
        ("syncRepoUrl".to_string(), json!("")),
        ("syncRetentionDays".to_string(), json!(7)),
    ])
}

pub fn validate_value(key: &str, value: &Value) -> Result<(), String> {
    match key {
        "theme" => validate_enum(key, value, &["system", "light", "dark"]),
        "colorScheme" => validate_enum(key, value, &["amber", "mono"]),
        "localeOverride" => validate_enum(
            key,
            value,
            &[
                "system", "en", "ar", "de", "es", "fr", "hi", "id", "it", "ja", "ko", "pt-BR",
                "pt-PT", "ru", "zh-CN", "zh-TW",
            ],
        ),
        "syncRepoUrl" => {
            if value.is_string() {
                Ok(())
            } else {
                Err(format!("{key} must be a string"))
            }
        }
        "syncMethod" => match value.as_str() {
            Some("github") => Ok(()),
            Some(_) => Err("syncMethod must be github".to_string()),
            None => Err("syncMethod must be a string".to_string()),
        },
        "historyFileBatch" | "syncRetentionDays" => match value.as_i64() {
            Some(number) if number >= 1 => Ok(()),
            _ => Err(format!(
                "{key} must be an integer greater than or equal to 1"
            )),
        },
        "captureSnapshotVideo" | "blacklistEnabled" | "titleCleanupEnabled" | "syncEnabled" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(format!("{key} must be a boolean"))
            }
        }
        "urlBlacklist" => validate_string_array(key, value),
        "titleTrimRules" => validate_title_trim_rules(value),
        _ => Err(format!("Unknown settings key: {key}")),
    }
}

fn validate_enum(key: &str, value: &Value, supported: &[&str]) -> Result<(), String> {
    match value.as_str() {
        Some(candidate) if supported.contains(&candidate) => Ok(()),
        Some(_) => Err(format!("{key} has an unsupported value")),
        None => Err(format!("{key} must be a string")),
    }
}

fn validate_string_array(key: &str, value: &Value) -> Result<(), String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    for value in values {
        match value.as_str() {
            Some(item) if !item.trim().is_empty() => {}
            Some(_) => return Err(format!("{key} must not contain empty strings")),
            None => return Err(format!("{key} must contain strings only")),
        }
    }
    Ok(())
}

fn validate_title_trim_rules(value: &Value) -> Result<(), String> {
    let rules = value
        .as_array()
        .ok_or_else(|| "titleTrimRules must be an array".to_string())?;
    for rule in rules {
        let object = rule
            .as_object()
            .ok_or_else(|| "titleTrimRules entries must be objects".to_string())?;
        if object.len() != 2 || !object.contains_key("urlPrefix") || !object.contains_key("action")
        {
            return Err(
                "titleTrimRules entries must contain exactly urlPrefix and action".to_string(),
            );
        }
        match object.get("urlPrefix").and_then(Value::as_str) {
            Some(prefix) if !prefix.trim().is_empty() => {}
            Some(_) => return Err("titleTrimRules urlPrefix must not be empty".to_string()),
            None => return Err("titleTrimRules urlPrefix must be a string".to_string()),
        }
        match object.get("action").and_then(Value::as_str) {
            Some("remove_after_pipe" | "remove_brackets" | "remove_parens") => {}
            _ => return Err("titleTrimRules action is invalid".to_string()),
        }
    }
    Ok(())
}

pub fn validate_complete(values: &BTreeMap<String, Value>) -> Result<(), String> {
    for key in values.keys() {
        if !PERSISTENT_SETTINGS_KEYS.contains(&key.as_str()) {
            return Err(format!("Unknown settings key: {key}"));
        }
    }
    for key in PERSISTENT_SETTINGS_KEYS {
        let value = values.get(*key).ok_or_else(|| {
            format!("settings missing {key}; migrate browser data before continuing")
        })?;
        validate_value(key, value)?;
    }
    Ok(())
}

pub fn values_from_entity(entity: Option<&Entity>) -> Result<&BTreeMap<String, Value>, String> {
    let settings = match entity {
        Some(Entity::Settings(settings)) => settings,
        Some(_) => return Err("settings manifest has unexpected entity type".to_string()),
        None => return Err("settings manifest is missing".to_string()),
    };
    validate_complete(&settings.values)?;
    Ok(&settings.values)
}
