use browser_recall_daemon::sync::{sync_device_entries_json, SyncController};
use browser_recall_daemon::{ConfigStore, DaemonConfig, SyncDeviceRecord, Token};
use std::collections::BTreeMap;
use std::sync::Arc;
use tempfile::tempdir;
use tokio::sync::Notify;

#[test]
fn sync_controller_tracks_devices_and_persists_pause_state() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config =
        DaemonConfig::new_configured(dir.path().join("data")).expect("configured data directory");
    config.device_id = "device-a".to_string();
    config.sync_devices = BTreeMap::from([(
        "device-b".to_string(),
        SyncDeviceRecord {
            last_pushed: Some(10),
            last_pulled: Some(20),
        },
    )]);
    config_store.save(&config).expect("save config");

    let controller = SyncController::new(
        config_store.clone(),
        &config,
        config.device_id.clone(),
        Arc::new(Notify::new()),
    );

    let entries = controller.device_entries();
    assert!(entries.iter().any(|entry| entry.device_id == "device-a"));
    assert!(entries.iter().any(|entry| entry.device_id == "device-b"));

    let paused = controller
        .toggle_device_paused("device-b")
        .expect("toggle pause");
    assert!(paused);

    let reloaded = config_store
        .load()
        .expect("load config")
        .expect("config exists");
    assert_eq!(reloaded.sync_paused_devices, vec!["device-b".to_string()]);

    let entries = controller.device_entries();
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.device_id == "device-b")
            .map(|entry| entry.paused),
        Some(true)
    );
    assert!(sync_device_entries_json(&entries).is_array());
}

#[test]
fn sync_controller_clears_auth_without_touching_device_records() {
    let dir = tempdir().expect("tempdir");
    let config_store = ConfigStore::new(dir.path());
    let mut config =
        DaemonConfig::new_configured(dir.path().join("data")).expect("configured data directory");
    config.device_id = "device-a".to_string();
    config.sync_github_token = Some(Token("secret".to_string()));
    config.sync_github_user = Some("octocat".to_string());
    config.sync_devices = BTreeMap::from([(
        "device-a".to_string(),
        SyncDeviceRecord {
            last_pushed: Some(30),
            last_pulled: None,
        },
    )]);
    config_store.save(&config).expect("save config");

    let controller = SyncController::new(
        config_store.clone(),
        &config,
        config.device_id.clone(),
        Arc::new(Notify::new()),
    );
    controller.clear_token().expect("clear token");

    let reloaded = config_store
        .load()
        .expect("load config")
        .expect("config exists");
    assert_eq!(reloaded.sync_github_token, None);
    assert_eq!(reloaded.sync_github_user, None);
    assert!(reloaded.sync_remember_token);
    assert_eq!(
        reloaded
            .sync_devices
            .get("device-a")
            .and_then(|record| record.last_pushed),
        Some(30)
    );
}
