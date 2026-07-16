use crate::commands;
use crate::mutations::{mutation_batch as mutation, mutation_batch_with as mutation_with};
use crate::protocol::{HistoryMutationEntry, MutationPayload, RulePayload};
use crate::runtime;
use crate::storage::Storage;
use browser_recall_replay::{entities::TreeNode, LogEntry};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct CommandOutcome {
    response: Value,
    pub mutations: Vec<MutationPayload>,
}

#[derive(Clone)]
pub struct CommandAuthority {
    storage: Storage,
    device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListOrderInput {
    slug: String,
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

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CommandRequest {
    SaveSettingsKey {
        key: String,
        value: Value,
    },
    RenamePage {
        url: String,
        user_title: String,
    },
    RatePage {
        url: String,
        likes: i64,
        title: Option<String>,
    },
    CreateNote {
        page_slug: Option<String>,
        url: Option<String>,
        title: Option<String>,
        excerpt: Option<Value>,
        note: Option<String>,
        css_path: Option<Value>,
    },
    DeleteNote {
        note_slug: String,
    },
    UpdateNote {
        note_slug: String,
        note: String,
    },
    ToggleListPin {
        list_id: String,
        url: Option<String>,
        title: Option<String>,
        id: Option<String>,
    },
    AddListPins {
        list_id: String,
        urls: Vec<String>,
        titles: Option<Vec<Option<String>>>,
    },
    SaveListMeta {
        list_id: Option<String>,
        name: Option<String>,
        parent_path: Option<String>,
    },
    CreateListAndPin {
        name: String,
        url: String,
        title: Option<String>,
    },
    ImportBookmarks {
        tree: Vec<commands::BookmarkImportNode>,
    },
    ImportHistory {
        entries: Vec<commands::HistoryImportEntry>,
    },
    DeleteList {
        list_id: String,
    },
    UpdateListTree {
        tree: Vec<ListOrderInput>,
    },
    RestoreNote {
        note_slug: String,
    },
    RestoreSnapshot {
        snap_slug: String,
    },
    RestoreList {
        list_id: String,
    },
    PermanentDeleteAll,
    DeleteSnapshot {
        slug: String,
        timestamp: i64,
    },
    ClearAllData,
    AddRule {
        list_id: String,
        rule: RulePayload,
    },
    RemoveRule {
        list_id: String,
        rule_id: String,
    },
    UpdateRule {
        list_id: String,
        rule_id: String,
        config: BTreeMap<String, Value>,
    },
}

const SUPPORTED_ACTIONS: &[&str] = &[
    "saveSettingsKey",
    "renamePage",
    "ratePage",
    "createNote",
    "deleteNote",
    "updateNote",
    "toggleListPin",
    "addListPins",
    "saveListMeta",
    "createListAndPin",
    "importBookmarks",
    "importHistory",
    "deleteList",
    "updateListTree",
    "restoreNote",
    "restoreSnapshot",
    "restoreList",
    "permanentDeleteAll",
    "deleteSnapshot",
    "clearAllData",
    "addRule",
    "removeRule",
    "updateRule",
];

impl CommandAuthority {
    pub fn new(storage: Storage, device_id: String) -> Self {
        Self { storage, device_id }
    }

    pub fn supports(action: &str) -> bool {
        SUPPORTED_ACTIONS.contains(&action)
    }

    pub async fn execute(&self, action: &str, request: Value) -> Result<CommandOutcome, String> {
        if !Self::supports(action) {
            return Err(format!("unsupported daemon command: {action}"));
        }
        let mut request_object = request
            .as_object()
            .cloned()
            .ok_or_else(|| format!("{action} request must be an object"))?;
        request_object.insert("action".to_string(), Value::String(action.to_string()));
        let request = serde_json::from_value::<CommandRequest>(Value::Object(request_object))
            .map_err(|error| command_request_error(action, error))?;

        let outcome = match request {
            CommandRequest::SaveSettingsKey { key, value } => {
                commands::save_settings_key(&self.storage, &self.device_id, &key, value).await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("settings", |fields| fields.key = Some(key)),
                )
            }
            CommandRequest::RenamePage { url, user_title } => {
                let timestamp =
                    commands::rename_page(&self.storage, &self.device_id, &url, &user_title)
                        .await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("history", |fields| {
                        fields.url = Some(url.clone());
                        fields.history_entry = Some(HistoryMutationEntry {
                            action: "rename_page".to_string(),
                            timestamp,
                            url,
                            title: None,
                            user_title: Some(user_title),
                            scroll_depth: None,
                            time_on_page: None,
                            likes: None,
                            device_id: self.device_id.clone(),
                        });
                    }),
                )
            }
            CommandRequest::RatePage { url, likes, title } => {
                let timestamp = self.storage.next_command_timestamp_millis();
                commands::replay_entry(
                    &self.storage,
                    &self.device_id,
                    LogEntry::RatePage {
                        timestamp,
                        url: url.clone(),
                        likes,
                        title: title.clone(),
                    },
                )
                .await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("history", |fields| {
                        fields.url = Some(url.clone());
                        fields.history_entry = Some(HistoryMutationEntry {
                            action: "rate_page".to_string(),
                            timestamp,
                            url,
                            title,
                            user_title: None,
                            scroll_depth: None,
                            time_on_page: None,
                            likes: Some(likes),
                            device_id: self.device_id.clone(),
                        });
                    }),
                )
            }
            CommandRequest::CreateNote {
                page_slug,
                url,
                title,
                excerpt,
                note,
                css_path,
            } => {
                let request_url = url.clone();
                let response = commands::create_note(
                    &self.storage,
                    &self.device_id,
                    commands::CreateNoteInput {
                        page_slug,
                        url,
                        title,
                        excerpt,
                        note,
                        css_path,
                    },
                )
                .await?;
                let note_slug = required_response_string(&response, "createNote", "noteSlug")?;
                let page_slug = optional_response_string(&response, "createNote", "pageSlug")?;
                let mutations = mutation_with("note", |fields| {
                    fields.page_slug = page_slug;
                    fields.note_slug = Some(note_slug);
                    fields.url = request_url;
                });
                CommandOutcome::new(response, mutations)
            }
            CommandRequest::DeleteNote { note_slug } => {
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
            CommandRequest::UpdateNote {
                note_slug: old_note_slug,
                note,
            } => {
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
            CommandRequest::ToggleListPin {
                list_id,
                url: request_url,
                title,
                id,
            } => {
                let url = if let Some(url) = request_url.as_ref() {
                    Some(url.clone())
                } else if let Some(note_slug) =
                    id.as_deref().and_then(|value| value.strip_prefix("note:"))
                {
                    self.storage
                        .load_note(note_slug)
                        .await
                        .map_err(|error| error.to_string())?
                        .and_then(|note| note.url)
                } else {
                    None
                };
                let response = commands::toggle_list_pin(
                    &self.storage,
                    &self.device_id,
                    commands::ToggleListPinInput {
                        list_id: list_id.clone(),
                        url: request_url,
                        title,
                        id,
                    },
                )
                .await?;
                CommandOutcome::new(
                    response,
                    mutation_with("pins", |fields| {
                        fields.list_id = Some(list_id);
                        fields.url = url.clone();
                        fields.urls = url.map(|value| vec![value]);
                    }),
                )
            }
            CommandRequest::AddListPins {
                list_id,
                urls,
                titles,
            } => {
                let mutation_urls = urls.clone();
                commands::add_list_pins(
                    &self.storage,
                    &self.device_id,
                    commands::AddListPinsInput {
                        list_id: list_id.clone(),
                        urls,
                        titles,
                    },
                )
                .await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("pins", |fields| {
                        fields.list_id = Some(list_id);
                        fields.url = mutation_urls.first().cloned();
                        fields.urls = Some(mutation_urls);
                    }),
                )
            }
            CommandRequest::SaveListMeta {
                list_id,
                name,
                parent_path,
            } => {
                let response = commands::save_list_meta(
                    &self.storage,
                    &self.device_id,
                    commands::SaveListMetaInput {
                        list_id,
                        name,
                        parent_path,
                    },
                )
                .await?;
                CommandOutcome::new(response, mutation("lists"))
            }
            CommandRequest::CreateListAndPin { name, url, title } => {
                let response = commands::create_list_and_pin(
                    &self.storage,
                    &self.device_id,
                    commands::CreateListAndPinInput {
                        name,
                        url: url.clone(),
                        title,
                    },
                )
                .await?;
                let list_id = response["listId"]
                    .as_str()
                    .ok_or_else(|| "createListAndPin returned no listId".to_string())?
                    .to_string();
                let mut mutations = mutation("lists");
                mutations.extend(mutation_with("pins", |fields| {
                    fields.list_id = Some(list_id);
                    fields.url = Some(url.clone());
                    fields.urls = Some(vec![url]);
                }));
                CommandOutcome::new(response, mutations)
            }
            CommandRequest::ImportBookmarks { tree } => {
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
            CommandRequest::ImportHistory { entries } => {
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
            CommandRequest::DeleteList { list_id } => {
                let response =
                    commands::delete_list(&self.storage, &self.device_id, &list_id).await?;
                let response_list_id = required_response_string(&response, "deleteList", "listId")?;
                let urls = required_response_string_array(&response, "deleteList", "urls")?;
                let mut mutations = mutation_with("lists", |fields| {
                    fields.list_id = Some(response_list_id);
                    fields.url = urls.first().cloned();
                    fields.urls = Some(urls);
                });
                mutations.extend(mutation("orphaned"));
                CommandOutcome::new(response, mutations)
            }
            CommandRequest::UpdateListTree { tree } => {
                let tree = tree
                    .into_iter()
                    .map(ListOrderInput::into_tree_node)
                    .collect();
                commands::update_list_tree(&self.storage, &self.device_id, tree).await?;
                CommandOutcome::new(json!({ "success": true }), mutation("lists"))
            }
            CommandRequest::RestoreNote { note_slug } => {
                commands::restore_note(&self.storage, &self.device_id, &note_slug).await?;
                let mut mutations = mutation("orphaned");
                mutations.extend(mutation_with("note", |fields| {
                    fields.note_slug = Some(note_slug)
                }));
                CommandOutcome::new(json!({ "success": true }), mutations)
            }
            CommandRequest::RestoreSnapshot { snap_slug } => {
                let page_slug =
                    commands::restore_snapshot(&self.storage, &self.device_id, &snap_slug).await?;
                let mut mutations = mutation("orphaned");
                mutations.extend(mutation_with("snapshot", |fields| {
                    fields.slug = Some(page_slug)
                }));
                CommandOutcome::new(json!({ "success": true }), mutations)
            }
            CommandRequest::RestoreList { list_id } => {
                commands::restore_list(&self.storage, &self.device_id, &list_id).await?;
                let mut mutations = mutation("orphaned");
                mutations.extend(mutation("lists"));
                CommandOutcome::new(json!({ "success": true }), mutations)
            }
            CommandRequest::DeleteSnapshot { slug, timestamp } => {
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
            CommandRequest::PermanentDeleteAll => {
                let keys = self
                    .storage
                    .load_orphaned()
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "orphaned manifest is missing".to_string())?
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
            CommandRequest::ClearAllData => {
                let deleted_count = runtime::clear_all_data(&self.storage, &self.device_id).await?;
                commands::ensure_default_settings(&self.storage, &self.device_id).await?;
                commands::ensure_default_lists(&self.storage, &self.device_id).await?;
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
            CommandRequest::AddRule { list_id, rule } => {
                let response =
                    commands::add_rule(&self.storage, &self.device_id, &list_id, rule).await?;
                CommandOutcome::new(
                    response,
                    mutation_with("rules", |fields| fields.list_id = Some(list_id)),
                )
            }
            CommandRequest::RemoveRule { list_id, rule_id } => {
                commands::remove_rule(&self.storage, &self.device_id, &list_id, &rule_id).await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("rules", |fields| fields.list_id = Some(list_id)),
                )
            }
            CommandRequest::UpdateRule {
                list_id,
                rule_id,
                config,
            } => {
                commands::update_rule(&self.storage, &self.device_id, &list_id, &rule_id, config)
                    .await?;
                CommandOutcome::new(
                    json!({ "success": true }),
                    mutation_with("rules", |fields| fields.list_id = Some(list_id)),
                )
            }
        };

        outcome
    }
}

fn command_request_error(action: &str, error: serde_json::Error) -> String {
    let message = error.to_string();
    if let Some(field) = message
        .strip_prefix("missing field `")
        .and_then(|rest| rest.split_once('`').map(|(field, _)| field))
    {
        return format!("{action} missing {field}");
    }
    format!("{action} request: {message}")
}

impl CommandOutcome {
    fn new(response: Value, mutations: Vec<MutationPayload>) -> Result<Self, String> {
        let payload = response
            .as_object()
            .ok_or_else(|| "command implementation returned a non-object response".to_string())?;
        match payload.get("success") {
            Some(Value::Bool(true)) => {}
            Some(_) => {
                return Err(
                    "command implementation returned a non-success response on the success path"
                        .to_string(),
                )
            }
            None => {
                return Err(
                    "command implementation response is missing explicit success".to_string(),
                )
            }
        }
        if payload.contains_key("error") {
            return Err("command success payload must not contain error".to_string());
        }
        Ok(Self {
            response,
            mutations,
        })
    }

    pub fn response(&self) -> Value {
        self.response.clone()
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

fn required_response_string_array(
    response: &Value,
    action: &str,
    key: &str,
) -> Result<Vec<String>, String> {
    response
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{action} response missing {key}"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{action} response {key} must contain strings only"))
        })
        .collect()
}
