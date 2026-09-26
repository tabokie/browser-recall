mod support;

use browser_recall_daemon::protocol::{
    ConnectorMessage, DaemonMessage, CONNECTOR_PROTOCOL_VERSION,
};
use browser_recall_daemon::ws_server::start_server;
use browser_recall_daemon::ConfigStore;
use futures_util::SinkExt;
use tempfile::tempdir;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{next_text_message, pair_once, test_server_options};

#[tokio::test]
async fn fresh_pairing_persists_token() {
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

    let pair_request = serde_json::to_string(&ConnectorMessage::PairRequest {
        protocol_version: Some(CONNECTOR_PROTOCOL_VERSION),
        browser_id: "browser-install-1".into(),
        browser_name: "Chrome".into(),
        extension_id: "abcdefghijklmnop".into(),
        browser_profile: Some("Default profile".into()),
    })
    .expect("serialize pair request");
    socket
        .send(Message::Text(pair_request))
        .await
        .expect("send pair request");

    let pending = next_text_message(&mut socket).await;
    let approved = next_text_message(&mut socket).await;

    let pending: DaemonMessage = serde_json::from_str(&pending).expect("pending json");
    let approved: DaemonMessage = serde_json::from_str(&approved).expect("approved json");
    assert!(matches!(pending, DaemonMessage::PairPending));
    let token = match approved {
        DaemonMessage::PairApproved {
            token,
            protocol_version,
        } => {
            assert_eq!(protocol_version, CONNECTOR_PROTOCOL_VERSION);
            token
        }
        other => panic!("expected pair approved, got {other:?}"),
    };
    assert!(!token.is_empty());

    let saved = config_store.load_or_create().expect("config reload");
    assert_eq!(saved.connectors.len(), 1);
    assert_eq!(saved.connectors[0].browser_name, "Chrome");
    assert_eq!(saved.connectors[0].extension_id, "abcdefghijklmnop");
    assert_eq!(
        saved.connectors[0].browser_profile.as_deref(),
        Some("Default profile")
    );
    assert!(saved.connectors[0].last_seen_at.is_some());

    handle.shutdown().await;
}

#[tokio::test]
async fn pairing_rejects_a_client_without_a_protocol_version() {
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

    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "pair_request",
                "browserId": "missing-version-browser-install",
                "browserName": "Chrome",
                "extensionId": "abcdefghijklmnop",
                "browserProfile": "Default profile"
            })
            .to_string(),
        ))
        .await
        .expect("send pair request without a protocol version");

    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("error json");
    assert!(matches!(
        response,
        DaemonMessage::Error { ref code, .. } if code == "incompatible_protocol"
    ));
    assert!(config_store
        .load_or_create()
        .expect("config reload")
        .connectors
        .is_empty());

    handle.shutdown().await;
}

#[tokio::test]
async fn firefox_extension_origin_can_pair() {
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
        "moz-extension://12345678-1234-1234-1234-123456789abc"
            .parse()
            .unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.expect("ws connect");

    let pair_request = serde_json::to_string(&ConnectorMessage::PairRequest {
        protocol_version: Some(CONNECTOR_PROTOCOL_VERSION),
        browser_id: "firefox-install-1".into(),
        browser_name: "Firefox".into(),
        extension_id: "12345678-1234-1234-1234-123456789abc".into(),
        browser_profile: Some("Default profile".into()),
    })
    .expect("serialize pair request");
    socket
        .send(Message::Text(pair_request))
        .await
        .expect("send pair request");

    let pending = next_text_message(&mut socket).await;
    let approved = next_text_message(&mut socket).await;

    let pending: DaemonMessage = serde_json::from_str(&pending).expect("pending json");
    let approved: DaemonMessage = serde_json::from_str(&approved).expect("approved json");
    assert!(matches!(pending, DaemonMessage::PairPending));
    assert!(matches!(approved, DaemonMessage::PairApproved { .. }));

    let saved = config_store.load_or_create().expect("config reload");
    assert_eq!(saved.connectors.len(), 1);
    assert_eq!(saved.connectors[0].browser_name, "Firefox");
    assert_eq!(
        saved.connectors[0].extension_id,
        "12345678-1234-1234-1234-123456789abc"
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn browser_activity_refreshes_last_seen_without_reconnecting() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let mut socket = connect_pair_socket(handle.port(), "Firefox").await;
    let paired_at = config_store.load_or_create().unwrap().connectors[0]
        .last_seen_at
        .expect("pairing timestamp");
    let snapshots = handle.subscribe();

    // Config timestamps have second precision. Cross that boundary before
    // sending activity on the same socket, without depending on scheduling.
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            <= paired_at
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("clock advances past pairing");
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::GetStatus).unwrap(),
        ))
        .await
        .expect("send activity on the existing connection");
    let response: DaemonMessage =
        serde_json::from_str(&next_text_message(&mut socket).await).unwrap();
    assert!(matches!(response, DaemonMessage::Status { .. }));
    let browsers = browser_recall_daemon::commands::list_paired_browsers(&config_store)
        .expect("read desktop browser records");
    assert!(browsers[0].last_seen.unwrap() > (paired_at * 1000) as i64);
    assert!(snapshots.has_changed().expect("snapshot channel is open"));
    assert_eq!(handle.snapshot().await.connected_connectors.len(), 1);
    socket.close(None).await.expect("close browser");
    handle.shutdown().await;
}

#[tokio::test]
async fn orion_browser_identity_is_accepted() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let mut socket = connect_pair_socket(handle.port(), "Orion").await;
    let browsers = browser_recall_daemon::commands::list_paired_browsers(&config_store)
        .expect("read desktop browser records");
    assert_eq!(browsers[0].browser_name, "Orion");
    assert_eq!(
        handle.snapshot().await.connected_connectors[0].browser_name,
        "Orion"
    );
    socket.close(None).await.expect("close Orion");
    handle.shutdown().await;
}

#[tokio::test]
async fn abrupt_browser_disconnect_clears_connected_state() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let socket = connect_pair_socket(handle.port(), "Firefox").await;
    assert_eq!(handle.snapshot().await.connected_connectors.len(), 1);
    // A browser crash closes TCP without sending the WebSocket close frame.
    // Tungstenite reports this as an error rather than a normal disconnect.
    drop(socket);
    let mut snapshots = handle.subscribe();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        snapshots.wait_for(|snapshot| snapshot.connected_connectors.is_empty()),
    )
    .await
    .expect("abrupt disconnect must not leave a browser marked connected")
    .expect("snapshot channel remains open");

    assert_eq!(config_store.load_or_create().unwrap().connectors.len(), 1);
    let mut reconnected = connect_pair_socket(handle.port(), "Firefox").await;
    assert_eq!(handle.snapshot().await.connected_connectors.len(), 1);
    reconnected
        .close(None)
        .await
        .expect("close reconnected browser");
    handle.shutdown().await;
}

#[tokio::test]
async fn fresh_pair_replaces_same_connector_active_socket() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let mut first = connect_pair_socket(handle.port(), "Firefox").await;
    let mut second = connect_pair_socket(handle.port(), "Firefox").await;

    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.connected_connectors.len(), 1);
    assert_eq!(snapshot.connected_connectors[0].browser_name, "Firefox");

    second.close(None).await.expect("close second socket");
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if handle.snapshot().await.connected_connectors.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("replacement socket disconnect clears connected state");

    first.close(None).await.expect("close first socket");
    handle.shutdown().await;
}

async fn connect_pair_socket(port: u16, browser_name: &str) -> support::TestSocket {
    let mut request = format!("ws://127.0.0.1:{port}/")
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Origin",
        "moz-extension://12345678-1234-1234-1234-123456789abc"
            .parse()
            .unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.expect("ws connect");
    let pair_request = serde_json::to_string(&ConnectorMessage::PairRequest {
        protocol_version: Some(CONNECTOR_PROTOCOL_VERSION),
        browser_id: "firefox-install-1".into(),
        browser_name: browser_name.into(),
        extension_id: "12345678-1234-1234-1234-123456789abc".into(),
        browser_profile: Some("Default profile".into()),
    })
    .expect("serialize pair request");
    socket
        .send(Message::Text(pair_request))
        .await
        .expect("send pair request");
    let pending = next_text_message(&mut socket).await;
    let pending: DaemonMessage = serde_json::from_str(&pending).expect("pending json");
    assert!(matches!(pending, DaemonMessage::PairPending), "{pending:?}");
    let approved = next_text_message(&mut socket).await;
    let approved: DaemonMessage = serde_json::from_str(&approved).expect("approved json");
    assert!(matches!(approved, DaemonMessage::PairApproved { .. }));
    socket
}

#[tokio::test]
async fn untrusted_origin_gets_protocol_error_after_websocket_upgrade() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let mut request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    request
        .headers_mut()
        .insert("Origin", "https://example.test".parse().unwrap());
    let (mut socket, _) = connect_async(request).await.expect("ws connect");

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::GetStatus).expect("status request"),
        ))
        .await
        .expect("send status");

    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("error json");
    match response {
        DaemonMessage::Error { error, code, .. } => {
            assert_eq!(error, "unauthorized");
            assert_eq!(code, "auth_required");
        }
        other => panic!("expected auth_required error, got {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn auth_with_cached_token_refreshes_browser_identity() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let token = pair_once(handle.port()).await;
    let mut request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnop".parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.expect("ws connect");

    let before = config_store.load_or_create().unwrap().connectors[0].clone();
    let auth_message = serde_json::json!({
        "type": "auth", "protocolVersion": CONNECTOR_PROTOCOL_VERSION,
        "token": token, "browserName": "Orion"
    })
    .to_string();
    socket
        .send(Message::Text(auth_message))
        .await
        .expect("send auth");
    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("auth json");
    assert!(matches!(
        response,
        DaemonMessage::AuthOk {
            protocol_version: CONNECTOR_PROTOCOL_VERSION
        }
    ));

    let after = config_store.load_or_create().unwrap().connectors[0].clone();
    assert_eq!(after.browser_name, "Orion");
    assert_eq!(after.token, before.token);
    assert_eq!(after.browser_id, before.browser_id);
    assert_eq!(after.approved_at, before.approved_at);
    assert_eq!(
        handle.snapshot().await.connected_connectors[0].browser_name,
        "Orion"
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn auth_rejects_a_mismatched_protocol_version() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");
    let token = pair_once(handle.port()).await;

    let mut request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnop".parse().unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.expect("ws connect");
    socket
        .send(Message::Text(
            serde_json::to_string(&serde_json::json!({
                "type": "auth", "protocolVersion": 3, "token": token
            }))
            .expect("auth json"),
        ))
        .await
        .expect("send auth");

    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("error json");
    assert!(matches!(
        response,
        DaemonMessage::Error { ref code, .. } if code == "incompatible_protocol"
    ));

    handle.shutdown().await;
}

#[tokio::test]
async fn activity_preserves_desktop_config_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(dir.path());
    let server = start_server(test_server_options(store.clone()))
        .await
        .unwrap();
    let (mut socket, _, _) = support::paired_socket(server.port(), &store).await;
    let config = store.load_or_create().unwrap();
    let last_seen = config.connectors[0].last_seen_at.unwrap();
    // Independently constructed stores share the desktop/daemon writer lock.
    ConfigStore::new(dir.path())
        .update(|current| {
            current.log_level = "debug".into();
            current.launch_at_login = !config.launch_at_login;
            current.sync_paused_devices = vec!["another-device".into()];
            Ok(())
        })
        .unwrap();
    while std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        <= last_seen
    {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::GetStatus).unwrap(),
        ))
        .await
        .unwrap();
    let response: DaemonMessage =
        serde_json::from_str(&support::next_text_message(&mut socket).await).unwrap();
    assert!(matches!(response, DaemonMessage::Status { .. }));
    let saved = store.load_or_create().unwrap();
    server.shutdown().await;
    assert_eq!(
        saved.log_level, "debug",
        "browser activity must preserve the desktop's persisted debug setting"
    );
    assert_eq!(saved.launch_at_login, !config.launch_at_login);
    assert_eq!(saved.sync_paused_devices, ["another-device"]);
}
