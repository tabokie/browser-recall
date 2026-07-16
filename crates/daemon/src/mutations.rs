use crate::protocol::{HistoryMutationEntry, MutationPayload};
use crate::runtime::EntityMapView;
use browser_recall_replay::{generate_slug_from_url, LogEntry};
use serde_json::Value;
use std::collections::HashSet;

pub fn dedupe_mutations(mutations: Vec<MutationPayload>) -> Vec<MutationPayload> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for mutation in mutations {
        if seen.insert(mutation.clone()) {
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
        urls: None,
        key: None,
        history_entry: None,
    }
}

pub fn mutation_batch(mutation_type: &str) -> Vec<MutationPayload> {
    vec![mutation(mutation_type)]
}

pub fn mutation_batch_with(
    mutation_type: &str,
    configure: impl FnOnce(&mut MutationPayload),
) -> Vec<MutationPayload> {
    let mut payload = mutation(mutation_type);
    configure(&mut payload);
    vec![payload]
}

fn note_slug_from_path(path: &str) -> Option<String> {
    path.strip_prefix("objects/notes/")
        .and_then(|value| value.strip_suffix(".json"))
        .map(str::to_string)
}

fn snapshot_slug_from_path(path: &str) -> Option<String> {
    path.strip_prefix("objects/snapshots/")
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.rsplit_once('-').map(|(slug, _)| slug.to_string()))
}

fn page_slug_from_url(url: Option<&str>) -> Result<Option<String>, String> {
    url.map(generate_slug_from_url)
        .transpose()
        .map_err(|error| error.to_string())
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
    device_id: &str,
) -> Result<Vec<MutationPayload>, String> {
    let mut mutations = Vec::new();

    match entry {
        LogEntry::VisitPage {
            timestamp,
            url,
            title,
            ..
        } => {
            mutations.push(MutationPayload {
                url: Some(url.clone()),
                history_entry: Some(HistoryMutationEntry {
                    action: "visit_page".to_string(),
                    timestamp: *timestamp,
                    url: url.clone(),
                    title: title.clone(),
                    user_title: None,
                    scroll_depth: None,
                    time_on_page: None,
                    likes: None,
                    device_id: device_id.to_string(),
                }),
                ..mutation("history")
            });
        }
        LogEntry::LeavePage {
            timestamp,
            url,
            title,
            scroll_depth,
            time_on_page,
        } => {
            mutations.push(MutationPayload {
                url: Some(url.clone()),
                history_entry: Some(HistoryMutationEntry {
                    action: "leave_page".to_string(),
                    timestamp: *timestamp,
                    url: url.clone(),
                    title: title.clone(),
                    user_title: None,
                    scroll_depth: *scroll_depth,
                    time_on_page: *time_on_page,
                    likes: None,
                    device_id: device_id.to_string(),
                }),
                ..mutation("history")
            });
        }
        LogEntry::RenamePage {
            timestamp,
            url,
            user_title,
        } => {
            mutations.push(MutationPayload {
                url: Some(url.clone()),
                history_entry: Some(HistoryMutationEntry {
                    action: "rename_page".to_string(),
                    timestamp: *timestamp,
                    url: url.clone(),
                    title: None,
                    user_title: Some(user_title.clone()),
                    scroll_depth: None,
                    time_on_page: None,
                    likes: None,
                    device_id: device_id.to_string(),
                }),
                ..mutation("history")
            });
        }
        LogEntry::RatePage {
            timestamp,
            url,
            title,
            likes,
        } => {
            mutations.push(MutationPayload {
                url: Some(url.clone()),
                history_entry: Some(HistoryMutationEntry {
                    action: "rate_page".to_string(),
                    timestamp: *timestamp,
                    url: url.clone(),
                    title: title.clone(),
                    user_title: None,
                    scroll_depth: None,
                    time_on_page: None,
                    likes: Some(*likes),
                    device_id: device_id.to_string(),
                }),
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
                urls: Some(urls.clone()),
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
                page_slug: page_slug_from_url(Some(url.as_str()))?,
                note_slug: note_slug_from_path(path),
                url: Some(url.clone()),
                ..mutation("note")
            });
        }
        LogEntry::DeleteNote { url, path, .. } | LogEntry::RestoreNote { url, path, .. } => {
            mutations.push(MutationPayload {
                page_slug: page_slug_from_url(url.as_deref())?,
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
                page_slug: page_slug_from_url(url.as_deref())?,
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
                page_slug: page_slug_from_url(Some(url.as_str()))?,
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
    if raw_entry.get("source").and_then(Value::as_str) == Some("auto") {
        let url = raw_entry
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string);
        mutations.push(MutationPayload {
            list_id: first_list_id_from_effects(effects),
            urls: url.clone().map(|value| vec![value]),
            url,
            ..mutation("pins")
        });
    }

    Ok(dedupe_mutations(mutations))
}

#[cfg(test)]
mod tests {
    use super::{build_mutations, dedupe_mutations};
    use crate::runtime::EntityMapView;
    use browser_recall_replay::LogEntry;
    use serde_json::json;

    #[test]
    fn visit_mutation_carries_the_committed_history_observation() {
        let entry = LogEntry::VisitPage {
            timestamp: 1_710_000_000_123,
            url: "https://example.com/precise-mutation".to_string(),
            title: Some("Precise mutation".to_string()),
            referrer_url: None,
        };
        let mutations = build_mutations(
            &entry,
            &serde_json::to_value(&entry).expect("visit JSON"),
            &EntityMapView::new(),
            "device-a",
        )
        .expect("history mutation");

        assert_eq!(mutations.len(), 1);
        assert_eq!(
            serde_json::to_value(&mutations[0]).expect("mutation JSON")["historyEntry"],
            json!({
                "action": "visit_page",
                "timestamp": 1_710_000_000_123i64,
                "url": "https://example.com/precise-mutation",
                "title": "Precise mutation",
                "userTitle": null,
                "scrollDepth": null,
                "timeOnPage": null,
                "likes": null,
                "deviceId": "device-a"
            })
        );
    }

    #[test]
    fn action_specific_history_mutations_preserve_committed_fields() {
        let leave = LogEntry::LeavePage {
            timestamp: 1_710_000_000_124,
            url: "https://example.com/precise-mutation".to_string(),
            title: Some("Precise mutation".to_string()),
            scroll_depth: Some(73),
            time_on_page: Some(45_000),
        };
        let rate = LogEntry::RatePage {
            timestamp: 1_710_000_000_125,
            url: "https://example.com/precise-mutation".to_string(),
            likes: -1,
            title: Some("Precise mutation".to_string()),
        };

        let leave_mutations = build_mutations(
            &leave,
            &serde_json::to_value(&leave).expect("leave JSON"),
            &EntityMapView::new(),
            "device-a",
        )
        .expect("leave mutation");
        let rate_mutations = build_mutations(
            &rate,
            &serde_json::to_value(&rate).expect("rate JSON"),
            &EntityMapView::new(),
            "device-a",
        )
        .expect("rate mutation");

        assert_eq!(
            serde_json::to_value(&leave_mutations[0]).expect("leave mutation JSON")["historyEntry"]
                ["scrollDepth"],
            json!(73)
        );
        assert_eq!(
            serde_json::to_value(&leave_mutations[0]).expect("leave mutation JSON")["historyEntry"]
                ["timeOnPage"],
            json!(45_000)
        );
        assert_eq!(
            serde_json::to_value(&rate_mutations[0]).expect("rate mutation JSON")["historyEntry"]
                ["likes"],
            json!(-1)
        );
    }

    #[test]
    fn precise_history_mutations_for_one_url_are_not_deduplicated() {
        let url = "https://example.com/precise-mutation";
        let entries = [
            LogEntry::VisitPage {
                timestamp: 1_710_000_000_123,
                url: url.to_string(),
                title: Some("Precise mutation".to_string()),
                referrer_url: None,
            },
            LogEntry::LeavePage {
                timestamp: 1_710_000_000_124,
                url: url.to_string(),
                title: Some("Precise mutation".to_string()),
                scroll_depth: Some(73),
                time_on_page: Some(45_000),
            },
        ];
        let mut mutations = Vec::new();
        for entry in entries {
            mutations.extend(
                build_mutations(
                    &entry,
                    &serde_json::to_value(&entry).expect("entry JSON"),
                    &EntityMapView::new(),
                    "device-a",
                )
                .expect("history mutation"),
            );
        }

        let deduped = dedupe_mutations(mutations);
        assert_eq!(deduped.len(), 2);
        assert_eq!(
            deduped
                .iter()
                .filter_map(|mutation| mutation.history_entry.as_ref())
                .map(|entry| entry.action.as_str())
                .collect::<Vec<_>>(),
            vec!["visit_page", "leave_page"]
        );
    }
}
