use browser_recall_daemon::commands::{
    add_list_pins, add_rule, create_note, delete_list, delete_note, delete_snapshot,
    ensure_default_lists, get_snapshot_html, import_bookmarks, import_history, list_event_fields,
    list_history_files, list_paired_browsers, load_all_pages_payload, load_history_batch,
    load_page_notes_payload, load_page_snapshot_payload, page_relations_payload,
    pair_browser_revoke, permanent_delete_candidates, permanent_delete_keys, preview_rule_payload,
    read_desktop_value, recover_checkpoint_tail, remove_rule, rename_page, replay_entries,
    replay_entry, restore_list, restore_note, restore_snapshot, save_list_meta, save_settings_key,
    search_notes, search_snapshots, submit_event, toggle_list_pin, update_note, update_rule,
    BookmarkImportEntry, BookmarkImportNode, BookmarkImportSkipped, HistoryImportEntry,
};
use browser_recall_daemon::protocol::{RuleBatchEntry, RulePayload};
use browser_recall_daemon::storage::Storage;
use browser_recall_daemon::{ApprovedConnector, ConfigStore, Token};
use browser_recall_replay::entities::{
    ListEntity, ListOrderManifest, NameToIdManifest, PageEntity, PinEntity, TreeNode,
};
use browser_recall_replay::{generate_slug_from_url, LogEntry, RuleInput};
use std::collections::BTreeMap;
use std::path::Path;
use tempfile::tempdir;

async fn read_log_files(log_dir: &Path) -> Vec<String> {
    let mut entries = tokio::fs::read_dir(log_dir).await.expect("log dir exists");
    let mut logs = Vec::new();
    while let Some(entry) = entries.next_entry().await.expect("dir read") {
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        logs.push(
            tokio::fs::read_to_string(entry.path())
                .await
                .expect("log exists"),
        );
    }
    logs
}

#[tokio::test]
async fn import_history_creates_pages_and_log_entries() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let (page_count, visit_count, skipped_count) = import_history(
        &storage,
        "device-a",
        vec![HistoryImportEntry {
            url: "https://example.com/page".to_string(),
            title: Some("Example Page".to_string()),
            referrer_url: Some("https://example.com/root".to_string()),
            visit_times: vec![1_710_000_000_000, 1_710_000_000_000, 1_710_000_010_000],
        }],
    )
    .await
    .expect("history import");

    assert_eq!(page_count, 1);
    assert_eq!(visit_count, 2);
    assert_eq!(skipped_count, 0);

    let slug = generate_slug_from_url("https://example.com/page").expect("slug");
    let page = storage
        .load_page(&slug)
        .await
        .expect("load page")
        .expect("page exists");
    assert_eq!(page.url.as_deref(), Some("https://example.com/page"));
    assert_eq!(page.title.as_deref(), Some("Example Page"));

    let files = list_history_files(&storage, false)
        .await
        .expect("history files")
        .files;
    let batch = load_history_batch(&storage, &files)
        .await
        .expect("history batch");
    assert_eq!(batch.len(), 2);
}

#[tokio::test]
async fn read_desktop_value_filters_deleted_entities() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let mut list = ListEntity::new("test-list".to_string());
    list.name = "Test List".to_string();
    list.deleted = true;
    storage
        .save_list("test-list", &list)
        .await
        .expect("save list");

    let hidden = read_desktop_value(&storage, "list:test-list", false)
        .await
        .expect("read hidden");
    assert!(hidden.is_none());

    let visible = read_desktop_value(&storage, "list:test-list", true)
        .await
        .expect("read visible")
        .expect("value exists");
    assert_eq!(
        visible.get("deleted").and_then(|value| value.as_bool()),
        Some(true)
    );
}

#[tokio::test]
async fn write_updates_cache_after_a_cached_miss() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let missing = storage.load_list("later").await.expect("load missing list");
    assert!(missing.is_none());

    let response = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({
            "name": "Later",
        }),
    )
    .await
    .expect("create list after miss");
    let list_id = response
        .get("listId")
        .and_then(|value| value.as_str())
        .expect("list id");

    let list = storage
        .load_list(list_id)
        .await
        .expect("load created list")
        .expect("created list is visible from cache");
    assert_eq!(list.name, "Later");
}

#[tokio::test]
async fn concurrent_toggle_list_pin_serializes_against_current_cache() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let response = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({
            "name": "Reading",
        }),
    )
    .await
    .expect("create list");
    let list_id = response
        .get("listId")
        .and_then(|value| value.as_str())
        .expect("list id")
        .to_string();

    submit_event(
        &storage,
        "device-a",
        serde_json::json!({
            "timestamp": 1_710_000_000_000i64,
            "action": "visit_page",
            "url": "https://example.com/toggle",
            "title": "Toggle Page",
        }),
    )
    .await
    .expect("seed page");

    let request = serde_json::json!({
        "listId": list_id,
        "url": "https://example.com/toggle",
        "title": "Toggle Page"
    });
    let (left, right) = tokio::join!(
        toggle_list_pin(&storage, "device-a", &request),
        toggle_list_pin(&storage, "device-a", &request)
    );
    let left = left.expect("left toggle");
    let right = right.expect("right toggle");
    let pinned_results = [
        left.get("pinned").and_then(|value| value.as_bool()),
        right.get("pinned").and_then(|value| value.as_bool()),
    ];
    assert!(pinned_results.contains(&Some(true)));
    assert!(pinned_results.contains(&Some(false)));

    let list = storage
        .load_list(
            request
                .get("listId")
                .and_then(|value| value.as_str())
                .expect("list id"),
        )
        .await
        .expect("load list")
        .expect("list exists");
    assert!(
        list.pins.is_empty(),
        "second toggle should observe the first toggle and unpin"
    );
}

#[tokio::test]
async fn raw_sync_file_write_clears_cached_misses() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    assert!(storage
        .load_list("synced")
        .await
        .expect("load missing list")
        .is_none());

    let mut list = ListEntity::new("synced".to_string());
    list.name = "Synced".to_string();
    let payload = serde_json::to_string(&list).expect("serialize list");
    storage
        .write_sync_files(&[("views/lists/synced.json".to_string(), payload)])
        .await
        .expect("write sync files");

    let loaded = storage
        .load_list("synced")
        .await
        .expect("load synced list")
        .expect("synced list visible after cache reset");
    assert_eq!(loaded.name, "Synced");
}

#[tokio::test]
async fn replay_appends_log_before_checkpoint_visibility_is_required() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    replay_entry(
        &storage,
        "device-a",
        LogEntry::UpdateSetting {
            timestamp: 1_710_000_000_000,
            key: "syncEnabled".to_string(),
            value: serde_json::json!(true),
        },
    )
    .await
    .expect("replay entry");

    let files = list_history_files(&storage, false)
        .await
        .expect("history files")
        .files;
    let batch = load_history_batch(&storage, &files)
        .await
        .expect("history batch");
    assert_eq!(batch.len(), 1);

    let settings = storage
        .load_settings()
        .await
        .expect("load settings")
        .expect("settings visible from cache");
    assert_eq!(
        settings
            .values
            .get("syncEnabled")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
}

#[tokio::test]
async fn startup_recovery_replays_logs_after_replay_progress() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let raw = serde_json::json!({
        "timestamp": 1_710_000_000_000i64,
        "action": "visit_page",
        "url": "https://example.com/recovered",
        "title": "Recovered Page",
    });
    storage
        .append_log_entry("device-a", 1_710_000_000_000, &raw)
        .await
        .expect("append log only");

    let recovered_storage = Storage::new(dir.path());
    recovered_storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let replayed = recover_checkpoint_tail(&recovered_storage)
        .await
        .expect("recover checkpoint tail");
    assert_eq!(replayed, 1);

    let slug = generate_slug_from_url("https://example.com/recovered").expect("slug");
    let page = recovered_storage
        .load_page(&slug)
        .await
        .expect("load recovered page")
        .expect("page recovered from log");
    assert_eq!(page.title.as_deref(), Some("Recovered Page"));
}

#[tokio::test]
async fn old_timestamp_entries_flush_checkpoints_before_ack() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let replay_progress_path = dir
        .path()
        .join("views")
        .join("manifest")
        .join("replay-progress.json");
    tokio::fs::write(&replay_progress_path, r#"{"device-a":1710000100000}"#)
        .await
        .expect("write replay progress");

    let url = "https://example.com/old-import";
    replay_entry(
        &storage,
        "device-a",
        LogEntry::VisitPage {
            timestamp: 1_710_000_000_000,
            url: url.to_string(),
            title: Some("Old Import".to_string()),
            referrer_url: None,
        },
    )
    .await
    .expect("replay old visit entry");
    replay_entry(
        &storage,
        "device-a",
        LogEntry::RatePage {
            timestamp: 1_710_000_000_001,
            url: url.to_string(),
            likes: 1,
            title: Some("Old Import".to_string()),
        },
    )
    .await
    .expect("replay old retained entry");

    let fresh_storage = Storage::new(dir.path());
    let slug = generate_slug_from_url(url).expect("slug");
    let page = fresh_storage
        .load_page(&slug)
        .await
        .expect("load page from checkpoint")
        .expect("old entry checkpoint was flushed before ack");
    assert_eq!(page.title.as_deref(), Some("Old Import"));
}

#[tokio::test]
async fn note_and_snapshot_payloads_reflect_storage_state() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    replay_entry(
        &storage,
        "device-a",
        LogEntry::CreateNote {
            timestamp: 1_710_000_100_000,
            url: "https://example.com/page".to_string(),
            path: "objects/notes/example-note.json".to_string(),
            title: Some("Example Page".to_string()),
            excerpt: Some(serde_json::json!(["excerpt text"])),
            note: Some("note body".to_string()),
            css_path: None,
        },
    )
    .await
    .expect("create note");

    let slug = generate_slug_from_url("https://example.com/page").expect("slug");
    storage
        .save_snapshot_html(&slug, 1_710_000_200_000, "<html></html>")
        .await
        .expect("save html");
    storage
        .save_snapshot_markdown(&slug, 1_710_000_200_000, "snapshot markdown")
        .await
        .expect("save markdown");
    replay_entry(
        &storage,
        "device-a",
        LogEntry::CreateSnapshot {
            timestamp: 1_710_000_200_000,
            url: "https://example.com/page".to_string(),
            path: storage.snapshot_sidecar_relative_path(&slug, 1_710_000_200_000),
            title: Some("Example Page".to_string()),
        },
    )
    .await
    .expect("create snapshot");

    let notes = load_page_notes_payload(&storage, &slug)
        .await
        .expect("load notes");
    assert_eq!(notes.len(), 1);
    assert_eq!(
        notes[0].get("note").and_then(|value| value.as_str()),
        Some("note body")
    );

    let snapshots = load_page_snapshot_payload(&storage, &slug)
        .await
        .expect("load snapshots");
    assert_eq!(snapshots.len(), 1);
    assert_eq!(
        snapshots[0]
            .get("timestamp")
            .and_then(|value| value.as_i64()),
        Some(1_710_000_200_000)
    );
    assert_eq!(
        snapshots[0]
            .get("hasHtml")
            .and_then(|value| value.as_bool()),
        Some(true)
    );

    let snapshot_path = storage.snapshot_sidecar_relative_path(&slug, 1_710_000_200_000);
    tokio::fs::remove_file(dir.path().join(format!("{snapshot_path}.html")))
        .await
        .expect("remove html backing file");
    tokio::fs::remove_file(dir.path().join(format!("{snapshot_path}.md")))
        .await
        .expect("remove markdown backing file");

    let snapshots = load_page_snapshot_payload(&storage, &slug)
        .await
        .expect("reload snapshots with missing files");
    assert_eq!(snapshots.len(), 1);
    assert_eq!(
        snapshots[0].get("hasMd").and_then(|value| value.as_bool()),
        Some(false)
    );
    assert_eq!(
        snapshots[0]
            .get("hasHtml")
            .and_then(|value| value.as_bool()),
        Some(false)
    );

    delete_snapshot(&storage, "device-a", &slug, 1_710_000_200_000)
        .await
        .expect("delete snapshot metadata");

    let snapshots = load_page_snapshot_payload(&storage, &slug)
        .await
        .expect("reload snapshots");
    assert!(
        snapshots.is_empty(),
        "snapshot payload should disappear after deleting the missing-file item"
    );

    let page = storage
        .load_page(&slug)
        .await
        .expect("load page")
        .expect("page exists");
    assert!(
        !page
            .child_ids
            .contains(&format!("snapshot:{slug}-1710000200000")),
        "deleting snapshot files should remove the page child ref"
    );
}

#[tokio::test]
async fn permanent_delete_repairs_note_and_list_relationship_metadata() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let page_slug = generate_slug_from_url("https://example.com/page-a").expect("slug");
    let mut page = PageEntity::new(page_slug.clone());
    page.url = Some("https://example.com/page-a".to_string());
    page.child_ids = vec!["note:n1".to_string()];
    page.parent_ids = vec!["list:reading".to_string()];
    storage
        .save_page(&page_slug, &page)
        .await
        .expect("save page");

    replay_entry(
        &storage,
        "device-a",
        LogEntry::CreateNote {
            timestamp: 1_710_000_000_000,
            url: "https://example.com/page-a".to_string(),
            path: "objects/notes/n1.json".to_string(),
            title: Some("Page A".to_string()),
            excerpt: Some(serde_json::json!(["highlight"])),
            note: Some("note body".to_string()),
            css_path: None,
        },
    )
    .await
    .expect("create note");

    let mut list = ListEntity::new("reading".to_string());
    list.name = "Reading".to_string();
    list.owner = Some("device-a".to_string());
    list.pins = vec![
        PinEntity {
            id: format!("page:{page_slug}"),
            pinned_at: 1,
            source: Some("manual".to_string()),
        },
        PinEntity {
            id: "note:n1".to_string(),
            pinned_at: 2,
            source: Some("manual".to_string()),
        },
    ];
    storage
        .save_list("reading", &list)
        .await
        .expect("save list");
    storage
        .save_name_to_id(&NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("device-a/Reading".to_string(), "reading".to_string())]),
        })
        .await
        .expect("save name map");
    storage
        .save_list_order(&ListOrderManifest {
            timestamps: Default::default(),
            tree: vec![TreeNode {
                id: "list:reading".to_string(),
                children: Vec::new(),
            }],
        })
        .await
        .expect("save list order");

    let deleted = permanent_delete_keys(&storage, "device-a", &["note:n1".to_string()])
        .await
        .expect("permanent delete note");
    assert_eq!(deleted, vec!["note:n1".to_string()]);
    let page = storage
        .load_page(&page_slug)
        .await
        .expect("load page")
        .expect("page remains through list membership");
    assert!(!page.child_ids.contains(&"note:n1".to_string()));
    let list = storage
        .load_list("reading")
        .await
        .expect("load list")
        .expect("list remains");
    assert!(!list.pins.iter().any(|pin| pin.id == "note:n1"));

    let deleted = permanent_delete_keys(&storage, "device-a", &["list:reading".to_string()])
        .await
        .expect("permanent delete list");
    assert_eq!(deleted, vec!["list:reading".to_string()]);
    assert!(storage
        .load_list("reading")
        .await
        .expect("load list")
        .is_none());
    assert!(storage
        .load_page(&page_slug)
        .await
        .expect("load page")
        .is_none());
    let name_map = storage
        .load_name_to_id()
        .await
        .expect("load name map")
        .expect("name map exists");
    assert!(!name_map.paths.values().any(|value| value == "reading"));
    let order = storage
        .load_list_order()
        .await
        .expect("load list order")
        .expect("list order exists");
    assert!(!order.tree.iter().any(|node| node.id == "list:reading"));
}

#[tokio::test]
async fn submit_event_replays_arbitrary_log_entries() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let response = submit_event(
        &storage,
        "device-a",
        serde_json::json!({
            "timestamp": 1_710_000_300_000i64,
            "action": "update_setting",
            "key": "syncEnabled",
            "value": true
        }),
    )
    .await
    .expect("submit event");

    assert_eq!(
        response.get("timestamp").and_then(|value| value.as_i64()),
        Some(1_710_000_300_000)
    );
    let settings = storage
        .load_settings()
        .await
        .expect("load settings")
        .expect("settings exist");
    assert_eq!(
        settings
            .values
            .get("syncEnabled")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
}

#[tokio::test]
async fn submit_event_rejects_non_canonical_log_schema() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let result = submit_event(
        &storage,
        "device-a",
        serde_json::json!({
            "timestamp": 1_710_000_300_000i64,
            "action": "visit_page",
            "url": "https://example.com/schema",
            "title": "Schema Page",
            "bodyPreview": "transient rule matching data",
            "checkpoint": true,
        }),
    )
    .await;
    assert!(
        result.is_err(),
        "submit_event accepts canonical log entries only; transient command fields must be stripped before append"
    );

    let files = list_history_files(&storage, false)
        .await
        .expect("history files")
        .files;
    assert!(files.is_empty());
}

#[test]
fn paired_browser_commands_list_and_revoke_connectors() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config = config_store.load_or_create().expect("config");
    config.connectors.push(ApprovedConnector {
        browser_id: "browser-install-1".into(),
        browser_name: "Chrome".into(),
        extension_id: "abcdefghijklmnop".into(),
        browser_profile: Some("Default profile".into()),
        token: Token("secret-token".into()),
        approved_at: 1_710_000_000,
        last_seen_at: Some(1_710_000_123),
    });
    config_store.save(&config).expect("save config");

    let paired = list_paired_browsers(&config_store).expect("list paired browsers");
    assert_eq!(paired.len(), 1);
    assert_eq!(paired[0].browser_name, "Chrome");
    assert_eq!(
        paired[0].browser_profile.as_deref(),
        Some("Default profile")
    );
    assert_eq!(paired[0].last_seen, Some(1_710_000_123_000));

    let revoked = pair_browser_revoke(&config_store, "browser-install-1", "abcdefghijklmnop")
        .expect("revoke paired browser");
    assert!(revoked);
    let paired = list_paired_browsers(&config_store).expect("list after revoke");
    assert!(paired.is_empty());
}

#[test]
fn paired_browser_list_orders_recent_tokens_first() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config = config_store.load_or_create().expect("config");
    config.connectors.push(ApprovedConnector {
        browser_id: "old".into(),
        browser_name: "Chrome".into(),
        extension_id: "abcdefghijklmnop".into(),
        browser_profile: Some("Default profile".into()),
        token: Token("old-token".into()),
        approved_at: 1_710_000_000,
        last_seen_at: Some(1_710_000_100),
    });
    config.connectors.push(ApprovedConnector {
        browser_id: "new".into(),
        browser_name: "Chrome".into(),
        extension_id: "abcdefghijklmnop".into(),
        browser_profile: Some("Default profile".into()),
        token: Token("new-token".into()),
        approved_at: 1_710_000_001,
        last_seen_at: Some(1_710_000_200),
    });
    config.connectors.push(ApprovedConnector {
        browser_id: "never-seen".into(),
        browser_name: "Brave".into(),
        extension_id: "abcdefghijklmnop".into(),
        browser_profile: Some("Default profile".into()),
        token: Token("never-seen-token".into()),
        approved_at: 1_710_000_300,
        last_seen_at: None,
    });
    config_store.save(&config).expect("save config");

    let paired = list_paired_browsers(&config_store).expect("list paired browsers");
    assert_eq!(paired[0].browser_id, "new");
    assert_eq!(paired[1].browser_id, "old");
    assert_eq!(paired[2].browser_id, "never-seen");
}

#[tokio::test]
async fn migrated_note_and_list_commands_replay_entities() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    replay_entry(
        &storage,
        "device-a",
        LogEntry::VisitPage {
            timestamp: 1_710_000_400_000,
            url: "https://example.com/migrated".to_string(),
            title: Some("Migrated Page".to_string()),
            referrer_url: None,
        },
    )
    .await
    .expect("visit page");
    let page_slug = generate_slug_from_url("https://example.com/migrated").expect("slug");

    let note_response = create_note(
        &storage,
        "device-a",
        &serde_json::json!({
            "pageSlug": page_slug,
            "excerpt": ["selected text"],
            "note": "first note",
        }),
    )
    .await
    .expect("create note");
    let note_slug = note_response
        .get("noteSlug")
        .and_then(|value| value.as_str())
        .expect("note slug")
        .to_string();

    let update_response = update_note(&storage, "device-a", &note_slug, "updated note")
        .await
        .expect("update note");
    let updated_note_slug = update_response
        .get("noteSlug")
        .and_then(|value| value.as_str())
        .expect("updated note slug")
        .to_string();
    let notes = load_page_notes_payload(&storage, &page_slug)
        .await
        .expect("load notes");
    assert!(notes
        .iter()
        .find(|note| note.get("note").and_then(|value| value.as_str()) == Some("updated note"))
        .and_then(|note| note.get("slug"))
        .and_then(|value| value.as_str())
        .is_some());

    delete_note(&storage, "device-a", &updated_note_slug)
        .await
        .expect("delete note");
    restore_note(&storage, "device-a", &updated_note_slug)
        .await
        .expect("restore note");

    let list_response = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({ "name": "Migrated List" }),
    )
    .await
    .expect("create list");
    let list_id = list_response
        .get("listId")
        .and_then(|value| value.as_str())
        .expect("list id");
    let pin_response = toggle_list_pin(
        &storage,
        "device-a",
        &serde_json::json!({
            "listId": list_id,
            "url": "https://example.com/migrated",
        }),
    )
    .await
    .expect("toggle pin");
    assert_eq!(
        pin_response.get("pinned").and_then(|value| value.as_bool()),
        Some(true)
    );

    let list = storage
        .load_list(list_id)
        .await
        .expect("load list")
        .expect("list exists");
    assert!(list
        .pins
        .iter()
        .any(|pin| pin.id == format!("page:{page_slug}")));
}

#[tokio::test]
async fn create_note_preserves_structural_excerpt_and_css_path_arrays() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    replay_entry(
        &storage,
        "device-a",
        LogEntry::VisitPage {
            timestamp: 1_710_000_500_000,
            url: "https://example.com/highlight-arrays".to_string(),
            title: Some("Highlight Arrays".to_string()),
            referrer_url: None,
        },
    )
    .await
    .expect("visit page");
    let page_slug = generate_slug_from_url("https://example.com/highlight-arrays").expect("slug");

    let response = create_note(
        &storage,
        "device-a",
        &serde_json::json!({
            "pageSlug": page_slug,
            "excerpt": ["First block", "Second block"],
            "cssPath": ["body > p:nth-of-type(1)", "body > p:nth-of-type(2)"],
            "note": "grouped note",
        }),
    )
    .await
    .expect("create note");
    assert_eq!(
        response.get("success").and_then(|value| value.as_bool()),
        Some(true)
    );

    let notes = load_page_notes_payload(&storage, &page_slug)
        .await
        .expect("load notes");
    let note = notes
        .iter()
        .find(|note| note.get("note").and_then(|value| value.as_str()) == Some("grouped note"))
        .expect("grouped note");
    assert_eq!(
        note.get("excerpt"),
        Some(&serde_json::json!(["First block", "Second block"]))
    );
    assert_eq!(
        note.get("cssPath"),
        Some(&serde_json::json!([
            "body > p:nth-of-type(1)",
            "body > p:nth-of-type(2)"
        ]))
    );
}

#[tokio::test]
async fn save_settings_key_replays_update_setting() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    save_settings_key(
        &storage,
        "device-a",
        "syncRepoUrl",
        serde_json::json!("https://github.com/example/browser-recall-sync"),
    )
    .await
    .expect("save setting");

    let settings = storage
        .load_settings()
        .await
        .expect("load settings")
        .expect("settings exists");
    assert_eq!(
        settings
            .values
            .get("syncRepoUrl")
            .and_then(|value| value.as_str()),
        Some("https://github.com/example/browser-recall-sync")
    );
}

#[tokio::test]
async fn rule_and_rename_commands_replay_entities() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let list_response = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({ "name": "Rules List" }),
    )
    .await
    .expect("create list");
    let list_id = list_response
        .get("listId")
        .and_then(|value| value.as_str())
        .expect("list id")
        .to_string();
    let mut config = BTreeMap::new();
    config.insert(
        "pattern".to_string(),
        serde_json::Value::String("Example".to_string()),
    );
    let rule = RulePayload {
        rule_type: "keyword".to_string(),
        config,
    };

    let preview = preview_rule_payload(
        rule.clone(),
        vec![RuleBatchEntry {
            url: "https://example.com/rules".to_string(),
            title: Some("Example Rules".to_string()),
            body_preview: None,
            body: None,
            timestamp: None,
            action: None,
        }],
    )
    .expect("preview rule");
    assert_eq!(
        preview.get("success").and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        preview
            .get("results")
            .and_then(|value| value.as_array())
            .and_then(|values| values.first())
            .and_then(|value| value.get("match"))
            .and_then(|value| value.as_bool()),
        Some(true)
    );

    let add_response = add_rule(&storage, "device-a", &list_id, rule)
        .await
        .expect("add rule");
    assert_eq!(
        add_response
            .get("success")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    let list = storage
        .load_list(&list_id)
        .await
        .expect("load list")
        .expect("list exists");
    let rule_id = list.rules.first().expect("rule exists").id.clone();

    remove_rule(&storage, "device-a", &list_id, &rule_id)
        .await
        .expect("remove rule");
    let list = storage
        .load_list(&list_id)
        .await
        .expect("load list")
        .expect("list exists");
    assert!(list.rules.is_empty());

    replay_entry(
        &storage,
        "device-a",
        LogEntry::VisitPage {
            timestamp: 1_710_000_500_000,
            url: "https://example.com/rules".to_string(),
            title: Some("Original".to_string()),
            referrer_url: None,
        },
    )
    .await
    .expect("visit page");
    rename_page(
        &storage,
        "device-a",
        "https://example.com/rules",
        "Renamed Page",
    )
    .await
    .expect("rename page");
    let slug = generate_slug_from_url("https://example.com/rules").expect("slug");
    let page = storage
        .load_page(&slug)
        .await
        .expect("load page")
        .expect("page exists");
    assert_eq!(page.user_title.as_deref(), Some("Renamed Page"));
}

#[tokio::test]
async fn command_workflow_combines_bookmark_import_bulk_pins_restore_and_relations() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    for _ in 0..10_000 {
        storage.next_command_timestamp_millis();
    }

    assert!(
        ensure_default_lists(&storage, "device-a")
            .await
            .expect("bootstrap default lists"),
        "first run should create the system hubs list"
    );
    assert!(
        !ensure_default_lists(&storage, "device-a")
            .await
            .expect("bootstrap is idempotent"),
        "second run should not create duplicate default lists"
    );

    save_settings_key(
        &storage,
        "device-a",
        "colorScheme",
        serde_json::json!("rose"),
    )
    .await
    .expect("save setting after default lists");
    let logs_after_bootstrap = read_log_files(&dir.path().join("logs").join("device-a")).await;
    let timestamps_after_bootstrap = logs_after_bootstrap
        .iter()
        .flat_map(|raw| raw.lines())
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .expect("log json")
                .get("timestamp")
                .and_then(serde_json::Value::as_i64)
                .expect("timestamp")
        })
        .collect::<Vec<_>>();
    assert_eq!(timestamps_after_bootstrap.len(), 3);
    let default_rule_timestamp = timestamps_after_bootstrap[1];
    assert!(
        timestamps_after_bootstrap[0] < timestamps_after_bootstrap[1],
        "default list creation should reserve distinct timestamps"
    );
    assert!(
        timestamps_after_bootstrap[1] < timestamps_after_bootstrap[2],
        "next command must be newer than every default-list entry"
    );
    assert!(
        default_rule_timestamp < storage.next_command_timestamp_millis(),
        "command clock should advance past the second default-list entry"
    );

    let (list_count, bookmark_count, failures) = import_bookmarks(
        &storage,
        "device-a",
        vec![BookmarkImportNode {
            title: " Research ".to_string(),
            bookmarks: vec![
                BookmarkImportEntry {
                    url: "https://example.com/bookmark-a".to_string(),
                    title: "Bookmark A".to_string(),
                },
                BookmarkImportEntry {
                    url: "https://example.com/bookmark-b".to_string(),
                    title: String::new(),
                },
            ],
            skipped: vec![BookmarkImportSkipped {
                url: "chrome://settings".to_string(),
                title: "Settings".to_string(),
                reason: "unsupported URL".to_string(),
            }],
            children: vec![BookmarkImportNode {
                title: String::new(),
                bookmarks: vec![BookmarkImportEntry {
                    url: "https://example.com/child-bookmark".to_string(),
                    title: "Child Bookmark".to_string(),
                }],
                skipped: Vec::new(),
                children: Vec::new(),
            }],
        }],
    )
    .await
    .expect("import bookmarks");

    assert_eq!(list_count, 2);
    assert_eq!(bookmark_count, 3);
    assert_eq!(
        failures
            .first()
            .and_then(|value| value.get("reason"))
            .and_then(|value| value.as_str()),
        Some("unsupported URL")
    );
    storage
        .flush_checkpoints()
        .await
        .expect("flush imported list checkpoints");

    let imported_lists = storage.load_all_lists().await.expect("load imported lists");
    assert!(imported_lists.values().any(|list| list.name == "Hubs"));
    let research_id = imported_lists
        .iter()
        .find_map(|(id, list)| (list.name == "Research").then_some(id.clone()))
        .expect("research import list");
    let untitled_id = imported_lists
        .iter()
        .find_map(|(id, list)| (list.name == "Untitled").then_some(id.clone()))
        .expect("untitled child import list");

    let order = storage
        .load_list_order()
        .await
        .expect("load list order")
        .expect("list order exists");
    assert!(
        order
            .tree
            .iter()
            .flat_map(|node| node.children.iter())
            .any(|node| node.id == format!("list:{research_id}")),
        "import list should be nested below the generated import parent"
    );
    assert!(
        order
            .tree
            .iter()
            .flat_map(|node| node.children.iter())
            .flat_map(|node| node.children.iter())
            .any(|node| node.id == format!("list:{untitled_id}")),
        "child bookmark folder should be nested below the imported parent"
    );

    replay_entry(
        &storage,
        "device-a",
        LogEntry::VisitPage {
            timestamp: 1_710_001_000_000,
            url: "https://example.com/bulk-a".to_string(),
            title: Some("Existing Bulk Title".to_string()),
            referrer_url: Some("https://example.com/referrer".to_string()),
        },
    )
    .await
    .expect("seed bulk page");
    rename_page(
        &storage,
        "device-a",
        "https://example.com/referrer",
        "Durable Referrer",
    )
    .await
    .expect("retain referrer page");
    add_list_pins(
        &storage,
        "device-a",
        &serde_json::json!({
            "listId": research_id,
            "urls": [
                "https://example.com/bulk-a",
                "https://example.com/bulk-b"
            ],
            "titles": [
                null,
                "Provided Bulk Title"
            ]
        }),
    )
    .await
    .expect("bulk add pins");

    let research = storage
        .load_list(&research_id)
        .await
        .expect("load research list")
        .expect("research list exists");
    let bulk_a_slug = generate_slug_from_url("https://example.com/bulk-a").expect("bulk a slug");
    let bulk_b_slug = generate_slug_from_url("https://example.com/bulk-b").expect("bulk b slug");
    assert!(research
        .pins
        .iter()
        .any(|pin| pin.id == format!("page:{bulk_a_slug}")));
    assert!(research
        .pins
        .iter()
        .any(|pin| pin.id == format!("page:{bulk_b_slug}")));
    let bulk_a_page = storage
        .load_page(&bulk_a_slug)
        .await
        .expect("load bulk page")
        .expect("bulk page exists");
    assert_eq!(bulk_a_page.title.as_deref(), Some("Existing Bulk Title"));
    let bulk_b_page = storage
        .load_page(&bulk_b_slug)
        .await
        .expect("load second bulk page")
        .expect("second bulk page exists");
    assert_eq!(bulk_b_page.title.as_deref(), Some("Provided Bulk Title"));

    let pages_payload = load_all_pages_payload(&storage)
        .await
        .expect("load all pages payload");
    assert!(pages_payload
        .as_object()
        .expect("pages payload is object")
        .contains_key(&bulk_a_slug));

    let relations = page_relations_payload(&storage, "https://example.com/bulk-a")
        .await
        .expect("page relations");
    assert!(relations["parents"]["lists"]
        .as_array()
        .expect("list parents")
        .iter()
        .any(
            |value| value.get("slug").and_then(|slug| slug.as_str()) == Some(research_id.as_str())
        ));
    assert!(relations["parents"]["referrers"]
        .as_array()
        .expect("referrer parents")
        .iter()
        .any(|value| value.as_str() == Some("https://example.com/referrer")));

    let mut renamed_rule = BTreeMap::new();
    renamed_rule.insert(
        "pattern".to_string(),
        serde_json::Value::String("Bulk".to_string()),
    );
    replay_entry(
        &storage,
        "device-a",
        LogEntry::AddRule {
            timestamp: 1_710_001_000_100,
            list_owner: "device-a".to_string(),
            name: "Research".to_string(),
            rule: RuleInput {
                id: Some("rule-fixed".to_string()),
                rule_type: "keyword".to_string(),
                config: renamed_rule,
            },
        },
    )
    .await
    .expect("seed rule");
    update_rule(
        &storage,
        "device-a",
        &research_id,
        "rule-fixed",
        BTreeMap::from([(
            "pattern".to_string(),
            serde_json::Value::String("Existing".to_string()),
        )]),
    )
    .await
    .expect("update rule through command");
    let updated_research = storage
        .load_list(&research_id)
        .await
        .expect("load updated list")
        .expect("updated list exists");
    assert_eq!(
        updated_research
            .rules
            .first()
            .and_then(|rule| rule.config.get("pattern"))
            .and_then(|value| value.as_str()),
        Some("Existing")
    );

    let deleted = delete_list(&storage, "device-a", &research_id)
        .await
        .expect("delete list command");
    assert_eq!(
        deleted.get("listId").and_then(|value| value.as_str()),
        Some(research_id.as_str())
    );
    assert!(
        deleted
            .get("urls")
            .and_then(|value| value.as_array())
            .expect("deleted urls")
            .iter()
            .any(|value| value.as_str() == Some("https://example.com/bulk-a")),
        "delete_list should return affected page URLs for badge refresh"
    );
    restore_list(&storage, "device-a", &research_id)
        .await
        .expect("restore list command");
    let restored_research = storage
        .load_list(&research_id)
        .await
        .expect("load restored list")
        .expect("restored list exists");
    assert!(!restored_research.deleted);

    let snapshot_ts = 1_710_001_000_200;
    storage
        .save_snapshot_html(
            &bulk_a_slug,
            snapshot_ts,
            "<html><body>bulk snapshot</body></html>",
        )
        .await
        .expect("save snapshot html");
    replay_entry(
        &storage,
        "device-a",
        LogEntry::CreateSnapshot {
            timestamp: snapshot_ts,
            url: "https://example.com/bulk-a".to_string(),
            path: storage.snapshot_sidecar_relative_path(&bulk_a_slug, snapshot_ts),
            title: Some("Existing Bulk Title".to_string()),
        },
    )
    .await
    .expect("create snapshot");
    delete_snapshot(&storage, "device-a", &bulk_a_slug, snapshot_ts)
        .await
        .expect("delete snapshot command");
    let restored_page_slug = restore_snapshot(
        &storage,
        "device-a",
        &format!("{bulk_a_slug}-{snapshot_ts}"),
    )
    .await
    .expect("restore snapshot command");
    assert_eq!(restored_page_slug, bulk_a_slug);

    let missing_relations = page_relations_payload(&storage, "https://example.com/missing")
        .await
        .expect("missing page relations");
    assert_eq!(missing_relations["parents"]["lists"], serde_json::json!([]));
    assert_eq!(
        restore_snapshot(&storage, "device-a", "bad-snapshot-stem")
            .await
            .expect_err("invalid snapshot stem should fail"),
        "restoreSnapshot invalid snapSlug"
    );
}

#[tokio::test]
async fn command_error_and_normalization_paths_are_explicit() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    assert_eq!(
        read_desktop_value(&storage, "page:missing", false)
            .await
            .expect("read missing"),
        None
    );
    assert!(load_page_notes_payload(&storage, "missing")
        .await
        .expect("missing notes")
        .is_empty());
    assert!(load_page_snapshot_payload(&storage, "missing")
        .await
        .expect("missing snapshots")
        .is_empty());
    assert_eq!(
        get_snapshot_html(&storage, "missing", 123)
            .await
            .expect("missing snapshot html"),
        None
    );
    assert!(list_event_fields(&storage, "device-a", "missing")
        .await
        .expect("missing list fields")
        .is_none());
    replay_entries(&storage, "device-a", Vec::new())
        .await
        .expect("empty replay is accepted");
    assert_eq!(
        recover_checkpoint_tail(&storage)
            .await
            .expect("empty recovery"),
        0
    );

    let (page_count, visit_count, skipped_count) = import_history(
        &storage,
        "device-a",
        vec![
            HistoryImportEntry {
                url: "   ".to_string(),
                title: Some("Blank".to_string()),
                referrer_url: None,
                visit_times: vec![1],
            },
            HistoryImportEntry {
                url: "chrome://settings".to_string(),
                title: Some("Chrome".to_string()),
                referrer_url: None,
                visit_times: vec![2],
            },
            HistoryImportEntry {
                url: "https://example.com/skipped-empty-times".to_string(),
                title: Some("No Time".to_string()),
                referrer_url: None,
                visit_times: vec![0, -1],
            },
            HistoryImportEntry {
                url: "https://example.com/trimmed".to_string(),
                title: Some("  Trimmed Title  ".to_string()),
                referrer_url: Some(" file:///tmp/local ".to_string()),
                visit_times: vec![1_710_002_000_000, 1_710_002_000_000],
            },
        ],
    )
    .await
    .expect("history import with skips");
    assert_eq!((page_count, visit_count, skipped_count), (1, 1, 3));
    let trimmed_slug = generate_slug_from_url("https://example.com/trimmed").expect("slug");
    let trimmed_page = storage
        .load_page(&trimmed_slug)
        .await
        .expect("load trimmed page")
        .expect("trimmed page exists");
    assert_eq!(trimmed_page.title.as_deref(), Some("Trimmed Title"));
    assert!(
        trimmed_page.parent_ids.is_empty(),
        "non-http referrer should be ignored during import"
    );

    assert_eq!(
        save_settings_key(
            &storage,
            "device-a",
            "unknownSetting",
            serde_json::json!(true)
        )
        .await
        .expect_err("unknown settings key fails"),
        "Unknown settings key: unknownSetting"
    );
    assert_eq!(
        create_note(&storage, "device-a", &serde_json::json!({"excerpt": [" "]}))
            .await
            .expect_err("missing note URL fails"),
        "Cannot determine page URL for note"
    );
    assert_eq!(
        create_note(
            &storage,
            "device-a",
            &serde_json::json!({
                "url": "https://example.com/legacy-string-note",
                "excerpt": "legacy highlight",
                "note": "",
            })
        )
        .await
        .expect_err("legacy string excerpt fails"),
        "excerpt must be a string array or null"
    );
    assert_eq!(
        create_note(
            &storage,
            "device-a",
            &serde_json::json!({
                "url": "https://example.com/legacy-string-path",
                "excerpt": ["highlight"],
                "cssPath": ".content",
                "note": "",
            })
        )
        .await
        .expect_err("legacy string css path fails"),
        "cssPath must be a string array or null"
    );
    assert_eq!(
        create_note(
            &storage,
            "device-a",
            &serde_json::json!({
                "url": "https://example.com/non-string-excerpt-member",
                "excerpt": ["highlight", 7],
                "note": "",
            })
        )
        .await
        .expect_err("non-string excerpt array member fails"),
        "excerpt array must contain strings only"
    );
    assert_eq!(
        create_note(
            &storage,
            "device-a",
            &serde_json::json!({
                "url": "https://example.com/non-string-css-path-member",
                "excerpt": ["highlight"],
                "cssPath": [".content", false],
                "note": "",
            })
        )
        .await
        .expect_err("non-string css path array member fails"),
        "cssPath array must contain strings only"
    );
    let note_response = create_note(
        &storage,
        "device-a",
        &serde_json::json!({
            "url": "https://example.com/direct-note",
            "title": "Direct Note",
            "excerpt": [" Alpha ", "", "Beta"],
            "note": "body",
            "cssPath": [".content"]
        }),
    )
    .await
    .expect("create direct note");
    assert!(
        note_response
            .get("notes")
            .and_then(|value| value.as_array())
            .expect("notes array")
            .is_empty(),
        "without a pageSlug the command returns only the created slug"
    );
    let direct_note_slug = note_response
        .get("noteSlug")
        .and_then(|value| value.as_str())
        .expect("note slug")
        .to_string();
    let unchanged_note = update_note(&storage, "device-a", &direct_note_slug, "body")
        .await
        .expect("unchanged note update succeeds");
    assert_eq!(
        unchanged_note
            .get("noteSlug")
            .and_then(|value| value.as_str()),
        Some(direct_note_slug.as_str())
    );
    assert_eq!(
        update_note(&storage, "device-a", "missing-note", "body")
            .await
            .expect_err("missing note update fails"),
        "Note not found"
    );

    let root_list_response = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({"name": "Root Parent"}),
    )
    .await
    .expect("create root list");
    let root_list_id = root_list_response
        .get("listId")
        .and_then(|value| value.as_str())
        .expect("root list id")
        .to_string();
    let child_list_response = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({
            "name": "Child List",
            "parentPath": format!("root/list:{root_list_id}")
        }),
    )
    .await
    .expect("create child list");
    let child_list_id = child_list_response
        .get("listId")
        .and_then(|value| value.as_str())
        .expect("child list id")
        .to_string();
    let no_name_update = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({"listId": child_list_id}),
    )
    .await
    .expect("empty list update is no-op");
    assert_eq!(
        no_name_update
            .get("success")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    let same_name_update = save_list_meta(
        &storage,
        "device-a",
        &serde_json::json!({"listId": child_list_id, "name": "Child List"}),
    )
    .await
    .expect("same-name list update is no-op");
    assert_eq!(
        same_name_update
            .get("success")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        save_list_meta(&storage, "device-a", &serde_json::json!({"name": "   "}))
            .await
            .expect_err("missing create name fails"),
        "saveListMeta missing name"
    );
    assert_eq!(
        save_list_meta(
            &storage,
            "device-a",
            &serde_json::json!({"listId": "missing", "name": "New"})
        )
        .await
        .expect_err("missing list update fails"),
        "List not found"
    );

    assert_eq!(
        toggle_list_pin(
            &storage,
            "device-a",
            &serde_json::json!({"url": "https://example.com/no-list"})
        )
        .await
        .expect_err("toggle without list id fails"),
        "toggleListPin missing listId"
    );
    assert_eq!(
        toggle_list_pin(
            &storage,
            "device-a",
            &serde_json::json!({"listId": child_list_id})
        )
        .await
        .expect_err("toggle without URL fails"),
        "toggleListPin missing url"
    );
    toggle_list_pin(
        &storage,
        "device-a",
        &serde_json::json!({"listId": child_list_id, "id": format!("note:{direct_note_slug}")}),
    )
    .await
    .expect("pin note by id");
    let child_list = storage
        .load_list(&child_list_id)
        .await
        .expect("load child list")
        .expect("child list exists");
    assert!(child_list
        .pins
        .iter()
        .any(|pin| pin.id == format!("note:{direct_note_slug}")));

    assert_eq!(
        add_list_pins(
            &storage,
            "device-a",
            &serde_json::json!({"urls": ["https://example.com/a"]})
        )
        .await
        .expect_err("bulk pins missing list id fails"),
        "addListPins missing listId"
    );
    assert_eq!(
        add_list_pins(
            &storage,
            "device-a",
            &serde_json::json!({"listId": child_list_id})
        )
        .await
        .expect_err("bulk pins missing urls fails"),
        "addListPins missing urls"
    );
    add_list_pins(
        &storage,
        "device-a",
        &serde_json::json!({
            "listId": child_list_id,
            "urls": ["https://example.com/no-title-a", "https://example.com/no-title-b"],
            "titles": []
        }),
    )
    .await
    .expect("bulk pins with resized empty titles");

    assert_eq!(
        delete_list(&storage, "device-a", "missing-list")
            .await
            .expect_err("missing delete list fails"),
        "List not found"
    );
    assert_eq!(
        restore_list(&storage, "device-a", "missing-list")
            .await
            .expect_err("missing restore list fails"),
        "List not found"
    );
    assert_eq!(
        delete_snapshot(&storage, "device-a", "missing-page", 123)
            .await
            .expect_err("missing snapshot page fails"),
        "Page entity not found for snapshot"
    );
    let missing_url_slug = "snapshot-missing-url";
    storage
        .save_page(
            missing_url_slug,
            &PageEntity::new(missing_url_slug.to_string()),
        )
        .await
        .expect("save URL-less page");
    assert_eq!(
        delete_snapshot(&storage, "device-a", missing_url_slug, 123)
            .await
            .expect_err("URL-less snapshot page fails"),
        "Page entity missing URL for snapshot"
    );

    assert_eq!(
        permanent_delete_candidates(&[
            "note:n1".to_string(),
            "list:l1".to_string(),
            "page:p1".to_string(),
            "snapshot:s1-1".to_string(),
            "manifest:orphaned".to_string(),
        ]),
        vec![
            "note:n1".to_string(),
            "list:l1".to_string(),
            "page:p1".to_string(),
            "snapshot:s1-1".to_string(),
        ]
    );
    assert!(
        permanent_delete_keys(&storage, "device-a", &["manifest:orphaned".to_string()])
            .await
            .expect("no permanent candidates")
            .is_empty()
    );

    let invalid_rule = RulePayload {
        rule_type: "keyword".to_string(),
        config: BTreeMap::from([("case_sensitive".to_string(), serde_json::Value::Bool(true))]),
    };
    let preview = preview_rule_payload(
        invalid_rule.clone(),
        vec![RuleBatchEntry {
            url: "https://example.com/rule".to_string(),
            title: Some("Rule Page".to_string()),
            body_preview: None,
            body: Some("body text".to_string()),
            timestamp: None,
            action: None,
        }],
    )
    .expect("invalid preview returns payload");
    assert_eq!(
        preview.get("success").and_then(|value| value.as_bool()),
        Some(false)
    );
    let add_rule_result = add_rule(&storage, "device-a", &child_list_id, invalid_rule)
        .await
        .expect("invalid add rule returns payload");
    assert_eq!(
        add_rule_result
            .get("success")
            .and_then(|value| value.as_bool()),
        Some(false)
    );
    assert_eq!(
        remove_rule(&storage, "device-a", "missing-list", "rule")
            .await
            .expect_err("missing remove rule list fails"),
        "List not found"
    );
    assert_eq!(
        update_rule(
            &storage,
            "device-a",
            "missing-list",
            "rule",
            BTreeMap::new()
        )
        .await
        .expect_err("missing update rule list fails"),
        "List not found"
    );

    assert!(search_notes(&storage, "Alpha Beta")
        .expect("search notes")
        .iter()
        .any(|hit| hit.note_slug == direct_note_slug));
    assert!(search_snapshots(&storage, "nothing")
        .expect("search snapshots")
        .is_empty());
}
