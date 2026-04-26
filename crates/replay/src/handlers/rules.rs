use std::collections::BTreeMap;
use std::future::Future;

use serde_json::Value;

use crate::{
    entities::Entity, generate_rule_id, get_list, resolve_list_key, touch_timestamp_map, Context,
    EntityEffect, EntityMap, ReplayError, RuleEntity, RuleInput,
};

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
    let mut result = EntityMap::new();
    let Some(list_key) = resolve_list_key(&mut result, load, name, list_owner).await? else {
        return Ok(result);
    };
    let Some(mut list) = get_list(&result, load, &list_key).await else {
        return Ok(result);
    };

    let rule_id = rule
        .id
        .unwrap_or_else(|| generate_rule_id(&rule.rule_type, timestamp));
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
    let Some(list_key) = resolve_list_key(&mut result, load, name, list_owner).await? else {
        return Ok(result);
    };
    let Some(mut list) = get_list(&result, load, &list_key).await else {
        return Ok(result);
    };

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
    let Some(list_key) = resolve_list_key(&mut result, load, name, list_owner).await? else {
        return Ok(result);
    };
    let Some(mut list) = get_list(&result, load, &list_key).await else {
        return Ok(result);
    };

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
