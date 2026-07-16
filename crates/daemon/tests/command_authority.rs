use browser_recall_daemon::command_authority::CommandAuthority;
use browser_recall_daemon::commands;
use browser_recall_daemon::read_projections::ReadProjections;
use browser_recall_daemon::storage::Storage;
use browser_recall_replay::entities::ListEntity;
use browser_recall_replay::{generate_slug_from_url, LogEntry};
use serde_json::json;
use tempfile::tempdir;

#[tokio::test]
async fn note_command_returns_committed_response_and_mutation_together() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let authority = CommandAuthority::new(storage.clone(), "device-a".to_string());
    let page_slug =
        generate_slug_from_url("https://example.com/authority-note").expect("page slug");

    let outcome = authority
        .execute(
            "createNote",
            json!({
                "url": "https://example.com/authority-note",
                "pageSlug": page_slug,
                "title": "Authority Note",
                "excerpt": ["shared semantics"],
                "note": "created once",
                "cssPath": ["main > p"]
            }),
        )
        .await
        .expect("create note");

    let response = outcome.response();
    let note_slug = response["noteSlug"]
        .as_str()
        .expect("note slug")
        .to_string();
    let response_page_slug = response["pageSlug"].as_str().expect("page slug");
    assert_eq!(outcome.mutations.len(), 1);
    assert_eq!(outcome.mutations[0].mutation_type, "note");
    assert_eq!(
        outcome.mutations[0].note_slug.as_deref(),
        Some(note_slug.as_str())
    );
    assert_eq!(
        outcome.mutations[0].page_slug.as_deref(),
        Some(response_page_slug)
    );
    assert_eq!(
        outcome.mutations[0].url.as_deref(),
        Some("https://example.com/authority-note")
    );

    let note = storage
        .load_note(&note_slug)
        .await
        .expect("load note")
        .expect("committed note");
    assert_eq!(note.note.as_deref(), Some("created once"));

    let updated = authority
        .execute(
            "updateNote",
            json!({ "noteSlug": note_slug, "note": "updated once" }),
        )
        .await
        .expect("update note");
    let updated_response = updated.response();
    let updated_slug = updated_response["noteSlug"]
        .as_str()
        .expect("updated note slug")
        .to_string();
    assert_eq!(updated.mutations.len(), 1);
    assert_eq!(updated.mutations[0].mutation_type, "note");
    assert_eq!(
        updated.mutations[0].old_note_slug.as_deref(),
        Some(note_slug.as_str())
    );

    let deleted = authority
        .execute("deleteNote", json!({ "noteSlug": updated_slug }))
        .await
        .expect("delete note");
    assert_eq!(
        deleted
            .mutations
            .iter()
            .map(|mutation| mutation.mutation_type.as_str())
            .collect::<Vec<_>>(),
        vec!["note", "orphaned"]
    );
    assert!(
        storage
            .load_note(&updated_slug)
            .await
            .expect("load deleted note")
            .expect("deleted note checkpoint")
            .deleted
    );
}

#[tokio::test]
async fn invalid_add_rule_preserves_the_validation_error() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let authority = CommandAuthority::new(storage.clone(), "device-a".to_string());
    let created = authority
        .execute("saveListMeta", json!({ "name": "Rules" }))
        .await
        .expect("create list");
    let list_id = created.response()["listId"]
        .as_str()
        .expect("list id")
        .to_string();

    let error = authority
        .execute(
            "addRule",
            json!({
                "listId": list_id,
                "rule": {
                    "type": "keyword",
                    "config": { "case_sensitive": true }
                }
            }),
        )
        .await
        .expect_err("invalid rule must fail");

    assert_eq!(error, "Unsupported keyword rule field: case_sensitive");
    assert!(storage
        .load_list(&list_id)
        .await
        .expect("load list")
        .expect("list checkpoint")
        .rules
        .is_empty());
}

#[tokio::test]
async fn page_list_and_snapshot_commands_report_their_committed_meaning() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let authority = CommandAuthority::new(storage.clone(), "device-a".to_string());
    let url = "https://example.com/authority-page";
    let page_slug = generate_slug_from_url(url).expect("page slug");

    let renamed = authority
        .execute(
            "renamePage",
            json!({ "url": url, "userTitle": "Authority Title" }),
        )
        .await
        .expect("rename page");
    assert_eq!(renamed.mutations[0].mutation_type, "history");
    assert_eq!(renamed.mutations[0].url.as_deref(), Some(url));
    assert_eq!(
        renamed.mutations[0]
            .history_entry
            .as_ref()
            .map(|entry| (entry.action.as_str(), entry.user_title.as_deref())),
        Some(("rename_page", Some("Authority Title")))
    );

    let rated = authority
        .execute("ratePage", json!({ "url": url, "likes": 1 }))
        .await
        .expect("rate page");
    assert_eq!(rated.mutations[0].mutation_type, "history");
    assert_eq!(
        rated.mutations[0]
            .history_entry
            .as_ref()
            .map(|entry| (entry.action.as_str(), entry.device_id.as_str())),
        Some(("rate_page", "device-a"))
    );
    let page = storage
        .load_page(&page_slug)
        .await
        .expect("load page")
        .expect("committed page");
    assert_eq!(page.user_title.as_deref(), Some("Authority Title"));
    assert_eq!(page.likes, Some(1));

    let list = authority
        .execute("saveListMeta", json!({ "name": "Authority List" }))
        .await
        .expect("create list");
    let list_response = list.response();
    let list_id = list_response["listId"]
        .as_str()
        .expect("list id")
        .to_string();
    let pin = authority
        .execute(
            "toggleListPin",
            json!({ "listId": list_id, "url": url, "title": "Authority Page" }),
        )
        .await
        .expect("toggle pin");
    assert_eq!(pin.response()["pinned"].as_bool(), Some(true));
    assert_eq!(pin.mutations[0].mutation_type, "pins");
    assert_eq!(pin.mutations[0].list_id.as_deref(), Some(list_id.as_str()));
    assert_eq!(pin.mutations[0].url.as_deref(), Some(url));
    assert_eq!(
        pin.mutations[0].urls.as_deref(),
        Some(&[url.to_string()][..])
    );

    let snapshot_timestamp = 1_710_040_000_000;
    storage
        .save_snapshot_html(&page_slug, snapshot_timestamp, "<html></html>")
        .await
        .expect("snapshot html");
    commands::replay_entry(
        &storage,
        "device-a",
        LogEntry::CreateSnapshot {
            timestamp: snapshot_timestamp,
            url: url.to_string(),
            path: storage.snapshot_sidecar_relative_path(&page_slug, snapshot_timestamp),
            title: Some("Authority Page".to_string()),
        },
    )
    .await
    .expect("create snapshot fixture");

    let deleted = authority
        .execute(
            "deleteSnapshot",
            json!({ "slug": page_slug, "timestamp": snapshot_timestamp }),
        )
        .await
        .expect("delete snapshot");
    assert_eq!(
        deleted
            .mutations
            .iter()
            .map(|mutation| mutation.mutation_type.as_str())
            .collect::<Vec<_>>(),
        vec!["snapshot", "orphaned"]
    );
    assert_eq!(
        deleted.mutations[0].slug.as_deref(),
        Some(page_slug.as_str())
    );
    assert_eq!(deleted.mutations[0].url.as_deref(), Some(url));
}

#[tokio::test]
async fn create_list_and_pin_commits_one_semantic_command() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let authority = CommandAuthority::new(storage.clone(), "device-a".to_string());
    let url = "https://example.com/create-and-pin";
    let page_slug = generate_slug_from_url(url).expect("page slug");

    let outcome = authority
        .execute(
            "createListAndPin",
            json!({
                "name": "Created and pinned",
                "url": url,
                "title": "Create and Pin"
            }),
        )
        .await
        .expect("create list and pin");

    let response = outcome.response();
    assert_eq!(response["success"].as_bool(), Some(true));
    assert_eq!(response["pinned"].as_bool(), Some(true));
    let list_id = response["listId"].as_str().expect("list id");
    assert_eq!(
        outcome
            .mutations
            .iter()
            .map(|mutation| mutation.mutation_type.as_str())
            .collect::<Vec<_>>(),
        vec!["lists", "pins"]
    );
    assert_eq!(outcome.mutations[1].list_id.as_deref(), Some(list_id));
    assert_eq!(outcome.mutations[1].url.as_deref(), Some(url));

    let list = storage
        .load_list(list_id)
        .await
        .expect("load list")
        .expect("created list");
    assert_eq!(list.name, "Created and pinned");
    assert_eq!(list.pins.len(), 1);
    assert_eq!(list.pins[0].id, format!("page:{page_slug}"));
}

#[tokio::test]
async fn note_pin_toggle_does_not_require_a_page_url() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let authority = CommandAuthority::new(storage, "device-a".to_string());
    let created = authority
        .execute(
            "createNote",
            json!({
                "url": "https://example.com/note-pin",
                "title": "Note pin",
                "excerpt": ["note pin"],
                "note": "body",
                "cssPath": ["main"]
            }),
        )
        .await
        .expect("create note");
    let created_response = created.response();
    let note_slug = created_response["noteSlug"].as_str().expect("note slug");
    let list = authority
        .execute("saveListMeta", json!({ "name": "Notes" }))
        .await
        .expect("create list");
    let list_response = list.response();
    let list_id = list_response["listId"].as_str().expect("list id");

    let pin = authority
        .execute(
            "toggleListPin",
            json!({ "listId": list_id, "id": format!("note:{note_slug}") }),
        )
        .await
        .expect("toggle note pin");

    assert_eq!(pin.response()["pinned"].as_bool(), Some(true));
    assert_eq!(pin.mutations.len(), 1);
    assert_eq!(pin.mutations[0].mutation_type, "pins");
    assert_eq!(pin.mutations[0].list_id.as_deref(), Some(list_id));
    assert_eq!(
        pin.mutations[0].url.as_deref(),
        Some("https://example.com/note-pin")
    );
    assert_eq!(
        pin.mutations[0].urls.as_deref(),
        Some(&["https://example.com/note-pin".to_string()][..])
    );
}

#[tokio::test]
async fn command_validation_and_ownership_are_explicit() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let authority = CommandAuthority::new(storage, "device-a".to_string());

    let missing = authority
        .execute("renamePage", json!({ "userTitle": "Missing URL" }))
        .await
        .expect_err("missing field must fail");
    assert_eq!(missing, "renamePage missing url");

    let unsupported = authority
        .execute("reportVisit", json!({}))
        .await
        .expect_err("connector observation is not shared authority");
    assert_eq!(unsupported, "unsupported daemon command: reportVisit");

    assert!(CommandAuthority::supports("toggleListPin"));
    assert!(CommandAuthority::supports("createListAndPin"));
    assert!(!CommandAuthority::supports("openExternalUrl"));
    assert!(!CommandAuthority::supports("reportVisit"));
}

#[tokio::test]
async fn settings_values_are_validated_before_replay() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    let authority = CommandAuthority::new(storage, "device-a".to_string());

    assert_eq!(
        authority
            .execute(
                "saveSettingsKey",
                json!({ "key": "blacklistEnabled", "value": "yes" }),
            )
            .await
            .expect_err("wrong setting type fails"),
        "blacklistEnabled must be a boolean"
    );
    assert_eq!(
        authority
            .execute(
                "saveSettingsKey",
                json!({ "key": "urlBlacklist", "value": ["https://ok.example", 4] }),
            )
            .await
            .expect_err("mixed blacklist fails"),
        "urlBlacklist must contain strings only"
    );
    assert_eq!(
        authority
            .execute(
                "saveSettingsKey",
                json!({ "key": "syncRetentionDays", "value": 0 }),
            )
            .await
            .expect_err("invalid retention fails"),
        "syncRetentionDays must be an integer greater than or equal to 1"
    );
    assert_eq!(
        authority
            .execute(
                "saveSettingsKey",
                json!({ "key": "theme", "value": "sepia" }),
            )
            .await
            .expect_err("unsupported theme fails"),
        "theme has an unsupported value"
    );
}

#[tokio::test]
async fn clearing_data_recreates_the_complete_authoritative_settings_schema() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    commands::ensure_default_settings(&storage, "device-a")
        .await
        .expect("default settings");
    let authority = CommandAuthority::new(storage.clone(), "device-a".to_string());
    authority
        .execute(
            "saveSettingsKey",
            json!({ "key": "theme", "value": "dark" }),
        )
        .await
        .expect("save changed theme");

    authority
        .execute("clearAllData", json!({}))
        .await
        .expect("clear data");

    let settings = ReadProjections::new(storage)
        .settings()
        .await
        .expect("complete settings projection")
        .expect("settings checkpoint");
    assert_eq!(settings.get("theme"), Some(&json!("system")));
    assert_eq!(
        settings.len(),
        browser_recall_replay::PERSISTENT_SETTINGS_KEYS.len()
    );
}

#[tokio::test]
async fn ownerless_persisted_lists_cannot_be_deserialized() {
    let error = serde_json::from_value::<ListEntity>(json!({
        "slug": "ownerless",
        "name": "Ownerless",
        "pins": [],
        "rules": [],
        "timestamps": {},
        "deleted": false,
        "deletedTs": null
    }))
    .expect_err("persisted lists require an owner");

    assert!(error.to_string().contains("owner"));

    let error = serde_json::from_value::<ListEntity>(json!({
        "slug": "ownerless",
        "name": "Ownerless",
        "owner": " ",
        "pins": [],
        "rules": [],
        "timestamps": {},
        "deleted": false,
        "deletedTs": null
    }))
    .expect_err("persisted list owners must be non-empty");
    assert!(error.to_string().contains("non-empty string"));
}
