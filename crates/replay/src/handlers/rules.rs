use std::collections::BTreeMap;
use std::future::Future;

use serde_json::Value;

use crate::{
    entities::Entity, generate_rule_id, get_list, resolve_list_key, touch_timestamp_map,
    validate_list_identity, Context, EntityEffect, EntityMap, ReplayError, RuleEntity, RuleInput,
};

fn require_rule_string(
    rule: &RuleInput,
    field: &str,
    expected_fields: &[&str],
) -> Result<(), ReplayError> {
    if rule.config.len() != expected_fields.len()
        || !rule
            .config
            .keys()
            .all(|key| expected_fields.contains(&key.as_str()))
    {
        return Err(ReplayError::InvalidEntry(format!(
            "{} rule config must contain exactly {}",
            rule.rule_type,
            expected_fields.join(" and ")
        )));
    }
    rule.config
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ReplayError::InvalidEntry(format!(
                "{} rule {field} must be a non-empty string",
                rule.rule_type
            ))
        })?;
    Ok(())
}

fn validate_rule_schema(rule: &RuleInput) -> Result<(), ReplayError> {
    if matches!(rule.id.as_deref(), Some("")) {
        return Err(ReplayError::InvalidEntry(
            "rule id must be non-empty or null".to_string(),
        ));
    }
    match rule.rule_type.as_str() {
        "keyword" => require_rule_string(rule, "pattern", &["pattern"]),
        "function" => {
            require_rule_string(rule, "description", &["description", "fnSource"])?;
            require_rule_string(rule, "fnSource", &["description", "fnSource"])
        }
        unknown => Err(ReplayError::InvalidEntry(format!(
            "unsupported rule type: {unknown}"
        ))),
    }
}

pub(crate) async fn handle_add_rule<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
    rule: RuleInput,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    validate_rule_schema(&rule)?;
    let mut result = EntityMap::new();
    let list_key = resolve_list_key(&mut result, load, name, list_owner)
        .await?
        .ok_or_else(|| ReplayError::InvalidEntry(format!("list not found: {list_owner}/{name}")))?;
    let mut list = get_list(&result, load, &list_key)
        .await
        .ok_or_else(|| ReplayError::InvalidEntry(format!("list entity is missing: {list_key}")))?;
    validate_list_identity(&list_key, &list, list_owner)?;

    let rule_id = match rule.id {
        Some(rule_id) => rule_id,
        None => generate_rule_id(&rule.rule_type, timestamp)?,
    };
    if !list.rules.iter().any(|existing| existing.id == rule_id) {
        list.rules.push(RuleEntity {
            id: rule_id,
            rule_type: rule.rule_type,
            config: rule.config,
            created_at: timestamp,
        });
    }
    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    Ok(result)
}

pub(crate) async fn handle_remove_rule<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
    rule_id: &str,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    let list_key = resolve_list_key(&mut result, load, name, list_owner)
        .await?
        .ok_or_else(|| ReplayError::InvalidEntry(format!("list not found: {list_owner}/{name}")))?;
    let mut list = get_list(&result, load, &list_key)
        .await
        .ok_or_else(|| ReplayError::InvalidEntry(format!("list entity is missing: {list_key}")))?;
    validate_list_identity(&list_key, &list, list_owner)?;

    list.rules.retain(|rule| rule.id != rule_id);
    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    Ok(result)
}

pub(crate) async fn handle_update_rule<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
    rule_id: &str,
    config: BTreeMap<String, Value>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    let list_key = resolve_list_key(&mut result, load, name, list_owner)
        .await?
        .ok_or_else(|| ReplayError::InvalidEntry(format!("list not found: {list_owner}/{name}")))?;
    let mut list = get_list(&result, load, &list_key)
        .await
        .ok_or_else(|| ReplayError::InvalidEntry(format!("list entity is missing: {list_key}")))?;
    validate_list_identity(&list_key, &list, list_owner)?;

    for rule in &mut list.rules {
        if rule.id != rule_id {
            continue;
        }
        for (key, value) in &config {
            rule.config.insert(key.clone(), value.clone());
        }
    }

    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    Ok(result)
}
