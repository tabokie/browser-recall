use std::future::Future;

use crate::{
    append_unique, ensure_page, entities::Entity, is_page_eligible, orphan_key,
    snapshot_stem_from_path, unorphan_key, Context, EntityEffect, EntityMap, ReplayError,
    SNAPSHOT_PREFIX,
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
    let slug = crate::generate_slug_from_url(url)?;
    let page_key = format!("{}{}", crate::PAGE_PREFIX, slug);
    let mut created = false;
    let mut page = crate::load_page(load, &page_key).await.unwrap_or_else(|| {
        created = true;
        let mut page = crate::default_page(&slug);
        page.created_at = Some(timestamp);
        page
    });
    crate::touch_timestamp(&mut page, &context.device_id, timestamp);
    page.url = Some(url.to_string());
    if created {
        if let Some(title_value) = title {
            page.title = Some(title_value.to_string());
        }
    }
    append_unique(
        &mut page.child_ids,
        format!("{SNAPSHOT_PREFIX}{}", snapshot_stem_from_path(path)),
    );

    let mut result = EntityMap::new();
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
    if is_page_eligible(&page) {
        result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    } else {
        result.insert(page_key, EntityEffect::Delete);
    }
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
