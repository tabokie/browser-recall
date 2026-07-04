use browser_recall_daemon::command_authority::CommandAuthority;
use browser_recall_daemon::commands;
use browser_recall_daemon::storage::Storage;
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

    let note_slug = outcome.response["noteSlug"]
        .as_str()
        .expect("note slug")
        .to_string();
    let response_page_slug = outcome.response["pageSlug"].as_str().expect("page slug");
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
    let updated_slug = updated.response["noteSlug"]
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

    let rated = authority
        .execute("ratePage", json!({ "url": url, "likes": 1 }))
        .await
        .expect("rate page");
    assert_eq!(rated.mutations[0].mutation_type, "history");
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
    let list_id = list.response["listId"]
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
    assert_eq!(pin.response["pinned"].as_bool(), Some(true));
    assert_eq!(pin.mutations[0].mutation_type, "pins");
    assert_eq!(pin.mutations[0].list_id.as_deref(), Some(list_id.as_str()));

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
    assert!(!CommandAuthority::supports("openExternalUrl"));
    assert!(!CommandAuthority::supports("reportVisit"));
}
