use std::future::Future;

use serde_json::Value;

use crate::{
    append_unique, default_note, ensure_page, ensure_page_with_overlay, entities::Entity,
    find_lists_with_pin, get_orphaned, load_note, note_slug_from_path, orphan_key,
    retain_page_or_delete, unorphan_key, Context, EntityEffect, EntityMap, ReplayError,
    NOTE_PREFIX, ORPHANED_KEY,
};

pub(crate) struct CreateNoteRequest<'a> {
    pub timestamp: i64,
    pub url: &'a str,
    pub path: &'a str,
    pub title: Option<&'a str>,
    pub excerpt: Option<Value>,
    pub note_body: Option<&'a str>,
    pub css_path: Option<Value>,
}

pub(crate) struct ReplaceNoteRequest<'a> {
    pub timestamp: i64,
    pub url: Option<&'a str>,
    pub path: &'a str,
    pub old_path: &'a str,
    pub excerpt: Option<Value>,
    pub note_body: Option<&'a str>,
    pub css_path: Option<Value>,
}

pub(crate) async fn handle_create_note<L, Fut>(
    request: CreateNoteRequest<'_>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let CreateNoteRequest {
        timestamp,
        url,
        path,
        title,
        excerpt,
        note_body,
        css_path,
    } = request;
    let note_slug = note_slug_from_path(path)?;
    let note_key = format!("{NOTE_PREFIX}{note_slug}");

    let mut note = load_note(load, &note_key)
        .await
        .unwrap_or_else(|| default_note(note_slug));
    note.excerpt = excerpt.or(note.excerpt);
    note.note = note_body.map(str::to_string).or(note.note);
    note.css_path = css_path.or(note.css_path);
    note.url = Some(url.to_string());
    if note.deleted_ts.unwrap_or(i64::MIN) < timestamp {
        note.deleted = false;
        note.deleted_ts = None;
        note.deletion_reason = None;
        note.replaced_by = None;
    }

    let mut result = EntityMap::new();
    if !note.deleted {
        let (page_key, mut page) =
            ensure_page_with_overlay(&mut result, load, url, timestamp, title, context).await?;
        append_unique(&mut page.child_ids, note_key.clone());
        result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    }
    result.insert(note_key, EntityEffect::Upsert(Entity::Note(note)));
    Ok(result)
}

pub(crate) async fn handle_delete_note<L, Fut>(
    timestamp: i64,
    url: Option<&str>,
    path: &str,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let note_slug = note_slug_from_path(path)?;
    let note_key = format!("{NOTE_PREFIX}{note_slug}");
    let mut note = load_note(load, &note_key)
        .await
        .unwrap_or_else(|| default_note(note_slug));

    if note.deleted_ts.unwrap_or(0) >= timestamp {
        return Ok(EntityMap::new());
    }

    let note_url = note.url.clone().or_else(|| url.map(str::to_string));
    note.deleted = true;
    note.deleted_ts = Some(timestamp);

    let mut result = EntityMap::new();
    result.insert(note_key.clone(), EntityEffect::Upsert(Entity::Note(note)));

    if let Some(note_url) = note_url.as_deref() {
        let (page_key, mut page) = ensure_page(load, note_url, timestamp).await?;
        page.child_ids.retain(|child| child != &note_key);
        retain_page_or_delete(&mut result, page_key, page);
    }

    for (list_key, mut list) in find_lists_with_pin(&result, load, &note_key).await? {
        list.pins.retain(|pin| pin.id != note_key);
        result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
    }

    orphan_key(
        &mut result,
        load,
        &context.device_id,
        &note_key,
        timestamp,
        note_url,
    )
    .await;

    Ok(result)
}

pub(crate) async fn handle_restore_note<L, Fut>(
    timestamp: i64,
    url: Option<&str>,
    path: &str,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let note_slug = note_slug_from_path(path)?;
    let note_key = format!("{NOTE_PREFIX}{note_slug}");
    let mut note = load_note(load, &note_key)
        .await
        .unwrap_or_else(|| default_note(note_slug));

    if note.deleted_ts.unwrap_or(0) >= timestamp {
        return Ok(EntityMap::new());
    }

    let orphaned = get_orphaned(&EntityMap::new(), load, ORPHANED_KEY).await;
    let note_url = orphaned
        .as_ref()
        .and_then(|manifest| manifest.entries.iter().find(|entry| entry.key == note_key))
        .and_then(|entry| entry.url.clone())
        .or_else(|| note.url.clone())
        .or_else(|| url.map(str::to_string));
    note.deleted = false;
    note.deleted_ts = Some(timestamp);

    let mut result = EntityMap::new();
    result.insert(note_key.clone(), EntityEffect::Upsert(Entity::Note(note)));

    if let Some(note_url) = note_url {
        let (page_key, mut page) = ensure_page(load, &note_url, timestamp).await?;
        append_unique(&mut page.child_ids, note_key.clone());
        result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    }

    unorphan_key(&mut result, load, &context.device_id, &note_key, timestamp).await;

    Ok(result)
}

pub(crate) async fn handle_replace_note<L, Fut>(
    request: ReplaceNoteRequest<'_>,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let ReplaceNoteRequest {
        timestamp,
        url,
        path,
        old_path,
        excerpt,
        note_body,
        css_path,
    } = request;
    let old_note_slug = note_slug_from_path(old_path)?;
    let new_note_slug = note_slug_from_path(path)?;
    let old_note_key = format!("{NOTE_PREFIX}{old_note_slug}");
    let new_note_key = format!("{NOTE_PREFIX}{new_note_slug}");

    let mut old_note = load_note(load, &old_note_key)
        .await
        .unwrap_or_else(|| default_note(old_note_slug));
    let note_url = old_note.url.clone().or_else(|| url.map(str::to_string));
    let replacement_is_current = old_note.deleted_ts.unwrap_or(i64::MIN) < timestamp;

    let mut result = EntityMap::new();

    if replacement_is_current {
        let note_url = note_url.as_deref().ok_or_else(|| {
            ReplayError::InvalidEntry(format!("replacement source note {old_note_key} has no URL"))
        })?;
        let (page_key, mut page) = ensure_page(load, note_url, timestamp).await?;
        page.child_ids.retain(|child| child != &old_note_key);
        result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    }

    if replacement_is_current {
        for (list_key, mut list) in find_lists_with_pin(&result, load, &old_note_key).await? {
            for pin in &mut list.pins {
                if pin.id == old_note_key {
                    pin.id = new_note_key.clone();
                }
            }
            result.insert(list_key, EntityEffect::Upsert(Entity::List(list)));
        }
    }

    let mut new_note = load_note(load, &new_note_key)
        .await
        .unwrap_or_else(|| default_note(new_note_slug));
    new_note.excerpt = excerpt.or(new_note.excerpt);
    new_note.note = note_body.map(str::to_string).or(new_note.note);
    new_note.css_path = css_path.or(new_note.css_path);
    new_note.url = note_url.clone();
    if new_note.deleted_ts.unwrap_or(i64::MIN) < timestamp {
        new_note.deleted = false;
        new_note.deleted_ts = None;
        new_note.deletion_reason = None;
        new_note.replaced_by = None;
    }
    if !new_note.deleted {
        let note_url = new_note.url.as_deref().ok_or_else(|| {
            ReplayError::InvalidEntry(format!("replacement note {new_note_key} has no source URL"))
        })?;
        let (page_key, mut page) =
            ensure_page_with_overlay(&mut result, load, note_url, timestamp, None, context).await?;
        append_unique(&mut page.child_ids, new_note_key.clone());
        result.insert(page_key, EntityEffect::Upsert(Entity::Page(page)));
    }
    result.insert(
        new_note_key.clone(),
        EntityEffect::Upsert(Entity::Note(new_note)),
    );

    if replacement_is_current {
        old_note.url = note_url;
        old_note.deleted = true;
        old_note.deleted_ts = Some(timestamp);
        old_note.deletion_reason = Some("replaced".to_string());
        old_note.replaced_by = Some(new_note_key.clone());
        result.insert(
            old_note_key.clone(),
            EntityEffect::Upsert(Entity::Note(old_note)),
        );
    }
    if replacement_is_current {
        unorphan_key(
            &mut result,
            load,
            &context.device_id,
            &old_note_key,
            timestamp,
        )
        .await;
    }

    Ok(result)
}
