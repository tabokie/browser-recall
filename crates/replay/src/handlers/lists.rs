use std::collections::HashSet;
use std::future::Future;

use crate::{
    append_to_tree, append_unique, collect_tree_ids, default_list, ensure_page_with_overlay,
    entities::Entity, entity_slug, generate_list_id, get_list, get_list_order, get_name_to_id,
    get_page, is_system_list, note_slug_from_path, orphan_key, remove_from_tree, resolve_list_key,
    retain_page_or_delete, touch_timestamp_map, unorphan_key, Context, EntityEffect, EntityMap,
    ListOrderManifest, NameToIdManifest, PinEntity, ReplayError, TreeNode, LIST_ORDER_KEY,
    LIST_PREFIX, NAME_TO_ID_KEY, NOTE_PREFIX, PAGE_PREFIX,
};

#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_pin_to_list<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
    urls: &[String],
    titles: Option<&Vec<Option<String>>>,
    source: Option<&str>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    if let Some(values) = titles {
        if values.len() != urls.len() {
            return Err(ReplayError::InvalidEntry(
                "pin_to_list titles length must match urls length".to_string(),
            ));
        }
    }
    let Some(list_key) = resolve_list_key(&mut result, load, name, list_owner).await? else {
        return Ok(result);
    };
    let Some(mut list) = get_list(&result, load, &list_key).await else {
        return Ok(result);
    };

    for (index, item) in urls.iter().enumerate() {
        if item.is_empty() {
            continue;
        }
        let pin_id = if item.starts_with("objects/notes/") {
            format!("{NOTE_PREFIX}{}", note_slug_from_path(item))
        } else {
            let title = titles
                .and_then(|values| values.get(index))
                .and_then(Option::as_deref);
            let (page_key, page) =
                ensure_page_with_overlay(&mut result, load, item, timestamp, title, context)
                    .await?;
            let mut page = page;
            append_unique(&mut page.parent_ids, list_key.clone());
            result.insert(page_key.clone(), EntityEffect::Upsert(Entity::Page(page)));
            page_key
        };

        if !list.pins.iter().any(|pin| pin.id == pin_id) {
            list.pins.push(PinEntity {
                id: pin_id,
                pinned_at: timestamp,
                source: source.map(str::to_string),
            });
        }
    }

    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    Ok(result)
}

pub(crate) async fn handle_unpin_from_list<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
    urls: &[String],
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

    let mut remove_ids = HashSet::new();
    for item in urls {
        if item.is_empty() {
            continue;
        }
        let pin_id = if item.starts_with("objects/notes/") {
            format!("{NOTE_PREFIX}{}", note_slug_from_path(item))
        } else {
            format!("{PAGE_PREFIX}{}", crate::generate_slug_from_url(item)?)
        };
        remove_ids.insert(pin_id);
    }

    list.pins.retain(|pin| !remove_ids.contains(&pin.id));
    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    result.insert(list_key.clone(), EntityEffect::Upsert(Entity::List(list)));

    for pin_id in remove_ids {
        if !pin_id.starts_with(PAGE_PREFIX) {
            continue;
        }
        if let Some(mut page) = get_page(&result, load, &pin_id).await {
            page.parent_ids.retain(|parent| parent != &list_key);
            retain_page_or_delete(&mut result, pin_id, page);
        }
    }

    Ok(result)
}

pub(crate) async fn handle_create_list<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
    list_id: Option<&str>,
    parent_list_id: Option<&str>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    let mut name_map = get_name_to_id(&result, load, NAME_TO_ID_KEY)
        .await
        .unwrap_or_else(NameToIdManifest::new);
    let mut list_order = get_list_order(&result, load, LIST_ORDER_KEY)
        .await
        .unwrap_or_else(ListOrderManifest::new);

    let list_id = list_id
        .map(str::to_string)
        .unwrap_or_else(|| generate_list_id(name, timestamp));
    let list_key = format!("{LIST_PREFIX}{list_id}");

    if get_list(&result, load, &list_key).await.is_some() {
        return Ok(result);
    }

    let parent_key = parent_list_id.map(|value| format!("{LIST_PREFIX}{value}"));
    let mut list = default_list(&list_id);
    list.name = name.to_string();
    list.owner = Some(list_owner.to_string());
    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    touch_timestamp_map(&mut name_map.timestamps, &context.device_id, timestamp);
    touch_timestamp_map(&mut list_order.timestamps, &context.device_id, timestamp);
    list_order.tree = append_to_tree(&list_order.tree, &list_key, parent_key.as_deref());
    name_map
        .paths
        .insert(format!("{list_owner}/{name}"), list_id.clone());

    result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    result.insert(
        NAME_TO_ID_KEY.to_string(),
        EntityEffect::Upsert(Entity::NameToId(name_map)),
    );
    result.insert(
        LIST_ORDER_KEY.to_string(),
        EntityEffect::Upsert(Entity::ListOrder(list_order)),
    );
    Ok(result)
}

pub(crate) async fn handle_update_list<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
    new_name: Option<&str>,
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
    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);

    if let Some(new_name) = new_name {
        let old_name = list.name.clone();
        list.name = new_name.to_string();
        if old_name != new_name {
            let mut name_map = get_name_to_id(&result, load, NAME_TO_ID_KEY)
                .await
                .unwrap_or_else(NameToIdManifest::new);
            touch_timestamp_map(&mut name_map.timestamps, &context.device_id, timestamp);
            let owner = list.owner.clone().unwrap_or_default();
            name_map.paths.remove(&format!("{owner}/{old_name}"));
            name_map.paths.insert(
                format!("{owner}/{new_name}"),
                entity_slug(&list_key).to_string(),
            );
            result.insert(
                NAME_TO_ID_KEY.to_string(),
                EntityEffect::Upsert(Entity::NameToId(name_map)),
            );
        }
    }

    result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    Ok(result)
}

pub(crate) async fn handle_update_list_tree<L, Fut>(
    timestamp: i64,
    tree: &[TreeNode],
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    let current = get_list_order(&result, load, LIST_ORDER_KEY)
        .await
        .unwrap_or_else(ListOrderManifest::new);
    if current
        .timestamps
        .get(&context.device_id)
        .copied()
        .unwrap_or(0)
        >= timestamp
    {
        return Ok(result);
    }

    let mut reconciled = tree.to_vec();
    for list_id in collect_tree_ids(&reconciled) {
        if is_system_list(&list_id) {
            continue;
        }
        if let Some(list) = get_list(&result, load, &list_id).await {
            if list.deleted {
                reconciled = remove_from_tree(&reconciled, &list_id);
            }
        }
    }

    let mut present = collect_tree_ids(&reconciled);
    let name_map = get_name_to_id(&result, load, NAME_TO_ID_KEY)
        .await
        .unwrap_or_else(NameToIdManifest::new);
    for list_id in name_map.paths.values() {
        let list_key = format!("{LIST_PREFIX}{list_id}");
        if present.contains(&list_key) || is_system_list(&list_key) {
            continue;
        }
        if let Some(list) = get_list(&result, load, &list_key).await {
            if !list.deleted {
                reconciled.push(TreeNode {
                    id: list_key.clone(),
                    children: Vec::new(),
                });
                present.insert(list_key);
            }
        }
    }

    let mut list_order = current;
    touch_timestamp_map(&mut list_order.timestamps, &context.device_id, timestamp);
    list_order.tree = reconciled;
    result.insert(
        LIST_ORDER_KEY.to_string(),
        EntityEffect::Upsert(Entity::ListOrder(list_order)),
    );
    Ok(result)
}

pub(crate) async fn handle_delete_list<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
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
    if is_system_list(&list_key) {
        return Ok(result);
    }
    let mut list = get_list(&result, load, &list_key)
        .await
        .unwrap_or_else(|| default_list(entity_slug(&list_key)));
    if list.deleted_ts.unwrap_or(0) >= timestamp {
        return Ok(result);
    }

    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    list.deleted = true;
    list.deleted_ts = Some(timestamp);
    let pins = list.pins.clone();
    let list_name = if list.name.is_empty() {
        name.to_string()
    } else {
        list.name.clone()
    };
    let list_owner_value = list.owner.clone().unwrap_or_else(|| list_owner.to_string());
    result.insert(list_key.clone(), EntityEffect::Upsert(Entity::List(list)));

    let mut list_order = get_list_order(&result, load, LIST_ORDER_KEY)
        .await
        .unwrap_or_else(ListOrderManifest::new);
    touch_timestamp_map(&mut list_order.timestamps, &context.device_id, timestamp);
    list_order.tree = remove_from_tree(&list_order.tree, &list_key);
    result.insert(
        LIST_ORDER_KEY.to_string(),
        EntityEffect::Upsert(Entity::ListOrder(list_order)),
    );

    for pin in pins {
        if !pin.id.starts_with(PAGE_PREFIX) {
            continue;
        }
        if let Some(mut page) = get_page(&result, load, &pin.id).await {
            page.parent_ids.retain(|parent| parent != &list_key);
            retain_page_or_delete(&mut result, pin.id, page);
        }
    }

    let mut name_map = get_name_to_id(&result, load, NAME_TO_ID_KEY)
        .await
        .unwrap_or_else(NameToIdManifest::new);
    touch_timestamp_map(&mut name_map.timestamps, &context.device_id, timestamp);
    name_map
        .paths
        .remove(&format!("{list_owner_value}/{list_name}"));
    result.insert(
        NAME_TO_ID_KEY.to_string(),
        EntityEffect::Upsert(Entity::NameToId(name_map)),
    );

    orphan_key(
        &mut result,
        load,
        &context.device_id,
        &list_key,
        timestamp,
        None,
    )
    .await;
    Ok(result)
}

pub(crate) async fn handle_restore_list<L, Fut>(
    timestamp: i64,
    name: &str,
    list_owner: &str,
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
    let mut list = get_list(&result, load, &list_key)
        .await
        .unwrap_or_else(|| default_list(entity_slug(&list_key)));
    if list.deleted_ts.unwrap_or(0) >= timestamp {
        return Ok(result);
    }

    touch_timestamp_map(&mut list.timestamps, &context.device_id, timestamp);
    list.deleted = false;
    list.deleted_ts = Some(timestamp);
    let pins = list.pins.clone();
    let list_name = if list.name.is_empty() {
        name.to_string()
    } else {
        list.name.clone()
    };
    let list_owner_value = list.owner.clone().unwrap_or_else(|| list_owner.to_string());
    result.insert(list_key.clone(), EntityEffect::Upsert(Entity::List(list)));

    let mut list_order = get_list_order(&result, load, LIST_ORDER_KEY)
        .await
        .unwrap_or_else(ListOrderManifest::new);
    if !collect_tree_ids(&list_order.tree).contains(&list_key) {
        touch_timestamp_map(&mut list_order.timestamps, &context.device_id, timestamp);
        list_order.tree.push(TreeNode {
            id: list_key.clone(),
            children: Vec::new(),
        });
        result.insert(
            LIST_ORDER_KEY.to_string(),
            EntityEffect::Upsert(Entity::ListOrder(list_order)),
        );
    }

    for pin in pins {
        if !pin.id.starts_with(PAGE_PREFIX) {
            continue;
        }
        if let Some(mut page) = get_page(&result, load, &pin.id).await {
            append_unique(&mut page.parent_ids, list_key.clone());
            result.insert(pin.id.clone(), EntityEffect::Upsert(Entity::Page(page)));
        }
    }

    let mut name_map = get_name_to_id(&result, load, NAME_TO_ID_KEY)
        .await
        .unwrap_or_else(NameToIdManifest::new);
    touch_timestamp_map(&mut name_map.timestamps, &context.device_id, timestamp);
    name_map.paths.insert(
        format!("{list_owner_value}/{list_name}"),
        entity_slug(&list_key).to_string(),
    );
    result.insert(
        NAME_TO_ID_KEY.to_string(),
        EntityEffect::Upsert(Entity::NameToId(name_map)),
    );

    unorphan_key(&mut result, load, &context.device_id, &list_key, timestamp).await;
    Ok(result)
}
