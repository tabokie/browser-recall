use std::collections::HashSet;
use std::future::Future;

use crate::{
    entities::Entity, entity_slug, find_lists_with_pin, generate_slug_from_url, get_list_order,
    get_name_to_id, get_orphaned, get_page, remove_from_tree, retain_page_or_delete,
    touch_timestamp_map, Context, EntityEffect, EntityMap, ReplayError, LIST_ORDER_KEY,
    LIST_PREFIX, NAME_TO_ID_KEY, NOTE_PREFIX, ORPHANED_KEY, PAGE_PREFIX, SNAPSHOT_PREFIX,
};

pub(crate) async fn handle_permanent_delete<L, Fut>(
    timestamp: i64,
    keys: &[String],
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    let delete_keys = keys
        .iter()
        .filter(|key| {
            key.starts_with("note:")
                || key.starts_with("list:")
                || key.starts_with("page:")
                || key.starts_with("snapshot:")
        })
        .cloned()
        .collect::<HashSet<_>>();

    for key in &delete_keys {
        result.insert(key.clone(), EntityEffect::Delete);
    }

    for key in &delete_keys {
        if key.starts_with(NOTE_PREFIX) {
            remove_note_references(&mut result, load, key, timestamp, context).await;
        } else if key.starts_with(SNAPSHOT_PREFIX) {
            remove_snapshot_references(&mut result, load, key, timestamp, context).await;
        } else if key.starts_with(LIST_PREFIX) {
            remove_list_references(&mut result, load, key, timestamp, context).await;
        } else if key.starts_with(PAGE_PREFIX) {
            remove_page_references(&mut result, load, key, timestamp, context).await;
        }
    }

    let mut orphaned = get_orphaned(&result, load, ORPHANED_KEY)
        .await
        .unwrap_or_else(crate::default_orphaned);
    orphaned
        .entries
        .retain(|entry| !delete_keys.contains(&entry.key));
    touch_timestamp_map(&mut orphaned.timestamps, &context.device_id, timestamp);
    result.insert(
        ORPHANED_KEY.to_string(),
        EntityEffect::Upsert(Entity::Orphaned(orphaned)),
    );

    Ok(result)
}

async fn remove_note_references<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    note_key: &str,
    timestamp: i64,
    context: &Context,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(note) = load(note_key).await.and_then(Entity::into_note) {
        if let Some(url) = note.url {
            if let Ok(slug) = generate_slug_from_url(&url) {
                let page_key = format!("{PAGE_PREFIX}{slug}");
                remove_child_from_page(result, load, &page_key, note_key, timestamp, context).await;
            }
        }
    }
    remove_pin_from_lists(result, load, note_key, timestamp, context).await;
}

async fn remove_snapshot_references<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    snapshot_key: &str,
    timestamp: i64,
    context: &Context,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let stem = entity_slug(snapshot_key);
    if let Some((slug, _)) = stem.rsplit_once('-') {
        let page_key = format!("{PAGE_PREFIX}{slug}");
        remove_child_from_page(result, load, &page_key, snapshot_key, timestamp, context).await;
    }
}

async fn remove_list_references<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    list_key: &str,
    timestamp: i64,
    context: &Context,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(list) = load(list_key).await.and_then(Entity::into_list) {
        for pin in list.pins {
            if !pin.id.starts_with(PAGE_PREFIX) {
                continue;
            }
            if let Some(mut page) = get_page(result, load, &pin.id).await {
                page.parent_ids.retain(|parent| parent != list_key);
                touch_timestamp_map(&mut page.timestamps, &context.device_id, timestamp);
                retain_page_or_delete(result, pin.id, page);
            }
        }
    }

    if let Some(mut order) = get_list_order(result, load, LIST_ORDER_KEY).await {
        order.tree = remove_from_tree(&order.tree, list_key);
        touch_timestamp_map(&mut order.timestamps, &context.device_id, timestamp);
        result.insert(
            LIST_ORDER_KEY.to_string(),
            EntityEffect::Upsert(Entity::ListOrder(order)),
        );
    }

    if let Some(mut name_map) = get_name_to_id(result, load, NAME_TO_ID_KEY).await {
        let list_slug = entity_slug(list_key);
        name_map.paths.retain(|_, value| value != list_slug);
        touch_timestamp_map(&mut name_map.timestamps, &context.device_id, timestamp);
        result.insert(
            NAME_TO_ID_KEY.to_string(),
            EntityEffect::Upsert(Entity::NameToId(name_map)),
        );
    }
}

async fn remove_page_references<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    page_key: &str,
    timestamp: i64,
    context: &Context,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    remove_pin_from_lists(result, load, page_key, timestamp, context).await;
}

async fn remove_child_from_page<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    page_key: &str,
    child_key: &str,
    timestamp: i64,
    context: &Context,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(mut page) = get_page(result, load, page_key).await {
        page.child_ids.retain(|child| child != child_key);
        touch_timestamp_map(&mut page.timestamps, &context.device_id, timestamp);
        retain_page_or_delete(result, page_key.to_string(), page);
    }
}

async fn remove_pin_from_lists<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    pin_id: &str,
    timestamp: i64,
    context: &Context,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    for (list_key, mut list) in find_lists_with_pin(result, load, pin_id).await {
        list.pins.retain(|pin| pin.id != pin_id);
        touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
        result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    }
}
