mod support;

use browser_recall_daemon::{ws_server::start_server, ConfigStore};
use browser_recall_replay::generate_slug_from_url;
use serde_json::json;
use tempfile::tempdir;
use tokio::{fs, io::AsyncWriteExt};

#[tokio::test]
async fn shipped_instructions_survive_refresh_and_offline_edits_replay_and_sync() {
    let directory = tempdir().expect("temporary library");
    let config_store = ConfigStore::new(directory.path().join("config"));
    let mut options = support::test_server_options(config_store.clone());
    options.test_control_enabled = false;
    let config = config_store.load_or_create().expect("configuration");
    fs::create_dir_all(&config.data_dir)
        .await
        .expect("data root");
    let document_path = config.data_dir.join("AGENTS.md");
    fs::write(
        &document_path,
        "# Personal instructions\nKeep my list names.\n",
    )
    .await
    .expect("existing personal instructions");
    let server = start_server(options).await.expect("first startup");
    let document = fs::read_to_string(&document_path)
        .await
        .expect("installed document");
    assert!(document.starts_with("# Personal instructions\nKeep my list names."));
    assert!(document.contains(&format!("local device ID is `{}`", config.device_id)));
    assert!(!document.contains("{{DEVICE_ID}}"));
    server.shutdown().await;

    // Follow the shipped procedure: after shutdown, append canonical events with
    // timestamps beyond both the existing logs and the durable replay watermark.
    let progress: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(config.data_dir.join("views/manifest/replay-progress.json"))
            .await
            .expect("flushed replay progress"),
    )
    .expect("progress JSON");
    let mut latest = progress
        .as_object()
        .expect("device map")
        .values()
        .map(|stamp| stamp.as_i64().expect("timestamp"))
        .max()
        .expect("bootstrap progress");
    let device_logs = config.data_dir.join("logs").join(&config.device_id);
    let mut files = fs::read_dir(&device_logs).await.expect("local logs");
    while let Some(file) = files.next_entry().await.expect("log file") {
        for line in fs::read_to_string(file.path())
            .await
            .expect("JSONL")
            .lines()
        {
            let entry: browser_recall_replay::LogEntry =
                serde_json::from_str(line).expect("typed event");
            latest = latest.max(entry.timestamp());
        }
    }
    let stamp = chrono::Local::now().timestamp_millis().max(latest + 1);
    let url = "https://example.com/offline-edit";
    let entries = [
        json!({"action": "rename_page", "timestamp": stamp, "url": url, "user_title": "An offline title"}),
        json!({"action": "rate_page", "timestamp": stamp + 1, "url": url, "likes": 2, "title": null}),
    ];
    for entry in &entries {
        use chrono::TimeZone;
        let day = chrono::Local
            .timestamp_millis_opt(entry["timestamp"].as_i64().unwrap())
            .single()
            .expect("local date")
            .format("%Y-%m-%d");
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(device_logs.join(format!("{day}.jsonl")))
            .await
            .expect("append log");
        log.write_all(format!("{entry}\n").as_bytes())
            .await
            .expect("append complete event");
        log.sync_all().await.expect("durable event");
    }
    // Simulate an older managed document and a personal suffix across upgrade.
    fs::write(
        &document_path,
        format!(
            "{}\nPersonal suffix.\n",
            document.replace("# Browser Recall data", "# Older shipped instructions")
        ),
    )
    .await
    .expect("old managed document");
    let mut options = support::test_server_options(config_store.clone());
    options.test_control_enabled = false;
    let server = start_server(options)
        .await
        .expect("reopen after offline edit");
    let storage = server.storage();
    let slug = generate_slug_from_url(url).expect("page identity");
    let page = storage
        .load_page(&slug)
        .await
        .expect("page projection")
        .expect("renamed page");
    assert_eq!(page.user_title.as_deref(), Some("An offline title"));
    assert_eq!(page.likes, Some(2));
    let sync_files = storage
        .collect_sync_files(&config.device_id, 7)
        .await
        .expect("normal sync collection");
    for entry in &entries {
        assert!(sync_files
            .iter()
            .any(|(path, content)| path.starts_with("logs/")
                && content.lines().any(|line| {
                    serde_json::from_str::<serde_json::Value>(line).expect("sync JSON") == *entry
                })));
    }
    assert!(!sync_files.iter().any(|(path, _)| path == "AGENTS.md"));
    let refreshed = fs::read_to_string(&document_path)
        .await
        .expect("refreshed document");
    assert!(refreshed.starts_with("# Personal instructions\nKeep my list names."));
    assert!(refreshed.ends_with("Personal suffix.\n"));
    assert!(refreshed.contains("# Browser Recall data"));
    assert!(!refreshed.contains("# Older shipped instructions"));
    assert_eq!(
        refreshed
            .matches("<!-- Browser Recall managed instructions: begin -->")
            .count(),
        1
    );
    server.shutdown().await;

    let mut options = support::test_server_options(config_store.clone());
    options.test_control_enabled = false;
    let server = start_server(options).await.expect("second restart");
    let page = server
        .storage()
        .load_page(&slug)
        .await
        .expect("load page")
        .expect("page");
    assert_eq!(
        page.likes,
        Some(2),
        "restart must not replay the rating delta twice"
    );
    // A separate writer can publish complete logs while the app runs, but the
    // current projection stays unchanged until ordinary startup recovery.
    let virtual_device = "agent-independent-writer";
    let virtual_logs = config.data_dir.join("logs").join(virtual_device);
    fs::create_dir(&virtual_logs)
        .await
        .expect("virtual device directory");
    let virtual_stamp = chrono::Local::now().timestamp_millis().max(stamp + 2);
    let virtual_day = chrono::DateTime::from_timestamp_millis(virtual_stamp)
        .expect("timestamp")
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string();
    let entry = json!({"action": "rename_page", "timestamp": virtual_stamp,
        "url": url, "user_title": "Published by another writer"});
    let temporary = virtual_logs.join("pending.tmp");
    let mut output = fs::File::create(&temporary).await.expect("staging file");
    output
        .write_all(format!("{entry}\n").as_bytes())
        .await
        .expect("complete event");
    output.sync_all().await.expect("flush staging file");
    drop(output);
    fs::rename(temporary, virtual_logs.join(format!("{virtual_day}.jsonl")))
        .await
        .expect("atomic publication");
    let storage = server.storage();
    assert!(storage
        .load_history_batch(&[format!("{virtual_day}.jsonl")])
        .await
        .expect("history can see complete external logs")
        .iter()
        .any(|event| event["user_title"] == "Published by another writer"));
    assert_eq!(
        storage
            .load_page(&slug)
            .await
            .expect("cached projection")
            .expect("page")
            .user_title
            .as_deref(),
        Some("An offline title")
    );
    server.shutdown().await;

    let mut options = support::test_server_options(config_store);
    options.test_control_enabled = false;
    let server = start_server(options)
        .await
        .expect("reconcile virtual device on restart");
    assert_eq!(
        server
            .storage()
            .load_page(&slug)
            .await
            .expect("replayed page")
            .expect("page")
            .user_title
            .as_deref(),
        Some("Published by another writer")
    );
    assert!(server
        .storage()
        .collect_sync_files(&config.device_id, 7)
        .await
        .expect("normal sync collection")
        .iter()
        .all(|(path, _)| !path.starts_with(&format!("logs/{virtual_device}/"))));
    server
        .control_handle()
        .run_command("clearAllData", json!({}))
        .await
        .expect("normal data reset");
    assert!(fs::read_to_string(document_path)
        .await
        .expect("reset document")
        .contains("# Browser Recall data"));
    server.shutdown().await;
}

#[tokio::test]
async fn unreadable_or_malformed_instructions_do_not_block_the_library() {
    for malformed_document in [true, false] {
        let directory = tempdir().expect("temporary library");
        let config_store = ConfigStore::new(directory.path().join("config"));
        let mut options = support::test_server_options(config_store.clone());
        options.test_control_enabled = false;
        let config = config_store.load_or_create().expect("configuration");
        fs::create_dir_all(&config.data_dir)
            .await
            .expect("data root");
        let document = config.data_dir.join("AGENTS.md");
        let broken = "Personal instructions\n<!-- Browser Recall managed instructions: begin -->\n";
        if malformed_document {
            fs::write(&document, broken).await.expect("damaged markers");
        } else {
            fs::create_dir(&document)
                .await
                .expect("unreadable document path");
        }

        let server = start_server(options)
            .await
            .expect("documentation cannot block startup");
        let url = "https://example.com/documentation-error";
        server
            .control_handle()
            .run_command(
                "renamePage",
                json!({
                    "url": url, "userTitle": "The library still works"
                }),
            )
            .await
            .expect("ordinary library write");
        let page = server
            .storage()
            .load_page(&generate_slug_from_url(url).expect("slug"))
            .await
            .expect("read library")
            .expect("renamed page");
        assert_eq!(page.user_title.as_deref(), Some("The library still works"));
        server.shutdown().await;
        if malformed_document {
            assert_eq!(
                fs::read_to_string(&document)
                    .await
                    .expect("preserved document"),
                broken
            );
        } else {
            assert!(fs::metadata(&document)
                .await
                .expect("preserved directory")
                .is_dir());
        }
    }
}
