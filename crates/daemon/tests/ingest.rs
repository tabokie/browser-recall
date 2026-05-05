mod support;

use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage};
use browser_recall_daemon::ws_server::start_server;
use browser_recall_daemon::{ApprovedConnector, ConfigStore, Token};
use browser_recall_replay::generate_slug_from_url;
use futures_util::SinkExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use tempfile::tempdir;
use tokio::time::{sleep, timeout, Duration};
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

async fn send_connector(socket: &mut TestSocket, message: ConnectorMessage) {
    socket
        .send(Message::Text(
            serde_json::to_string(&message).expect("message json"),
        ))
        .await
        .expect("send message");
}

async fn send_raw(socket: &mut TestSocket, value: Value) {
    socket
        .send(Message::Text(value.to_string()))
        .await
        .expect("send message");
}

async fn next_daemon(socket: &mut TestSocket) -> DaemonMessage {
    loop {
        let message: DaemonMessage =
            serde_json::from_str(&next_text_message(socket).await).expect("daemon message json");
        if !matches!(message, DaemonMessage::Change { .. }) {
            return message;
        }
    }
}

async fn expect_ack(socket: &mut TestSocket) {
    let message = next_daemon(socket).await;
    assert!(
        matches!(message, DaemonMessage::Ack { .. }),
        "expected ack, got {message:?}"
    );
}

async fn expect_change(socket: &mut TestSocket) -> DaemonMessage {
    loop {
        let raw = timeout(Duration::from_secs(2), next_text_message(socket))
            .await
            .expect("timed out waiting for change message");
        let message: DaemonMessage = serde_json::from_str(&raw).expect("daemon message json");
        if matches!(message, DaemonMessage::Change { .. }) {
            return message;
        }
    }
}

async fn send_event(socket: &mut TestSocket, entry: Value) {
    send_connector(
        socket,
        ConnectorMessage::Event {
            entry,
            source: "extension".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
}

async fn send_event_and_ack(socket: &mut TestSocket, entry: Value) {
    send_event(socket, entry).await;
    expect_ack(socket).await;
}

async fn send_note_and_ack(
    socket: &mut TestSocket,
    slug: &str,
    note: &str,
    url: &str,
    ts: i64,
    old_slug: Option<&str>,
) {
    send_connector(
        socket,
        ConnectorMessage::Note {
            slug: slug.to_string(),
            excerpt: Some("Hello".to_string()),
            note: note.to_string(),
            css_path: None,
            old_slug: old_slug.map(str::to_string),
            url: url.to_string(),
            title: Some("Notes Page".to_string()),
            ts,
            source: "extension".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    expect_ack(socket).await;
}

async fn send_snapshot_and_ack(socket: &mut TestSocket, slug: &str, url: &str, ts: i64) {
    send_connector(
        socket,
        ConnectorMessage::Snapshot {
            slug: slug.to_string(),
            ts,
            url: url.to_string(),
            title: Some("Snapshot".to_string()),
            markdown: Some("banana snapshot".to_string()),
            html: "<html><body>snapshot</body></html>".to_string(),
            source: "extension".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    expect_ack(socket).await;
}

async fn wait_for_text<F>(path: &Path, predicate: F) -> String
where
    F: Fn(&str) -> bool,
{
    let mut last_error = None;
    for _ in 0..100 {
        match tokio::fs::read_to_string(path).await {
            Ok(raw) if predicate(&raw) => return raw,
            Ok(_) => {}
            Err(error) => last_error = Some(error.to_string()),
        }
        sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "timed out waiting for {}: {}",
        path.display(),
        last_error.unwrap_or_else(|| "predicate did not match".to_string())
    );
}

async fn wait_for_absent(path: &Path) {
    for _ in 0..100 {
        if !path.exists() {
            return;
        }
        sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {} to be absent", path.display());
}

fn shard_for(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{:02x}", digest[0])
}

fn page_path(data_dir: &Path, slug: &str) -> std::path::PathBuf {
    data_dir
        .join("views")
        .join("pages")
        .join(shard_for(slug))
        .join(format!("{slug}.json"))
}

fn pages_dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("views").join("pages")
}

fn list_path(data_dir: &Path, slug: &str) -> std::path::PathBuf {
    data_dir
        .join("views")
        .join("lists")
        .join(format!("{slug}.json"))
}

fn manifest_path(data_dir: &Path, filename: &str) -> std::path::PathBuf {
    data_dir.join("views").join("manifest").join(filename)
}

fn note_path(data_dir: &Path, slug: &str) -> std::path::PathBuf {
    data_dir
        .join("objects")
        .join("notes")
        .join(format!("{slug}.json"))
}

fn snapshot_base_path(data_dir: &Path, slug: &str, timestamp: i64) -> std::path::PathBuf {
    let stem = format!("{slug}-{timestamp}");
    data_dir
        .join("objects")
        .join("snapshots")
        .join(shard_for(&stem))
        .join(stem)
}

fn snapshot_relative_path(slug: &str, timestamp: i64) -> String {
    let stem = format!("{slug}-{timestamp}");
    format!("objects/snapshots/{}/{}", shard_for(&stem), stem)
}

fn log_dir(data_dir: &Path, device_id: &str) -> std::path::PathBuf {
    data_dir.join("logs").join(device_id)
}

#[tokio::test]
async fn event_ingest_persists_page_and_reports_status() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    send_event_and_ack(
        &mut socket,
        json!({
            "timestamp": 1_710_000_000_000i64,
            "action": "visit_page",
            "url": "https://example.com/page",
            "title": "Example",
        }),
    )
    .await;

    send_connector(&mut socket, ConnectorMessage::GetStatus).await;
    let status = next_daemon(&mut socket).await;
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
    let page_path = page_path(&data_dir, &slug);
    wait_for_absent(&page_path).await;
    let logs = read_log_files(&log_dir(&data_dir, &device_id)).await;
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("\"action\":\"visit_page\""));
    assert!(!logs[0].contains("bodyPreview"));
    assert!(!logs[0].contains("checkpoint"));

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
    assert_eq!(
        snapshot.connected_connectors[0].browser_id,
        "browser-install"
    );

    first.close(None).await.expect("close first socket");
    sleep(Duration::from_millis(100)).await;
    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.connected_connectors.len(), 1);
    assert_eq!(
        snapshot.connected_connectors[0].browser_id,
        "browser-install"
    );

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
    send_raw(
        &mut socket,
        json!({
            "type": "event",
            "entry": {
                "timestamp": 1_710_000_000_000i64,
                "action": "visit_page",
                "url": "https://example.com/bad",
                "title": "Bad",
            }
        }),
    )
    .await;

    let next = next_daemon(&mut socket).await;
    match next {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "invalid_message");
            assert_eq!(code, "invalid_message");
        }
        other => panic!("expected invalid_message error, got {other:?}"),
    }

    send_connector(&mut socket, ConnectorMessage::GetStatus).await;
    let status = next_daemon(&mut socket).await;
    assert!(matches!(status, DaemonMessage::Status { .. }));

    let pages_dir = pages_dir(&data_dir);
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
    send_snapshot_and_ack(
        &mut socket,
        &slug,
        "https://example.com/page",
        1_710_000_001_000i64,
    )
    .await;

    let snapshot_path =
        snapshot_base_path(&data_dir, &slug, 1_710_000_001_000).with_extension("html");
    let snapshot_html = tokio::fs::read_to_string(snapshot_path)
        .await
        .expect("snapshot html exists");
    assert!(snapshot_html.contains("snapshot"));
    let snapshot_md = tokio::fs::read_to_string(
        snapshot_base_path(&data_dir, &slug, 1_710_000_001_000).with_extension("md"),
    )
    .await
    .expect("snapshot markdown exists");
    assert!(snapshot_md.contains("banana snapshot"));

    let log_dir = log_dir(&data_dir, &device_id);
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
    send_connector(
        &mut socket,
        ConnectorMessage::SetDeviceId {
            device_id: new_device_id.to_string(),
        },
    )
    .await;

    let response = next_daemon(&mut socket).await;
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
        .join("logs")
        .join(new_device_id)
        .join("CURRENT")
        .exists());
    assert!(!data_dir
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
    send_event_and_ack(
        &mut socket,
        json!({
            "timestamp": 1_710_000_000_000i64,
            "action": "visit_page",
            "url": "https://example.com/page",
            "title": "Example",
        }),
    )
    .await;

    send_connector(&mut socket, ConnectorMessage::ClearAllData).await;
    let response = next_daemon(&mut socket).await;
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

    sleep(Duration::from_millis(150)).await;

    assert!(tokio::fs::read_dir(pages_dir(&data_dir))
        .await
        .expect("pages dir")
        .next_entry()
        .await
        .expect("pages read")
        .is_none());
    assert!(tokio::fs::read_dir(data_dir.join("views").join("lists"))
        .await
        .expect("lists dir")
        .next_entry()
        .await
        .expect("lists read")
        .is_none());
    assert!(tokio::fs::read_dir(data_dir.join("views").join("manifest"))
        .await
        .expect("manifest dir")
        .next_entry()
        .await
        .expect("manifest read")
        .is_none());

    let logs_dir = log_dir(&data_dir, &device_id);
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
    send_event_and_ack(
        &mut socket,
        json!({
            "timestamp": 1_710_000_000_000i64,
            "action": "visit_page",
            "url": "https://example.com/page",
            "title": "Banana Example",
        }),
    )
    .await;
    send_note_and_ack(
        &mut socket,
        "note-search",
        "banana note body",
        "https://example.com/page",
        1_710_000_000_100i64,
        None,
    )
    .await;
    send_connector(
        &mut socket,
        ConnectorMessage::Snapshot {
            slug: "example-page".to_string(),
            ts: 1_710_000_000_200i64,
            url: "https://example.com/page".to_string(),
            title: Some("Banana Example".to_string()),
            markdown: Some("banana snapshot body".to_string()),
            html: "<html><body>banana snapshot body</body></html>".to_string(),
            source: "extension".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    expect_ack(&mut socket).await;

    send_connector(
        &mut socket,
        ConnectorMessage::SearchHistory {
            query: "banana".to_string(),
            limit: None,
        },
    )
    .await;
    let history = next_daemon(&mut socket).await;
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

    send_connector(
        &mut socket,
        ConnectorMessage::SearchNotes {
            query: "banana".to_string(),
            limit: None,
        },
    )
    .await;
    let notes = next_daemon(&mut socket).await;
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

    send_connector(
        &mut socket,
        ConnectorMessage::SearchSnapshots {
            query: "banana".to_string(),
            limit: None,
        },
    )
    .await;
    let snapshots = next_daemon(&mut socket).await;
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
            "urls": ["https://example.com/popup"],
            "titles": ["Popup Page"]
        }),
        json!({
            "timestamp": 1_710_000_010_100i64,
            "action": "visit_page",
            "url": "https://example.com/popup",
            "title": "Popup Page",
        }),
    ] {
        send_event_and_ack(&mut socket, entry).await;
    }

    send_connector(
        &mut socket,
        ConnectorMessage::Note {
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
        },
    )
    .await;
    expect_ack(&mut socket).await;

    send_connector(
        &mut socket,
        ConnectorMessage::Snapshot {
            slug: "popup-page".to_string(),
            ts: 1_710_000_010_300i64,
            url: "https://example.com/popup".to_string(),
            title: Some("Popup Page".to_string()),
            markdown: Some("popup snapshot".to_string()),
            html: "<html><body>popup snapshot</body></html>".to_string(),
            source: "extension".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    expect_ack(&mut socket).await;

    let page_slug = generate_slug_from_url("https://example.com/popup").expect("slug");

    send_raw(
        &mut socket,
        json!({
            "type": "get_page_info",
            "slug": page_slug
        }),
    )
    .await;
    let page_info = next_daemon(&mut socket).await;
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

    send_raw(
        &mut socket,
        json!({
            "type": "get_snapshot_html",
            "slug": "popup-page",
            "ts": 1_710_000_010_300i64
        }),
    )
    .await;
    let snapshot_html = next_daemon(&mut socket).await;
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

    send_raw(
        &mut socket,
        json!({
            "type": "get_entity",
            "key": format!("page:{page_slug}")
        }),
    )
    .await;
    let entity = next_daemon(&mut socket).await;
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

    send_raw(&mut socket, json!({ "type": "get_popup_lists" })).await;
    let popup_lists = next_daemon(&mut socket).await;
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
    send_connector(
        &mut socket,
        ConnectorMessage::ReplayRemoteEntries {
            device_id: "peer-sync".to_string(),
            entries: vec![
                json!({
                    "timestamp": 1_710_000_020_000i64,
                    "action": "visit_page",
                    "url": "https://example.com/remote",
                    "title": "Remote Page",
                }),
                json!({
                    "timestamp": 1_710_000_020_100i64,
                    "action": "create_note",
                    "url": "https://example.com/remote",
                    "path": "objects/notes/remote-note.json",
                    "excerpt": "remote excerpt",
                    "note": "remote note body"
                }),
            ],
        },
    )
    .await;

    let result = next_daemon(&mut socket).await;
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

    let slug = generate_slug_from_url("https://example.com/remote").expect("slug");
    let page_path = page_path(&data_dir, &slug);
    let page_raw = wait_for_text(&page_path, |raw| raw.contains("\"note:remote-note\"")).await;
    assert!(page_raw.contains("\"title\": \"Remote Page\""));
    assert!(page_raw.contains("\"note:remote-note\""));

    let remote_note_path = note_path(&data_dir, "remote-note");
    let note_raw = wait_for_text(&remote_note_path, |raw| raw.contains("remote note body")).await;
    assert!(note_raw.contains("\"remote note body\""));

    let logs = read_log_files(&log_dir(&data_dir, &device_id)).await;
    assert!(logs.is_empty());

    handle.shutdown().await;
}

#[tokio::test]
async fn run_command_executes_desktop_mutation() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut actor, data_dir, _) = paired_socket(handle.port(), &config_store).await;
    for entry in [
        json!({
            "timestamp": 1_710_000_030_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Reading",
            "listId": "reading"
        }),
        json!({
            "timestamp": 1_710_000_030_100i64,
            "action": "visit_page",
            "url": "https://example.com/command",
            "title": "Command Page",
        }),
    ] {
        send_event_and_ack(&mut actor, entry).await;
    }

    send_raw(
        &mut actor,
        json!({
            "type": "run_command",
            "action": "toggleListPin",
            "request": {
                "listId": "reading",
                "url": "https://example.com/command",
                "title": "Command Page"
            }
        }),
    )
    .await;

    let response = next_daemon(&mut actor).await;
    match response {
        DaemonMessage::CommandResult {
            success,
            response,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(
                response
                    .expect("response")
                    .get("pinned")
                    .and_then(|value| value.as_bool()),
                Some(true)
            );
        }
        other => panic!("expected command result, got {other:?}"),
    }

    let list_path = list_path(&data_dir, "reading");
    let list_raw = wait_for_text(&list_path, |raw| raw.contains("\"id\": \"page:")).await;
    assert!(list_raw.contains("\"id\": \"page:"));

    handle.shutdown().await;
}

#[tokio::test]
async fn run_command_bootstraps_default_lists_in_desktop() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _) = paired_socket(handle.port(), &config_store).await;
    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "ensureDefaultLists",
            "request": {}
        }),
    )
    .await;

    let response = next_daemon(&mut socket).await;
    match response {
        DaemonMessage::CommandResult {
            success,
            response,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(
                response
                    .expect("response")
                    .get("created")
                    .and_then(|value| value.as_bool()),
                Some(true)
            );
        }
        other => panic!("expected command result, got {other:?}"),
    }

    let hubs_path = list_path(&data_dir, "hubs");
    let list_raw = wait_for_text(&hubs_path, |raw| raw.contains("\"type\": \"function\"")).await;
    assert!(list_raw.contains("\"name\": \"Hubs\""));
    assert!(list_raw.contains("\"type\": \"function\""));

    let name_map_path = manifest_path(&data_dir, "list-name-to-id.json");
    let name_map_raw = wait_for_text(&name_map_path, |raw| {
        raw.contains("\"system/Hubs\": \"hubs\"")
    })
    .await;
    assert!(name_map_raw.contains("\"system/Hubs\": \"hubs\""));

    handle.shutdown().await;
}

#[tokio::test]
async fn run_command_classifies_popup_blacklist_with_desktop_policy() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _, _) = paired_socket(handle.port(), &config_store).await;
    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "getPopupAccessState",
            "request": { "url": "chrome://settings" }
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response: Some(response),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(
                response.get("blacklisted").and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                response.get("hasVisitHistory").and_then(Value::as_bool),
                Some(false)
            );
        }
        other => panic!("expected command result, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "reportVisit",
            "request": {
                "timestamp": 1_710_000_040_000i64,
                "url": "chrome://settings",
                "title": "Settings",
                "bypassBlacklist": true
            }
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "getPopupAccessState",
            "request": { "url": "chrome://settings" }
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response: Some(response),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(
                response.get("blacklisted").and_then(Value::as_bool),
                Some(false)
            );
            assert_eq!(
                response.get("hasVisitHistory").and_then(Value::as_bool),
                Some(true)
            );
        }
        other => panic!("expected command result, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn popup_lists_use_shared_storage_cache_after_desktop_side_write() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _, _device_id) = paired_socket(handle.port(), &config_store).await;
    send_event_and_ack(
        &mut socket,
        json!({
            "timestamp": 1_710_000_031_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Existing",
            "listId": "existing"
        }),
    )
    .await;

    send_raw(&mut socket, json!({ "type": "get_popup_lists" })).await;
    let warmed = next_daemon(&mut socket).await;
    match warmed {
        DaemonMessage::PopupListsResult { lists, .. } => {
            assert_eq!(
                lists
                    .iter()
                    .map(|list| list.name.as_str())
                    .collect::<Vec<_>>(),
                vec!["Existing"]
            );
        }
        other => panic!("expected popup lists result, got {other:?}"),
    }

    handle
        .control_handle()
        .run_command("saveListMeta", json!({ "name": "Desktop Added" }))
        .await
        .expect("desktop-side list create through daemon write authority");

    send_raw(&mut socket, json!({ "type": "get_popup_lists" })).await;
    let refreshed = next_daemon(&mut socket).await;
    match refreshed {
        DaemonMessage::PopupListsResult { lists, .. } => {
            let names = lists
                .iter()
                .map(|list| list.name.as_str())
                .collect::<Vec<_>>();
            assert_eq!(names, vec!["Desktop Added", "Existing"]);
        }
        other => panic!("expected popup lists result, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn desktop_side_mutations_are_forwarded_to_connector_sockets() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (_paired, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    let token = config_store
        .load_or_create()
        .expect("config")
        .connectors
        .first()
        .expect("paired connector")
        .token
        .0
        .clone();
    let mut observer = authenticated_socket(handle.port(), &token).await;

    handle
        .control_handle()
        .run_command("saveListMeta", json!({ "name": "Desktop Added" }))
        .await
        .expect("desktop-side mutation");

    match expect_change(&mut observer).await {
        DaemonMessage::Change { mutations } => {
            assert!(mutations
                .iter()
                .any(|mutation| mutation.mutation_type == "lists"));
        }
        other => panic!("expected change message, got {other:?}"),
    }

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
    send_note_and_ack(
        &mut socket,
        "n1",
        "World",
        "https://example.com/notes",
        1_710_000_002_000i64,
        None,
    )
    .await;

    let note_path = note_path(&data_dir, "n1");
    let note_raw = wait_for_text(&note_path, |raw| raw.contains("\"note\": \"World\"")).await;
    assert!(note_raw.contains("\"excerpt\": \"Hello\""));
    assert!(note_raw.contains("\"note\": \"World\""));

    let page_slug = generate_slug_from_url("https://example.com/notes").expect("slug");
    let page_raw = wait_for_text(&page_path(&data_dir, &page_slug), |raw| {
        raw.contains("\"note:n1\"")
    })
    .await;
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
    send_note_and_ack(
        &mut socket,
        "n1",
        "World",
        "https://example.com/notes",
        1_710_000_002_000i64,
        None,
    )
    .await;
    send_note_and_ack(
        &mut socket,
        "n2",
        "Updated",
        "https://example.com/notes",
        1_710_000_002_100i64,
        Some("n1"),
    )
    .await;

    wait_for_absent(&note_path(&data_dir, "n1")).await;

    let new_note_path = note_path(&data_dir, "n2");
    let new_note_raw =
        wait_for_text(&new_note_path, |raw| raw.contains("\"note\": \"Updated\"")).await;
    assert!(new_note_raw.contains("\"note\": \"Updated\""));

    let page_slug = generate_slug_from_url("https://example.com/notes").expect("slug");
    let page_raw = wait_for_text(&page_path(&data_dir, &page_slug), |raw| {
        raw.contains("\"note:n2\"") && !raw.contains("\"note:n1\"")
    })
    .await;
    assert!(page_raw.contains("\"note:n2\""));
    assert!(!page_raw.contains("\"note:n1\""));

    let orphaned_path = manifest_path(&data_dir, "orphaned.json");
    let orphaned_raw = wait_for_text(&orphaned_path, |raw| !raw.contains("\"note:n1\"")).await;
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

    send_event_and_ack(
        &mut socket,
        json!({
            "timestamp": 1_710_000_010_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Reading",
            "listId": "reading-list"
        }),
    )
    .await;
    send_note_and_ack(
        &mut socket,
        "n1",
        "World",
        page_url,
        1_710_000_010_100i64,
        None,
    )
    .await;
    send_snapshot_and_ack(&mut socket, &page_slug, page_url, 1_710_000_010_200i64).await;

    for entry in [
        json!({
            "timestamp": 1_710_000_010_300i64,
            "action": "delete_note",
            "url": page_url,
            "path": "objects/notes/n1.json"
        }),
        json!({
            "timestamp": 1_710_000_010_400i64,
            "action": "delete_snapshot",
            "url": page_url,
            "path": snapshot_relative_path(&page_slug, 1_710_000_010_200)
        }),
        json!({
            "timestamp": 1_710_000_010_500i64,
            "action": "delete_list",
            "listOwner": "test-device",
            "name": "Reading"
        }),
    ] {
        send_event_and_ack(&mut socket, entry).await;
    }

    send_connector(
        &mut socket,
        ConnectorMessage::PermanentDelete {
            keys: vec![
                "note:n1".to_string(),
                format!("snapshot:{page_slug}-1710000010200"),
                "list:reading-list".to_string(),
            ],
        },
    )
    .await;

    let response = next_daemon(&mut socket).await;
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

    wait_for_absent(&note_path(&data_dir, "n1")).await;
    wait_for_absent(&list_path(&data_dir, "reading-list")).await;
    wait_for_absent(
        &snapshot_base_path(&data_dir, &page_slug, 1_710_000_010_200).with_extension("html"),
    )
    .await;
    wait_for_absent(
        &snapshot_base_path(&data_dir, &page_slug, 1_710_000_010_200).with_extension("md"),
    )
    .await;
    let orphaned_path = manifest_path(&data_dir, "orphaned.json");
    let orphaned_raw = wait_for_text(&orphaned_path, |raw| {
        !raw.contains("\"note:n1\"")
            && !raw.contains("\"list:reading-list\"")
            && !raw.contains(&format!("\"snapshot:{page_slug}-1710000010200\""))
    })
    .await;
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
            "urls": ["https://example.com/reading"],
            "titles": ["Reading Page"]
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
        send_event_and_ack(&mut socket, entry).await;
    }

    let reading_list_path = list_path(&data_dir, "reading-list");
    let list_raw = wait_for_text(&reading_list_path, |raw| {
        raw.contains("\"rule-k-reading\"") && raw.contains("\"id\": \"page:")
    })
    .await;
    assert!(list_raw.contains("\"name\": \"Reading\""));
    assert!(list_raw.contains("\"rule-k-reading\""));
    assert!(list_raw.contains("\"id\": \"page:"));

    let settings_path = manifest_path(&data_dir, "settings.json");
    let settings_raw =
        wait_for_text(&settings_path, |raw| raw.contains("\"theme\": \"sepia\"")).await;
    assert!(settings_raw.contains("\"theme\": \"sepia\""));

    let name_map_path = manifest_path(&data_dir, "list-name-to-id.json");
    let name_map_raw = wait_for_text(&name_map_path, |raw| {
        raw.contains("\"test-device/Reading\": \"reading-list\"")
    })
    .await;
    assert!(name_map_raw.contains("\"test-device/Reading\": \"reading-list\""));

    let list_order_path = manifest_path(&data_dir, "list-order.json");
    let list_order_raw = wait_for_text(&list_order_path, |raw| {
        raw.contains("\"id\": \"list:reading-list\"")
    })
    .await;
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
        }),
    ] {
        send_event_and_ack(&mut socket, entry).await;
    }

    let list_path = list_path(&data_dir, "hubs");
    let list_raw = wait_for_text(&list_path, |raw| {
        raw.contains("\"rule-f-hubs\"")
            && raw.contains("\"source\": \"auto\"")
            && raw.contains("\"id\": \"page:")
    })
    .await;
    assert!(list_raw.contains("\"rule-f-hubs\""));
    assert!(list_raw.contains("\"source\": \"auto\""));
    assert!(list_raw.contains("\"id\": \"page:"));

    let log_dir = log_dir(&data_dir, &device_id);
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
                "config": { "pattern": "Repo" }
            }
        }),
    ] {
        send_event_and_ack(&mut socket, entry).await;
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

    let batch = next_daemon(&mut socket).await;
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

    let list_path = list_path(&data_dir, "reading");
    let list_raw = wait_for_text(&list_path, |raw| raw.contains("\"source\": \"auto\"")).await;
    assert!(list_raw.contains("\"source\": \"auto\""));

    let log_dir = log_dir(&data_dir, &device_id);
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
                }),
                source: "extension".to_string(),
                buffer_depth: None,
                buffer_bytes: None,
            })
            .expect("event json"),
        ))
        .await
        .expect("send resumed event");

    expect_ack(&mut socket).await;

    handle.shutdown().await;
}
