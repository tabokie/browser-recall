use browser_recall_daemon::runtime::{install_remote_files, ReplayTransaction};
use browser_recall_daemon::storage::Storage;
use browser_recall_replay::{generate_slug_from_url, LogEntry};
use tempfile::tempdir;

#[tokio::test]
async fn local_transaction_appends_entries_and_updates_the_projection() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let url = "https://example.com/runtime-local";
    let mut transaction = ReplayTransaction::begin(&storage, "device-a")
        .await
        .expect("begin transaction");
    let entry_effects = transaction
        .apply(LogEntry::VisitPage {
            timestamp: 1_710_000_000_000,
            url: url.to_string(),
            title: Some("Runtime Local".to_string()),
            referrer_url: None,
        })
        .await
        .expect("apply visit");
    assert_eq!(entry_effects.len(), 1);
    let result = transaction.commit().await.expect("commit transaction");

    assert_eq!(result.entry_count, 1);
    assert_eq!(result.effects, entry_effects);
    let slug = generate_slug_from_url(url).expect("slug");
    let page = storage
        .load_page(&slug)
        .await
        .expect("load page")
        .expect("page is visible from projection cache");
    assert_eq!(page.title.as_deref(), Some("Runtime Local"));

    let mut log_files = tokio::fs::read_dir(dir.path().join("logs").join("device-a"))
        .await
        .expect("device log directory");
    let log_path = log_files
        .next_entry()
        .await
        .expect("read log directory")
        .expect("canonical log file")
        .path();
    let log = tokio::fs::read_to_string(log_path)
        .await
        .expect("canonical log appended");
    assert_eq!(log.lines().count(), 1);
    assert!(!log.contains("bodyPreview"));
}

#[tokio::test]
async fn remote_file_install_replays_without_reappending_downloaded_logs() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");

    let url = "https://example.com/runtime-remote";
    let entry = LogEntry::VisitPage {
        timestamp: 1_710_000_000_000,
        url: url.to_string(),
        title: Some("Runtime Remote".to_string()),
        referrer_url: None,
    };
    let log_content = format!(
        "{}\n",
        serde_json::to_string(&entry).expect("serialize remote entry")
    );
    let files = vec![("logs/device-b/2024-03-09.jsonl".to_string(), log_content)];

    let result = install_remote_files(&storage, "device-b", &files, vec![entry])
        .await
        .expect("install remote files");
    assert_eq!(result.entry_count, 1);

    let remote_log_path = dir
        .path()
        .join("logs")
        .join("device-b")
        .join("2024-03-09.jsonl");
    let installed_log = tokio::fs::read_to_string(remote_log_path)
        .await
        .expect("remote log installed");
    assert_eq!(installed_log.lines().count(), 1);

    let slug = generate_slug_from_url(url).expect("slug");
    let page = storage
        .load_page(&slug)
        .await
        .expect("load page")
        .expect("remote page is visible from projection cache");
    assert_eq!(page.title.as_deref(), Some("Runtime Remote"));
}

#[tokio::test]
async fn transaction_rejects_storage_read_errors_instead_of_treating_them_as_missing() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    tokio::fs::create_dir_all(
        dir.path()
            .join("views")
            .join("manifest")
            .join("settings.json"),
    )
    .await
    .expect("block settings file with a directory");

    let mut transaction = ReplayTransaction::begin(&storage, "device-a")
        .await
        .expect("begin transaction");
    let error = transaction
        .apply(LogEntry::UpdateSetting {
            timestamp: 1_710_000_000_000,
            key: "theme".to_string(),
            value: serde_json::json!("dark"),
        })
        .await
        .expect_err("storage read error must be explicit");
    assert!(error.contains("replay entity load failed"));

    let mut logs = tokio::fs::read_dir(dir.path().join("logs").join("device-a"))
        .await
        .expect("device log directory");
    assert!(logs
        .next_entry()
        .await
        .expect("read log directory")
        .is_none());
}

#[tokio::test]
async fn remote_install_validates_replay_before_writing_downloaded_files() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("storage layout");
    tokio::fs::create_dir_all(
        dir.path()
            .join("views")
            .join("manifest")
            .join("settings.json"),
    )
    .await
    .expect("block settings file with a directory");

    let remote_path = "logs/device-b/2026-07-04.jsonl";
    let files = vec![(remote_path.to_string(), "downloaded\n".to_string())];
    let entry = LogEntry::UpdateSetting {
        timestamp: 1_720_000_000_000,
        key: "theme".to_string(),
        value: serde_json::json!("dark"),
    };

    install_remote_files(&storage, "device-b", &files, vec![entry])
        .await
        .expect_err("replay validation must fail");
    assert!(
        !dir.path().join(remote_path).exists(),
        "failed validation must not install remote files"
    );
}
