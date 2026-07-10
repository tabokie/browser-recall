use crate::commands;
use crate::mutations::{mutation_batch as mutation, mutation_batch_with as mutation_with};
use crate::protocol::MutationPayload;
use crate::runtime;
use crate::storage::Storage;
use browser_recall_replay::{entities::TreeNode, LogEntry};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct CommandOutcome {
    pub response: Value,
    pub mutations: Vec<MutationPayload>,
}

#[derive(Clone)]
pub struct CommandAuthority {
    storage: Storage,
    device_id: String,
}

#[derive(Debug, Deserialize)]
struct ListOrderInput {
    slug: String,
    #[serde(default)]
    children: Vec<ListOrderInput>,
}

impl ListOrderInput {
    fn into_tree_node(self) -> TreeNode {
        TreeNode {
            id: format!("list:{}", self.slug),
            children: self
                .children
                .into_iter()
                .map(Self::into_tree_node)
                .collect(),
        }
    }
}

#[derive(Clone, Copy)]
enum Command {
    SaveSettingsKey,
    EnsureDefaultLists,
    RenamePage,
    RatePage,
    CreateNote,
    DeleteNote,
    UpdateNote,
    ToggleListPin,
    AddListPins,
    SaveListMeta,
    ImportBookmarks,
    ImportHistory,
    DeleteList,
    UpdateListTree,
    RestoreNote,
    RestoreSnapshot,
    RestoreList,
    PermanentDeleteAll,
    DeleteSnapshot,
    ClearAllData,
    AddRule,
    RemoveRule,
    UpdateRule,
}

impl Command {
    fn parse(action: &str) -> Option<Self> {
        match action {
            "saveSettingsKey" => Some(Self::SaveSettingsKey),
            "ensureDefaultLists" => Some(Self::EnsureDefaultLists),
            "renamePage" => Some(Self::RenamePage),
            "ratePage" => Some(Self::RatePage),
            "createNote" => Some(Self::CreateNote),
            "deleteNote" => Some(Self::DeleteNote),
            "updateNote" => Some(Self::UpdateNote),
            "toggleListPin" => Some(Self::ToggleListPin),
            "addListPins" => Some(Self::AddListPins),
            "saveListMeta" => Some(Self::SaveListMeta),
            "importBookmarks" => Some(Self::ImportBookmarks),
            "importHistory" => Some(Self::ImportHistory),
            "deleteList" => Some(Self::DeleteList),
            "updateListTree" => Some(Self::UpdateListTree),
            "restoreNote" => Some(Self::RestoreNote),
            "restoreSnapshot" => Some(Self::RestoreSnapshot),
            "restoreList" => Some(Self::RestoreList),
            "permanentDeleteAll" => Some(Self::PermanentDeleteAll),
            "deleteSnapshot" => Some(Self::DeleteSnapshot),
            "clearAllData" => Some(Self::ClearAllData),
            "addRule" => Some(Self::AddRule),
            "removeRule" => Some(Self::RemoveRule),
            "updateRule" => Some(Self::UpdateRule),
            _ => None,
        }
    }
}

impl CommandAuthority {
    pub fn new(storage: Storage, device_id: String) -> Self {
        Self { storage, device_id }
    }

    pub fn supports(action: &str) -> bool {
        Command::parse(action).is_some()
    }

    pub async fn execute(&self, action: &str, request: Value) -> Result<CommandOutcome, String> {
        let command = Command::parse(action)
            .ok_or_else(|| format!("unsupported daemon command: {action}"))?;
        let request_string = |key: &str| -> Result<String, String> {
            request
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("{action} missing {key}"))
        };

        let outcome = match command {
            Command::SaveSettingsKey => {
                let key = request_string("key")?;
                let value = request
                    .get("value")
                    .cloned()
                    .ok_or_else(|| "saveSettingsKey missing value".to_string())?;
                commands::save_settings_key(&self.storage, &self.device_id, &key, value).await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("settings", |fields| fields.key = Some(key)),
                )
            }
            Command::EnsureDefaultLists => {
                let created =
                    commands::ensure_default_lists(&self.storage, &self.device_id).await?;
                let mutations = if created {
                    let mut mutations = mutation("lists");
                    mutations.extend(mutation_with("rules", |fields| {
                        fields.list_id = Some("hubs".to_string())
                    }));
                    mutations
                } else {
                    Vec::new()
                };
                CommandOutcome::new(json!({ "success": true, "created": created }), mutations)
            }
            Command::RenamePage => {
                let url = request_string("url")?;
                let user_title = request_string("userTitle")?;
                commands::rename_page(&self.storage, &self.device_id, &url, &user_title).await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("history", |fields| fields.url = Some(url)),
                )
            }
            Command::RatePage => {
                let url = request_string("url")?;
                let likes = request
                    .get("likes")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "ratePage missing likes".to_string())?;
                let title = request
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                commands::replay_entry(
                    &self.storage,
                    &self.device_id,
                    LogEntry::RatePage {
                        timestamp: self.storage.next_command_timestamp_millis(),
                        url: url.clone(),
                        likes,
                        title,
                    },
                )
                .await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("history", |fields| fields.url = Some(url)),
                )
            }
            Command::CreateNote => {
                let request_url = request
                    .get("url")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let response =
                    commands::create_note(&self.storage, &self.device_id, &request).await?;
                let note_slug = required_response_string(&response, "createNote", "noteSlug")?;
                let page_slug = optional_response_string(&response, "createNote", "pageSlug")?;
                let mutations = mutation_with("note", |fields| {
                    fields.page_slug = page_slug;
                    fields.note_slug = Some(note_slug);
                    fields.url = request_url;
                });
                CommandOutcome::new(response, mutations)
            }
            Command::DeleteNote => {
                let note_slug = request_string("noteSlug")?;
                let response =
                    commands::delete_note(&self.storage, &self.device_id, &note_slug).await?;
                let response_note_slug =
                    required_response_string(&response, "deleteNote", "noteSlug")?;
                let page_slug = optional_response_string(&response, "deleteNote", "pageSlug")?;
                let url = optional_response_string(&response, "deleteNote", "url")?;
                let mut mutations = mutation_with("note", |fields| {
                    fields.note_slug = Some(response_note_slug);
                    fields.page_slug = page_slug;
                    fields.url = url;
                });
                mutations.extend(mutation("orphaned"));
                CommandOutcome::new(response, mutations)
            }
            Command::UpdateNote => {
                let old_note_slug = request_string("noteSlug")?;
                let note = request_string("note")?;
                let response =
                    commands::update_note(&self.storage, &self.device_id, &old_note_slug, &note)
                        .await?;
                let mutations = if response.get("oldNoteSlug").is_some() {
                    let note_slug = required_response_string(&response, "updateNote", "noteSlug")?;
                    mutation_with("note", |fields| {
                        fields.note_slug = Some(note_slug);
                        fields.old_note_slug = Some(old_note_slug);
                    })
                } else {
                    Vec::new()
                };
                CommandOutcome::new(response, mutations)
            }
            Command::ToggleListPin => {
                let list_id = request_string("listId")?;
                let url = if let Some(url) = request.get("url").and_then(Value::as_str) {
                    Some(url.to_string())
                } else if let Some(note_slug) = request
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| id.strip_prefix("note:"))
                {
                    self.storage
                        .load_note(note_slug)
                        .await
                        .map_err(|error| error.to_string())?
                        .and_then(|note| note.url)
                } else {
                    None
                };
                let response =
                    commands::toggle_list_pin(&self.storage, &self.device_id, &request).await?;
                CommandOutcome::new(
                    response,
                    mutation_with("pins", |fields| {
                        fields.list_id = Some(list_id);
                        fields.url = url.clone();
                        fields.urls = url.map(|value| vec![value]);
                    }),
                )
            }
            Command::AddListPins => {
                let list_id = request_string("listId")?;
                let urls = request
                    .get("urls")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "addListPins missing urls".to_string())?
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                commands::add_list_pins(&self.storage, &self.device_id, &request).await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("pins", |fields| {
                        fields.list_id = Some(list_id);
                        fields.url = urls.first().cloned();
                        fields.urls = Some(urls);
                    }),
                )
            }
            Command::SaveListMeta => {
                let response =
                    commands::save_list_meta(&self.storage, &self.device_id, &request).await?;
                CommandOutcome::new(response, mutation("lists"))
            }
            Command::ImportBookmarks => {
                let tree = serde_json::from_value::<Vec<commands::BookmarkImportNode>>(
                    request
                        .get("tree")
                        .cloned()
                        .ok_or_else(|| "importBookmarks missing tree".to_string())?,
                )
                .map_err(|error| error.to_string())?;
                let (list_count, bookmark_count, failures) =
                    commands::import_bookmarks(&self.storage, &self.device_id, tree).await?;
                CommandOutcome::new(
                    json!({
                        "success": true,
                        "listCount": list_count,
                        "bookmarkCount": bookmark_count,
                        "failures": failures,
                    }),
                    mutation("lists"),
                )
            }
            Command::ImportHistory => {
                let entries = serde_json::from_value::<Vec<commands::HistoryImportEntry>>(
                    request
                        .get("entries")
                        .cloned()
                        .ok_or_else(|| "importHistory missing entries".to_string())?,
                )
                .map_err(|error| error.to_string())?;
                let (page_count, visit_count, skipped_count) =
                    commands::import_history(&self.storage, &self.device_id, entries).await?;
                CommandOutcome::new(
                    json!({
                        "success": true,
                        "pageCount": page_count,
                        "visitCount": visit_count,
                        "skippedCount": skipped_count,
                    }),
                    mutation("history"),
                )
            }
            Command::DeleteList => {
                let list_id = request_string("listId")?;
                let response =
                    commands::delete_list(&self.storage, &self.device_id, &list_id).await?;
                let response_list_id = required_response_string(&response, "deleteList", "listId")?;
                let urls = response
                    .get("urls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                let mut mutations = mutation_with("lists", |fields| {
                    fields.list_id = Some(response_list_id);
                    fields.url = urls.first().cloned();
                    fields.urls = Some(urls);
                });
                mutations.extend(mutation("orphaned"));
                CommandOutcome::new(response, mutations)
            }
            Command::UpdateListTree => {
                let tree = serde_json::from_value::<Vec<ListOrderInput>>(
                    request
                        .get("tree")
                        .cloned()
                        .ok_or_else(|| "updateListTree missing tree".to_string())?,
                )
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(ListOrderInput::into_tree_node)
                .collect();
                commands::update_list_tree(&self.storage, &self.device_id, tree).await?;
                CommandOutcome::new(json!({ "success": true }), mutation("lists"))
            }
            Command::RestoreNote => {
                let note_slug = request_string("noteSlug")?;
                commands::restore_note(&self.storage, &self.device_id, &note_slug).await?;
                let mut mutations = mutation("orphaned");
                mutations.extend(mutation_with("note", |fields| {
                    fields.note_slug = Some(note_slug)
                }));
                CommandOutcome::new(json!({ "success": true }), mutations)
            }
            Command::RestoreSnapshot => {
                let snap_slug = request_string("snapSlug")?;
                let page_slug =
                    commands::restore_snapshot(&self.storage, &self.device_id, &snap_slug).await?;
                let mut mutations = mutation("orphaned");
                mutations.extend(mutation_with("snapshot", |fields| {
                    fields.slug = Some(page_slug)
                }));
                CommandOutcome::new(json!({ "success": true }), mutations)
            }
            Command::RestoreList => {
                let list_id = request_string("listId")?;
                commands::restore_list(&self.storage, &self.device_id, &list_id).await?;
                let mut mutations = mutation("orphaned");
                mutations.extend(mutation("lists"));
                CommandOutcome::new(json!({ "success": true }), mutations)
            }
            Command::DeleteSnapshot => {
                let slug = request_string("slug")?;
                let timestamp = request
                    .get("timestamp")
                    .or_else(|| request.get("ts"))
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "deleteSnapshot missing timestamp".to_string())?;
                let url =
                    commands::delete_snapshot(&self.storage, &self.device_id, &slug, timestamp)
                        .await?;
                let mut mutations = mutation_with("snapshot", |fields| {
                    fields.slug = Some(slug);
                    fields.url = Some(url);
                });
                mutations.extend(mutation("orphaned"));
                CommandOutcome::new(json!({ "success": true }), mutations)
            }
            Command::PermanentDeleteAll => {
                let keys = self
                    .storage
                    .load_orphaned()
                    .await
                    .map_err(|error| error.to_string())?
                    .unwrap_or_default()
                    .entries
                    .into_iter()
                    .map(|entry| entry.key)
                    .collect::<Vec<_>>();
                let deleted_keys =
                    commands::permanent_delete_keys(&self.storage, &self.device_id, &keys).await?;
                let mut mutations = mutation("note");
                mutations.extend(mutation("snapshot"));
                mutations.extend(mutation("lists"));
                mutations.extend(mutation("orphaned"));
                CommandOutcome::new(
                    json!({ "success": true, "deletedKeys": deleted_keys }),
                    mutations,
                )
            }
            Command::ClearAllData => {
                let deleted_count = runtime::clear_all_data(&self.storage, &self.device_id).await?;
                let mut mutations = mutation("note");
                mutations.extend(mutation("snapshot"));
                mutations.extend(mutation("lists"));
                mutations.extend(mutation("orphaned"));
                mutations.extend(mutation("settings"));
                CommandOutcome::new(
                    json!({ "success": true, "deletedCount": deleted_count }),
                    mutations,
                )
            }
            Command::AddRule => {
                let list_id = request_string("listId")?;
                let rule = serde_json::from_value(
                    request
                        .get("rule")
                        .cloned()
                        .ok_or_else(|| "addRule missing rule".to_string())?,
                )
                .map_err(|error| error.to_string())?;
                let response =
                    commands::add_rule(&self.storage, &self.device_id, &list_id, rule).await?;
                CommandOutcome::new(
                    response,
                    mutation_with("rules", |fields| fields.list_id = Some(list_id)),
                )
            }
            Command::RemoveRule => {
                let list_id = request_string("listId")?;
                let rule_id = request_string("ruleId")?;
                commands::remove_rule(&self.storage, &self.device_id, &list_id, &rule_id).await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("rules", |fields| fields.list_id = Some(list_id)),
                )
            }
            Command::UpdateRule => {
                let list_id = request_string("listId")?;
                let rule_id = request_string("ruleId")?;
                let config = serde_json::from_value(
                    request
                        .get("config")
                        .cloned()
                        .ok_or_else(|| "updateRule missing config".to_string())?,
                )
                .map_err(|error| error.to_string())?;
                commands::update_rule(&self.storage, &self.device_id, &list_id, &rule_id, config)
                    .await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("rules", |fields| fields.list_id = Some(list_id)),
                )
            }
        };

        Ok(outcome)
    }
}

impl CommandOutcome {
    fn new(response: Value, mutations: Vec<MutationPayload>) -> Self {
        Self {
            response,
            mutations,
        }
    }
}

fn required_response_string(response: &Value, action: &str, key: &str) -> Result<String, String> {
    optional_response_string(response, action, key)?
        .ok_or_else(|| format!("{action} response missing {key}"))
}

fn optional_response_string(
    response: &Value,
    action: &str,
    key: &str,
) -> Result<Option<String>, String> {
    match response.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{action} response {key} must be a string or null")),
    }
}
