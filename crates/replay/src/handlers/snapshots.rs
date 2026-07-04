use std::future::Future;

use crate::{
    append_unique, ensure_page, ensure_page_with_overlay, entities::Entity, orphan_key,
    retain_page_or_delete, snapshot_stem_from_path, unorphan_key, Context, EntityEffect, EntityMap,
    ReplayError, SNAPSHOT_PREFIX,
};

pub(crate) async fn handle_create_snapshot<L, Fut>(
    timestamp: i64,
    url: &str,
    path: &str,
    title: Option<&str>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    let (page_key, mut page) =
        ensure_page_with_overlay(&mut result, load, url, timestamp, title, context).await?;
    append_unique(
        &mut page.child_ids,
        format!("{SNAPSHOT_PREFIX}{}", snapshot_stem_from_path(path)),
    );

    result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    Ok(result)
}

pub(crate) async fn handle_delete_snapshot<L, Fut>(
    timestamp: i64,
    url: &str,
    path: &str,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let (page_key, mut page) = ensure_page(load, url, 0).await?;
    let snapshot_key = format!("{SNAPSHOT_PREFIX}{}", snapshot_stem_from_path(path));
    page.child_ids.retain(|child| child != &snapshot_key);

    let mut result = EntityMap::new();
    retain_page_or_delete(&mut result, page_key, page);
    orphan_key(
        &mut result,
        load,
        &context.device_id,
        &snapshot_key,
        timestamp,
        Some(url.to_string()),
    )
    .await;
    Ok(result)
}

pub(crate) async fn handle_restore_snapshot<L, Fut>(
    timestamp: i64,
    url: &str,
    path: &str,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let (page_key, mut page) = ensure_page(load, url, timestamp).await?;
    let snapshot_key = format!("{SNAPSHOT_PREFIX}{}", snapshot_stem_from_path(path));
    append_unique(&mut page.child_ids, snapshot_key.clone());

    let mut result = EntityMap::new();
    result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    unorphan_key(
        &mut result,
        load,
        &context.device_id,
        &snapshot_key,
        timestamp,
    )
    .await;
    Ok(result)
}
