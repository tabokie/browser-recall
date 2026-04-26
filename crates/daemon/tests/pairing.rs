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
        } => token,
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

    let auth_message = serde_json::to_string(&ConnectorMessage::Auth { token }).expect("auth");
    socket
        .send(Message::Text(auth_message))
        .await
        .expect("send auth");
    let response = next_text_message(&mut socket).await;
    let response: DaemonMessage = serde_json::from_str(&response).expect("auth json");
    assert!(matches!(response, DaemonMessage::AuthOk));

    handle.shutdown().await;
}
