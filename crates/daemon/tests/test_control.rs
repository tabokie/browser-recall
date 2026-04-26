use browser_recall_daemon::pairing::{static_approver, PairingDecision};
use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage, TestSeedFilePayload};
use browser_recall_daemon::ws_server::{start_server, ServerStartOptions};
use browser_recall_daemon::ConfigStore;
use futures_util::{SinkExt, StreamExt};
use tempfile::tempdir;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

async fn next_text_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> String {
    while let Some(message) = socket.next().await {
        match message.expect("message") {
            Message::Text(text) => return text,
            _ => continue,
        }
    }
    panic!("socket closed before a text message arrived");
}

fn test_control_server_options(config_store: ConfigStore) -> ServerStartOptions {
    let mut options = ServerStartOptions::phase1_defaults(
        config_store,
        static_approver(PairingDecision::Approve),
    );
    options.port_candidates = vec![0];
    options.test_control_enabled = true;
    options
}

#[tokio::test]
async fn test_control_can_reset_and_seed_daemon_data() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_control_server_options(config_store.clone()))
        .await
        .expect("start server");

    let mut request = format!("ws://127.0.0.1:{}/", handle.port())
        .into_client_request()
        .expect("request");
    request
        .headers_mut()
        .insert("Origin", "http://127.0.0.1:4173".parse().expect("origin"));
    let (mut socket, _) = connect_async(request).await.expect("ws connect");

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::TestResetData).expect("serialize reset"),
        ))
        .await
        .expect("send reset");
    let reset: DaemonMessage =
        serde_json::from_str(&next_text_message(&mut socket).await).expect("reset json");
    match reset {
        DaemonMessage::TestResetDataResult {
            success, device_id, ..
        } => {
            assert!(success, "expected test reset success");
            let config = config_store.load_or_create().expect("config");
            assert_eq!(device_id, config.device_id);
        }
        other => panic!("expected test reset result, got {other:?}"),
    }

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::TestSeedData {
                files: vec![TestSeedFilePayload {
                    path: "manifest/settings.json".into(),
                    content: "{\n  \"trimRules\": []\n}\n".into(),
                }],
            })
            .expect("serialize seed"),
        ))
        .await
        .expect("send seed");
    let seed: DaemonMessage =
        serde_json::from_str(&next_text_message(&mut socket).await).expect("seed json");
    match seed {
        DaemonMessage::TestSeedDataResult { success, error } => {
            assert!(success, "expected test seed success: {error:?}");
        }
        other => panic!("expected test seed result, got {other:?}"),
    }

    let settings_path = config_store
        .load_or_create()
        .expect("config")
        .data_dir
        .join("manifest")
        .join("settings.json");
    let settings_raw = tokio::fs::read_to_string(settings_path)
        .await
        .expect("settings written");
    assert!(settings_raw.contains("\"trimRules\""));

    handle.shutdown().await;
}
