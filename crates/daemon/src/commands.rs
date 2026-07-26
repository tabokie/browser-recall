use crate::connectors::{current_local_day_start_unix, prune_inactive_connectors};
use crate::search::{search_notes_in_storage, search_snapshots_in_data_dir};
use crate::storage::{HistoryFileListing, Storage};
use crate::{
    protocol::{RuleBatchEntry, RulePayload},
    rules::{preview_rule, validate_rule, PageData, RuleSpec},
    runtime::{self, ReplayTransaction},
};
use browser_recall_replay::entities::{Entity, ListEntity, TreeNode};
use browser_recall_replay::{
    generate_slug_from_url, LogEntry, RuleInput, PERSISTENT_SETTINGS_KEYS,
};
use chrono::TimeZone;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedBrowserInfo {
    pub browser_id: String,
    pub browser_name: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub browser_profile: Option<String>,
    pub extension_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub approved_at: Option<i64>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub last_seen: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookmarkImportNode {
    pub title: String,
    pub bookmarks: Vec<BookmarkImportEntry>,
    pub skipped: Vec<BookmarkImportSkipped>,
    pub children: Vec<BookmarkImportNode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BookmarkImportEntry {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BookmarkImportSkipped {
    pub url: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryImportEntry {
    pub url: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub title: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub referrer_url: Option<String>,
    pub visit_times: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateNoteInput {
    pub page_slug: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub excerpt: Option<Value>,
    pub note: Option<String>,
    pub css_path: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToggleListPinInput {
    pub list_id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddListPinsInput {
    pub list_id: String,
    pub urls: Vec<String>,
    pub titles: Option<Vec<Option<String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveListMetaInput {
    pub list_id: Option<String>,
    pub name: Option<String>,
    pub parent_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateListAndPinInput {
    pub name: String,
    pub url: String,
    pub title: Option<String>,
}

pub async fn page_relations_payload(storage: &Storage, url: &str) -> Result<Value, String> {
    let slug = generate_slug_from_url(url).map_err(|error| error.to_string())?;
    crate::read_projections::ReadProjections::new(storage.clone())
        .page_info(&slug)
        .await?;
    let page = storage
        .load_page_coordinated(&slug)
        .await
        .map_err(|error| error.to_string())?;
    let Some(page) = page else {
        return Ok(json!({
            "parents": { "referrers": [], "lists": [] },
            "children": [],
        }));
    };

    let mut parent_referrers = Vec::new();
    let mut parent_lists = Vec::new();
    for parent_id in &page.parent_ids {
        if let Some(parent_slug) = parent_id.strip_prefix("page:") {
            let parent_page = storage
                .load_page_coordinated(parent_slug)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    format!("page {slug} references missing parent page {parent_slug}")
                })?;
            let parent_url = parent_page.url.ok_or_else(|| {
                format!("parent page {parent_slug} referenced by {slug} is missing its URL")
            })?;
            parent_referrers.push(parent_url);
            continue;
        }

        if let Some(list_slug) = parent_id.strip_prefix("list:") {
            let list_entity = storage
                .load_list_coordinated(list_slug)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("page {slug} references missing list {list_slug}"))?;
            parent_lists.push(json!({
                "slug": list_slug,
                "name": list_entity.name,
                "type": "pin",
            }));
            continue;
        }

        return Err(format!(
            "page {slug} has unsupported parent reference {parent_id}"
        ));
    }

    let mut children = Vec::new();
    for child_id in &page.child_ids {
        let Some(child_slug) = child_id.strip_prefix("page:") else {
            if child_id.starts_with("note:") || child_id.starts_with("snapshot:") {
                continue;
            }
            return Err(format!(
                "page {slug} has unsupported child reference {child_id}"
            ));
        };
        let child_page = storage
            .load_page_coordinated(child_slug)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("page {slug} references missing child page {child_slug}"))?;
        let child_url = child_page.url.ok_or_else(|| {
            format!("child page {child_slug} referenced by {slug} is missing its URL")
        })?;
        children.push(Value::String(child_url));
    }

    Ok(json!({
        "parents": {
            "referrers": parent_referrers,
            "lists": parent_lists,
        },
        "children": children,
    }))
}

pub async fn get_snapshot_html(
    storage: &Storage,
    slug: &str,
    timestamp: i64,
) -> Result<Option<String>, String> {
    storage
        .load_snapshot_html(slug, timestamp)
        .await
        .map_err(|error| error.to_string())
}

pub async fn list_history_files(
    storage: &Storage,
    include_sizes: bool,
) -> Result<HistoryFileListing, String> {
    let mut listing = storage
        .list_history_files(include_sizes)
        .await
        .map_err(|error| error.to_string())?;
    if listing.sizes.is_none() {
        listing.sizes = Some(BTreeMap::new());
    }
    Ok(listing)
}

pub async fn load_history_batch(storage: &Storage, files: &[String]) -> Result<Vec<Value>, String> {
    storage
        .load_history_batch(files)
        .await
        .map_err(|error| error.to_string())
}

pub async fn search_notes(
    storage: &Storage,
    query: &str,
) -> Result<Vec<crate::search::NoteSearchHit>, String> {
    search_notes_in_storage(storage, query, None)
        .await
        .map_err(|error| error.to_string())
}

pub fn search_snapshots(
    storage: &Storage,
    query: &str,
) -> Result<Vec<crate::search::SnapshotSearchHit>, String> {
    search_snapshots_in_data_dir(storage.root(), query, None).map_err(|error| error.to_string())
}

pub async fn replay_entry(
    storage: &Storage,
    device_id: &str,
    entry: LogEntry,
) -> Result<(), String> {
    replay_entries(storage, device_id, vec![entry]).await
}

pub async fn replay_entries(
    storage: &Storage,
    device_id: &str,
    entries: Vec<LogEntry>,
) -> Result<(), String> {
    runtime::commit_local_entries(storage, device_id, entries)
        .await
        .map(|_| ())
}

async fn replay_entries_in_transaction(
    mut transaction: ReplayTransaction<'_>,
    entries: Vec<LogEntry>,
) -> Result<(), String> {
    for entry in entries {
        transaction.apply(entry).await?;
    }
    transaction.commit().await.map(|_| ())
}

pub async fn recover_checkpoint_tail(storage: &Storage) -> Result<usize, String> {
    runtime::recover_checkpoint_tail(storage).await
}

pub async fn submit_event(
    storage: &Storage,
    device_id: &str,
    entry: Value,
) -> Result<Value, String> {
    let parsed = serde_json::from_value::<LogEntry>(entry).map_err(|error| error.to_string())?;
    let timestamp = parsed.timestamp();
    replay_entry(storage, device_id, parsed).await?;
    Ok(json!({
        "success": true,
        "timestamp": timestamp,
    }))
}

pub async fn list_event_fields(
    storage: &Storage,
    _device_id: &str,
    list_id: &str,
) -> Result<Option<(String, String)>, String> {
    let Some(list) = storage
        .load_list(list_id)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    Ok(Some(list_event_fields_from_list(&list)?))
}

fn list_event_fields_from_list(list: &ListEntity) -> Result<(String, String), String> {
    if list.name.trim().is_empty() {
        return Err("List name is missing; migrate browser data before continuing".to_string());
    }
    Ok((list.name.clone(), list.owner.clone()))
}

fn validate_list_pin_urls(urls: Vec<String>) -> Result<Vec<String>, String> {
    urls.into_iter()
        .map(|url| {
            if url.is_empty() {
                Err("addListPins urls must not contain empty strings".to_string())
            } else {
                Ok(url)
            }
        })
        .collect()
}

fn add_list_pin_titles(
    titles: Option<Vec<Option<String>>>,
    url_count: usize,
) -> Result<Vec<Option<String>>, String> {
    let Some(titles) = titles else {
        return Ok(vec![None; url_count]);
    };
    if titles.len() != url_count {
        return Err("addListPins titles length must match urls length".to_string());
    }
    Ok(titles)
}

pub(crate) fn note_text_value(
    field_name: &str,
    value: Option<&Value>,
) -> Result<Option<Value>, String> {
    match value {
        Some(Value::Array(values)) => {
            if !values.iter().all(Value::is_string) {
                return Err(format!("{field_name} array must contain strings only"));
            }
            if values.is_empty()
                || values.iter().any(|value| {
                    value
                        .as_str()
                        .is_some_and(|text| text.is_empty() || text != text.trim())
                })
            {
                return Err(format!(
                    "{field_name} array must contain canonical non-empty strings"
                ));
            }
            Ok(Some(Value::Array(values.clone())))
        }
        Some(Value::Null) | None => Err(format!("{field_name} must be a non-empty string array")),
        Some(_) => Err(format!("{field_name} must be a non-empty string array")),
    }
}

pub(crate) fn note_css_path_value(value: Option<&Value>) -> Result<Option<Value>, String> {
    match value {
        Some(Value::Array(values)) => {
            if !values.iter().all(Value::is_string) {
                return Err("cssPath array must contain strings only".to_string());
            }
            if values.iter().any(|value| {
                value
                    .as_str()
                    .is_some_and(|path| !path.is_empty() && path != path.trim())
            }) {
                return Err(
                    "cssPath array must contain canonical strings without outer whitespace"
                        .to_string(),
                );
            }
            Ok(Some(Value::Array(values.clone())))
        }
        Some(Value::Null) | None => Err("cssPath must be a string array".to_string()),
        Some(_) => Err("cssPath must be a string array".to_string()),
    }
}

pub(crate) fn validate_note_anchor(
    excerpt: &Option<Value>,
    css_path: &Option<Value>,
) -> Result<(), String> {
    match (excerpt, css_path) {
        (Some(Value::Array(excerpts)), Some(Value::Array(paths)))
            if !excerpts.is_empty() && excerpts.len() == paths.len() =>
        {
            Ok(())
        }
        _ => Err(
            "Highlight excerpt and cssPath must both be non-empty arrays with the same length"
                .to_string(),
        ),
    }
}

fn note_slug_text(value: Option<&Value>) -> Result<String, String> {
    match value {
        Some(Value::Array(values)) => {
            if !values.iter().all(Value::is_string) {
                return Err("Persisted note excerpt must contain strings only".to_string());
            }
            let parts = values
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| "Persisted note excerpt must contain strings only".to_string())?
                .into_iter()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if parts.is_empty() {
                Err("Persisted note excerpt must contain non-empty strings".to_string())
            } else {
                Ok(parts.join(" "))
            }
        }
        Some(Value::Null) | None => {
            Err("Persisted note excerpt must be a non-empty string array".to_string())
        }
        Some(_) => Err("Persisted note excerpt must be a non-empty string array".to_string()),
    }
}

fn normalized_slug_base(text: &str, empty_base: &str) -> String {
    let mut base = String::new();
    let mut pending_dash = false;
    for character in text.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_dash && !base.is_empty() {
                base.push('-');
            }
            base.push(character);
            pending_dash = false;
        } else if !base.is_empty() {
            pending_dash = true;
        }
    }
    base = base.chars().take(30).collect::<String>();
    while base.ends_with('-') {
        base.pop();
    }
    if base.is_empty() {
        base = empty_base.to_string();
    }
    base
}

fn js_hash_base36(hash_input: &str) -> String {
    let mut hash: i32 = 0;
    for unit in hash_input.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(unit as i32);
    }
    to_base36(i64::from(hash).unsigned_abs())
}

fn generate_slug_like_js(text: &str, hash_input: &str) -> String {
    let base = normalized_slug_base(text, "note");
    let hash_base36 = js_hash_base36(hash_input);
    let slug = format!("{base}-{hash_base36}");
    slug.chars().take(80).collect()
}

fn generate_note_slug(timestamp: i64, excerpt: &str) -> Result<String, String> {
    let datetime = chrono::Local
        .timestamp_millis_opt(timestamp)
        .single()
        .ok_or_else(|| format!("note timestamp is outside the supported range: {timestamp}"))?;
    let yy = datetime.format("%y%m%d").to_string();
    let hash_input = format!("{excerpt}{timestamp}");
    Ok(format!(
        "{yy}-{}",
        generate_slug_like_js(excerpt, &hash_input)
    ))
}

fn parse_parent_list_id(parent_path: Option<&str>) -> Result<Option<String>, String> {
    let Some(path) = parent_path else {
        return Ok(None);
    };
    if path == "root" {
        return Ok(None);
    }
    let list_id = path
        .split('/')
        .next_back()
        .ok_or_else(|| format!("invalid parentPath: {path}"))?
        .strip_prefix("list:")
        .filter(|list_id| !list_id.is_empty())
        .ok_or_else(|| format!("invalid parentPath: {path}"))?;
    Ok(Some(list_id.to_string()))
}

pub fn split_snapshot_stem(snapshot_stem: &str) -> Option<(String, i64)> {
    let last_dash = snapshot_stem.rfind('-')?;
    let slug = snapshot_stem[..last_dash].to_string();
    let timestamp = snapshot_stem[last_dash + 1..].parse::<i64>().ok()?;
    Some((slug, timestamp))
}

pub async fn save_settings_key(
    storage: &Storage,
    device_id: &str,
    key: &str,
    value: Value,
) -> Result<(), String> {
    if !PERSISTENT_SETTINGS_KEYS.contains(&key) {
        return Err(format!("Unknown settings key: {key}"));
    }
    crate::settings::validate_value(key, &value)?;
    replay_entry(
        storage,
        device_id,
        LogEntry::UpdateSetting {
            timestamp: storage.next_command_timestamp_millis(),
            key: key.to_string(),
            value,
        },
    )
    .await
}

pub async fn ensure_default_lists(storage: &Storage, device_id: &str) -> Result<bool, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let name_map = storage
        .load_name_to_id()
        .await
        .map_err(|error| error.to_string())?;
    let list_order = storage
        .load_list_order()
        .await
        .map_err(|error| error.to_string())?;
    let lists = storage
        .load_all_lists()
        .await
        .map_err(|error| error.to_string())?;
    match (&name_map, &list_order) {
        (None, None) if lists.is_empty() => {}
        (None, None) => return Err(
            "list checkpoints exist without list manifests; rebuild browser data before continuing"
                .to_string(),
        ),
        (None, Some(_)) => return Err("list name-to-id manifest is missing".to_string()),
        (Some(_), None) => return Err("list order manifest is missing".to_string()),
        (Some(name_map), Some(list_order)) => {
            validate_list_manifests(name_map, list_order, &lists)?;
        }
    }
    let paths = name_map.as_ref().map(|manifest| &manifest.paths);
    let has_user_lists = paths
        .map(|paths| paths.keys().any(|key| !key.starts_with("system/")))
        .unwrap_or(false);
    let has_hubs = paths
        .and_then(|paths| paths.get("system/Hubs"))
        .map(|list_id| list_id == "hubs")
        .unwrap_or(false);
    if has_user_lists || has_hubs {
        return Ok(false);
    }

    let list_timestamp = storage.next_command_timestamp_millis();
    let rule_timestamp = storage.next_command_timestamp_millis();
    let mut config = BTreeMap::new();
    config.insert(
        "description".to_string(),
        Value::String("Hub and landing pages".to_string()),
    );
    config.insert(
        "fnSource".to_string(),
        Value::String(
            [
                "const u = new URL(page.url);",
                "const p = u.pathname.toLowerCase();",
                "const skip = ['s', 'search', 'query', 'q', 'target'];",
                "if (skip.some(k => u.searchParams.has(k))) return false;",
                "if (p === '/' || p === '') return u.search.length <= 100;",
                "const parts = p.split('/').filter(Boolean);",
                "if (parts.length === 1 && p.endsWith('/')) return true;",
                "const last = parts[parts.length - 1] || '';",
                "const hub = ['blog', 'wiki', 'home', 'landing', 'explore', 'discover', 'index'];",
                "if (hub.some(k => last.includes(k))) return !u.hash;",
                "return false;",
            ]
            .join("\n"),
        ),
    );
    replay_entries_in_transaction(
        transaction,
        vec![
            LogEntry::CreateList {
                timestamp: list_timestamp,
                list_owner: "system".to_string(),
                list_id: Some("hubs".to_string()),
                name: "Hubs".to_string(),
                parent_list_id: None,
            },
            LogEntry::AddRule {
                timestamp: rule_timestamp,
                list_owner: "system".to_string(),
                name: "Hubs".to_string(),
                rule: RuleInput {
                    id: None,
                    rule_type: "function".to_string(),
                    config,
                },
            },
        ],
    )
    .await?;

    Ok(true)
}

fn validate_list_manifests(
    name_map: &browser_recall_replay::entities::NameToIdManifest,
    list_order: &browser_recall_replay::entities::ListOrderManifest,
    lists: &BTreeMap<String, ListEntity>,
) -> Result<(), String> {
    let mut active_ids = HashSet::new();
    for (list_id, list) in lists {
        if list.slug != *list_id {
            return Err(format!(
                "list checkpoint filename {list_id} does not match entity slug {}",
                list.slug
            ));
        }
        let path = format!("{}/{}", list.owner, list.name);
        if list.deleted {
            if name_map.paths.values().any(|value| value == list_id) {
                return Err(format!(
                    "deleted list {list_id} remains in name-to-id manifest"
                ));
            }
            continue;
        }
        match name_map.paths.get(&path) {
            Some(mapped_id) if mapped_id == list_id => {}
            Some(mapped_id) => {
                return Err(format!(
                    "list path {path} maps to {mapped_id}, expected {list_id}"
                ))
            }
            None => {
                return Err(format!(
                    "active list {list_id} is missing from name-to-id manifest"
                ))
            }
        }
        active_ids.insert(list_id.clone());
    }
    for (path, list_id) in &name_map.paths {
        if !active_ids.contains(list_id) {
            return Err(format!(
                "name-to-id path {path} references missing or deleted list {list_id}"
            ));
        }
    }
    let mut ordered_ids = HashSet::new();
    collect_list_order_ids(&list_order.tree, &mut ordered_ids)?;
    if ordered_ids != active_ids {
        return Err(format!(
            "list order IDs do not match active lists: order={ordered_ids:?}, active={active_ids:?}"
        ));
    }
    Ok(())
}

fn collect_list_order_ids(nodes: &[TreeNode], ids: &mut HashSet<String>) -> Result<(), String> {
    for node in nodes {
        let list_id = node
            .id
            .strip_prefix("list:")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("list order contains invalid ID {}", node.id))?;
        if !ids.insert(list_id.to_string()) {
            return Err(format!("list order contains duplicate list {list_id}"));
        }
        collect_list_order_ids(&node.children, ids)?;
    }
    Ok(())
}

pub async fn ensure_default_settings(storage: &Storage, device_id: &str) -> Result<bool, String> {
    if let Some(settings) = storage
        .load_settings()
        .await
        .map_err(|error| error.to_string())?
    {
        crate::settings::validate_complete(&settings.values)?;
        return Ok(false);
    }

    let mut transaction = ReplayTransaction::begin(storage, device_id).await?;
    for (key, value) in crate::settings::default_values() {
        transaction
            .apply(LogEntry::UpdateSetting {
                timestamp: storage.next_command_timestamp_millis(),
                key,
                value,
            })
            .await?;
    }
    transaction.commit().await?;
    Ok(true)
}

pub async fn create_note(
    storage: &Storage,
    device_id: &str,
    input: CreateNoteInput,
) -> Result<Value, String> {
    let (page_slug, note_slug) = {
        let transaction = ReplayTransaction::begin(storage, device_id).await?;
        let timestamp = storage.next_command_timestamp_millis();
        let page_slug = input.page_slug;
        let excerpt = note_text_value("excerpt", input.excerpt.as_ref())?;
        let css_path = note_css_path_value(input.css_path.as_ref())?;
        validate_note_anchor(&excerpt, &css_path)?;
        let page = if let Some(slug) = page_slug.as_deref() {
            storage
                .load_page(slug)
                .await
                .map_err(|error| error.to_string())?
        } else {
            None
        };
        let slug_text = note_slug_text(excerpt.as_ref())?;
        let note_slug = generate_note_slug(timestamp, &slug_text)?;
        let page_url = page
            .as_ref()
            .and_then(|value| value.url.clone())
            .or(input.url)
            .ok_or_else(|| "Cannot determine page URL for note".to_string())?;
        let page_title = page.and_then(|value| value.title).or(input.title);

        replay_entries_in_transaction(
            transaction,
            vec![LogEntry::CreateNote {
                timestamp,
                url: page_url,
                path: format!("objects/notes/{note_slug}.json"),
                title: page_title,
                excerpt: excerpt.clone(),
                note: input.note,
                css_path,
            }],
        )
        .await?;
        (page_slug, note_slug)
    };
    let notes = if let Some(page_slug) = page_slug.as_deref() {
        crate::read_projections::ReadProjections::new(storage.clone())
            .page_info(page_slug)
            .await?
            .notes
    } else {
        Vec::new()
    };
    Ok(json!({
        "success": true,
        "noteSlug": note_slug,
        "pageSlug": page_slug,
        "notes": notes,
    }))
}

pub async fn delete_note(
    storage: &Storage,
    device_id: &str,
    note_slug: &str,
) -> Result<Value, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let note = storage
        .load_note(note_slug)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Note not found: {note_slug}"))?;
    let note_url = note.url.clone();
    let page_slug = note_url
        .as_deref()
        .map(generate_slug_from_url)
        .transpose()
        .map_err(|error| error.to_string())?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::DeleteNote {
            timestamp: storage.next_command_timestamp_millis(),
            url: note_url.clone(),
            path: format!("objects/notes/{note_slug}.json"),
        }],
    )
    .await?;
    Ok(json!({
        "success": true,
        "noteSlug": note_slug,
        "pageSlug": page_slug,
        "url": note_url,
    }))
}

pub async fn update_note(
    storage: &Storage,
    device_id: &str,
    note_slug: &str,
    note_value: &str,
) -> Result<Value, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let old_note = storage
        .load_note(note_slug)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Note not found".to_string())?;
    if matches!(old_note.note.as_deref(), Some(existing) if existing == note_value)
        || (old_note.note.is_none() && note_value.is_empty())
    {
        return Ok(json!({
            "success": true,
            "noteSlug": note_slug,
        }));
    }

    let mut timestamp = storage.next_command_timestamp_millis();
    let slug_text = note_slug_text(old_note.excerpt.as_ref())?;
    let mut new_note_slug = generate_note_slug(timestamp, &slug_text)?;
    while new_note_slug == note_slug {
        timestamp += 1;
        new_note_slug = generate_note_slug(timestamp, &slug_text)?;
    }
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::ReplaceNote {
            timestamp,
            url: old_note.url.clone(),
            path: format!("objects/notes/{new_note_slug}.json"),
            old_path: format!("objects/notes/{note_slug}.json"),
            excerpt: old_note.excerpt.clone(),
            note: Some(note_value.to_string()),
            css_path: old_note.css_path.clone(),
        }],
    )
    .await?;
    Ok(json!({
        "success": true,
        "noteSlug": new_note_slug,
        "oldNoteSlug": note_slug,
    }))
}

pub async fn toggle_list_pin(
    storage: &Storage,
    device_id: &str,
    input: ToggleListPinInput,
) -> Result<Value, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let list = storage
        .load_list(&input.list_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "List not found".to_string())?;
    let (list_name, list_owner) = list_event_fields_from_list(&list)?;
    let note_id = input.id.as_deref();
    let pin_item = if let Some(note_id) = note_id.filter(|value| value.starts_with("note:")) {
        format!("objects/notes/{}.json", &note_id["note:".len()..])
    } else {
        input
            .url
            .clone()
            .ok_or_else(|| "toggleListPin missing url".to_string())?
    };
    let pin_key = if let Some(note_id) = note_id.filter(|value| value.starts_with("note:")) {
        note_id.to_string()
    } else {
        format!(
            "page:{}",
            generate_slug_from_url(&pin_item).map_err(|error| error.to_string())?
        )
    };
    let is_pinned = list.pins.iter().any(|pin| pin.id == pin_key);
    let title = if !is_pinned && !pin_key.starts_with("note:") {
        storage
            .load_entity(&pin_key)
            .await
            .map_err(|error| error.to_string())?
            .and_then(|entity| match entity {
                Entity::Page(page) => page.title,
                _ => None,
            })
            .or(input.title)
    } else {
        None
    };
    replay_entries_in_transaction(
        transaction,
        vec![if is_pinned {
            LogEntry::UnpinFromList {
                timestamp: storage.next_command_timestamp_millis(),
                name: list_name,
                list_owner,
                urls: vec![pin_item],
            }
        } else {
            LogEntry::PinToList {
                timestamp: storage.next_command_timestamp_millis(),
                name: list_name,
                list_owner,
                urls: vec![pin_item],
                titles: title.map(|value| vec![Some(value)]),
                source: None,
            }
        }],
    )
    .await?;
    Ok(json!({
        "success": true,
        "pinned": !is_pinned,
    }))
}

pub async fn add_list_pins(
    storage: &Storage,
    device_id: &str,
    input: AddListPinsInput,
) -> Result<(), String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let urls = validate_list_pin_urls(input.urls)?;
    let (list_name, list_owner) = list_event_fields(storage, device_id, &input.list_id)
        .await?
        .ok_or_else(|| "List not found".to_string())?;
    let mut titles = add_list_pin_titles(input.titles, urls.len())?;
    for (index, url) in urls.iter().enumerate() {
        if titles[index].is_some() {
            continue;
        }
        let page_key = format!(
            "page:{}",
            generate_slug_from_url(url).map_err(|error| error.to_string())?
        );
        if let Some(Entity::Page(page)) = storage
            .load_entity(&page_key)
            .await
            .map_err(|error| error.to_string())?
        {
            if let Some(title) = page.title {
                titles[index] = Some(title);
            }
        }
    }
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::PinToList {
            timestamp: storage.next_command_timestamp_millis(),
            name: list_name,
            list_owner,
            urls,
            titles: titles.iter().any(Option::is_some).then_some(titles),
            source: None,
        }],
    )
    .await
}

pub async fn save_list_meta(
    storage: &Storage,
    device_id: &str,
    input: SaveListMetaInput,
) -> Result<Value, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(list_id) = input.list_id {
        let list = storage
            .load_list(&list_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "List not found".to_string())?;
        let Some(new_name) = name else {
            return Ok(json!({ "success": true }));
        };
        if list.name == new_name {
            return Ok(json!({ "success": true }));
        }
        replay_entries_in_transaction(
            transaction,
            vec![LogEntry::UpdateList {
                timestamp: storage.next_command_timestamp_millis(),
                name: list.name,
                list_owner: list.owner,
                new_name: Some(new_name),
            }],
        )
        .await?;
        Ok(json!({ "success": true }))
    } else {
        let name = name.ok_or_else(|| "saveListMeta missing name".to_string())?;
        let timestamp = storage.next_command_timestamp_millis();
        let generated_list_id = generate_list_id(&name, timestamp);
        replay_entries_in_transaction(
            transaction,
            vec![LogEntry::CreateList {
                timestamp,
                name,
                list_owner: device_id.to_string(),
                list_id: Some(generated_list_id.clone()),
                parent_list_id: parse_parent_list_id(input.parent_path.as_deref())?,
            }],
        )
        .await?;
        Ok(json!({
            "success": true,
            "listId": generated_list_id,
        }))
    }
}

pub async fn create_list_and_pin(
    storage: &Storage,
    device_id: &str,
    input: CreateListAndPinInput,
) -> Result<Value, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("createListAndPin missing name".to_string());
    }
    let name = name.to_string();
    if input.url.is_empty() {
        return Err("createListAndPin missing url".to_string());
    }
    let url = input.url;
    let title = input.title.filter(|value| !value.is_empty());
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let create_timestamp = storage.next_command_timestamp_millis();
    let list_id = generate_list_id(&name, create_timestamp);
    replay_entries_in_transaction(
        transaction,
        vec![
            LogEntry::CreateList {
                timestamp: create_timestamp,
                name: name.clone(),
                list_owner: device_id.to_string(),
                list_id: Some(list_id.clone()),
                parent_list_id: None,
            },
            LogEntry::PinToList {
                timestamp: storage.next_command_timestamp_millis(),
                name,
                list_owner: device_id.to_string(),
                urls: vec![url],
                titles: title.map(|value| vec![Some(value)]),
                source: None,
            },
        ],
    )
    .await?;
    Ok(json!({
        "success": true,
        "listId": list_id,
        "pinned": true,
    }))
}

pub async fn delete_list(
    storage: &Storage,
    device_id: &str,
    list_id: &str,
) -> Result<Value, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let list = storage
        .load_list(list_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "List not found".to_string())?;
    let mut urls = Vec::new();
    for pin in &list.pins {
        if !pin.id.starts_with("page:") {
            continue;
        }
        if let Some(Entity::Page(page)) = storage
            .load_entity(&pin.id)
            .await
            .map_err(|error| error.to_string())?
        {
            if let Some(url) = page.url {
                urls.push(url);
            }
        }
    }
    let (list_name, list_owner) = list_event_fields_from_list(&list)?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::DeleteList {
            timestamp: storage.next_command_timestamp_millis(),
            name: list_name,
            list_owner,
        }],
    )
    .await?;
    Ok(json!({
        "success": true,
        "listId": list_id,
        "urls": urls,
    }))
}

pub async fn update_list_tree(
    storage: &Storage,
    device_id: &str,
    tree: Vec<TreeNode>,
) -> Result<(), String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::UpdateListTree {
            timestamp: storage.next_command_timestamp_millis(),
            tree,
        }],
    )
    .await
}

pub async fn restore_note(
    storage: &Storage,
    device_id: &str,
    note_slug: &str,
) -> Result<(), String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let orphaned = storage
        .load_orphaned()
        .await
        .map_err(|error| error.to_string())?;
    let note = storage
        .load_note(note_slug)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Note not found: {note_slug}"))?;
    let page_url = orphaned
        .as_ref()
        .and_then(|value| {
            value
                .entries
                .iter()
                .find(|entry| entry.key == format!("note:{note_slug}"))
                .and_then(|entry| entry.url.clone())
        })
        .or(note.url);
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::RestoreNote {
            timestamp: storage.next_command_timestamp_millis(),
            url: page_url,
            path: format!("objects/notes/{note_slug}.json"),
        }],
    )
    .await
}

pub async fn restore_snapshot(
    storage: &Storage,
    device_id: &str,
    snapshot_stem: &str,
) -> Result<String, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let (page_slug, timestamp) = split_snapshot_stem(snapshot_stem)
        .ok_or_else(|| "restoreSnapshot invalid snapSlug".to_string())?;
    let orphaned = storage
        .load_orphaned()
        .await
        .map_err(|error| error.to_string())?;
    let page = storage
        .load_page(&page_slug)
        .await
        .map_err(|error| error.to_string())?;
    let page_url = orphaned
        .as_ref()
        .and_then(|value| {
            value
                .entries
                .iter()
                .find(|entry| entry.key == format!("snapshot:{snapshot_stem}"))
                .and_then(|entry| entry.url.clone())
        })
        .or_else(|| page.and_then(|value| value.url))
        .ok_or_else(|| "Cannot determine page URL for snapshot".to_string())?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::RestoreSnapshot {
            timestamp: storage.next_command_timestamp_millis(),
            url: page_url,
            path: storage.snapshot_sidecar_relative_path(&page_slug, timestamp),
        }],
    )
    .await?;
    Ok(page_slug)
}

pub async fn restore_list(storage: &Storage, device_id: &str, list_id: &str) -> Result<(), String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let list = storage
        .load_list(list_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "List not found".to_string())?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::RestoreList {
            timestamp: storage.next_command_timestamp_millis(),
            name: list.name,
            list_owner: list.owner,
        }],
    )
    .await
}

pub async fn delete_snapshot(
    storage: &Storage,
    device_id: &str,
    slug: &str,
    timestamp: i64,
) -> Result<String, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let page = storage
        .load_page(slug)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Page entity not found for snapshot".to_string())?;
    let url = page
        .url
        .ok_or_else(|| "Page entity missing URL for snapshot".to_string())?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::DeleteSnapshot {
            timestamp: storage.next_command_timestamp_millis(),
            url: url.clone(),
            path: storage.snapshot_sidecar_relative_path(slug, timestamp),
        }],
    )
    .await?;
    Ok(url)
}

pub async fn permanent_delete_keys(
    storage: &Storage,
    device_id: &str,
    keys: &[String],
) -> Result<Vec<String>, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let deleted_keys = permanent_delete_candidates(keys)?;
    if deleted_keys.is_empty() {
        return Ok(deleted_keys);
    }
    let orphaned = storage
        .load_orphaned()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "orphaned manifest is missing".to_string())?;
    let orphaned_keys = orphaned
        .entries
        .iter()
        .map(|entry| entry.key.as_str())
        .collect::<HashSet<_>>();
    if let Some(key) = deleted_keys
        .iter()
        .find(|key| !orphaned_keys.contains(key.as_str()))
    {
        return Err(format!("permanent-delete target is not orphaned: {key}"));
    }
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::PermanentDelete {
            timestamp: storage.next_command_timestamp_millis(),
            keys: deleted_keys.clone(),
        }],
    )
    .await?;
    Ok(deleted_keys)
}

pub fn permanent_delete_candidates(keys: &[String]) -> Result<Vec<String>, String> {
    let mut candidates = Vec::with_capacity(keys.len());
    for key in keys {
        if !is_permanent_delete_candidate(key) {
            return Err(format!("unsupported permanent-delete key: {key}"));
        }
        candidates.push(key.clone());
    }
    Ok(candidates)
}

fn is_permanent_delete_candidate(key: &str) -> bool {
    let Some((prefix, slug)) = key.split_once(':') else {
        return false;
    };
    !slug.is_empty() && matches!(prefix, "note" | "list" | "page" | "snapshot")
}

pub fn list_paired_browsers(
    config_store: &crate::config::ConfigStore,
) -> Result<Vec<PairedBrowserInfo>, String> {
    let config = config_store
        .load_or_create()
        .map_err(|error| error.to_string())?;
    let mut connectors = config
        .connectors
        .into_iter()
        .map(|connector| PairedBrowserInfo {
            browser_id: connector.browser_id,
            browser_name: connector.browser_name,
            browser_profile: connector.browser_profile,
            extension_id: connector.extension_id,
            approved_at: Some((connector.approved_at as i64) * 1000),
            last_seen: connector.last_seen_at.map(|value| (value as i64) * 1000),
        })
        .collect::<Vec<_>>();
    connectors.sort_by(|left, right| {
        right
            .last_seen
            .cmp(&left.last_seen)
            .then_with(|| right.approved_at.cmp(&left.approved_at))
            .then_with(|| left.browser_name.cmp(&right.browser_name))
            .then_with(|| left.browser_profile.cmp(&right.browser_profile))
            .then_with(|| left.browser_id.cmp(&right.browser_id))
            .then_with(|| left.extension_id.cmp(&right.extension_id))
    });
    Ok(connectors)
}

pub fn pair_browser_revoke(
    config_store: &crate::config::ConfigStore,
    browser_id: &str,
    extension_id: &str,
) -> Result<bool, String> {
    let mut config = config_store
        .load_or_create()
        .map_err(|error| error.to_string())?;
    let before = config.connectors.len();
    config.connectors.retain(|connector| {
        !(connector.browser_id == browser_id && connector.extension_id == extension_id)
    });
    prune_inactive_connectors(
        &mut config.connectors,
        &HashSet::new(),
        current_local_day_start_unix()?,
    );
    if config.connectors.len() != before {
        config_store
            .save(&config)
            .map_err(|error| error.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

pub fn preview_rule_payload(
    rule: RulePayload,
    entries: Vec<RuleBatchEntry>,
) -> Result<Value, String> {
    let rule_spec = RuleSpec {
        rule_type: rule.rule_type,
        config: rule.config,
    };
    if let Err(error) = validate_rule(&rule_spec) {
        return Ok(json!({
            "success": false,
            "error": error,
            "results": [],
        }));
    }

    let mut results = Vec::new();
    for entry in entries {
        let title = entry.title.clone();
        let matched = preview_rule(
            &rule_spec,
            &PageData {
                title: Some(title.clone()),
                url: entry.url.clone(),
                body: entry.body_preview.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        results.push(json!({
            "url": entry.url,
            "title": title,
            "match": matched,
        }));
    }
    Ok(json!({
        "success": true,
        "results": results,
    }))
}

pub async fn add_rule(
    storage: &Storage,
    device_id: &str,
    list_id: &str,
    rule: RulePayload,
) -> Result<Value, String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let (list_name, list_owner) = list_event_fields(storage, device_id, list_id)
        .await?
        .ok_or_else(|| "List not found".to_string())?;
    let rule_spec = RuleSpec {
        rule_type: rule.rule_type.clone(),
        config: rule.config.clone(),
    };
    validate_rule(&rule_spec)?;

    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::AddRule {
            timestamp: storage.next_command_timestamp_millis(),
            name: list_name,
            list_owner,
            rule: RuleInput {
                id: None,
                rule_type: rule.rule_type,
                config: rule.config,
            },
        }],
    )
    .await?;
    Ok(json!({ "success": true }))
}

pub async fn remove_rule(
    storage: &Storage,
    device_id: &str,
    list_id: &str,
    rule_id: &str,
) -> Result<(), String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let (list_name, list_owner) = list_event_fields(storage, device_id, list_id)
        .await?
        .ok_or_else(|| "List not found".to_string())?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::RemoveRule {
            timestamp: storage.next_command_timestamp_millis(),
            name: list_name,
            list_owner,
            rule_id: rule_id.to_string(),
        }],
    )
    .await
}

pub async fn update_rule(
    storage: &Storage,
    device_id: &str,
    list_id: &str,
    rule_id: &str,
    config: BTreeMap<String, Value>,
) -> Result<(), String> {
    let transaction = ReplayTransaction::begin(storage, device_id).await?;
    let (list_name, list_owner) = list_event_fields(storage, device_id, list_id)
        .await?
        .ok_or_else(|| "List not found".to_string())?;
    replay_entries_in_transaction(
        transaction,
        vec![LogEntry::UpdateRule {
            timestamp: storage.next_command_timestamp_millis(),
            name: list_name,
            list_owner,
            rule_id: rule_id.to_string(),
            config,
        }],
    )
    .await
}

pub async fn rename_page(
    storage: &Storage,
    device_id: &str,
    url: &str,
    user_title: &str,
) -> Result<i64, String> {
    let timestamp = storage.next_command_timestamp_millis();
    replay_entry(
        storage,
        device_id,
        LogEntry::RenamePage {
            timestamp,
            url: url.to_string(),
            user_title: user_title.to_string(),
        },
    )
    .await?;
    Ok(timestamp)
}

fn import_list_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        chars.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        value /= 36;
    }
    chars.iter().rev().collect()
}

fn generate_list_id(name: &str, timestamp: i64) -> String {
    let base = normalized_slug_base(name, "list");
    let suffix = js_hash_base36(&format!("{name}{timestamp}"));
    format!("{base}-{suffix}")
}

async fn create_import_list(
    storage: &Storage,
    device_id: &str,
    name: &str,
    parent_list_id: Option<String>,
) -> Result<String, String> {
    let timestamp = storage.next_command_timestamp_millis();
    let list_name = import_list_name(name);
    let list_id = generate_list_id(&list_name, timestamp);
    replay_entry(
        storage,
        device_id,
        LogEntry::CreateList {
            timestamp,
            name: list_name,
            list_owner: device_id.to_string(),
            list_id: Some(list_id.clone()),
            parent_list_id,
        },
    )
    .await?;
    Ok(list_id)
}

pub async fn import_bookmarks(
    storage: &Storage,
    device_id: &str,
    tree: Vec<BookmarkImportNode>,
) -> Result<(usize, usize, Vec<Value>), String> {
    let parent_name = format!(
        "Imported Bookmarks ({})",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    );
    let parent_list_id = create_import_list(storage, device_id, &parent_name, None).await?;

    let mut list_count = 0usize;
    let mut bookmark_count = 0usize;
    let mut failures = Vec::new();
    let mut stack = tree
        .into_iter()
        .rev()
        .map(|node| (node, parent_list_id.clone()))
        .collect::<Vec<_>>();

    while let Some((node, parent_id)) = stack.pop() {
        let list_name = import_list_name(&node.title);
        let list_id = create_import_list(storage, device_id, &list_name, Some(parent_id)).await?;
        list_count += 1;

        if !node.bookmarks.is_empty() {
            let mut urls = Vec::with_capacity(node.bookmarks.len());
            let mut titles = Vec::with_capacity(node.bookmarks.len());
            for bookmark in node.bookmarks {
                urls.push(bookmark.url.clone());
                titles.push((!bookmark.title.trim().is_empty()).then_some(bookmark.title));
            }
            bookmark_count += urls.len();

            replay_entry(
                storage,
                device_id,
                LogEntry::PinToList {
                    timestamp: storage.next_command_timestamp_millis(),
                    name: list_name.clone(),
                    list_owner: device_id.to_string(),
                    urls,
                    titles: titles.iter().any(Option::is_some).then_some(titles),
                    source: None,
                },
            )
            .await?;
        }

        failures.extend(node.skipped.into_iter().map(|skipped| {
            json!({
                "url": skipped.url,
                "title": skipped.title,
                "reason": skipped.reason,
            })
        }));

        for child in node.children.into_iter().rev() {
            stack.push((child, list_id.clone()));
        }
    }

    Ok((list_count, bookmark_count, failures))
}

fn is_history_importable_url(url: &str) -> bool {
    generate_slug_from_url(url).is_ok()
}

pub(crate) fn optional_page_referrer(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed =
        url::Url::parse(value).map_err(|error| format!("invalid referrer URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Ok(None);
    }
    generate_slug_from_url(value).map_err(|error| format!("invalid referrer URL: {error}"))?;
    Ok(Some(value.to_string()))
}

pub async fn import_history(
    storage: &Storage,
    device_id: &str,
    entries: Vec<HistoryImportEntry>,
) -> Result<(usize, usize, usize), String> {
    let mut normalized_events = Vec::new();
    let mut imported_pages = BTreeSet::new();
    let mut skipped = 0usize;

    for entry in entries {
        let url = entry.url.trim().to_string();
        if url.is_empty() || !is_history_importable_url(&url) {
            skipped += 1;
            continue;
        }

        let title = entry
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let referrer_url = match optional_page_referrer(entry.referrer_url.as_deref()) {
            Ok(referrer_url) => referrer_url,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        if entry.visit_times.is_empty() || entry.visit_times.iter().any(|timestamp| *timestamp <= 0)
        {
            skipped += 1;
            continue;
        }
        let visit_times = entry.visit_times.into_iter().collect::<BTreeSet<_>>();

        imported_pages.insert(url.clone());
        for timestamp in visit_times {
            normalized_events.push((timestamp, url.clone(), title.clone(), referrer_url.clone()));
        }
    }

    normalized_events.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });

    let imported_visits = normalized_events.len();
    if imported_visits == 0 {
        return Ok((0, 0, skipped));
    }

    for (timestamp, url, title, referrer_url) in normalized_events {
        replay_entry(
            storage,
            device_id,
            LogEntry::VisitPage {
                timestamp,
                url,
                title,
                referrer_url,
            },
        )
        .await?;
    }

    Ok((imported_pages.len(), imported_visits, skipped))
}
