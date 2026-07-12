use browser_recall_daemon::pairing::{static_approver, PairingDecision};
use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage};
use browser_recall_daemon::ws_server::ServerStartOptions;
use browser_recall_daemon::ConfigStore;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

pub(crate) type TestSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(crate) async fn next_text_message(socket: &mut TestSocket) -> String {
    while let Some(message) = socket.next().await {
        match message.expect("message") {
            Message::Text(text) => return text,
            _ => continue,
        }
    }
    panic!("socket closed before a text message arrived");
}

#[allow(dead_code)]
pub(crate) async fn pair_once(port: u16) -> String {
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
            serde_json::to_string(&ConnectorMessage::PairRequest {
                protocol_version: Some(2),
                browser_id: "browser-install-1".into(),
                browser_name: "Chrome".into(),
                extension_id: "abcdefghijklmnop".into(),
                browser_profile: Some("Default profile".into()),
            })
            .expect("serialize pair request"),
        ))
        .await
        .expect("send pair request");
    let _ = next_text_message(&mut socket).await;
    let approved = next_text_message(&mut socket).await;
    let approved: DaemonMessage = serde_json::from_str(&approved).expect("approved json");
    match approved {
        DaemonMessage::PairApproved { token, .. } => token,
        other => panic!("expected pair approved, got {other:?}"),
    }
}

#[allow(dead_code)]
pub(crate) async fn paired_socket(
    port: u16,
    config_store: &ConfigStore,
) -> (TestSocket, std::path::PathBuf, String) {
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
            serde_json::to_string(&ConnectorMessage::PairRequest {
                protocol_version: Some(2),
                browser_id: "browser-install-1".into(),
                browser_name: "Chrome".into(),
                extension_id: "abcdefghijklmnop".into(),
                browser_profile: Some("Default profile".into()),
            })
            .expect("serialize pair request"),
        ))
        .await
        .expect("send pair request");

    let _ = next_text_message(&mut socket).await;
    let approved = next_text_message(&mut socket).await;
    let approved: DaemonMessage = serde_json::from_str(&approved).expect("approved json");
    let returned_device_id = match approved {
        DaemonMessage::PairApproved { device_id, .. } => device_id,
        other => panic!("expected pair approved, got {other:?}"),
    };
    let config = config_store.load_or_create().expect("config");
    (socket, config.data_dir, returned_device_id)
}

pub(crate) fn test_server_options(config_store: ConfigStore) -> ServerStartOptions {
    let mut options = ServerStartOptions::phase1_defaults(
        config_store,
        static_approver(PairingDecision::Approve),
    );
    options.port_candidates = vec![0];
    options
}
