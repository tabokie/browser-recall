mod support;

use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage};
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
        protocol_version: Some(1),
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
    assert!(matches!(pending, DaemonMessage::PairPending { .. }));
    let token = match approved {
        DaemonMessage::PairApproved {
            token,
            device_id: _,
            protocol_version,
        } => {
            assert_eq!(protocol_version, 1);
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
                "browserId": "legacy-browser-install",
                "browserName": "Chrome",
                "extensionId": "abcdefghijklmnop",
                "browserProfile": "Default profile"
            })
            .to_string(),
        ))
        .await
        .expect("send legacy pair request");

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
        protocol_version: Some(1),
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
    assert!(matches!(pending, DaemonMessage::PairPending { .. }));
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
        protocol_version: Some(1),
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
    let approved = next_text_message(&mut socket).await;
    let pending: DaemonMessage = serde_json::from_str(&pending).expect("pending json");
    let approved: DaemonMessage = serde_json::from_str(&approved).expect("approved json");
    assert!(matches!(pending, DaemonMessage::PairPending { .. }));
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
async fn auth_with_cached_token_succeeds() {
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

    let auth_message = serde_json::to_string(&ConnectorMessage::Auth {
        protocol_version: Some(1),
        token,
    })
    .expect("auth");
    socket
        .send(Message::Text(auth_message))
        .await
        .expect("send auth");
    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("auth json");
    assert!(matches!(
        response,
        DaemonMessage::AuthOk {
            protocol_version: 1
        }
    ));

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
            serde_json::to_string(&ConnectorMessage::Auth {
                protocol_version: Some(2),
                token,
            })
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
