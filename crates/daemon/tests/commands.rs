use browser_recall_daemon::commands::{
    add_rule, create_note, delete_note, import_history, list_history_files, list_paired_browsers,
    load_history_batch, load_page_notes_payload, load_page_snapshot_payload, pair_browser_revoke,
    preview_rule_payload, read_cacheable, remove_rule, rename_page, replay_entry, restore_note,
    save_list_meta, save_settings_key, submit_event, toggle_list_pin, update_note,
    HistoryImportEntry,
};
use browser_recall_daemon::protocol::{RuleBatchEntry, RulePayload};
use browser_recall_daemon::storage::Storage;
use browser_recall_daemon::{ApprovedConnector, ConfigStore, Token};
use browser_recall_replay::entities::ListEntity;
use browser_recall_replay::{generate_slug_from_url, LogEntry};
use std::collections::BTreeMap;
use tempfile::tempdir;

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

    let (files, _) = list_history_files(&storage, false)
        .await
        .expect("history files");
    let batch = load_history_batch(&storage, &files)
        .await
        .expect("history batch");
    assert_eq!(batch.len(), 2);
}

#[tokio::test]
async fn read_cacheable_filters_deleted_entities() {
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

    let hidden = read_cacheable(&storage, "list:test-list", false)
        .await
        .expect("read hidden");
    assert!(hidden.is_none());

    let visible = read_cacheable(&storage, "list:test-list", true)
        .await
        .expect("read visible")
        .expect("value exists");
    assert_eq!(
        visible.get("deleted").and_then(|value| value.as_bool()),
        Some(true)
    );
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
            path: "notes/example-note.json".to_string(),
            title: Some("Example Page".to_string()),
            excerpt: Some("excerpt text".to_string()),
            note: Some("note body".to_string()),
            css_path: None,
        },
    )
    .await
    .expect("create note");

    storage
        .save_snapshot_html("example-com-page", 1_710_000_200_000, "<html></html>")
        .await
        .expect("save html");
    storage
        .save_snapshot_markdown("example-com-page", 1_710_000_200_000, "snapshot markdown")
        .await
        .expect("save markdown");
    replay_entry(
        &storage,
        "device-a",
        LogEntry::CreateSnapshot {
            timestamp: 1_710_000_200_000,
            url: "https://example.com/page".to_string(),
            path: "snapshots/example-com-page-1710000200000".to_string(),
            title: Some("Example Page".to_string()),
        },
    )
    .await
    .expect("create snapshot");

    let slug = generate_slug_from_url("https://example.com/page").expect("slug");
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
            checkpoint: true,
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
            "excerpt": "selected text",
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
            checkpoint: true,
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
