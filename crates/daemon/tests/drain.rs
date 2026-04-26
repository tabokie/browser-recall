mod support;

use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage};
use browser_recall_daemon::ws_server::start_server;
use browser_recall_daemon::ConfigStore;
use browser_recall_replay::entities::{
    ListEntity, ListOrderManifest, NameToIdManifest, OrphanedManifest, PageEntity,
};
use browser_recall_replay::generate_slug_from_url;
use futures_util::SinkExt;
use serde_json::{json, Value};
use tempfile::tempdir;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{next_text_message, paired_socket, test_server_options};

async fn read_log_lines(log_dir: &std::path::Path) -> Vec<Value> {
    let mut entries = tokio::fs::read_dir(log_dir).await.expect("log dir exists");
    let mut lines = Vec::new();
    while let Some(entry) = entries.next_entry().await.expect("dir read") {
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let raw = tokio::fs::read_to_string(entry.path())
            .await
            .expect("log exists");
        lines.extend(
            raw.lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str::<Value>(line).expect("valid jsonl line")),
        );
    }
    lines
}

#[tokio::test]
async fn drain_pipeline_preserves_fifo_order_for_page_updates() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, device_id) = paired_socket(handle.port(), &config_store).await;
    let url = "https://example.com/drain-order";
    let entries = [
        json!({
            "timestamp": 1_710_000_100_000i64,
            "action": "visit_page",
            "url": url,
            "title": "Initial Title",
            "checkpoint": true
        }),
        json!({
            "timestamp": 1_710_000_100_100i64,
            "action": "leave_page",
            "url": url,
            "scrollDepth": 45,
            "timeOnPage": 12
        }),
        json!({
            "timestamp": 1_710_000_100_200i64,
            "action": "rename_page",
            "url": url,
            "user_title": "Pinned Title"
        }),
        json!({
            "timestamp": 1_710_000_100_300i64,
            "action": "rate_page",
            "url": url,
            "likes": 1
        }),
    ];

    for entry in entries {
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

    let slug = generate_slug_from_url(url).expect("slug");
    let page_raw = tokio::fs::read_to_string(data_dir.join("pages").join(format!("{slug}.json")))
        .await
        .expect("page exists");
    let page: PageEntity = serde_json::from_str(&page_raw).expect("page json");
    assert_eq!(page.title.as_deref(), Some("Initial Title"));
    assert_eq!(page.user_title.as_deref(), Some("Pinned Title"));
    assert_eq!(page.scroll_depth, Some(45));
    assert_eq!(page.time_on_page, Some(12));
    assert_eq!(page.likes, Some(1));

    let lines = read_log_lines(&data_dir.join("data").join("logs").join(device_id)).await;
    let actions: Vec<_> = lines
        .iter()
        .map(|line| {
            line.get("action")
                .and_then(Value::as_str)
                .expect("action field")
        })
        .collect();
    assert_eq!(
        actions,
        vec!["visit_page", "leave_page", "rename_page", "rate_page"]
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn drain_pipeline_reconciles_list_manifests_after_sequential_mutations() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    let entries = [
        json!({
            "timestamp": 1_710_000_200_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Reading",
            "listId": "reading"
        }),
        json!({
            "timestamp": 1_710_000_200_100i64,
            "action": "update_list",
            "listOwner": "test-device",
            "name": "Reading",
            "newName": "Longform"
        }),
        json!({
            "timestamp": 1_710_000_200_200i64,
            "action": "delete_list",
            "listOwner": "test-device",
            "name": "Longform"
        }),
    ];

    for entry in entries {
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

    let list_raw = tokio::fs::read_to_string(data_dir.join("lists").join("reading.json"))
        .await
        .expect("list exists");
    let list: ListEntity = serde_json::from_str(&list_raw).expect("list json");
    assert_eq!(list.name, "Longform");
    assert!(list.deleted);
    assert_eq!(list.deleted_ts, Some(1_710_000_200_200i64));

    let name_to_id_raw =
        tokio::fs::read_to_string(data_dir.join("manifest").join("list-name-to-id.json"))
            .await
            .expect("name map exists");
    let name_to_id: NameToIdManifest =
        serde_json::from_str(&name_to_id_raw).expect("name map json");
    assert!(!name_to_id.paths.contains_key("test-device/Reading"));
    assert!(!name_to_id.paths.contains_key("test-device/Longform"));

    let list_order_raw =
        tokio::fs::read_to_string(data_dir.join("manifest").join("list-order.json"))
            .await
            .expect("list order exists");
    let list_order: ListOrderManifest =
        serde_json::from_str(&list_order_raw).expect("list order json");
    assert!(list_order.tree.is_empty());

    let orphaned_raw = tokio::fs::read_to_string(data_dir.join("manifest").join("orphaned.json"))
        .await
        .expect("orphaned exists");
    let orphaned: OrphanedManifest = serde_json::from_str(&orphaned_raw).expect("orphaned json");
    assert!(orphaned
        .entries
        .iter()
        .any(|entry| entry.key == "list:reading"));

    handle.shutdown().await;
}
