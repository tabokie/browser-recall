use std::future::Future;

use crate::{
    append_capped_page_reference, default_page, entities::Entity, load_page, local_visit_date,
    touch_timestamp, Context, EntityEffect, EntityMap, ReplayError, PAGE_PREFIX,
};

pub(crate) async fn handle_visit_page<L, Fut>(
    timestamp: i64,
    url: &str,
    title: Option<&str>,
    referrer_url: Option<&str>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let slug = crate::generate_slug_from_url(url)?;
    let page_key = format!("{PAGE_PREFIX}{slug}");
    let mut result = EntityMap::new();

    let maybe_page = load_page(load, &page_key).await;
    let mut page = maybe_page.unwrap_or_else(|| default_page(&slug));
    if page.created_at.is_none() {
        page.created_at = Some(timestamp);
    }

    touch_timestamp(&mut page, &context.device_id, timestamp);
    page.url = Some(url.to_string());
    if let Some(title_value) = title {
        page.title = Some(title_value.to_string());
    }
    let visit_date = local_visit_date(timestamp)?;
    if !page.visit_dates.contains(&visit_date) {
        page.visit_dates.push(visit_date);
    }
    let parent_key = referrer_url
        .map(crate::generate_slug_from_url)
        .transpose()?
        .map(|slug| format!("{PAGE_PREFIX}{slug}"));
    if let Some(parent_key) = &parent_key {
        append_capped_page_reference(&mut page.parent_ids, parent_key.clone());
    }
    result.insert(page_key.clone(), EntityEffect::Upsert(Entity::Page(page)));

    if let Some(parent_key) = parent_key {
        if parent_key != page_key {
            if let Some(mut parent) = load_page(load, &parent_key).await {
                touch_timestamp(&mut parent, &context.device_id, timestamp);
                append_capped_page_reference(&mut parent.child_ids, page_key);
                result.insert(parent_key, EntityEffect::Upsert(Entity::Page(parent)));
            }
        }
    }

    Ok(result)
}

pub(crate) async fn handle_leave_page<L, Fut>(
    timestamp: i64,
    url: &str,
    title: Option<&str>,
    scroll_depth: Option<i64>,
    time_on_page: Option<i64>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let slug = crate::generate_slug_from_url(url)?;
    let page_key = format!("{PAGE_PREFIX}{slug}");
    let Some(mut page) = load_page(load, &page_key).await else {
        return Ok(EntityMap::new());
    };

    let prior_device_ts = page
        .timestamps
        .get(&context.device_id)
        .copied()
        .unwrap_or(0);
    touch_timestamp(&mut page, &context.device_id, timestamp);

    if let Some(title_value) = title {
        page.title = Some(title_value.to_string());
    }
    if timestamp > prior_device_ts {
        if let Some(scroll_value) = scroll_depth {
            page.scroll_depth = Some(page.scroll_depth.unwrap_or(0).max(scroll_value));
        }
        if let Some(time_value) = time_on_page {
            page.time_on_page = Some(page.time_on_page.unwrap_or(0) + time_value);
        }
    }

    let mut result = EntityMap::new();
    result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    Ok(result)
}

pub(crate) async fn handle_rename_page<L, Fut>(
    timestamp: i64,
    url: &str,
    user_title: &str,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let slug = crate::generate_slug_from_url(url)?;
    let page_key = format!("{PAGE_PREFIX}{slug}");
    let mut page = load_page(load, &page_key)
        .await
        .unwrap_or_else(|| default_page(&slug));
    if page.created_at.is_none() {
        page.created_at = Some(timestamp);
    }
    touch_timestamp(&mut page, &context.device_id, timestamp);
    page.url = Some(url.to_string());
    page.user_title = Some(user_title.to_string());

    let mut result = EntityMap::new();
    result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    Ok(result)
}

pub(crate) async fn handle_rate_page<L, Fut>(
    timestamp: i64,
    url: &str,
    likes: i64,
    title: Option<&str>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let slug = crate::generate_slug_from_url(url)?;
    let page_key = format!("{PAGE_PREFIX}{slug}");
    let mut created = false;
    let mut page = load_page(load, &page_key).await.unwrap_or_else(|| {
        created = true;
        default_page(&slug)
    });
    if page.created_at.is_none() {
        page.created_at = Some(timestamp);
    }
    let prior_device_ts = page
        .timestamps
        .get(&context.device_id)
        .copied()
        .unwrap_or(0);
    if timestamp <= prior_device_ts {
        return Ok(EntityMap::new());
    }
    touch_timestamp(&mut page, &context.device_id, timestamp);
    page.url = Some(url.to_string());
    if created {
        if let Some(title_value) = title {
            page.title = Some(title_value.to_string());
        }
    }
    page.likes = Some(page.likes.unwrap_or(0) + likes);

    let mut result = EntityMap::new();
    result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    Ok(result)
}
