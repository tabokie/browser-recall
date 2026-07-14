mod support;

use browser_recall_daemon::protocol::{ConnectorMessage, DaemonMessage, TestControlMessage};
use browser_recall_daemon::ws_server::{start_server, ServerStartOptions};
use browser_recall_daemon::ConfigStore;
use browser_recall_replay::entities::{
    ListEntity, ListOrderManifest, NameToIdManifest, OrphanedManifest, PageEntity,
};
use browser_recall_replay::generate_slug_from_url;
use futures_util::SinkExt;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use tempfile::tempdir;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{next_text_message, paired_socket, test_server_options};

fn test_control_server_options(config_store: ConfigStore) -> ServerStartOptions {
    let mut options = test_server_options(config_store);
    options.test_control_enabled = true;
    options
}

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

async fn wait_for_json<T, F>(path: &Path, predicate: F) -> T
where
    T: DeserializeOwned,
    F: Fn(&T) -> bool,
{
    let mut last_error = None;
    for _ in 0..100 {
        match tokio::fs::read_to_string(path).await {
            Ok(raw) => match serde_json::from_str::<T>(&raw) {
                Ok(value) if predicate(&value) => return value,
                Ok(_) => {}
                Err(error) => last_error = Some(error.to_string()),
            },
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

async fn wait_for_ack(socket: &mut support::TestSocket) {
    loop {
        let message = next_text_message(socket).await;
        let parsed: DaemonMessage = serde_json::from_str(&message).expect("daemon message json");
        match parsed {
            DaemonMessage::Ack { .. } => return,
            DaemonMessage::Error {
                error,
                code,
                message,
            } => panic!("daemon rejected drain event: {code}/{error}: {message}"),
            _ => {}
        }
    }
}

fn shard_for(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{:02x}", digest[0])
}

#[tokio::test]
async fn drain_pipeline_preserves_fifo_order_for_page_updates() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let handle = start_server(test_control_server_options(config_store.clone()))
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
            "referrerUrl": null,
        }),
        json!({
            "timestamp": 1_710_000_100_100i64,
            "action": "leave_page",
            "url": url,
            "title": null,
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
            "likes": 1,
            "title": null
        }),
    ];

    for entry in entries {
        socket
            .send(Message::Text(
                serde_json::to_string(&ConnectorMessage::TestControl {
                    request: TestControlMessage::Event {
                        entry,
                        source: "extension".to_string(),
                        buffer_depth: 0,
                        buffer_bytes: 0,
                    },
                })
                .expect("event json"),
            ))
            .await
            .expect("send event");
        wait_for_ack(&mut socket).await;
    }

    let slug = generate_slug_from_url(url).expect("slug");
    let page_path = data_dir
        .join("views")
        .join("pages")
        .join(shard_for(&slug))
        .join(format!("{slug}.json"));
    let page: PageEntity = wait_for_json(&page_path, |page: &PageEntity| {
        page.likes == Some(1)
            && page.user_title.as_deref() == Some("Pinned Title")
            && page.scroll_depth == Some(45)
    })
    .await;
    assert_eq!(page.title.as_deref(), Some("Initial Title"));
    assert_eq!(page.user_title.as_deref(), Some("Pinned Title"));
    assert_eq!(page.scroll_depth, Some(45));
    assert_eq!(page.time_on_page, Some(12));
    assert_eq!(page.likes, Some(1));

    let lines = read_log_lines(&data_dir.join("logs").join(device_id)).await;
    let actions: Vec<_> = lines
        .iter()
        .filter(|line| line.get("url").and_then(Value::as_str) == Some(url))
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
    let handle = start_server(test_control_server_options(config_store.clone()))
        .await
        .expect("server starts");

    let (mut socket, data_dir, _device_id) = paired_socket(handle.port(), &config_store).await;
    let entries = [
        json!({
            "timestamp": 1_710_000_200_000i64,
            "action": "create_list",
            "listOwner": "test-device",
            "name": "Reading",
            "listId": "reading",
            "parentListId": null
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
                serde_json::to_string(&ConnectorMessage::TestControl {
                    request: TestControlMessage::Event {
                        entry,
                        source: "extension".to_string(),
                        buffer_depth: 0,
                        buffer_bytes: 0,
                    },
                })
                .expect("event json"),
            ))
            .await
            .expect("send event");
        wait_for_ack(&mut socket).await;
    }

    let list_path = data_dir.join("views").join("lists").join("reading.json");
    let list: ListEntity = wait_for_json(&list_path, |list: &ListEntity| list.deleted).await;
    assert_eq!(list.name, "Longform");
    assert!(list.deleted);
    assert_eq!(list.deleted_ts, Some(1_710_000_200_200i64));

    let name_to_id_path = data_dir
        .join("views")
        .join("manifest")
        .join("list-name-to-id.json");
    let name_to_id: NameToIdManifest =
        wait_for_json(&name_to_id_path, |name_to_id: &NameToIdManifest| {
            !name_to_id.paths.contains_key("test-device/Longform")
        })
        .await;
    assert!(!name_to_id.paths.contains_key("test-device/Reading"));
    assert!(!name_to_id.paths.contains_key("test-device/Longform"));

    let list_order_path = data_dir
        .join("views")
        .join("manifest")
        .join("list-order.json");
    let list_order: ListOrderManifest =
        wait_for_json(&list_order_path, |list_order: &ListOrderManifest| {
            !list_order.tree.iter().any(|node| node.id == "reading")
        })
        .await;
    assert!(!list_order.tree.iter().any(|node| node.id == "reading"));

    let orphaned_raw = tokio::fs::read_to_string(
        data_dir
            .join("views")
            .join("manifest")
            .join("orphaned.json"),
    )
    .await
    .expect("orphaned exists");
    let orphaned: OrphanedManifest = serde_json::from_str(&orphaned_raw).expect("orphaned json");
    assert!(orphaned
        .entries
        .iter()
        .any(|entry| entry.key == "list:reading"));

    handle.shutdown().await;
}
