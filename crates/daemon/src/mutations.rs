use crate::protocol::MutationPayload;
use crate::runtime::EntityMapView;
use browser_recall_replay::{generate_slug_from_url, LogEntry};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

pub fn dedupe_mutations(mutations: Vec<MutationPayload>) -> Vec<MutationPayload> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for mutation in mutations {
        let key = format!(
            "{}|{}|{}|{}|{}|{}|{}|{}",
            mutation.mutation_type,
            mutation.list_id.as_deref().unwrap_or(""),
            mutation.page_slug.as_deref().unwrap_or(""),
            mutation.note_slug.as_deref().unwrap_or(""),
            mutation.old_note_slug.as_deref().unwrap_or(""),
            mutation.slug.as_deref().unwrap_or(""),
            mutation.url.as_deref().unwrap_or(""),
            mutation.key.as_deref().unwrap_or(""),
        );
        if seen.insert(key) {
            deduped.push(mutation);
        }
    }
    deduped
}

pub fn mutation(mutation_type: &str) -> MutationPayload {
    MutationPayload {
        mutation_type: mutation_type.to_string(),
        list_id: None,
        page_slug: None,
        note_slug: None,
        old_note_slug: None,
        slug: None,
        url: None,
        key: None,
    }
}

fn note_slug_from_path(path: &str) -> Option<String> {
    path.strip_prefix("objects/notes/")
        .and_then(|value| value.strip_suffix(".json"))
        .map(str::to_string)
}

fn snapshot_slug_from_path(path: &str) -> Option<String> {
    path.strip_prefix("objects/snapshots/")
        .and_then(|value| value.rsplit_once('/').map(|(_, stem)| stem).or(Some(value)))
        .and_then(|value| value.rsplit_once('-').map(|(slug, _)| slug.to_string()))
}

fn page_slug_from_url(url: Option<&str>) -> Option<String> {
    url.and_then(|value| generate_slug_from_url(value).ok())
}

fn first_list_id_from_effects(effects: &EntityMapView) -> Option<String> {
    effects
        .keys()
        .find_map(|key| key.strip_prefix("list:").map(str::to_string))
}

pub fn build_mutations(
    entry: &LogEntry,
    raw_entry: &Value,
    effects: &EntityMapView,
) -> Vec<MutationPayload> {
    let mut mutations = Vec::new();

    match entry {
        LogEntry::VisitPage { url, .. }
        | LogEntry::LeavePage { url, .. }
        | LogEntry::RenamePage { url, .. }
        | LogEntry::RatePage { url, .. } => {
            mutations.push(MutationPayload {
                url: Some(url.clone()),
                ..mutation("history")
            });
        }
        LogEntry::UpdateSetting { key, .. } => {
            mutations.push(MutationPayload {
                key: Some(key.clone()),
                ..mutation("settings")
            });
        }
        LogEntry::PinToList { urls, .. } | LogEntry::UnpinFromList { urls, .. } => {
            let list_id = first_list_id_from_effects(effects);
            mutations.push(MutationPayload {
                list_id,
                url: urls.first().cloned(),
                ..mutation("pins")
            });
        }
        LogEntry::AddRule { .. } | LogEntry::RemoveRule { .. } | LogEntry::UpdateRule { .. } => {
            mutations.push(MutationPayload {
                list_id: first_list_id_from_effects(effects),
                ..mutation("rules")
            });
        }
        LogEntry::CreateList { .. }
        | LogEntry::UpdateList { .. }
        | LogEntry::UpdateListTree { .. }
        | LogEntry::DeleteList { .. }
        | LogEntry::RestoreList { .. } => {
            mutations.push(mutation("lists"));
        }
        LogEntry::CreateNote { path, url, .. } => {
            mutations.push(MutationPayload {
                page_slug: page_slug_from_url(Some(url.as_str())),
                note_slug: note_slug_from_path(path),
                url: Some(url.clone()),
                ..mutation("note")
            });
        }
        LogEntry::DeleteNote { url, path, .. } | LogEntry::RestoreNote { url, path, .. } => {
            mutations.push(MutationPayload {
                page_slug: page_slug_from_url(url.as_deref()),
                note_slug: note_slug_from_path(path),
                url: url.clone(),
                ..mutation("note")
            });
        }
        LogEntry::ReplaceNote {
            url,
            path,
            old_path,
            ..
        } => {
            mutations.push(MutationPayload {
                page_slug: page_slug_from_url(url.as_deref()),
                note_slug: note_slug_from_path(path),
                old_note_slug: note_slug_from_path(old_path),
                url: url.clone(),
                ..mutation("note")
            });
        }
        LogEntry::CreateSnapshot { url, path, .. }
        | LogEntry::DeleteSnapshot { url, path, .. }
        | LogEntry::RestoreSnapshot { url, path, .. } => {
            mutations.push(MutationPayload {
                page_slug: page_slug_from_url(Some(url.as_str())),
                slug: snapshot_slug_from_path(path),
                url: Some(url.clone()),
                ..mutation("snapshot")
            });
        }
        LogEntry::PermanentDelete { keys, .. } => {
            if keys.iter().any(|key| key.starts_with("note:")) {
                mutations.push(mutation("note"));
            }
            if keys.iter().any(|key| key.starts_with("snapshot:")) {
                mutations.push(mutation("snapshot"));
            }
            if keys
                .iter()
                .any(|key| key.starts_with("list:") || key.starts_with("page:"))
            {
                mutations.push(mutation("lists"));
            }
        }
    }

    if effects.contains_key("manifest:orphaned") {
        mutations.push(mutation("orphaned"));
    }
    if effects.contains_key("manifest:list-order") || effects.contains_key("manifest:name-to-id") {
        mutations.push(mutation("lists"));
    }
    if raw_entry
        .get("source")
        .and_then(Value::as_str)
        .is_some_and(|value| value == "auto")
    {
        mutations.push(MutationPayload {
            list_id: first_list_id_from_effects(effects),
            ..mutation("pins")
        });
    }

    let mut deduped = Vec::new();
    let mut seen = BTreeSet::new();
    for item in mutations {
        let signature = format!(
            "{}|{}|{}|{}|{}|{}|{}|{}",
            item.mutation_type,
            item.list_id.as_deref().unwrap_or_default(),
            item.page_slug.as_deref().unwrap_or_default(),
            item.note_slug.as_deref().unwrap_or_default(),
            item.old_note_slug.as_deref().unwrap_or_default(),
            item.slug.as_deref().unwrap_or_default(),
            item.url.as_deref().unwrap_or_default(),
            item.key.as_deref().unwrap_or_default()
        );
        if seen.insert(signature) {
            deduped.push(item);
        }
    }
    deduped
}
