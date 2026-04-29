mod support;

use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage};
use browser_recall_daemon::ws_server::start_server;
use browser_recall_daemon::{ApprovedConnector, ConfigStore, Token};
use browser_recall_replay::generate_slug_from_url;
use futures_util::SinkExt;
use serde_json::json;
use tempfile::tempdir;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{next_text_message, pair_once, paired_socket, test_server_options, TestSocket};

fn approved_connector(browser_id: &str, token: &str) -> ApprovedConnector {
    ApprovedConnector {
        browser_id: browser_id.into(),
        browser_name: "Chrome".into(),
        extension_id: "abcdefghijklmnop".into(),
        browser_profile: Some("Default profile".into()),
        token: Token(token.into()),
        approved_at: 1_710_000_000,
        last_seen_at: Some(1_710_000_000),
    }
}

async fn authenticated_socket(port: u16, token: &str) -> TestSocket {
    let mut request = format!("ws://127.0.0.1:{port}/")
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnop".parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.expect("ws connect");
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Auth {
                token: token.into(),
            })
            .expect("auth json"),
        ))
        .await
        .expect("send auth");
    let auth = next_text_message(&mut socket).await;
    let auth: DaemonMessage = serde_json::from_str(&auth).expect("auth response json");
    assert!(matches!(auth, DaemonMessage::AuthOk));
    socket
}

async fn read_log_files(log_dir: &std::path::Path) -> Vec<String> {
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
async fn event_ingest_persists_page_and_reports_status() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Event {
                entry: json!({
                    "timestamp": 1_710_000_000_000i64,
                    "action": "visit_page",
                    "url": "https://example.com/page",
                    "title": "Example",
                    "checkpoint": true
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("event json"),
        ))
        .await
        .expect("send event");

    let ack = next_text_message(&mut socket).await;
    let ack: DaemonMessage = serde_json::from_str(&ack).expect("ack json");
    assert!(matches!(ack, DaemonMessage::Ack { .. }));

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::GetStatus).expect("status request"),
        ))
        .await
        .expect("send status");
    let status = next_text_message(&mut socket).await;
    let status: DaemonMessage = serde_json::from_str(&status).expect("status json");
    match status {
        DaemonMessage::Status {
            connected_browsers,
            buffer_depth,
            last_drained_at,
            data_folder,
            device_id: returned_device_id,
            ..
        } => {
            assert_eq!(connected_browsers, vec!["Chrome".to_string()]);
            assert_eq!(buffer_depth, 0);
            assert!(last_drained_at.is_some());
            assert_eq!(data_folder, data_dir.to_string_lossy());
            assert_eq!(returned_device_id, device_id);
        }
        other => panic!("expected status response, got {other:?}"),
    }

    let slug = generate_slug_from_url("https://example.com/page").expect("slug");
    let page_path = data_dir.join("pages").join(format!("{slug}.json"));
    let page_raw = tokio::fs::read_to_string(page_path)
        .await
        .expect("page exists");
    assert!(page_raw.contains("\"title\": \"Example\""));
    assert!(page_raw.contains("\"url\": \"https://example.com/page\""));

    handle.shutdown().await;
}

#[tokio::test]
async fn active_connectors_are_tracked_by_connector_identity() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config = config_store.load_or_create().expect("config");
    config
        .connectors
        .push(approved_connector("old-browser-install", "old-token"));
    config
        .connectors
        .push(approved_connector("new-browser-install", "new-token"));
    config_store.save(&config).expect("save config");

    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let mut socket = authenticated_socket(handle.port(), "new-token").await;

    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.connected_browsers, vec!["Chrome"]);
    assert_eq!(snapshot.connected_connectors.len(), 1);
    assert_eq!(
        snapshot.connected_connectors[0].browser_id,
        "new-browser-install"
    );

    let revoked = handle
        .control_handle()
        .revoke_connector("new-browser-install", "abcdefghijklmnop")
        .await
        .expect("revoke active connector");
    assert!(revoked);
    let config = config_store.load_or_create().expect("reload config");
    assert!(config.connectors.is_empty());
    let snapshot = handle.snapshot().await;
    assert!(snapshot.connected_browsers.is_empty());
    assert!(snapshot.connected_connectors.is_empty());

    let revoked = next_text_message(&mut socket).await;
    let revoked: DaemonMessage = serde_json::from_str(&revoked).expect("revoked auth response");
    match revoked {
        DaemonMessage::AuthFail { reason } => assert_eq!(reason, "token_revoked"),
        other => panic!("expected revoked auth failure, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn duplicate_connections_for_same_connector_stay_connected_until_last_socket_closes() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config = config_store.load_or_create().expect("config");
    config
        .connectors
        .push(approved_connector("browser-install", "shared-token"));
    config_store.save(&config).expect("save config");

    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let mut first = authenticated_socket(handle.port(), "shared-token").await;
    let mut second = authenticated_socket(handle.port(), "shared-token").await;

    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.connected_connectors.len(), 1);
    assert_eq!(snapshot.connected_connectors[0].browser_id, "browser-install");

    first.close(None).await.expect("close first socket");
    sleep(Duration::from_millis(100)).await;
    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.connected_connectors.len(), 1);
    assert_eq!(snapshot.connected_connectors[0].browser_id, "browser-install");

    second.close(None).await.expect("close second socket");
    for _ in 0..40 {
        if handle.snapshot().await.connected_connectors.is_empty() {
            handle.shutdown().await;
            return;
        }
        sleep(Duration::from_millis(25)).await;
    }
    let snapshot = handle.snapshot().await;
    handle.shutdown().await;
    assert!(snapshot.connected_connectors.is_empty());
}

#[tokio::test]
async fn pairing_prunes_inactive_connectors() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config = config_store.load_or_create().expect("config");
    config
        .connectors
        .push(approved_connector("old-browser-install", "old-token"));
    config_store.save(&config).expect("save config");

    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let token = pair_once(handle.port()).await;

    let config = config_store.load_or_create().expect("reload config");
    assert_eq!(config.connectors.len(), 1);
    assert_eq!(config.connectors[0].browser_id, "browser-install-1");
    assert_eq!(config.connectors[0].token.0, token);

    handle.shutdown().await;
}

#[tokio::test]
async fn event_ingest_rejects_missing_source_metadata() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            json!({
                "type": "event",
                "entry": {
                    "timestamp": 1_710_000_000_000i64,
                    "action": "visit_page",
                    "url": "https://example.com/bad",
                    "title": "Bad",
                    "checkpoint": true
                }
            })
            .to_string(),
        ))
        .await
        .expect("send malformed event");

    let next = next_text_message(&mut socket).await;
    let next: DaemonMessage = serde_json::from_str(&next).expect("error json");
    match next {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "invalid_message");
            assert_eq!(code, "invalid_message");
        }
        other => panic!("expected invalid_message error, got {other:?}"),
    }

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::GetStatus).expect("status json"),
        ))
        .await
        .expect("send status after malformed event");
    let status = next_text_message(&mut socket).await;
    let status: DaemonMessage = serde_json::from_str(&status).expect("status json");
    assert!(matches!(status, DaemonMessage::Status { .. }));

    let pages_dir = data_dir.join("pages");
    let mut entries = tokio::fs::read_dir(&pages_dir)
        .await
        .expect("pages dir exists");
    assert!(entries.next_entry().await.expect("pages read").is_none());

    handle.shutdown().await;
}

#[tokio::test]
async fn startup_keeps_device_id_in_config() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let config = config_store
        .load()
        .expect("config load")
        .expect("config exists");
    assert!(!config.device_id.trim().is_empty());
    assert!(!config.data_dir.join("CURRENT").exists());
    assert!(!config
        .data_dir
        .join("data")
        .join("logs")
        .join(&config.device_id)
        .join("CURRENT")
        .exists());

    handle.shutdown().await;
}

#[tokio::test]
async fn snapshot_ingest_persists_html_and_appends_log() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    let slug = generate_slug_from_url("https://example.com/page").expect("slug");
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Snapshot {
                slug: slug.clone(),
                ts: 1_710_000_001_000i64,
                url: "https://example.com/page".to_string(),
                title: Some("Snapshot".to_string()),
                markdown: Some("banana snapshot".to_string()),
                html: "<html><body>snapshot</body></html>".to_string(),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("snapshot json"),
        ))
        .await
        .expect("send snapshot");

    let ack = next_text_message(&mut socket).await;
    let ack: DaemonMessage = serde_json::from_str(&ack).expect("ack json");
    assert!(matches!(ack, DaemonMessage::Ack { .. }));

    let snapshot_path = data_dir
        .join("data")
        .join("snapshots")
        .join(format!("{slug}-1710000001000.html"));
    let snapshot_html = tokio::fs::read_to_string(snapshot_path)
        .await
        .expect("snapshot html exists");
    assert!(snapshot_html.contains("snapshot"));
    let snapshot_md = tokio::fs::read_to_string(
        data_dir
            .join("data")
            .join("snapshots")
            .join(format!("{slug}-1710000001000.md")),
    )
    .await
    .expect("snapshot markdown exists");
    assert!(snapshot_md.contains("banana snapshot"));

    let log_dir = data_dir.join("data").join("logs").join(device_id);
    let logs = read_log_files(&log_dir).await;
    assert!(logs
        .iter()
        .any(|log| log.contains("\"action\":\"create_snapshot\"")));

    handle.shutdown().await;
}

#[tokio::test]
async fn set_device_id_rewrites_config_only() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, old_device_id) = paired_socket(handle.port(), &config_store).await;
    let new_device_id = "fresh-sync-device";
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::SetDeviceId {
                device_id: new_device_id.to_string(),
            })
            .expect("set device json"),
        ))
        .await
        .expect("send set device");

    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("set device response");
    match response {
        DaemonMessage::SetDeviceIdResult {
            success,
            device_id,
            error,
        } => {
            assert!(success);
            assert_eq!(device_id, new_device_id);
            assert_eq!(error, None);
        }
        other => panic!("expected set device response, got {other:?}"),
    }

    let config = config_store
        .load()
        .expect("config load")
        .expect("config exists");
    assert_eq!(config.device_id, new_device_id);
    assert!(!data_dir.join("CURRENT").exists());
    assert!(!data_dir
        .join("data")
        .join("logs")
        .join(new_device_id)
        .join("CURRENT")
        .exists());
    assert!(!data_dir
        .join("data")
        .join("logs")
        .join(old_device_id)
        .join("CURRENT")
        .exists());

    handle.shutdown().await;
}

#[tokio::test]
async fn clear_all_data_recreates_empty_layout_without_current_marker() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Event {
                entry: json!({
                    "timestamp": 1_710_000_000_000i64,
                    "action": "visit_page",
                    "url": "https://example.com/page",
                    "title": "Example",
                    "checkpoint": true
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("event json"),
        ))
        .await
        .expect("send event");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::ClearAllData).expect("clear json"),
        ))
        .await
        .expect("send clear");

    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("clear response");
    match response {
        DaemonMessage::ClearAllDataResult {
            success,
            deleted_count: _,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
        }
        other => panic!("expected clear result, got {other:?}"),
    }

    assert!(tokio::fs::read_dir(data_dir.join("pages"))
        .await
        .expect("pages dir")
        .next_entry()
        .await
        .expect("pages read")
        .is_none());
    assert!(tokio::fs::read_dir(data_dir.join("lists"))
        .await
        .expect("lists dir")
        .next_entry()
        .await
        .expect("lists read")
        .is_none());
    assert!(tokio::fs::read_dir(data_dir.join("manifest"))
        .await
        .expect("manifest dir")
        .next_entry()
        .await
        .expect("manifest read")
        .is_none());

    let logs_dir = data_dir.join("data").join("logs").join(device_id);
    assert!(tokio::fs::read_dir(logs_dir)
        .await
        .expect("logs dir")
        .next_entry()
        .await
        .expect("logs read")
        .is_none());

    handle.shutdown().await;
}

#[tokio::test]
async fn search_messages_return_history_note_and_snapshot_hits() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Event {
                entry: json!({
                    "timestamp": 1_710_000_000_000i64,
                    "action": "visit_page",
                    "url": "https://example.com/page",
                    "title": "Banana Example",
                    "checkpoint": true
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("event json"),
        ))
        .await
        .expect("send event");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Note {
                slug: "note-search".to_string(),
                excerpt: Some("hello".to_string()),
                note: "banana note body".to_string(),
                css_path: None,
                old_slug: None,
                url: "https://example.com/page".to_string(),
                title: Some("Banana Example".to_string()),
                ts: 1_710_000_000_100i64,
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("note json"),
        ))
        .await
        .expect("send note");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Snapshot {
                slug: "example-page".to_string(),
                ts: 1_710_000_000_200i64,
                url: "https://example.com/page".to_string(),
                title: Some("Banana Example".to_string()),
                markdown: Some("banana snapshot body".to_string()),
                html: "<html><body>banana snapshot body</body></html>".to_string(),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("snapshot json"),
        ))
        .await
        .expect("send snapshot");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::SearchHistory {
                query: "banana".to_string(),
                limit: None,
            })
            .expect("history search json"),
        ))
        .await
        .expect("send history search");
    let history = next_text_message(&mut socket).await;
    let history: DaemonMessage =
        serde_json::from_str(&history).expect("history search result json");
    match history {
        DaemonMessage::SearchHistoryResult {
            success,
            results,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].url, "https://example.com/page");
            assert_eq!(results[0].title, "Banana Example");
        }
        other => panic!("expected history search result, got {other:?}"),
    }

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::SearchNotes {
                query: "banana".to_string(),
                limit: None,
            })
            .expect("notes search json"),
        ))
        .await
        .expect("send notes search");
    let notes = next_text_message(&mut socket).await;
    let notes: DaemonMessage = serde_json::from_str(&notes).expect("notes search result json");
    match notes {
        DaemonMessage::SearchNotesResult {
            success,
            results,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].url, "https://example.com/page");
            assert_eq!(results[0].note_slug, "note-search");
        }
        other => panic!("expected notes search result, got {other:?}"),
    }

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::SearchSnapshots {
                query: "banana".to_string(),
                limit: None,
            })
            .expect("snapshots search json"),
        ))
        .await
        .expect("send snapshots search");
    let snapshots = next_text_message(&mut socket).await;
    let snapshots: DaemonMessage =
        serde_json::from_str(&snapshots).expect("snapshots search result json");
    match snapshots {
        DaemonMessage::SearchSnapshotsResult {
            success,
            results,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].slug, "example-page");
        }
        other => panic!("expected snapshots search result, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn popup_read_messages_return_page_info_and_lists() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    for entry in [
        json!({
            "timestamp": 1_710_000_010_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Reading",
            "listId": "reading"
        }),
        json!({
            "timestamp": 1_710_000_010_050i64,
            "action": "pin_to_list",
            "listOwner": "test-device",
            "name": "Reading",
            "items": ["https://example.com/popup"],
            "titles": { "https://example.com/popup": "Popup Page" }
        }),
        json!({
            "timestamp": 1_710_000_010_100i64,
            "action": "visit_page",
            "url": "https://example.com/popup",
            "title": "Popup Page",
            "checkpoint": true
        }),
    ] {
        socket
            .send(Message::Text(
                serde_json::to_string(&ConnectorMessage::Event {
                    entry,
                    source: "extension".to_string(),
                    buffer_depth: None,
                    buffer_bytes: None,
                })
                .expect("event json"),
            ))
            .await
            .expect("send event");
        let _ = next_text_message(&mut socket).await;
    }

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Note {
                slug: "popup-note".to_string(),
                excerpt: Some("hello".to_string()),
                note: "popup annotation".to_string(),
                css_path: None,
                old_slug: None,
                url: "https://example.com/popup".to_string(),
                title: Some("Popup Page".to_string()),
                ts: 1_710_000_010_200i64,
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("note json"),
        ))
        .await
        .expect("send note");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Snapshot {
                slug: "popup-page".to_string(),
                ts: 1_710_000_010_300i64,
                url: "https://example.com/popup".to_string(),
                title: Some("Popup Page".to_string()),
                markdown: Some("popup snapshot".to_string()),
                html: "<html><body>popup snapshot</body></html>".to_string(),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("snapshot json"),
        ))
        .await
        .expect("send snapshot");
    let _ = next_text_message(&mut socket).await;

    let page_slug = generate_slug_from_url("https://example.com/popup").expect("slug");

    socket
        .send(Message::Text(
            json!({
                "type": "get_page_info",
                "slug": page_slug
            })
            .to_string(),
        ))
        .await
        .expect("send page info request");
    let page_info = next_text_message(&mut socket).await;
    let page_info: DaemonMessage = serde_json::from_str(&page_info).expect("page info json");
    match page_info {
        DaemonMessage::PageInfoResult {
            success,
            slug,
            entry,
            notes,
            snapshots,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(
                slug,
                generate_slug_from_url("https://example.com/popup").expect("slug")
            );
            assert_eq!(
                entry.expect("entry").url.as_deref(),
                Some("https://example.com/popup")
            );
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].slug, "popup-note");
            assert_eq!(snapshots.len(), 1);
            assert!(snapshots[0].has_md);
            assert!(snapshots[0].has_html);
        }
        other => panic!("expected page info result, got {other:?}"),
    }

    socket
        .send(Message::Text(
            json!({
                "type": "get_snapshot_html",
                "slug": "popup-page",
                "ts": 1_710_000_010_300i64
            })
            .to_string(),
        ))
        .await
        .expect("send snapshot html request");
    let snapshot_html = next_text_message(&mut socket).await;
    let snapshot_html: DaemonMessage =
        serde_json::from_str(&snapshot_html).expect("snapshot html json");
    match snapshot_html {
        DaemonMessage::SnapshotHtmlResult {
            success,
            html,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(
                html.as_deref(),
                Some("<html><body>popup snapshot</body></html>")
            );
        }
        other => panic!("expected snapshot html result, got {other:?}"),
    }

    socket
        .send(Message::Text(
            json!({
                "type": "get_entity",
                "key": format!("page:{page_slug}")
            })
            .to_string(),
        ))
        .await
        .expect("send entity request");
    let entity = next_text_message(&mut socket).await;
    let entity: DaemonMessage = serde_json::from_str(&entity).expect("entity json");
    match entity {
        DaemonMessage::EntityResult {
            success,
            key,
            entity,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(key, format!("page:{page_slug}"));
            assert_eq!(
                entity
                    .expect("entity")
                    .get("url")
                    .and_then(|value| value.as_str()),
                Some("https://example.com/popup")
            );
        }
        other => panic!("expected entity result, got {other:?}"),
    }

    socket
        .send(Message::Text(
            json!({
                "type": "get_popup_lists"
            })
            .to_string(),
        ))
        .await
        .expect("send popup lists request");
    let popup_lists = next_text_message(&mut socket).await;
    let popup_lists: DaemonMessage = serde_json::from_str(&popup_lists).expect("popup lists json");
    match popup_lists {
        DaemonMessage::PopupListsResult {
            success,
            lists,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(lists.len(), 1);
            assert_eq!(lists[0].slug, "reading");
            assert_eq!(lists[0].name, "Reading");
            assert_eq!(lists[0].pins.len(), 1);
            assert!(lists[0].pins[0].id.starts_with("page:"));
        }
        other => panic!("expected popup lists result, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn remote_replay_materializes_entities_without_appending_local_logs() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::ReplayRemoteEntries {
                device_id: "peer-sync".to_string(),
                entries: vec![
                    json!({
                        "timestamp": 1_710_000_020_000i64,
                        "action": "visit_page",
                        "url": "https://example.com/remote",
                        "title": "Remote Page",
                        "checkpoint": true
                    }),
                    json!({
                        "timestamp": 1_710_000_020_100i64,
                        "action": "create_note",
                        "url": "https://example.com/remote",
                        "path": "notes/remote-note.json",
                        "excerpt": "remote excerpt",
                        "note": "remote note body"
                    }),
                ],
            })
            .expect("remote replay json"),
        ))
        .await
        .expect("send remote replay");

    let result = next_text_message(&mut socket).await;
    let result: DaemonMessage = serde_json::from_str(&result).expect("remote replay result json");
    match result {
        DaemonMessage::RemoteReplayResult {
            success,
            replayed_entries,
            error,
        } => {
            assert!(success);
            assert_eq!(replayed_entries, 2);
            assert!(error.is_none());
        }
        other => panic!("expected remote replay result, got {other:?}"),
    }

    let change = next_text_message(&mut socket).await;
    let change: DaemonMessage = serde_json::from_str(&change).expect("change json");
    match change {
        DaemonMessage::Change { mutations } => {
            assert!(!mutations.is_empty());
            assert!(mutations.iter().any(|item| item.mutation_type == "note"));
        }
        other => panic!("expected change broadcast, got {other:?}"),
    }

    let slug = generate_slug_from_url("https://example.com/remote").expect("slug");
    let page_raw = tokio::fs::read_to_string(data_dir.join("pages").join(format!("{slug}.json")))
        .await
        .expect("page exists");
    assert!(page_raw.contains("\"title\": \"Remote Page\""));
    assert!(page_raw.contains("\"note:remote-note\""));

    let note_raw =
        tokio::fs::read_to_string(data_dir.join("data").join("notes").join("remote-note.json"))
            .await
            .expect("note exists");
    assert!(note_raw.contains("\"remote note body\""));

    let logs = read_log_files(&data_dir.join("data").join("logs").join(device_id)).await;
    assert!(logs.is_empty());

    handle.shutdown().await;
}

#[tokio::test]
async fn note_ingest_persists_note_file_and_links_page() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Note {
                slug: "n1".to_string(),
                excerpt: Some("Hello".to_string()),
                note: "World".to_string(),
                css_path: None,
                old_slug: None,
                url: "https://example.com/notes".to_string(),
                title: Some("Notes Page".to_string()),
                ts: 1_710_000_002_000i64,
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("note json"),
        ))
        .await
        .expect("send note");

    let ack = next_text_message(&mut socket).await;
    let ack: DaemonMessage = serde_json::from_str(&ack).expect("ack json");
    assert!(matches!(ack, DaemonMessage::Ack { .. }));

    let note_path = data_dir.join("data").join("notes").join("n1.json");
    let note_raw = tokio::fs::read_to_string(note_path)
        .await
        .expect("note exists");
    assert!(note_raw.contains("\"excerpt\": \"Hello\""));
    assert!(note_raw.contains("\"note\": \"World\""));

    let page_dir = data_dir.join("pages");
    let mut pages = tokio::fs::read_dir(page_dir)
        .await
        .expect("page dir exists");
    let page_file = pages
        .next_entry()
        .await
        .expect("read dir")
        .expect("one page");
    let page_raw = tokio::fs::read_to_string(page_file.path())
        .await
        .expect("page exists");
    assert!(page_raw.contains("\"note:n1\""));

    handle.shutdown().await;
}

#[tokio::test]
async fn note_replace_ingest_deletes_old_note_and_links_new_note() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Note {
                slug: "n1".to_string(),
                excerpt: Some("Hello".to_string()),
                note: "World".to_string(),
                css_path: None,
                old_slug: None,
                url: "https://example.com/notes".to_string(),
                title: Some("Notes Page".to_string()),
                ts: 1_710_000_002_000i64,
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("note json"),
        ))
        .await
        .expect("send note");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Note {
                slug: "n2".to_string(),
                excerpt: Some("Hello".to_string()),
                note: "Updated".to_string(),
                css_path: None,
                old_slug: Some("n1".to_string()),
                url: "https://example.com/notes".to_string(),
                title: None,
                ts: 1_710_000_002_100i64,
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("replace note json"),
        ))
        .await
        .expect("send replace note");

    let ack = next_text_message(&mut socket).await;
    let ack: DaemonMessage = serde_json::from_str(&ack).expect("ack json");
    assert!(matches!(ack, DaemonMessage::Ack { .. }));

    assert!(!data_dir.join("data").join("notes").join("n1.json").exists());

    let new_note_raw =
        tokio::fs::read_to_string(data_dir.join("data").join("notes").join("n2.json"))
            .await
            .expect("new note exists");
    assert!(new_note_raw.contains("\"note\": \"Updated\""));

    let page_dir = data_dir.join("pages");
    let mut pages = tokio::fs::read_dir(page_dir)
        .await
        .expect("page dir exists");
    let page_file = pages
        .next_entry()
        .await
        .expect("read dir")
        .expect("one page");
    let page_raw = tokio::fs::read_to_string(page_file.path())
        .await
        .expect("page exists");
    assert!(page_raw.contains("\"note:n2\""));
    assert!(!page_raw.contains("\"note:n1\""));

    let orphaned_raw = tokio::fs::read_to_string(data_dir.join("manifest").join("orphaned.json"))
        .await
        .expect("orphaned manifest exists");
    assert!(!orphaned_raw.contains("\"note:n1\""));

    handle.shutdown().await;
}

#[tokio::test]
async fn permanent_delete_removes_orphaned_note_list_and_snapshot_files() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    let page_url = "https://example.com/delete-me";
    let page_slug = generate_slug_from_url(page_url).expect("slug");

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Event {
                entry: json!({
                    "timestamp": 1_710_000_010_000i64,
                    "action": "create_list",
                    "listOwner": "test-device",
                    "name": "Reading",
                    "listId": "reading-list"
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("create list json"),
        ))
        .await
        .expect("send create list");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Note {
                slug: "n1".to_string(),
                excerpt: Some("Hello".to_string()),
                note: "World".to_string(),
                css_path: None,
                old_slug: None,
                url: page_url.to_string(),
                title: Some("Delete Me".to_string()),
                ts: 1_710_000_010_100i64,
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("note json"),
        ))
        .await
        .expect("send note");
    let _ = next_text_message(&mut socket).await;

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Snapshot {
                slug: page_slug.clone(),
                ts: 1_710_000_010_200i64,
                url: page_url.to_string(),
                title: Some("Delete Me".to_string()),
                markdown: Some("snapshot markdown".to_string()),
                html: "<html><body>snapshot</body></html>".to_string(),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("snapshot json"),
        ))
        .await
        .expect("send snapshot");
    let _ = next_text_message(&mut socket).await;

    for entry in [
        json!({
            "timestamp": 1_710_000_010_300i64,
            "action": "delete_note",
            "url": page_url,
            "path": "notes/n1.json"
        }),
        json!({
            "timestamp": 1_710_000_010_400i64,
            "action": "delete_snapshot",
            "url": page_url,
            "path": format!("snapshots/{page_slug}-1710000010200")
        }),
        json!({
            "timestamp": 1_710_000_010_500i64,
            "action": "delete_list",
            "listOwner": "test-device",
            "name": "Reading"
        }),
    ] {
        socket
            .send(Message::Text(
                serde_json::to_string(&ConnectorMessage::Event {
                    entry,
                    source: "extension".to_string(),
                    buffer_depth: None,
                    buffer_bytes: None,
                })
                .expect("event json"),
            ))
            .await
            .expect("send delete event");
        let _ = next_text_message(&mut socket).await;
    }

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::PermanentDelete {
                keys: vec![
                    "note:n1".to_string(),
                    format!("snapshot:{page_slug}-1710000010200"),
                    "list:reading-list".to_string(),
                ],
            })
            .expect("permanent delete json"),
        ))
        .await
        .expect("send permanent delete");

    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("result json");
    match response {
        DaemonMessage::PermanentDeleteResult {
            success,
            deleted_keys,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(deleted_keys.len(), 3);
        }
        other => panic!("expected permanent delete result, got {other:?}"),
    }

    assert!(!data_dir.join("data").join("notes").join("n1.json").exists());
    assert!(!data_dir.join("lists").join("reading-list.json").exists());
    assert!(!data_dir
        .join("data")
        .join("snapshots")
        .join(format!("{page_slug}-1710000010200.html"))
        .exists());
    assert!(!data_dir
        .join("data")
        .join("snapshots")
        .join(format!("{page_slug}-1710000010200.md"))
        .exists());
    let orphaned_raw = tokio::fs::read_to_string(data_dir.join("manifest").join("orphaned.json"))
        .await
        .expect("orphaned manifest exists");
    assert!(!orphaned_raw.contains("\"note:n1\""));
    assert!(!orphaned_raw.contains("\"list:reading-list\""));
    assert!(!orphaned_raw.contains(&format!("\"snapshot:{page_slug}-1710000010200\"")));

    handle.shutdown().await;
}

#[tokio::test]
async fn list_rule_pin_and_settings_events_persist_expected_files() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    for entry in [
        json!({
            "timestamp": 1_710_000_003_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Reading",
            "listId": "reading-list"
        }),
        json!({
            "timestamp": 1_710_000_003_100i64,
            "action": "pin_to_list",
            "listOwner": "test-device",
            "name": "Reading",
            "items": ["https://example.com/reading"],
            "titles": { "https://example.com/reading": "Reading Page" }
        }),
        json!({
            "timestamp": 1_710_000_003_200i64,
            "action": "add_rule",
            "listOwner": "test-device",
            "name": "Reading",
            "rule": {
                "id": "rule-k-reading",
                "type": "keyword",
                "config": { "pattern": "reading" }
            }
        }),
        json!({
            "timestamp": 1_710_000_003_300i64,
            "action": "update_setting",
            "key": "theme",
            "value": "sepia"
        }),
    ] {
        socket
            .send(Message::Text(
                serde_json::to_string(&ConnectorMessage::Event {
                    entry,
                    source: "extension".to_string(),
                    buffer_depth: None,
                    buffer_bytes: None,
                })
                .expect("event json"),
            ))
            .await
            .expect("send event");
        let ack = next_text_message(&mut socket).await;
        let ack: DaemonMessage = serde_json::from_str(&ack).expect("ack json");
        assert!(matches!(ack, DaemonMessage::Ack { .. }));
    }

    let list_raw = tokio::fs::read_to_string(data_dir.join("lists").join("reading-list.json"))
        .await
        .expect("list exists");
    assert!(list_raw.contains("\"name\": \"Reading\""));
    assert!(list_raw.contains("\"rule-k-reading\""));
    assert!(list_raw.contains("\"id\": \"page:"));

    let settings_raw = tokio::fs::read_to_string(data_dir.join("manifest").join("settings.json"))
        .await
        .expect("settings exist");
    assert!(settings_raw.contains("\"theme\": \"sepia\""));

    let name_map_raw =
        tokio::fs::read_to_string(data_dir.join("manifest").join("list-name-to-id.json"))
            .await
            .expect("name map exists");
    assert!(name_map_raw.contains("\"test-device/Reading\": \"reading-list\""));

    let list_order_raw =
        tokio::fs::read_to_string(data_dir.join("manifest").join("list-order.json"))
            .await
            .expect("list order exists");
    assert!(list_order_raw.contains("\"id\": \"list:reading-list\""));

    handle.shutdown().await;
}

#[tokio::test]
async fn visit_events_auto_pin_lists_with_matching_function_rules() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    for entry in [
        json!({
            "timestamp": 1_710_000_004_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Hubs",
            "listId": "hubs"
        }),
        json!({
            "timestamp": 1_710_000_004_100i64,
            "action": "add_rule",
            "listOwner": "test-device",
            "name": "Hubs",
            "rule": {
                "id": "rule-f-hubs",
                "type": "function",
                "config": {
                    "description": "Hub pages",
                    "fnSource": "const u = new URL(page.url); return u.pathname === '/' && !u.searchParams.has('q');"
                }
            }
        }),
        json!({
            "timestamp": 1_710_000_004_200i64,
            "action": "visit_page",
            "url": "https://example.com/",
            "title": "Example Home",
            "checkpoint": true
        }),
    ] {
        socket
            .send(Message::Text(
                serde_json::to_string(&ConnectorMessage::Event {
                    entry,
                    source: "extension".to_string(),
                    buffer_depth: None,
                    buffer_bytes: None,
                })
                .expect("event json"),
            ))
            .await
            .expect("send event");
        let ack = next_text_message(&mut socket).await;
        let ack: DaemonMessage = serde_json::from_str(&ack).expect("ack json");
        assert!(matches!(ack, DaemonMessage::Ack { .. }));
    }

    let list_raw = tokio::fs::read_to_string(data_dir.join("lists").join("hubs.json"))
        .await
        .expect("list exists");
    assert!(list_raw.contains("\"rule-f-hubs\""));
    assert!(list_raw.contains("\"source\": \"auto\""));
    assert!(list_raw.contains("\"id\": \"page:"));

    let log_dir = data_dir.join("data").join("logs").join(device_id);
    let logs = read_log_files(&log_dir).await;
    assert!(logs
        .iter()
        .any(|log| log.contains("\"action\":\"visit_page\"")));
    assert!(logs
        .iter()
        .any(|log| log.contains("\"action\":\"pin_to_list\"")));
    assert!(logs.iter().any(|log| log.contains("\"source\":\"auto\"")));

    handle.shutdown().await;
}

#[tokio::test]
async fn preview_rule_reports_matches_and_compile_errors() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    socket
        .send(Message::Text(
            json!({
                "type": "preview_rule",
                "rule": {
                    "type": "function",
                    "config": {
                        "description": "Long titles",
                        "fnSource": "return page.title.length > 10;"
                    }
                },
                "entries": [
                    {
                        "url": "https://example.com/long",
                        "title": "A Very Long Title"
                    },
                    {
                        "url": "https://example.com/short",
                        "title": "Short"
                    }
                ]
            })
            .to_string(),
        ))
        .await
        .expect("send preview");

    let preview = next_text_message(&mut socket).await;
    let preview: DaemonMessage = serde_json::from_str(&preview).expect("preview json");
    match preview {
        DaemonMessage::PreviewRuleResult {
            success,
            results,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(results.len(), 2);
            assert!(results[0].r#match);
            assert!(!results[1].r#match);
        }
        other => panic!("expected preview result, got {other:?}"),
    }

    socket
        .send(Message::Text(
            json!({
                "type": "preview_rule",
                "rule": {
                    "type": "function",
                    "config": {
                        "description": "Broken",
                        "fnSource": "return page.title.length >>"
                    }
                },
                "entries": []
            })
            .to_string(),
        ))
        .await
        .expect("send broken preview");

    let broken = next_text_message(&mut socket).await;
    let broken: DaemonMessage = serde_json::from_str(&broken).expect("broken preview json");
    match broken {
        DaemonMessage::PreviewRuleResult {
            success,
            results,
            error,
        } => {
            assert!(!success);
            assert!(results.is_empty());
            assert!(!error.expect("error").trim().is_empty());
        }
        other => panic!("expected preview result, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn run_rule_batch_persists_matches_and_returns_hits() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    for entry in [
        json!({
            "timestamp": 1_710_000_005_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Reading",
            "listId": "reading"
        }),
        json!({
            "timestamp": 1_710_000_005_100i64,
            "action": "add_rule",
            "listOwner": "test-device",
            "name": "Reading",
            "rule": {
                "id": "rule-k-reading",
                "type": "keyword",
                "config": { "pattern": "github", "fields": ["url"] }
            }
        }),
    ] {
        socket
            .send(Message::Text(
                serde_json::to_string(&ConnectorMessage::Event {
                    entry,
                    source: "extension".to_string(),
                    buffer_depth: None,
                    buffer_bytes: None,
                })
                .expect("event json"),
            ))
            .await
            .expect("send event");
        let _ = next_text_message(&mut socket).await;
    }

    socket
        .send(Message::Text(
            json!({
                "type": "run_rule_batch",
                "listIds": ["reading"],
                "entries": [
                    {
                        "url": "https://github.com/example/repo",
                        "title": "Repo"
                    },
                    {
                        "url": "https://example.com/",
                        "title": "Example"
                    }
                ]
            })
            .to_string(),
        ))
        .await
        .expect("send rule batch");

    let batch = next_text_message(&mut socket).await;
    let batch: DaemonMessage = serde_json::from_str(&batch).expect("batch json");
    match batch {
        DaemonMessage::RuleBatchResult {
            success,
            results,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].list_id, "reading");
            assert_eq!(results[0].url, "https://github.com/example/repo");
            assert_eq!(results[0].matches[0].rule_id, "rule-k-reading");
        }
        other => panic!("expected batch result, got {other:?}"),
    }

    let list_raw = tokio::fs::read_to_string(data_dir.join("lists").join("reading.json"))
        .await
        .expect("list exists");
    assert!(list_raw.contains("\"source\": \"auto\""));

    let log_dir = data_dir.join("data").join("logs").join(device_id);
    let logs = read_log_files(&log_dir).await;
    assert!(
        logs.iter()
            .any(|log| log.contains("\"action\":\"pin_to_list\"")),
        "expected pin_to_list in at least one log file"
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn replay_failure_pauses_daemon_and_rejects_followup_events() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Event {
                entry: json!({
                    "timestamp": 1_710_000_000_000i64,
                    "action": "visit_page",
                    "url": "not a url",
                    "title": "Invalid URL"
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("event json"),
        ))
        .await
        .expect("send broken event");

    let first = next_text_message(&mut socket).await;
    let first: DaemonMessage = serde_json::from_str(&first).expect("error json");
    match first {
        DaemonMessage::Error {
            error,
            code,
            message,
        } => {
            assert_eq!(error, "paused");
            assert_eq!(code, "replay_error");
            assert!(message.contains("Event ingest failed"));
        }
        other => panic!("expected paused error, got {other:?}"),
    }

    let snapshot = handle.snapshot().await;
    assert_eq!(
        snapshot.service_status,
        browser_recall_daemon::ServiceStatus::Paused
    );
    assert_eq!(snapshot.last_error_code.as_deref(), Some("replay_error"));

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Event {
                entry: json!({
                    "timestamp": 1_710_000_000_100i64,
                    "action": "visit_page",
                    "url": "https://example.com/after-pause",
                    "title": "After Pause"
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("event json"),
        ))
        .await
        .expect("send followup event");

    let second = next_text_message(&mut socket).await;
    let second: DaemonMessage = serde_json::from_str(&second).expect("error json");
    match second {
        DaemonMessage::Error {
            error,
            code,
            message,
        } => {
            assert_eq!(error, "paused");
            assert_eq!(code, "replay_error");
            assert!(message.contains("Event ingest failed"));
        }
        other => panic!("expected paused error, got {other:?}"),
    }

    handle.resume().await;

    let resumed_snapshot = handle.snapshot().await;
    assert_eq!(
        resumed_snapshot.service_status,
        browser_recall_daemon::ServiceStatus::Running
    );
    assert_eq!(resumed_snapshot.connected_browsers, vec!["Chrome"]);
    assert_eq!(resumed_snapshot.last_error, None);
    assert_eq!(resumed_snapshot.last_error_code, None);

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::Event {
                entry: json!({
                    "timestamp": 1_710_000_000_200i64,
                    "action": "visit_page",
                    "url": "https://example.com/after-resume",
                    "title": "After Resume",
                    "checkpoint": true
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("event json"),
        ))
        .await
        .expect("send resumed event");

    let third = next_text_message(&mut socket).await;
    let third: DaemonMessage = serde_json::from_str(&third).expect("ack json");
    assert!(matches!(third, DaemonMessage::Ack { .. }));

    handle.shutdown().await;
}
