mod support;

use browser_recall_daemon::protocol::{
    ConnectorMessage, DaemonMessage, TestControlMessage, TestSeedFilePayload,
};
use browser_recall_daemon::ws_server::{start_server, ServerStartOptions};
use browser_recall_daemon::ConfigStore;
use browser_recall_replay::entities::SettingsEntity;
use futures_util::{SinkExt, StreamExt};
use tempfile::tempdir;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::test_server_options;

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
    let mut options = test_server_options(config_store);
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

    let mut settings = browser_recall_daemon::settings::default_values();
    settings.insert("theme".into(), serde_json::json!("dark"));
    let settings_content = serde_json::to_string_pretty(&SettingsEntity {
        timestamps: std::collections::HashMap::new(),
        values: settings,
    })
    .expect("serialize settings seed");

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::TestControl {
                request: TestControlMessage::ResetData,
            })
            .expect("serialize reset"),
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
            serde_json::to_string(&ConnectorMessage::TestControl {
                request: TestControlMessage::SeedData {
                    files: vec![TestSeedFilePayload {
                        path: "views/manifest/settings.json".into(),
                        content: settings_content,
                    }],
                },
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
        .join("views")
        .join("manifest")
        .join("settings.json");
    let settings_raw = tokio::fs::read_to_string(settings_path)
        .await
        .expect("settings written");
    assert!(settings_raw.contains("\"theme\": \"dark\""));
    assert!(settings_raw.contains("\"captureSnapshotVideo\": false"));

    socket
        .send(Message::Text(
            serde_json::to_string(&ConnectorMessage::TestControl {
                request: TestControlMessage::SeedData {
                    files: vec![TestSeedFilePayload {
                        path: "views/pages/00/incomplete.json".into(),
                        content: serde_json::json!({
                            "slug": "incomplete",
                            "url": "https://example.com/incomplete"
                        })
                        .to_string(),
                    }],
                },
            })
            .expect("serialize invalid page seed"),
        ))
        .await
        .expect("send invalid page seed");
    let invalid_page: DaemonMessage = serde_json::from_str(&next_text_message(&mut socket).await)
        .expect("invalid page seed json");
    match invalid_page {
        DaemonMessage::TestSeedDataResult { success, error } => {
            assert!(!success, "incomplete page entity must be rejected");
            assert!(error
                .expect("invalid page seed error")
                .contains("invalid page test seed"));
        }
        other => panic!("expected invalid page seed result, got {other:?}"),
    }

    handle.shutdown().await;
}
