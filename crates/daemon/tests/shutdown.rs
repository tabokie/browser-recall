mod support;

use browser_recall_daemon::{ws_server::start_server, ConfigStore};
use futures_util::StreamExt;
use serde_json::json;
use std::time::Duration;
use tempfile::tempdir;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn shutdown_closes_connected_clients_and_saves_accepted_notes() {
    let directory = tempdir().expect("temporary directory");
    let config = ConfigStore::new(directory.path());
    let server = start_server(support::test_server_options(config.clone()))
        .await
        .expect("server");
    let (mut socket, data_dir, _) = support::paired_socket(server.port(), &config).await;
    let response = server
        .control_handle()
        .run_command(
            "createNote",
            json!({
                "url": "https://shutdown.example/note", "title": "Shutdown",
                "excerpt": ["accepted before shutdown"], "cssPath": ["main > p"], "note": "saved"
            }),
        )
        .await
        .expect("create accepted note");
    let note_slug = response["noteSlug"].as_str().expect("note slug");
    server.shutdown().await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(message) = socket.next().await {
            match message {
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    })
    .await
    .expect("shutdown must close existing connector sessions");
    let note: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(data_dir.join(format!("objects/notes/{note_slug}.json")))
            .await
            .expect("checkpoint saved before shutdown returns"),
    )
    .expect("note checkpoint");
    assert_eq!(note["note"], "saved");
}
