#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

pub mod entities;
mod handlers;
pub mod settings;

pub use settings::PERSISTENT_SETTINGS_KEYS;

use chrono::{Local, TimeZone};
use entities::{
    Entity, ListEntity, ListOrderManifest, NameToIdManifest, NoteEntity, OrphanedEntry,
    OrphanedManifest, PageEntity, PinEntity, RuleEntity, SettingsEntity, TreeNode,
};
use handlers::{
    handle_add_rule, handle_create_list, handle_create_note, handle_create_snapshot,
    handle_delete_list, handle_delete_note, handle_delete_snapshot, handle_leave_page,
    handle_permanent_delete, handle_pin_to_list, handle_rate_page, handle_remove_rule,
    handle_rename_page, handle_replace_note, handle_restore_list, handle_restore_note,
    handle_restore_snapshot, handle_unpin_from_list, handle_update_list, handle_update_list_tree,
    handle_update_rule, handle_update_setting, handle_visit_page, CreateNoteRequest,
    ReplaceNoteRequest,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::{error::Error, fmt};
use url::Url;

pub(crate) const PAGE_PREFIX: &str = "page:";
pub(crate) const NOTE_PREFIX: &str = "note:";
pub(crate) const SNAPSHOT_PREFIX: &str = "snapshot:";
pub(crate) const LIST_PREFIX: &str = "list:";
pub(crate) const SETTINGS_KEY: &str = "manifest:settings";
pub(crate) const NAME_TO_ID_KEY: &str = "manifest:name-to-id";
pub(crate) const LIST_ORDER_KEY: &str = "manifest:list-order";
pub(crate) const ORPHANED_KEY: &str = "manifest:orphaned";
pub(crate) const REFERRER_CAP: usize = 50;

pub type EntityMap = BTreeMap<String, EntityEffect>;

fn deserialize_string_array_value<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None => Ok(None),
        Some(Value::Array(values)) => {
            if values.iter().all(Value::is_string) {
                Ok(Some(Value::Array(values)))
            } else {
                Err(serde::de::Error::custom(
                    "array values must contain strings only",
                ))
            }
        }
        Some(_) => Err(serde::de::Error::custom("value must be a string array")),
    }
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityEffect {
    Upsert(Entity),
    Delete,
}

impl EntityEffect {
    pub fn as_page(&self) -> Option<&PageEntity> {
        match self {
            Self::Upsert(Entity::Page(page)) => Some(page),
            _ => None,
        }
    }

    pub fn as_note(&self) -> Option<&NoteEntity> {
        match self {
            Self::Upsert(Entity::Note(note)) => Some(note),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&ListEntity> {
        match self {
            Self::Upsert(Entity::List(list)) => Some(list),
            _ => None,
        }
    }

    pub fn as_settings(&self) -> Option<&SettingsEntity> {
        match self {
            Self::Upsert(Entity::Settings(settings)) => Some(settings),
            _ => None,
        }
    }

    pub fn as_name_to_id(&self) -> Option<&NameToIdManifest> {
        match self {
            Self::Upsert(Entity::NameToId(manifest)) => Some(manifest),
            _ => None,
        }
    }

    pub fn as_list_order(&self) -> Option<&ListOrderManifest> {
        match self {
            Self::Upsert(Entity::ListOrder(manifest)) => Some(manifest),
            _ => None,
        }
    }

    pub fn as_orphaned(&self) -> Option<&OrphanedManifest> {
        match self {
            Self::Upsert(Entity::Orphaned(manifest)) => Some(manifest),
            _ => None,
        }
    }

    pub fn is_delete(&self) -> bool {
        matches!(self, Self::Delete)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Context {
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum LogEntry {
    VisitPage {
        timestamp: i64,
        url: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        title: Option<String>,
        #[serde(
            rename = "referrerUrl",
            deserialize_with = "deserialize_required_option"
        )]
        referrer_url: Option<String>,
    },
    LeavePage {
        timestamp: i64,
        url: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        title: Option<String>,
        #[serde(
            rename = "scrollDepth",
            deserialize_with = "deserialize_required_option"
        )]
        scroll_depth: Option<i64>,
        #[serde(
            rename = "timeOnPage",
            deserialize_with = "deserialize_required_option"
        )]
        time_on_page: Option<i64>,
    },
    RenamePage {
        timestamp: i64,
        url: String,
        #[serde(rename = "user_title")]
        user_title: String,
    },
    RatePage {
        timestamp: i64,
        url: String,
        likes: i64,
        #[serde(deserialize_with = "deserialize_required_option")]
        title: Option<String>,
    },
    UpdateSetting {
        timestamp: i64,
        key: String,
        value: Value,
    },
    PinToList {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
        urls: Vec<String>,
        #[serde(deserialize_with = "deserialize_required_option")]
        titles: Option<Vec<Option<String>>>,
        #[serde(deserialize_with = "deserialize_required_option")]
        source: Option<String>,
    },
    UnpinFromList {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
        urls: Vec<String>,
    },
    AddRule {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
        rule: RuleInput,
    },
    RemoveRule {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
        #[serde(rename = "ruleId")]
        rule_id: String,
    },
    UpdateRule {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
        #[serde(rename = "ruleId")]
        rule_id: String,
        config: BTreeMap<String, Value>,
    },
    CreateList {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
        #[serde(rename = "listId", deserialize_with = "deserialize_required_option")]
        list_id: Option<String>,
        #[serde(
            rename = "parentListId",
            deserialize_with = "deserialize_required_option"
        )]
        parent_list_id: Option<String>,
    },
    UpdateList {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
        #[serde(rename = "newName", deserialize_with = "deserialize_required_option")]
        new_name: Option<String>,
    },
    UpdateListTree {
        timestamp: i64,
        tree: Vec<TreeNode>,
    },
    DeleteList {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
    },
    RestoreList {
        timestamp: i64,
        name: String,
        #[serde(rename = "listOwner")]
        list_owner: String,
    },
    CreateNote {
        timestamp: i64,
        url: String,
        path: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        title: Option<String>,
        #[serde(deserialize_with = "deserialize_string_array_value")]
        excerpt: Option<Value>,
        #[serde(deserialize_with = "deserialize_required_option")]
        note: Option<String>,
        #[serde(
            rename = "cssPath",
            deserialize_with = "deserialize_string_array_value"
        )]
        css_path: Option<Value>,
    },
    DeleteNote {
        timestamp: i64,
        #[serde(deserialize_with = "deserialize_required_option")]
        url: Option<String>,
        path: String,
    },
    RestoreNote {
        timestamp: i64,
        #[serde(deserialize_with = "deserialize_required_option")]
        url: Option<String>,
        path: String,
    },
    ReplaceNote {
        timestamp: i64,
        #[serde(deserialize_with = "deserialize_required_option")]
        url: Option<String>,
        path: String,
        #[serde(rename = "oldPath")]
        old_path: String,
        #[serde(deserialize_with = "deserialize_string_array_value")]
        excerpt: Option<Value>,
        #[serde(deserialize_with = "deserialize_required_option")]
        note: Option<String>,
        #[serde(
            rename = "cssPath",
            deserialize_with = "deserialize_string_array_value"
        )]
        css_path: Option<Value>,
    },
    CreateSnapshot {
        timestamp: i64,
        url: String,
        path: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        title: Option<String>,
    },
    DeleteSnapshot {
        timestamp: i64,
        url: String,
        path: String,
    },
    RestoreSnapshot {
        timestamp: i64,
        url: String,
        path: String,
    },
    PermanentDelete {
        timestamp: i64,
        keys: Vec<String>,
    },
}

impl LogEntry {
    pub fn timestamp(&self) -> i64 {
        match self {
            Self::VisitPage { timestamp, .. }
            | Self::LeavePage { timestamp, .. }
            | Self::RenamePage { timestamp, .. }
            | Self::RatePage { timestamp, .. }
            | Self::UpdateSetting { timestamp, .. }
            | Self::PinToList { timestamp, .. }
            | Self::UnpinFromList { timestamp, .. }
            | Self::AddRule { timestamp, .. }
            | Self::RemoveRule { timestamp, .. }
            | Self::UpdateRule { timestamp, .. }
            | Self::CreateList { timestamp, .. }
            | Self::UpdateList { timestamp, .. }
            | Self::UpdateListTree { timestamp, .. }
            | Self::DeleteList { timestamp, .. }
            | Self::RestoreList { timestamp, .. }
            | Self::CreateNote { timestamp, .. }
            | Self::DeleteNote { timestamp, .. }
            | Self::RestoreNote { timestamp, .. }
            | Self::ReplaceNote { timestamp, .. }
            | Self::CreateSnapshot { timestamp, .. }
            | Self::DeleteSnapshot { timestamp, .. }
            | Self::RestoreSnapshot { timestamp, .. }
            | Self::PermanentDelete { timestamp, .. } => *timestamp,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayError {
    InvalidEntry(String),
    InvalidUrl(String),
    Load(String),
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEntry(message) => write!(f, "invalid log entry: {message}"),
            Self::InvalidUrl(url) => write!(f, "invalid url: {url}"),
            Self::Load(message) => write!(f, "replay entity load failed: {message}"),
        }
    }
}

impl Error for ReplayError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuleInput {
    #[serde(deserialize_with = "deserialize_required_option")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub rule_type: String,
    pub config: BTreeMap<String, Value>,
}

pub async fn effect_of<L, Fut>(
    entry: LogEntry,
    load: L,
    context: Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    match entry {
        LogEntry::VisitPage {
            timestamp,
            url,
            title,
            referrer_url,
        } => {
            handle_visit_page(
                timestamp,
                &url,
                title.as_deref(),
                referrer_url.as_deref(),
                &load,
                &context,
            )
            .await
        }
        LogEntry::LeavePage {
            timestamp,
            url,
            title,
            scroll_depth,
            time_on_page,
        } => {
            handle_leave_page(
                timestamp,
                &url,
                title.as_deref(),
                scroll_depth,
                time_on_page,
                &load,
                &context,
            )
            .await
        }
        LogEntry::RenamePage {
            timestamp,
            url,
            user_title,
        } => handle_rename_page(timestamp, &url, &user_title, &load, &context).await,
        LogEntry::RatePage {
            timestamp,
            url,
            likes,
            title,
        } => handle_rate_page(timestamp, &url, likes, title.as_deref(), &load, &context).await,
        LogEntry::UpdateSetting {
            timestamp,
            key,
            value,
        } => handle_update_setting(timestamp, &key, value, &load, &context).await,
        LogEntry::PinToList {
            timestamp,
            name,
            list_owner,
            urls,
            titles,
            source,
        } => {
            handle_pin_to_list(
                timestamp,
                &name,
                &list_owner,
                &urls,
                titles.as_ref(),
                source.as_deref(),
                &load,
                &context,
            )
            .await
        }
        LogEntry::UnpinFromList {
            timestamp,
            name,
            list_owner,
            urls,
        } => handle_unpin_from_list(timestamp, &name, &list_owner, &urls, &load, &context).await,
        LogEntry::AddRule {
            timestamp,
            name,
            list_owner,
            rule,
        } => handle_add_rule(timestamp, &name, &list_owner, rule, &load, &context).await,
        LogEntry::RemoveRule {
            timestamp,
            name,
            list_owner,
            rule_id,
        } => handle_remove_rule(timestamp, &name, &list_owner, &rule_id, &load, &context).await,
        LogEntry::UpdateRule {
            timestamp,
            name,
            list_owner,
            rule_id,
            config,
        } => {
            handle_update_rule(
                timestamp,
                &name,
                &list_owner,
                &rule_id,
                config,
                &load,
                &context,
            )
            .await
        }
        LogEntry::CreateList {
            timestamp,
            name,
            list_owner,
            list_id,
            parent_list_id,
        } => {
            handle_create_list(
                timestamp,
                &name,
                &list_owner,
                list_id.as_deref(),
                parent_list_id.as_deref(),
                &load,
                &context,
            )
            .await
        }
        LogEntry::UpdateList {
            timestamp,
            name,
            list_owner,
            new_name,
        } => {
            handle_update_list(
                timestamp,
                &name,
                &list_owner,
                new_name.as_deref(),
                &load,
                &context,
            )
            .await
        }
        LogEntry::UpdateListTree { timestamp, tree } => {
            handle_update_list_tree(timestamp, &tree, &load, &context).await
        }
        LogEntry::DeleteList {
            timestamp,
            name,
            list_owner,
        } => handle_delete_list(timestamp, &name, &list_owner, &load, &context).await,
        LogEntry::RestoreList {
            timestamp,
            name,
            list_owner,
        } => handle_restore_list(timestamp, &name, &list_owner, &load, &context).await,
        LogEntry::CreateNote {
            timestamp,
            url,
            path,
            title,
            excerpt,
            note,
            css_path,
        } => {
            handle_create_note(
                CreateNoteRequest {
                    timestamp,
                    url: &url,
                    path: &path,
                    title: title.as_deref(),
                    excerpt,
                    note_body: note.as_deref(),
                    css_path,
                },
                &load,
                &context,
            )
            .await
        }
        LogEntry::DeleteNote {
            timestamp,
            url,
            path,
        } => handle_delete_note(timestamp, url.as_deref(), &path, &load, &context).await,
        LogEntry::RestoreNote {
            timestamp,
            url,
            path,
        } => handle_restore_note(timestamp, url.as_deref(), &path, &load, &context).await,
        LogEntry::ReplaceNote {
            timestamp,
            url,
            path,
            old_path,
            excerpt,
            note,
            css_path,
        } => {
            handle_replace_note(
                ReplaceNoteRequest {
                    timestamp,
                    url: url.as_deref(),
                    path: &path,
                    old_path: &old_path,
                    excerpt,
                    note_body: note.as_deref(),
                    css_path,
                },
                &load,
                &context,
            )
            .await
        }
        LogEntry::CreateSnapshot {
            timestamp,
            url,
            path,
            title,
        } => {
            handle_create_snapshot(timestamp, &url, &path, title.as_deref(), &load, &context).await
        }
        LogEntry::DeleteSnapshot {
            timestamp,
            url,
            path,
        } => handle_delete_snapshot(timestamp, &url, &path, &load, &context).await,
        LogEntry::RestoreSnapshot {
            timestamp,
            url,
            path,
        } => handle_restore_snapshot(timestamp, &url, &path, &load, &context).await,
        LogEntry::PermanentDelete { timestamp, keys } => {
            handle_permanent_delete(timestamp, &keys, &load, &context).await
        }
    }
}

pub(crate) async fn load_page<L, Fut>(load: &L, key: &str) -> Option<PageEntity>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    load(key).await.and_then(Entity::into_page)
}

pub(crate) async fn load_note<L, Fut>(load: &L, key: &str) -> Option<NoteEntity>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    load(key).await.and_then(Entity::into_note)
}

pub(crate) async fn load_list<L, Fut>(load: &L, key: &str) -> Option<ListEntity>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    load(key).await.and_then(Entity::into_list)
}

pub(crate) async fn load_settings<L, Fut>(load: &L, key: &str) -> Option<SettingsEntity>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    load(key).await.and_then(Entity::into_settings)
}

pub(crate) async fn load_name_to_id<L, Fut>(load: &L, key: &str) -> Option<NameToIdManifest>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    load(key).await.and_then(Entity::into_name_to_id)
}

pub(crate) async fn load_list_order<L, Fut>(load: &L, key: &str) -> Option<ListOrderManifest>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    load(key).await.and_then(Entity::into_list_order)
}

pub(crate) async fn load_orphaned<L, Fut>(load: &L, key: &str) -> Option<OrphanedManifest>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    load(key).await.and_then(Entity::into_orphaned)
}

pub(crate) fn default_page(slug: &str) -> PageEntity {
    PageEntity::new(slug.to_string())
}

pub(crate) fn default_note(slug: &str) -> NoteEntity {
    NoteEntity::new(slug.to_string())
}

pub(crate) fn default_orphaned() -> OrphanedManifest {
    OrphanedManifest::new()
}

pub(crate) async fn get_page<L, Fut>(result: &EntityMap, load: &L, key: &str) -> Option<PageEntity>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(effect) = result.get(key) {
        return match effect {
            EntityEffect::Upsert(Entity::Page(page)) => Some(page.clone()),
            _ => None,
        };
    }
    load_page(load, key).await
}

pub(crate) async fn get_list<L, Fut>(result: &EntityMap, load: &L, key: &str) -> Option<ListEntity>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(effect) = result.get(key) {
        return match effect {
            EntityEffect::Upsert(Entity::List(list)) => Some(list.clone()),
            _ => None,
        };
    }
    load_list(load, key).await
}

pub(crate) async fn get_name_to_id<L, Fut>(
    result: &EntityMap,
    load: &L,
    key: &str,
) -> Option<NameToIdManifest>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(effect) = result.get(key) {
        return match effect {
            EntityEffect::Upsert(Entity::NameToId(manifest)) => Some(manifest.clone()),
            _ => None,
        };
    }
    load_name_to_id(load, key).await
}

pub(crate) async fn get_list_order<L, Fut>(
    result: &EntityMap,
    load: &L,
    key: &str,
) -> Option<ListOrderManifest>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(effect) = result.get(key) {
        return match effect {
            EntityEffect::Upsert(Entity::ListOrder(manifest)) => Some(manifest.clone()),
            _ => None,
        };
    }
    load_list_order(load, key).await
}

pub(crate) async fn get_orphaned<L, Fut>(
    result: &EntityMap,
    load: &L,
    key: &str,
) -> Option<OrphanedManifest>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if let Some(effect) = result.get(key) {
        return match effect {
            EntityEffect::Upsert(Entity::Orphaned(manifest)) => Some(manifest.clone()),
            _ => None,
        };
    }
    load_orphaned(load, key).await
}

pub(crate) async fn find_lists_with_pin<L, Fut>(
    result: &EntityMap,
    load: &L,
    pin_id: &str,
) -> Result<Vec<(String, ListEntity)>, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let Some(name_map) = get_name_to_id(result, load, NAME_TO_ID_KEY).await else {
        // The list index is created by the first create_list entry. Its absence
        // therefore means this projection has never contained a list.
        return Ok(Vec::new());
    };
    let mut seen = HashSet::new();
    let mut matches = Vec::new();
    for list_id in name_map.paths.values() {
        let list_key = format!("{LIST_PREFIX}{list_id}");
        if !seen.insert(list_key.clone()) {
            continue;
        }
        let list = get_list(result, load, &list_key).await.ok_or_else(|| {
            ReplayError::InvalidEntry(format!("name-to-id references missing list: {list_key}"))
        })?;
        let owner = list.owner.clone();
        validate_list_identity(&list_key, &list, &owner)?;
        if list.pins.iter().any(|pin| pin.id == pin_id) {
            matches.push((list_key, list));
        }
    }
    Ok(matches)
}

pub(crate) async fn ensure_page<L, Fut>(
    load: &L,
    url: &str,
    timestamp: i64,
) -> Result<(String, PageEntity), ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let slug = generate_slug_from_url(url)?;
    let page_key = format!("{PAGE_PREFIX}{slug}");
    let mut page = load_page(load, &page_key).await.unwrap_or_else(|| {
        let mut page = default_page(&slug);
        if timestamp > 0 {
            page.created_at = Some(timestamp);
        }
        page
    });
    if timestamp > 0 {
        page.created_at = Some(
            page.created_at
                .map_or(timestamp, |created_at| created_at.min(timestamp)),
        );
    }
    if page.url.is_none() {
        page.url = Some(url.to_string());
    }
    Ok((page_key, page))
}

pub(crate) async fn ensure_page_with_overlay<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    url: &str,
    timestamp: i64,
    title: Option<&str>,
    context: &Context,
) -> Result<(String, PageEntity), ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let slug = generate_slug_from_url(url)?;
    let page_key = format!("{PAGE_PREFIX}{slug}");
    let mut created = false;
    let mut page = get_page(result, load, &page_key).await.unwrap_or_else(|| {
        created = true;
        let mut page = default_page(&slug);
        if timestamp > 0 {
            page.created_at = Some(timestamp);
        }
        page
    });
    if timestamp > 0 {
        page.created_at = Some(
            page.created_at
                .map_or(timestamp, |created_at| created_at.min(timestamp)),
        );
    }
    page.url = Some(url.to_string());
    if created {
        if let Some(title) = title {
            page.title = Some(title.to_string());
        }
    }
    touch_timestamp(&mut page, &context.device_id, timestamp);
    Ok((page_key, page))
}

pub(crate) fn touch_timestamp(page: &mut PageEntity, device_id: &str, timestamp: i64) {
    touch_timestamp_map(&mut page.timestamps, device_id, timestamp);
}

pub(crate) fn touch_timestamp_map(
    timestamps: &mut HashMap<String, i64>,
    device_id: &str,
    timestamp: i64,
) {
    let current = timestamps.get(device_id).copied().unwrap_or(0);
    timestamps.insert(device_id.to_string(), current.max(timestamp));
}

pub(crate) fn append_unique(items: &mut Vec<String>, value: String) {
    if !items.contains(&value) {
        items.push(value);
        items.sort_unstable();
    }
}

pub(crate) fn note_slug_from_path(path: &str) -> Result<&str, ReplayError> {
    let slug = path
        .strip_prefix("objects/notes/")
        .and_then(|value| value.strip_suffix(".json"))
        .ok_or_else(|| {
            ReplayError::InvalidEntry(format!(
                "note path must be objects/notes/<slug>.json: {path}"
            ))
        })?;
    if slug.is_empty() || slug.contains('/') || slug == "." || slug == ".." {
        return Err(ReplayError::InvalidEntry(format!(
            "note path contains an invalid slug: {path}"
        )));
    }
    Ok(slug)
}

pub(crate) fn snapshot_stem_from_path(path: &str) -> Result<&str, ReplayError> {
    let relative = path.strip_prefix("objects/snapshots/").ok_or_else(|| {
        ReplayError::InvalidEntry(format!(
            "snapshot path must start with objects/snapshots/: {path}"
        ))
    })?;
    let (shard, stem) = relative.split_once('/').ok_or_else(|| {
        ReplayError::InvalidEntry(format!("snapshot path is missing its shard: {path}"))
    })?;
    if shard.len() != 2 || !shard.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ReplayError::InvalidEntry(format!(
            "snapshot path has an invalid shard: {path}"
        )));
    }
    let (slug, timestamp) = stem.rsplit_once('-').ok_or_else(|| {
        ReplayError::InvalidEntry(format!("snapshot path is missing its timestamp: {path}"))
    })?;
    if slug.is_empty()
        || slug.contains('/')
        || timestamp.parse::<i64>().is_err()
        || relative.matches('/').count() != 1
    {
        return Err(ReplayError::InvalidEntry(format!(
            "snapshot path has an invalid stem: {path}"
        )));
    }
    Ok(stem)
}

pub(crate) fn entity_slug(key: &str) -> &str {
    key.split_once(':').map(|(_, suffix)| suffix).unwrap_or(key)
}

pub(crate) fn is_system_list(key: &str) -> bool {
    key.starts_with("list:system/")
}

pub(crate) fn validate_list_identity(
    key: &str,
    list: &ListEntity,
    expected_owner: &str,
) -> Result<(), ReplayError> {
    if list.owner != expected_owner {
        return Err(ReplayError::InvalidEntry(format!(
            "{key} owner {:?} does not match command owner {expected_owner:?}",
            list.owner
        )));
    }
    if list.name.trim().is_empty() {
        return Err(ReplayError::InvalidEntry(format!(
            "{key} has no name; migrate browser data before replay"
        )));
    }
    Ok(())
}

pub fn page_retains_checkpoint(page: &PageEntity) -> bool {
    page.parent_ids.iter().any(|id| id.starts_with("list:"))
        || page
            .child_ids
            .iter()
            .any(|id| id.starts_with(NOTE_PREFIX) || id.starts_with(SNAPSHOT_PREFIX))
        || page
            .user_title
            .as_deref()
            .is_some_and(|title| !title.is_empty())
        || page.likes.unwrap_or(0) != 0
}

pub(crate) fn retain_page_or_delete(result: &mut EntityMap, key: String, page: PageEntity) {
    let effect = if page_retains_checkpoint(&page) {
        EntityEffect::Upsert(Entity::Page(page))
    } else {
        EntityEffect::Delete
    };
    result.insert(key, effect);
}

pub(crate) fn append_capped_page_reference(items: &mut Vec<String>, value: String) {
    if items.contains(&value) {
        return;
    }
    items.push(value);
    if items
        .iter()
        .filter(|item| item.starts_with(PAGE_PREFIX))
        .count()
        > REFERRER_CAP
    {
        if let Some(oldest_page_index) = items.iter().position(|item| item.starts_with(PAGE_PREFIX))
        {
            items.remove(oldest_page_index);
        }
    }
}

pub(crate) async fn resolve_list_key<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    name: &str,
    list_owner: &str,
) -> Result<Option<String>, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    if name.starts_with("system/") {
        return Ok(Some(format!("{LIST_PREFIX}{name}")));
    }

    let name_map = get_name_to_id(result, load, NAME_TO_ID_KEY)
        .await
        .ok_or_else(|| ReplayError::InvalidEntry("name-to-id manifest is missing".to_string()))?;
    if let Some(list_id) = name_map.paths.get(&format!("{list_owner}/{name}")) {
        return Ok(Some(format!("{LIST_PREFIX}{list_id}")));
    }

    let orphaned = get_orphaned(result, load, ORPHANED_KEY)
        .await
        .unwrap_or_else(default_orphaned);
    for orphan in orphaned.entries {
        if !orphan.key.starts_with(LIST_PREFIX) || is_system_list(&orphan.key) {
            continue;
        }
        if let Some(list) = get_list(result, load, &orphan.key).await {
            if list.owner == list_owner && list.name == name {
                return Ok(Some(orphan.key));
            }
        }
    }
    Ok(None)
}

pub(crate) async fn orphan_key<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    device_id: &str,
    child_key: &str,
    timestamp: i64,
    parent_url: Option<String>,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut orphaned = get_orphaned(result, load, ORPHANED_KEY)
        .await
        .unwrap_or_else(default_orphaned);
    if !orphaned.entries.iter().any(|entry| entry.key == child_key) {
        orphaned.entries.push(OrphanedEntry {
            key: child_key.to_string(),
            url: parent_url,
        });
    }
    touch_timestamp_map(&mut orphaned.timestamps, device_id, timestamp);
    result.insert(
        ORPHANED_KEY.to_string(),
        EntityEffect::Upsert(Entity::Orphaned(orphaned)),
    );
}

pub(crate) async fn unorphan_key<L, Fut>(
    result: &mut EntityMap,
    load: &L,
    device_id: &str,
    child_key: &str,
    timestamp: i64,
) where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut orphaned = get_orphaned(result, load, ORPHANED_KEY)
        .await
        .unwrap_or_else(default_orphaned);
    orphaned.entries.retain(|entry| entry.key != child_key);
    touch_timestamp_map(&mut orphaned.timestamps, device_id, timestamp);
    result.insert(
        ORPHANED_KEY.to_string(),
        EntityEffect::Upsert(Entity::Orphaned(orphaned)),
    );
}

pub(crate) fn append_to_tree(
    tree: &[TreeNode],
    list_id: &str,
    parent_id: Option<&str>,
) -> Vec<TreeNode> {
    let new_node = TreeNode {
        id: list_id.to_string(),
        children: Vec::new(),
    };
    let Some(parent_id) = parent_id else {
        let mut next = tree.to_vec();
        next.insert(0, new_node);
        return next;
    };
    let mut cloned = tree.to_vec();
    if append_to_tree_recursive(&mut cloned, list_id, parent_id) {
        cloned
    } else {
        cloned.push(new_node);
        cloned
    }
}

fn append_to_tree_recursive(nodes: &mut [TreeNode], list_id: &str, parent_id: &str) -> bool {
    for node in nodes {
        if node.id == parent_id {
            node.children.push(TreeNode {
                id: list_id.to_string(),
                children: Vec::new(),
            });
            return true;
        }
        if append_to_tree_recursive(&mut node.children, list_id, parent_id) {
            return true;
        }
    }
    false
}

pub(crate) fn remove_from_tree(tree: &[TreeNode], list_id: &str) -> Vec<TreeNode> {
    let mut output = Vec::new();
    for node in tree {
        if node.id == list_id {
            output.extend(node.children.clone());
        } else {
            let mut cloned = node.clone();
            cloned.children = remove_from_tree(&cloned.children, list_id);
            output.push(cloned);
        }
    }
    output
}

pub(crate) fn collect_tree_ids(tree: &[TreeNode]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for node in tree {
        ids.insert(node.id.clone());
        ids.extend(collect_tree_ids(&node.children));
    }
    ids
}

pub(crate) fn generate_list_id(name: &str, timestamp: i64) -> String {
    let base = normalized_slug_base(name);
    format!(
        "{base}-{}",
        to_base36(hash_string(&(name.to_string() + &timestamp.to_string())))
    )
}

pub(crate) fn generate_rule_id(rule_type: &str, timestamp: i64) -> Result<String, ReplayError> {
    let prefix = rule_type
        .chars()
        .next()
        .ok_or_else(|| ReplayError::InvalidEntry("rule type must not be empty".to_string()))?;
    let hash_input = format!("{rule_type}:{timestamp}");
    let suffix = to_base36(hash_string(&hash_input));
    Ok(format!(
        "rule-{prefix}-{}-{}",
        timestamp.to_string().to_lowercase(),
        &suffix[..suffix.len().min(4)]
    ))
}

fn hash_string(text: &str) -> u64 {
    let mut hash: i32 = 0;
    for unit in text.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit));
    }
    i64::from(hash).unsigned_abs()
}

pub(crate) fn local_visit_date(timestamp: i64) -> Result<i32, ReplayError> {
    let datetime = Local
        .timestamp_millis_opt(timestamp)
        .single()
        .ok_or_else(|| ReplayError::InvalidEntry(format!("invalid timestamp: {timestamp}")))?;
    let year = datetime.year();
    let month = i32::from(datetime.month() as u16);
    let day = i32::from(datetime.day() as u16);
    Ok(year * 10000 + month * 100 + day)
}

pub fn generate_slug_from_url(url: &str) -> Result<String, ReplayError> {
    let parsed = Url::parse(url).map_err(|_| ReplayError::InvalidUrl(url.to_string()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ReplayError::InvalidUrl(url.to_string()));
    }
    let mut domain = parsed
        .host_str()
        .ok_or_else(|| ReplayError::InvalidUrl(url.to_string()))?
        .to_lowercase();
    if let Some(stripped) = domain.strip_prefix("www.") {
        domain = stripped.to_string();
    }
    if let Some(last_dot) = domain.rfind('.') {
        if last_dot > 0 {
            domain.truncate(last_dot);
        }
    }

    let text = format!("{domain}{}", parsed.path());
    Ok(generate_slug(&text, url))
}

fn generate_slug(text: &str, hash_input: &str) -> String {
    let base = normalized_slug_base(text);
    let hash_str = to_base36(hash_string(hash_input));
    let mut slug = if base.is_empty() {
        hash_str
    } else {
        format!("{base}-{hash_str}")
    };
    if slug.len() > 80 {
        slug.truncate(80);
    }
    slug
}

fn normalized_slug_base(text: &str) -> String {
    let mut base = String::new();
    let mut pending_hyphen = false;
    for character in text.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_hyphen && !base.is_empty() {
                base.push('-');
            }
            pending_hyphen = false;
            base.push(character);
        } else {
            pending_hyphen = !base.is_empty();
        }
    }
    let mut base = base.trim_matches('-').chars().take(30).collect::<String>();
    while base.ends_with('-') {
        base.pop();
    }
    base
}

fn to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        let character = match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + (digit - 10)) as char,
        };
        digits.push(character);
        value /= 36;
    }
    digits.iter().rev().collect()
}

trait DateParts {
    fn year(&self) -> i32;
    fn month(&self) -> u32;
    fn day(&self) -> u32;
}

impl DateParts for chrono::DateTime<Local> {
    fn year(&self) -> i32 {
        chrono::Datelike::year(self)
    }

    fn month(&self) -> u32 {
        chrono::Datelike::month(self)
    }

    fn day(&self) -> u32 {
        chrono::Datelike::day(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_helpers_return_empty_entities() {
        let page = default_page("page-slug");
        assert_eq!(page.slug, "page-slug");
        assert!(page.parent_ids.is_empty());
        assert!(page.child_ids.is_empty());
        assert!(page.timestamps.is_empty());
        assert!(page.url.is_none());
        assert!(page.title.is_none());
        assert!(page.created_at.is_none());

        let note = default_note("note-slug");
        assert_eq!(note.slug, "note-slug");
        assert!(note.excerpt.is_none());
        assert!(note.note.is_none());
        assert!(!note.deleted);

        let name_map = NameToIdManifest::new();
        assert!(name_map.timestamps.is_empty());
        assert!(name_map.paths.is_empty());

        let orphaned = default_orphaned();
        assert!(orphaned.timestamps.is_empty());
        assert!(orphaned.entries.is_empty());
    }

    #[test]
    fn page_retains_checkpoint_matches_retention_rules() {
        let mut page = default_page("page-slug");
        assert!(!page_retains_checkpoint(&page));

        page.parent_ids.push("list:test".to_string());
        assert!(page_retains_checkpoint(&page));
        page.parent_ids = vec!["page:referrer".to_string()];
        assert!(!page_retains_checkpoint(&page));

        page.child_ids.push("note:n1".to_string());
        assert!(page_retains_checkpoint(&page));
        page.child_ids = vec!["snapshot:s1".to_string()];
        assert!(page_retains_checkpoint(&page));
        page.child_ids = vec!["page:child".to_string()];
        assert!(!page_retains_checkpoint(&page));

        page.user_title = Some("Kept".to_string());
        assert!(page_retains_checkpoint(&page));
        page.user_title = None;

        page.likes = Some(1);
        assert!(page_retains_checkpoint(&page));
    }

    #[test]
    fn url_slug_keeps_ordinary_query_params() {
        let first = generate_slug_from_url("https://example.com/page?article=1&_trace=old")
            .expect("first slug");
        let second = generate_slug_from_url("https://example.com/page?article=2&_trace=new")
            .expect("second slug");

        assert_ne!(first, second);
    }
}
