mod support;

use browser_recall_daemon::pairing::{static_approver, PairingDecision};
use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage};
use browser_recall_daemon::ws_server::start_server;
use browser_recall_daemon::{ApprovedConnector, ConfigStore, ServerStartOptions, Token};
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

fn test_control_server_options(config_store: ConfigStore) -> ServerStartOptions {
    let mut options = test_server_options(config_store);
    options.test_control_enabled = true;
    options
}

fn denied_pairing_server_options(config_store: ConfigStore) -> ServerStartOptions {
    let mut options =
        ServerStartOptions::phase1_defaults(config_store, static_approver(PairingDecision::Deny));
    options.port_candidates = vec![0];
    options
}

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
                protocol_version: Some(2),
                token: token.into(),
            })
            .expect("auth json"),
        ))
        .await
        .expect("send auth");
    let auth = next_text_message(&mut socket).await;
    let auth: DaemonMessage = serde_json::from_str(&auth).expect("auth response json");
    assert!(matches!(
        auth,
        DaemonMessage::AuthOk {
            protocol_version: 2
        }
    ));
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

async fn get_entity(socket: &mut TestSocket, key: &str) -> Option<Value> {
    send_raw(socket, json!({ "type": "get_entity", "key": key })).await;
    match next_daemon(socket).await {
        DaemonMessage::EntityResult {
            success,
            key: result_key,
            entity,
            error,
        } => {
            assert!(success);
            assert_eq!(result_key, key);
            assert!(error.is_none());
            entity
        }
        other => panic!("expected entity result for {key}, got {other:?}"),
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

fn log_entries(logs: &[String]) -> Vec<Value> {
    logs.iter()
        .flat_map(|log| log.lines())
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("log entry json"))
        .collect()
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
            excerpt: Some(serde_json::json!(["Hello"])),
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
async fn connector_source_errors_are_protocol_errors_not_socket_disconnects() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    send_connector(
        &mut socket,
        ConnectorMessage::Event {
            entry: json!({
                "timestamp": 1_710_000_000_000i64,
                "action": "visit_page",
                "url": "https://example.com/bad-source",
                "title": "Bad Source",
            }),
            source: "content-script".to_string(),
            buffer_depth: Some(3),
            buffer_bytes: Some(99),
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error {
            error,
            code,
            message,
        } => {
            assert_eq!(error, "invalid_message");
            assert_eq!(code, "invalid_message");
            assert!(message.contains("invalid connector source"));
        }
        other => panic!("expected invalid source error, got {other:?}"),
    }

    send_connector(
        &mut socket,
        ConnectorMessage::Note {
            slug: "bad-source-note".to_string(),
            excerpt: Some(serde_json::json!(["bad source"])),
            note: "should not persist".to_string(),
            css_path: None,
            old_slug: None,
            url: "https://example.com/bad-source".to_string(),
            title: Some("Bad Source".to_string()),
            ts: 1_710_000_000_100i64,
            source: "popup-cache".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error {
            error,
            code,
            message,
        } => {
            assert_eq!(error, "invalid_message");
            assert_eq!(code, "invalid_message");
            assert!(message.contains("invalid connector source"));
        }
        other => panic!("expected invalid note source error, got {other:?}"),
    }

    send_connector(
        &mut socket,
        ConnectorMessage::Snapshot {
            slug: "bad-source-page".to_string(),
            ts: 1_710_000_000_200i64,
            url: "https://example.com/bad-source".to_string(),
            title: Some("Bad Source".to_string()),
            markdown: Some("should not persist".to_string()),
            html: "<html><body>should not persist</body></html>".to_string(),
            source: "snapshot-cache".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error {
            error,
            code,
            message,
        } => {
            assert_eq!(error, "invalid_message");
            assert_eq!(code, "invalid_message");
            assert!(message.contains("invalid connector source"));
        }
        other => panic!("expected invalid snapshot source error, got {other:?}"),
    }

    send_connector(&mut socket, ConnectorMessage::GetStatus).await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Status {
            buffer_depth,
            buffer_bytes,
            daemon_buffer_depth,
            ..
        } => {
            assert_eq!(buffer_depth, 0);
            assert_eq!(buffer_bytes, 0);
            assert_eq!(daemon_buffer_depth, 0);
        }
        other => panic!("expected status after invalid source errors, got {other:?}"),
    }

    let slug = generate_slug_from_url("https://example.com/bad-source").expect("slug");
    assert!(!page_path(&data_dir, &slug).exists());
    assert!(!note_path(&data_dir, "bad-source-note").exists());
    assert!(
        !snapshot_base_path(&data_dir, "bad-source-page", 1_710_000_000_200)
            .with_extension("html")
            .exists()
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn legacy_websocket_history_search_messages_are_explicitly_unsupported() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    for message in [
        json!({
            "type": "search_history_stream",
            "searchId": "removed-search",
            "query": "banana"
        }),
        json!({
            "type": "cancel_history_search",
            "searchId": "removed-search"
        }),
    ] {
        send_raw(&mut socket, message).await;
        match next_daemon(&mut socket).await {
            DaemonMessage::Error { error, code, .. } => {
                assert_eq!(error, "invalid_message");
                assert_eq!(code, "invalid_message");
            }
            other => panic!("expected explicit invalid_message error, got {other:?}"),
        }
    }

    send_connector(&mut socket, ConnectorMessage::GetStatus).await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::Status { .. }
    ));
    handle.shutdown().await;
}

#[tokio::test]
async fn generic_entity_diagnostics_are_disabled_in_production_sessions() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    for message in [
        ConnectorMessage::GetAllPages,
        ConnectorMessage::GetEntity {
            key: "manifest:settings".to_string(),
        },
    ] {
        send_connector(&mut socket, message).await;
        match next_daemon(&mut socket).await {
            DaemonMessage::Error { error, code, .. } => {
                assert_eq!(error, "test_control_disabled");
                assert_eq!(code, "test_control_disabled");
            }
            other => panic!("expected disabled diagnostic error, got {other:?}"),
        }
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_auth_control_and_error_matrix_keeps_connections_predictable() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config = config_store.load_or_create().expect("config");
    config
        .connectors
        .push(approved_connector("browser-install", "valid-token"));
    config_store.save(&config).expect("save config");
    let handle = start_server(test_control_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let mut request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnop".parse().unwrap(),
    );
    let (mut unauthenticated, _) = connect_async(request).await.expect("ws connect");

    unauthenticated
        .send(Message::Text(
            json!({
                "type": "get_all_pages"
            })
            .to_string(),
        ))
        .await
        .expect("send unauthenticated read");
    let unauthorized: DaemonMessage =
        serde_json::from_str(&next_text_message(&mut unauthenticated).await)
            .expect("unauthorized json");
    match unauthorized {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "unauthorized");
            assert_eq!(code, "auth_required");
        }
        other => panic!("expected unauthorized error, got {other:?}"),
    }

    unauthenticated
        .send(Message::Text("not-json".to_string()))
        .await
        .expect("send malformed json");
    let malformed: DaemonMessage =
        serde_json::from_str(&next_text_message(&mut unauthenticated).await)
            .expect("malformed json response");
    match malformed {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "invalid_message");
            assert_eq!(code, "invalid_message");
        }
        other => panic!("expected invalid message error, got {other:?}"),
    }

    unauthenticated
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::TestSeedData {
                files: vec![browser_recall_daemon::protocol::TestSeedFilePayload {
                    path: "../escape.json".to_string(),
                    content: "{}".to_string(),
                }],
            })
            .expect("invalid seed json"),
        ))
        .await
        .expect("send invalid seed");
    let invalid_seed: DaemonMessage =
        serde_json::from_str(&next_text_message(&mut unauthenticated).await)
            .expect("invalid seed response");
    match invalid_seed {
        DaemonMessage::TestSeedDataResult { success, error } => {
            assert!(!success);
            assert!(error.expect("error").contains("invalid test seed path"));
        }
        other => panic!("expected invalid seed result, got {other:?}"),
    }

    unauthenticated
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::TestSeedData {
                files: vec![browser_recall_daemon::protocol::TestSeedFilePayload {
                    path: "logs/seed-device/2024-03-04.jsonl".to_string(),
                    content: "{\"timestamp\":1710000000000,\"action\":\"visit_page\",\"url\":\"https://seed.example/page\",\"title\":\"Seed Page\"}\n".to_string(),
                }],
            })
            .expect("seed json"),
        ))
        .await
        .expect("send seed");
    let seed: DaemonMessage = serde_json::from_str(&next_text_message(&mut unauthenticated).await)
        .expect("seed response");
    match seed {
        DaemonMessage::TestSeedDataResult { success, error } => {
            assert!(success, "expected seed success: {error:?}");
        }
        other => panic!("expected seed result, got {other:?}"),
    }

    unauthenticated
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::TestResetData).expect("reset json"),
        ))
        .await
        .expect("send reset");
    let reset: DaemonMessage = serde_json::from_str(&next_text_message(&mut unauthenticated).await)
        .expect("reset response");
    match reset {
        DaemonMessage::TestResetDataResult {
            success,
            device_id,
            error,
        } => {
            assert!(success, "expected reset success: {error:?}");
            assert_eq!(
                device_id,
                config_store.load_or_create().expect("config").device_id
            );
        }
        other => panic!("expected reset result, got {other:?}"),
    }

    let mut bad_auth_request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    bad_auth_request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnop".parse().unwrap(),
    );
    let (mut bad_auth, _) = connect_async(bad_auth_request).await.expect("ws connect");
    send_connector(
        &mut bad_auth,
        ConnectorMessage::Auth {
            protocol_version: Some(2),
            token: "missing-token".to_string(),
        },
    )
    .await;
    let auth_fail = next_text_message(&mut bad_auth).await;
    let auth_fail: DaemonMessage = serde_json::from_str(&auth_fail).expect("auth fail json");
    match auth_fail {
        DaemonMessage::AuthFail { reason } => assert_eq!(reason, "token_not_found"),
        other => panic!("expected auth fail, got {other:?}"),
    }

    let mut socket = authenticated_socket(handle.port(), "valid-token").await;
    let revoked = handle
        .control_handle()
        .revoke_connector("browser-install", "abcdefghijklmnop")
        .await
        .expect("revoke connector");
    assert!(revoked);
    let revoked = next_text_message(&mut socket).await;
    let revoked: DaemonMessage = serde_json::from_str(&revoked).expect("revoked json");
    match revoked {
        DaemonMessage::AuthFail { reason } => assert_eq!(reason, "token_revoked"),
        other => panic!("expected token revoked, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_pairing_denial_is_explicit_and_closes_request() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(denied_pairing_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let mut request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnop".parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.expect("ws connect");

    send_connector(
        &mut socket,
        ConnectorMessage::PairRequest {
            protocol_version: Some(2),
            browser_id: "denied-browser".to_string(),
            browser_name: "Chrome".to_string(),
            extension_id: "abcdefghijklmnop".to_string(),
            browser_profile: Some("Default".to_string()),
        },
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::PairPending { .. }
    ));
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::PairDenied
    ));

    let config = config_store.load_or_create().expect("config");
    assert!(config.connectors.is_empty());

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_unauthenticated_matrix_rejects_privileged_messages_without_closing() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let mut request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnop".parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.expect("ws connect");

    for message in [
        json!({ "type": "get_status" }),
        json!({ "type": "get_directory_info" }),
        json!({ "type": "get_directory_size" }),
        json!({ "type": "clear_all_data" }),
        json!({ "type": "replay_remote_entries", "deviceId": "peer", "entries": [] }),
        json!({ "type": "set_device_id", "deviceId": "peer" }),
        json!({ "type": "list_history_files", "includeSizes": true }),
        json!({ "type": "load_history_batch", "files": [] }),
        json!({ "type": "get_all_pages" }),
        json!({ "type": "get_page_info", "slug": "missing" }),
        json!({ "type": "get_page_summary", "url": "https://example.com/summary" }),
        json!({ "type": "get_snapshot_html", "slug": "missing", "ts": 1 }),
        json!({ "type": "get_entity", "key": "page:missing" }),
        json!({ "type": "permanent_delete", "keys": ["note:missing"] }),
        json!({ "type": "run_command", "action": "createList", "request": { "name": "Unauthenticated" } }),
        json!({ "type": "search_notes", "query": "x" }),
        json!({ "type": "search_snapshots", "query": "x" }),
        json!({
            "type": "event",
            "entry": {
                "timestamp": 1_710_050_000_000i64,
                "action": "visit_page",
                "url": "https://example.com/unauth"
            },
            "source": "extension"
        }),
        json!({ "type": "run_rule_batch", "listIds": [], "entries": [] }),
        json!({
            "type": "preview_rule",
            "rule": { "type": "keyword", "config": { "pattern": "x" } },
            "entries": []
        }),
        json!({
            "type": "snapshot",
            "slug": "unauth",
            "ts": 1_710_050_000_100i64,
            "url": "https://example.com/unauth",
            "html": "<html></html>",
            "source": "extension"
        }),
        json!({
            "type": "note",
            "slug": "unauth-note",
            "note": "unauth",
            "url": "https://example.com/unauth",
            "ts": 1_710_050_000_200i64,
            "source": "extension"
        }),
    ] {
        send_raw(&mut socket, message).await;
        match next_daemon(&mut socket).await {
            DaemonMessage::Error { error, code, .. } => {
                assert_eq!(error, "unauthorized");
                assert_eq!(code, "auth_required");
            }
            other => panic!("expected unauthorized error, got {other:?}"),
        }
    }

    send_connector(&mut socket, ConnectorMessage::Ping).await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::Pong
    ));

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_command_and_rule_error_matrix_is_structured() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    for (action, request, expected) in [
        ("reportVisit", json!({}), "reportVisit missing url"),
        ("reportLeave", json!({}), "reportLeave missing url"),
        ("saveSettingsKey", json!({}), "saveSettingsKey missing key"),
        (
            "ratePage",
            json!({ "url": "https://example.com/rate-missing-likes" }),
            "ratePage missing likes",
        ),
        ("importBookmarks", json!({}), "importBookmarks missing tree"),
        ("importHistory", json!({}), "importHistory missing entries"),
        (
            "deleteSnapshot",
            json!({ "slug": "missing-snapshot" }),
            "deleteSnapshot missing timestamp",
        ),
        (
            "addRule",
            json!({ "listId": "missing-list" }),
            "addRule missing rule",
        ),
        (
            "updateRule",
            json!({ "listId": "missing-list", "ruleId": "missing-rule" }),
            "updateRule missing config",
        ),
    ] {
        send_raw(
            &mut socket,
            json!({
                "type": "run_command",
                "action": action,
                "request": request
            }),
        )
        .await;
        match next_daemon(&mut socket).await {
            DaemonMessage::CommandResult {
                success,
                response,
                error: Some(error),
            } => {
                assert!(!success, "{action} should fail");
                assert!(response.is_none());
                assert!(error.contains(expected), "{action} returned {error}");
            }
            other => panic!("expected structured command error for {action}, got {other:?}"),
        }
    }

    for (key, value) in [
        (
            "titleTrimRules",
            json!([
                { "urlPrefix": "https://docs.example/", "action": "remove_after_pipe" },
                { "urlPrefix": "https://docs.example/", "action": "remove_brackets" },
                { "urlPrefix": "https://docs.example/", "action": "remove_parens" }
            ]),
        ),
        ("urlBlacklist", json!(["https://private.example/"])),
    ] {
        send_raw(
            &mut socket,
            json!({
                "type": "run_command",
                "action": "saveSettingsKey",
                "request": { "key": key, "value": value }
            }),
        )
        .await;
        assert!(matches!(
            next_daemon(&mut socket).await,
            DaemonMessage::CommandResult { success: true, .. }
        ));
    }

    send_raw(
        &mut socket,
        json!({
            "type": "get_page_summary",
            "url": "https://docs.example/page",
            "title": "  API Guide [Draft] (Internal) | Browser Recall  "
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PageSummaryResult {
            success,
            display_title,
            error,
            ..
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(display_title, "API Guide");
        }
        other => panic!("expected popup summary response, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "reportVisit",
            "request": {
                "timestamp": 1_710_040_000_000i64,
                "url": "https://private.example/secret",
                "title": "Private Page"
            }
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
            assert_eq!(response.get("skipped").and_then(Value::as_bool), Some(true));
        }
        other => panic!("expected skipped reportVisit response, got {other:?}"),
    }
    let private_slug = generate_slug_from_url("https://private.example/secret").expect("slug");
    assert!(!page_path(&data_dir, &private_slug).exists());

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "reportVisit",
            "request": {
                "timestamp": 1_710_040_000_100i64,
                "url": "https://private.example/secret",
                "title": "Private Page",
                "bypassBlacklist": true
            }
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));
    wait_for_absent(&page_path(&data_dir, &private_slug)).await;

    send_raw(
        &mut socket,
        json!({
            "type": "replay_remote_entries",
            "deviceId": "peer",
            "entries": [{
                "timestamp": 1_710_040_001_000i64,
                "action": "visit_page",
                "url": "not a url"
            }]
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::RemoteReplayResult {
            success,
            replayed_entries,
            error: Some(error),
        } => {
            assert!(!success);
            assert_eq!(replayed_entries, 0);
            assert!(!error.trim().is_empty());
        }
        other => panic!("expected remote replay error, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_rule_batch",
            "listIds": ["missing-list"],
            "entries": [{
                "url": "https://example.com/no-match",
                "title": "No Match"
            }]
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::RuleBatchResult {
            success,
            results,
            error,
        } => {
            assert!(success);
            assert!(results.is_empty());
            assert!(error.is_none());
        }
        other => panic!("expected empty rule batch result, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "preview_rule",
            "rule": {
                "type": "keyword",
                "config": { "pattern": "Private", "fields": ["url"] }
            },
            "entries": [{
                "url": "https://example.com/private",
                "title": "Private"
            }]
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PreviewRuleResult {
            success,
            results,
            error: Some(error),
        } => {
            assert!(!success);
            assert!(results.is_empty());
            assert!(error.contains("fields") || error.contains("field"));
        }
        other => panic!("expected preview validation error, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_paused_and_invalid_payload_matrix_stays_structured() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    send_raw(
        &mut socket,
        json!({
            "type": "event",
            "entry": {
                "timestamp": 1_710_060_000_000i64,
                "action": "visit_page",
                "url": "https://example.com/invalid-payload",
                "title": 42
            },
            "source": "extension"
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "invalid_message");
            assert_eq!(code, "invalid_message");
        }
        other => panic!("expected invalid event payload error, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "event",
            "entry": {
                "timestamp": 1_710_060_000_100i64,
                "action": "visit_page",
                "url": "not a url",
                "title": "Invalid URL"
            },
            "source": "extension"
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "paused");
            assert_eq!(code, "replay_error");
        }
        other => panic!("expected paused replay error, got {other:?}"),
    }

    for message in [
        json!({ "type": "clear_all_data" }),
        json!({ "type": "replay_remote_entries", "deviceId": "peer", "entries": [] }),
        json!({ "type": "set_device_id", "deviceId": "paused-device" }),
        json!({ "type": "permanent_delete", "keys": ["note:paused"] }),
        json!({ "type": "run_command", "action": "createList", "request": { "name": "Paused" } }),
        json!({
            "type": "event",
            "entry": {
                "timestamp": 1_710_060_000_200i64,
                "action": "visit_page",
                "url": "https://example.com/paused"
            },
            "source": "extension"
        }),
        json!({ "type": "run_rule_batch", "listIds": [], "entries": [] }),
        json!({
            "type": "snapshot",
            "slug": "paused",
            "ts": 1_710_060_000_300i64,
            "url": "https://example.com/paused",
            "html": "<html></html>",
            "source": "extension"
        }),
        json!({
            "type": "note",
            "slug": "paused-note",
            "note": "paused",
            "url": "https://example.com/paused",
            "ts": 1_710_060_000_400i64,
            "source": "extension"
        }),
    ] {
        send_raw(&mut socket, message).await;
        match next_daemon(&mut socket).await {
            DaemonMessage::Error { error, code, .. } => {
                assert_eq!(error, "paused");
                assert_eq!(code, "replay_error");
            }
            other => panic!("expected paused error, got {other:?}"),
        }
    }

    handle.resume().await;

    send_connector(
        &mut socket,
        ConnectorMessage::Snapshot {
            slug: "bad-snapshot-url".to_string(),
            ts: 1_710_060_000_500i64,
            url: "not a url".to_string(),
            title: Some("Bad Snapshot".to_string()),
            markdown: None,
            html: "<html><body>bad</body></html>".to_string(),
            source: "extension".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "paused");
            assert_eq!(code, "fs_error");
        }
        other => panic!("expected snapshot fs pause, got {other:?}"),
    }

    handle.resume().await;

    send_connector(
        &mut socket,
        ConnectorMessage::Note {
            slug: "bad-note-url".to_string(),
            excerpt: None,
            note: "bad".to_string(),
            css_path: None,
            old_slug: None,
            url: "not a url".to_string(),
            title: Some("Bad Note".to_string()),
            ts: 1_710_060_000_600i64,
            source: "extension".to_string(),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "paused");
            assert_eq!(code, "fs_error");
        }
        other => panic!("expected note fs pause, got {other:?}"),
    }

    handle.resume().await;
    send_connector(&mut socket, ConnectorMessage::GetStatus).await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::Status { .. }
    ));

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_read_error_and_secondary_command_matrix_is_structured() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "ensureDefaultLists",
            "request": {}
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
            "action": "ensureDefaultLists",
            "request": {}
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
                response.get("created").and_then(Value::as_bool),
                Some(false)
            );
        }
        other => panic!("expected ensureDefaultLists no-op, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "renamePage",
            "request": {
                "url": "https://example.com/secondary",
                "userTitle": "Secondary Title"
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
            "action": "createNote",
            "request": {
                "url": "https://example.com/secondary",
                "title": "Secondary",
                "excerpt": ["secondary excerpt"],
                "note": "secondary note"
            }
        }),
    )
    .await;
    let note_slug = match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response: Some(response),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            response
                .get("noteSlug")
                .and_then(Value::as_str)
                .expect("note slug")
                .to_string()
        }
        other => panic!("expected note creation, got {other:?}"),
    };

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "updateNote",
            "request": {
                "noteSlug": note_slug,
                "note": "secondary note unchanged"
            }
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
            assert!(response.get("noteSlug").and_then(Value::as_str).is_some());
        }
        other => panic!("expected in-place note update, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "clearAllData",
            "request": {}
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
            assert!(
                response
                    .get("deletedCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > 0
            );
        }
        other => panic!("expected command clearAllData, got {other:?}"),
    }

    send_connector(
        &mut socket,
        ConnectorMessage::GetPageSummary {
            url: "not a url".to_string(),
            title: None,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PageSummaryResult {
            success,
            page,
            notes,
            snapshots,
            lists,
            attention,
            error: Some(error),
            ..
        } => {
            assert!(!success);
            assert!(page.is_none());
            assert!(notes.is_empty());
            assert!(snapshots.is_empty());
            assert!(lists.is_empty());
            assert!(attention.is_none());
            assert!(!error.trim().is_empty());
        }
        other => panic!("expected invalid page summary, got {other:?}"),
    }

    tokio::fs::remove_dir_all(data_dir.join("objects").join("notes"))
        .await
        .expect("remove notes");
    tokio::fs::write(data_dir.join("objects").join("notes"), "not a directory")
        .await
        .expect("write notes file");
    send_connector(
        &mut socket,
        ConnectorMessage::SearchNotes {
            query: "secondary".to_string(),
            limit: Some(10),
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::SearchNotesResult {
            success,
            results,
            error: Some(error),
        } => {
            assert!(!success);
            assert!(results.is_empty());
            assert!(!error.trim().is_empty());
        }
        other => panic!("expected note search error, got {other:?}"),
    }

    tokio::fs::remove_dir_all(data_dir.join("objects").join("snapshots"))
        .await
        .expect("remove snapshots");
    tokio::fs::write(
        data_dir.join("objects").join("snapshots"),
        "not a directory",
    )
    .await
    .expect("write snapshots file");
    send_connector(
        &mut socket,
        ConnectorMessage::SearchSnapshots {
            query: "secondary".to_string(),
            limit: Some(10),
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::SearchSnapshotsResult {
            success,
            results,
            error: Some(error),
        } => {
            assert!(!success);
            assert!(results.is_empty());
            assert!(!error.trim().is_empty());
        }
        other => panic!("expected snapshot search error, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_get_entity_covers_manifest_and_child_entities() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_control_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "saveSettingsKey",
            "request": {
                "key": "localeOverride",
                "value": "en"
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
            "action": "ensureDefaultLists",
            "request": {}
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));

    let settings = get_entity(&mut socket, "manifest:settings")
        .await
        .expect("settings entity");
    assert_eq!(
        settings.get("localeOverride").and_then(Value::as_str),
        Some("en")
    );

    let name_to_id = get_entity(&mut socket, "manifest:name-to-id")
        .await
        .expect("name map entity");
    assert_eq!(
        name_to_id
            .get("paths")
            .and_then(|paths| paths.get("system/Hubs"))
            .and_then(Value::as_str),
        Some("hubs")
    );

    let list_order = get_entity(&mut socket, "manifest:list-order")
        .await
        .expect("list order entity");
    let hubs_in_tree = list_order
        .get("tree")
        .and_then(Value::as_array)
        .expect("list tree")
        .iter()
        .any(|node| node.get("id").and_then(Value::as_str) == Some("list:hubs"));
    assert!(hubs_in_tree);

    let hubs_list = get_entity(&mut socket, "list:hubs")
        .await
        .expect("hubs list entity");
    assert_eq!(hubs_list.get("name").and_then(Value::as_str), Some("Hubs"));
    assert!(hubs_list
        .get("rules")
        .and_then(Value::as_array)
        .is_some_and(|rules| !rules.is_empty()));

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "createNote",
            "request": {
                "url": "https://example.com/entity-note",
                "title": "Entity Note",
                "excerpt": ["entity excerpt"],
                "note": "entity note"
            }
        }),
    )
    .await;
    let note_slug = match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response: Some(response),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            response
                .get("noteSlug")
                .and_then(Value::as_str)
                .expect("note slug")
                .to_string()
        }
        other => panic!("expected note creation, got {other:?}"),
    };

    let note = get_entity(&mut socket, &format!("note:{note_slug}"))
        .await
        .expect("note entity");
    assert_eq!(
        note.get("note").and_then(Value::as_str),
        Some("entity note")
    );

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "deleteNote",
            "request": { "noteSlug": note_slug }
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));

    let orphaned = get_entity(&mut socket, "manifest:orphaned")
        .await
        .expect("orphaned entity");
    let orphaned_note_key = format!("note:{note_slug}");
    let note_is_orphaned = orphaned
        .get("entries")
        .and_then(Value::as_array)
        .expect("orphaned entries")
        .iter()
        .any(|entry| entry.get("key").and_then(Value::as_str) == Some(orphaned_note_key.as_str()));
    assert!(note_is_orphaned);

    assert!(get_entity(&mut socket, "list:missing-list").await.is_none());

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
async fn search_messages_return_note_and_snapshot_hits() {
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
            assert_eq!(results[0].score, 1.0);
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
            assert_eq!(results[0].timestamp, 1_710_000_000_200i64);
            assert_eq!(results[0].score, 1.0);
        }
        other => panic!("expected snapshots search result, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn popup_summary_returns_page_info_and_compact_lists() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_control_server_options(config_store.clone()))
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
            excerpt: Some(serde_json::json!(["hello"])),
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

    send_raw(
        &mut socket,
        json!({
            "type": "get_page_summary",
            "url": "https://example.com/popup"
        }),
    )
    .await;
    let popup_lists = next_daemon(&mut socket).await;
    match popup_lists {
        DaemonMessage::PageSummaryResult {
            success,
            lists,
            error,
            ..
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(lists.len(), 1);
            assert_eq!(lists[0].slug, "reading");
            assert_eq!(lists[0].name, "Reading");
            assert!(lists[0].contains_page);
            assert!(lists[0].last_activity > 0);
        }
        other => panic!("expected popup page summary, got {other:?}"),
    }

    send_raw(&mut socket, json!({ "type": "get_settings" })).await;
    match next_daemon(&mut socket).await {
        DaemonMessage::SettingsResult {
            success,
            settings,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert!(settings.is_none());
        }
        other => panic!("expected settings result, got {other:?}"),
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
    let url =
        "https://www.douban.com/people/49804423/status/8969603475/?_spm_id=x&dt_dapp=1&_i=a,b";
    send_connector(
        &mut socket,
        ConnectorMessage::ReplayRemoteEntries {
            device_id: "peer-sync".to_string(),
            entries: vec![
                json!({
                    "timestamp": 1_710_000_020_000i64,
                    "action": "visit_page",
                    "url": url,
                    "title": "Remote Page",
                }),
                json!({
                    "timestamp": 1_710_000_020_100i64,
                    "action": "create_note",
                    "url": url,
                    "path": "objects/notes/remote-note.json",
                    "excerpt": ["remote excerpt"],
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

    let slug = generate_slug_from_url(url).expect("slug");
    let page_path = page_path(&data_dir, &slug);
    let page_raw = wait_for_text(&page_path, |raw| raw.contains("\"note:remote-note\"")).await;
    assert!(page_raw.contains("\"title\": \"Remote Page\""));
    assert!(page_raw.contains("\"note:remote-note\""));
    assert!(page_raw.contains(url));

    let remote_note_path = note_path(&data_dir, "remote-note");
    let note_raw = wait_for_text(&remote_note_path, |raw| raw.contains("remote note body")).await;
    assert!(note_raw.contains("\"remote note body\""));
    assert!(note_raw.contains(url));

    let logs = read_log_files(&log_dir(&data_dir, &device_id)).await;
    assert!(logs.is_empty());
    let peer_logs = read_log_files(&log_dir(&data_dir, "peer-sync")).await;
    let peer_entries = log_entries(&peer_logs);
    assert_eq!(peer_entries.len(), 2);
    for entry in peer_entries {
        assert_eq!(entry.get("url").and_then(Value::as_str), Some(url));
    }

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
async fn desktop_and_websocket_adapters_share_command_validation() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let (mut socket, _, _) = paired_socket(handle.port(), &config_store).await;

    let desktop_error = handle
        .control_handle()
        .run_command("renamePage", json!({ "userTitle": "Missing URL" }))
        .await
        .expect_err("desktop validation failure")
        .to_string();

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "renamePage",
            "request": { "userTitle": "Missing URL" }
        }),
    )
    .await;
    let websocket_error = match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success: false,
            error: Some(error),
            ..
        } => error,
        other => panic!("expected websocket validation failure, got {other:?}"),
    };

    assert_eq!(desktop_error, "renamePage missing url");
    assert_eq!(websocket_error, desktop_error);

    handle.shutdown().await;
}

#[tokio::test]
async fn websocket_command_matrix_covers_desktop_reads_and_mutations() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;

    send_connector(&mut socket, ConnectorMessage::Ping).await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::Pong
    ));

    send_connector(&mut socket, ConnectorMessage::GetDirectoryInfo).await;
    match next_daemon(&mut socket).await {
        DaemonMessage::DirectoryInfoResult {
            success,
            info: Some(info),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert!(info.has_permission);
        }
        other => panic!("expected directory info, got {other:?}"),
    }

    send_connector(&mut socket, ConnectorMessage::GetDirectorySize).await;
    match next_daemon(&mut socket).await {
        DaemonMessage::DirectorySizeResult { success, error, .. } => {
            assert!(success);
            assert!(error.is_none());
        }
        other => panic!("expected directory size, got {other:?}"),
    }

    send_connector(&mut socket, ConnectorMessage::TestResetData).await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "test_control_disabled");
            assert_eq!(code, "test_control_disabled");
        }
        other => panic!("expected disabled test control error, got {other:?}"),
    }

    send_connector(
        &mut socket,
        ConnectorMessage::RunCommand {
            action: "unsupportedCommand".to_string(),
            request: json!({}),
            buffer_depth: None,
            buffer_bytes: None,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response,
            error: Some(error),
        } => {
            assert!(!success);
            assert!(response.is_none());
            assert!(error.contains("unsupported connector command"));
        }
        other => panic!("expected unsupported command result, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "saveSettingsKey",
            "request": { "key": "theme", "value": "dark" },
            "bufferDepth": 7,
            "bufferBytes": 2048
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));

    send_connector(&mut socket, ConnectorMessage::GetStatus).await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Status {
            buffer_depth,
            buffer_bytes,
            ..
        } => {
            assert_eq!(buffer_depth, 7);
            assert_eq!(buffer_bytes, 2048);
        }
        other => panic!("expected status, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "get_page_summary",
            "url": "https://example.com/matrix",
            "title": "  Matrix   Page  "
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PageSummaryResult {
            success,
            display_title,
            error,
            ..
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(display_title, "Matrix Page");
        }
        other => panic!("expected popup summary result, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "reportVisit",
            "request": {
                "timestamp": 1_710_030_000_000i64,
                "url": "https://example.com/matrix",
                "title": "Matrix Page",
                "referrerUrl": "https://example.com/ref",
                "bodyPreview": "matrix body"
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
            "action": "reportLeave",
            "request": {
                "timestamp": 1_710_030_005_000i64,
                "url": "https://example.com/matrix",
                "title": "Matrix Page Updated",
                "scrollDepth": 80,
                "timeOnPage": 5000
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
            "action": "ratePage",
            "request": {
                "url": "https://example.com/matrix",
                "title": "Matrix Page Updated",
                "likes": 1
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
            "action": "saveListMeta",
            "request": { "name": "Matrix List" }
        }),
    )
    .await;
    let list_id = match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response: Some(response),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            response
                .get("listId")
                .and_then(Value::as_str)
                .expect("list id")
                .to_string()
        }
        other => panic!("expected saveListMeta result, got {other:?}"),
    };

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "addRule",
            "request": {
                "listId": list_id,
                "rule": {
                    "type": "keyword",
                    "config": { "pattern": "Matrix" }
                }
            }
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));
    let list = handle
        .storage()
        .load_list(&list_id)
        .await
        .expect("load list")
        .expect("list exists");
    let rule_id = list.rules.first().expect("rule exists").id.clone();

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "updateRule",
            "request": {
                "listId": list_id,
                "ruleId": rule_id,
                "config": { "pattern": "Updated" }
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
            "action": "removeRule",
            "request": {
                "listId": list_id,
                "ruleId": rule_id
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
            "action": "addListPins",
            "request": {
                "listId": list_id,
                "urls": [
                    "https://example.com/matrix",
                    "https://example.com/matrix-extra"
                ],
                "titles": [null, "Matrix Extra"]
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
            "action": "updateListTree",
            "request": {
                "tree": [{ "slug": list_id, "children": [] }]
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
            "action": "createNote",
            "request": {
                "url": "https://example.com/matrix",
                "title": "Matrix Page",
                "excerpt": ["matrix excerpt"],
                "note": "matrix note"
            }
        }),
    )
    .await;
    let note_slug = match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response: Some(response),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            response
                .get("noteSlug")
                .and_then(Value::as_str)
                .expect("note slug")
                .to_string()
        }
        other => panic!("expected createNote result, got {other:?}"),
    };

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "updateNote",
            "request": {
                "noteSlug": note_slug,
                "note": "matrix note updated"
            }
        }),
    )
    .await;
    let updated_note_slug = match next_daemon(&mut socket).await {
        DaemonMessage::CommandResult {
            success,
            response: Some(response),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            response
                .get("noteSlug")
                .and_then(Value::as_str)
                .expect("updated note slug")
                .to_string()
        }
        other => panic!("expected updateNote result, got {other:?}"),
    };

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "deleteNote",
            "request": { "noteSlug": updated_note_slug }
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
            "action": "restoreNote",
            "request": { "noteSlug": updated_note_slug }
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));

    let page_slug = generate_slug_from_url("https://example.com/matrix").expect("page slug");
    send_snapshot_and_ack(
        &mut socket,
        &page_slug,
        "https://example.com/matrix",
        1_710_030_010_000,
    )
    .await;

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "deleteSnapshot",
            "request": {
                "slug": page_slug,
                "timestamp": 1_710_030_010_000i64
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
            "action": "restoreSnapshot",
            "request": { "snapSlug": format!("{page_slug}-1710030010000") }
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
            "action": "deleteList",
            "request": { "listId": list_id }
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
            "action": "restoreList",
            "request": { "listId": list_id }
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
            "action": "importHistory",
            "request": {
                "entries": [{
                    "url": "https://example.com/imported-history",
                    "title": "Imported History",
                    "visitTimes": [1_710_030_020_000i64]
                }]
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
            "action": "importBookmarks",
            "request": {
                "tree": [{
                    "title": "Imported Folder",
                    "bookmarks": [{
                        "url": "https://example.com/imported-bookmark",
                        "title": "Imported Bookmark"
                    }]
                }]
            }
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));

    send_connector(
        &mut socket,
        ConnectorMessage::ListHistoryFiles {
            include_sizes: true,
        },
    )
    .await;
    let files = match next_daemon(&mut socket).await {
        DaemonMessage::HistoryFilesResult {
            success,
            files,
            devices,
            sizes: Some(sizes),
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert!(devices.contains(&device_id));
            assert!(!sizes.is_empty());
            files
        }
        other => panic!("expected history files, got {other:?}"),
    };
    assert!(!files.is_empty());

    send_connector(
        &mut socket,
        ConnectorMessage::LoadHistoryBatch {
            files: files.clone(),
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::HistoryBatchResult {
            success,
            entries,
            error,
        } => {
            assert!(success);
            assert!(error.is_none());
            assert!(entries
                .iter()
                .any(|entry| entry.get("url").and_then(Value::as_str)
                    == Some("https://example.com/matrix")));
        }
        other => panic!("expected history batch, got {other:?}"),
    }

    send_connector(
        &mut socket,
        ConnectorMessage::GetPageSummary {
            url: "https://example.com/matrix".to_string(),
            title: None,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PageSummaryResult {
            success,
            page: Some(page),
            attention: Some(attention),
            error,
            ..
        } => {
            assert!(success);
            assert!(error.is_none());
            assert_eq!(page.url.as_deref(), Some("https://example.com/matrix"));
            assert_eq!(attention.total_seconds, 5);
        }
        other => panic!("expected page summary, got {other:?}"),
    }

    send_connector(
        &mut socket,
        ConnectorMessage::GetSnapshotHtml {
            slug: "missing".to_string(),
            ts: 1,
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::SnapshotHtmlResult {
            success,
            html,
            error: Some(error),
        } => {
            assert!(!success);
            assert!(html.is_none());
            assert_eq!(error, "Not found");
        }
        other => panic!("expected missing snapshot html, got {other:?}"),
    }

    send_connector(
        &mut socket,
        ConnectorMessage::PermanentDelete {
            keys: vec!["manifest:orphaned".to_string()],
        },
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PermanentDeleteResult {
            success,
            deleted_keys,
            error,
        } => {
            assert!(success);
            assert!(deleted_keys.is_empty());
            assert!(error.is_none());
        }
        other => panic!("expected no-op permanent delete, got {other:?}"),
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_command",
            "action": "permanentDeleteAll",
            "request": {}
        }),
    )
    .await;
    assert!(matches!(
        next_daemon(&mut socket).await,
        DaemonMessage::CommandResult { success: true, .. }
    ));

    send_connector(&mut socket, ConnectorMessage::GetStatus).await;
    match next_daemon(&mut socket).await {
        DaemonMessage::Status {
            buffer_depth,
            buffer_bytes,
            ..
        } => {
            assert_eq!(buffer_depth, 0);
            assert_eq!(buffer_bytes, 0);
        }
        other => panic!("expected status, got {other:?}"),
    }

    assert!(data_dir.exists());
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
async fn page_summary_classifies_popup_blacklist_with_desktop_policy() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _, _) = paired_socket(handle.port(), &config_store).await;
    send_raw(
        &mut socket,
        json!({
            "type": "get_page_summary",
            "url": "chrome://settings",
            "title": "Settings"
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PageSummaryResult {
            success,
            access,
            error,
            ..
        } => {
            assert!(success);
            assert!(error.is_none());
            assert!(access.blacklisted);
            assert!(!access.has_visit_history);
        }
        other => panic!("expected popup summary result, got {other:?}"),
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
            "type": "get_page_summary",
            "url": "chrome://settings",
            "title": "Settings"
        }),
    )
    .await;
    match next_daemon(&mut socket).await {
        DaemonMessage::PageSummaryResult {
            success,
            access,
            error,
            ..
        } => {
            assert!(success);
            assert!(error.is_none());
            assert!(!access.blacklisted);
            assert!(access.has_visit_history);
        }
        other => panic!("expected popup summary result, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn popup_summary_lists_use_shared_storage_cache_after_desktop_side_write() {
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

    send_raw(
        &mut socket,
        json!({
            "type": "get_page_summary",
            "url": "https://example.com/popup-list-cache"
        }),
    )
    .await;
    let warmed = next_daemon(&mut socket).await;
    match warmed {
        DaemonMessage::PageSummaryResult { lists, .. } => {
            assert_eq!(
                lists
                    .iter()
                    .map(|list| list.name.as_str())
                    .collect::<Vec<_>>(),
                vec!["Existing"]
            );
        }
        other => panic!("expected popup page summary, got {other:?}"),
    }

    handle
        .control_handle()
        .run_command("saveListMeta", json!({ "name": "Desktop Added" }))
        .await
        .expect("desktop-side list create through daemon write authority");

    send_raw(
        &mut socket,
        json!({
            "type": "get_page_summary",
            "url": "https://example.com/popup-list-cache"
        }),
    )
    .await;
    let refreshed = next_daemon(&mut socket).await;
    match refreshed {
        DaemonMessage::PageSummaryResult { lists, .. } => {
            let names = lists
                .iter()
                .map(|list| list.name.as_str())
                .collect::<Vec<_>>();
            assert_eq!(names, vec!["Desktop Added", "Existing"]);
        }
        other => panic!("expected popup page summary, got {other:?}"),
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
    assert!(note_raw.contains("\"excerpt\": ["));
    assert!(note_raw.contains("\"Hello\""));
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

    let matching_url = "https://github.com/example/repo?_spm_id=x&utm_source=keep&_i=a,b";
    socket
        .send(Message::Text(
            json!({
                "type": "run_rule_batch",
                "listIds": ["reading"],
                "entries": [
                    {
                        "url": matching_url,
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
            assert_eq!(results[0].url, matching_url);
            assert_eq!(results[0].matches[0].rule_id, "rule-k-reading");
        }
        other => panic!("expected batch result, got {other:?}"),
    }

    let list_path = list_path(&data_dir, "reading");
    let list_raw = wait_for_text(&list_path, |raw| raw.contains("\"source\": \"auto\"")).await;
    assert!(list_raw.contains("\"source\": \"auto\""));
    let page_slug = generate_slug_from_url(matching_url).expect("page slug");
    let page_raw = wait_for_text(&page_path(&data_dir, &page_slug), |raw| {
        raw.contains(matching_url)
    })
    .await;
    assert!(page_raw.contains(matching_url));

    let log_dir = log_dir(&data_dir, &device_id);
    let logs = read_log_files(&log_dir).await;
    assert!(
        logs.iter()
            .any(|log| log.contains("\"action\":\"pin_to_list\"")),
        "expected pin_to_list in at least one log file"
    );
    let entries = log_entries(&logs);
    let pin = entries
        .iter()
        .find(|entry| entry.get("action").and_then(Value::as_str) == Some("pin_to_list"))
        .expect("pin_to_list log");
    assert_eq!(
        pin.get("urls")
            .and_then(Value::as_array)
            .and_then(|urls| urls.first())
            .and_then(Value::as_str),
        Some(matching_url)
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn run_rule_batch_invalid_matching_url_returns_structured_error() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, _data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    for entry in [
        json!({
            "timestamp": 1_710_000_006_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Broken Rule Batch",
            "listId": "broken-rule-batch"
        }),
        json!({
            "timestamp": 1_710_000_006_100i64,
            "action": "add_rule",
            "listOwner": "test-device",
            "name": "Broken Rule Batch",
            "rule": {
                "id": "rule-k-invalid",
                "type": "keyword",
                "config": { "pattern": "Match" }
            }
        }),
    ] {
        send_event_and_ack(&mut socket, entry).await;
    }

    send_raw(
        &mut socket,
        json!({
            "type": "run_rule_batch",
            "listIds": ["broken-rule-batch"],
            "entries": [{
                "url": "not a url",
                "title": "Match"
            }]
        }),
    )
    .await;

    match next_daemon(&mut socket).await {
        DaemonMessage::RuleBatchResult {
            success,
            results,
            error: Some(error),
        } => {
            assert!(!success);
            assert!(results.is_empty());
            assert!(!error.trim().is_empty());
        }
        other => panic!("expected invalid rule batch error, got {other:?}"),
    }

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
