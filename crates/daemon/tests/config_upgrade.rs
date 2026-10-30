use browser_recall_daemon::{
    config::{ApprovedConnector, ReviewRequestHistory, SyncDeviceRecord, Token},
    pairing::{static_approver, PairingDecision},
    ws_server::{start_server, ServerStartOptions},
    ConfigStore, DaemonConfig, ServiceState,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

fn configured_fixture(data: &Path) -> DaemonConfig {
    let mut config = DaemonConfig::new_configured(data.to_path_buf()).unwrap();
    config.device_id = "upgrade-device".into();
    config.last_port = Some(49152);
    config.launch_at_login = false;
    config.log_level = "debug".into();
    config.connectors.push(ApprovedConnector {
        browser_id: "browser-install".into(),
        browser_name: "Chrome".into(),
        extension_id: "abcdefghijklmnop".into(),
        browser_profile: Some("Work".into()),
        token: Token("pairing-secret".into()),
        approved_at: 1000,
        last_seen_at: Some(2000),
    });
    config.sync_github_token = Some(Token("sync-secret".into()));
    config.sync_github_user = Some("upgrade-user".into());
    config.sync_remember_token = false;
    config.sync_paused_devices.push("paused-device".into());
    config.sync_devices.insert(
        "synced-device".into(),
        SyncDeviceRecord {
            last_pushed: Some(1000),
            last_pulled: Some(2000),
        },
    );
    config.review_requests = Some(ReviewRequestHistory {
        first_opened_at: 1_792_800_000_000,
        requested_at: vec![1_792_800_000_000 + 7 * 86_400_000],
    });
    config
}

#[tokio::test]
async fn every_missing_configuration_field_gets_a_persisted_default_and_keeps_other_settings() {
    let directory = tempfile::tempdir().unwrap();
    let original =
        serde_json::to_value(configured_fixture(&directory.path().join("collection"))).unwrap();
    // Enumerate the real serialized schema so future fields join this regression.
    for omitted in original.as_object().unwrap().keys() {
        let profile = directory.path().join(omitted);
        fs::create_dir(&profile).unwrap();
        let store = ConfigStore::new(&profile);
        let mut older = original.clone();
        older.as_object_mut().unwrap().remove(omitted);
        fs::write(store.config_path(), serde_json::to_vec(&older).unwrap()).unwrap();
        let config = store
            .load()
            .unwrap_or_else(|error| panic!("missing {omitted}: {error}"))
            .unwrap();
        let loaded = serde_json::to_value(&config).unwrap();
        for (key, expected) in original.as_object().unwrap() {
            if key != omitted && !(omitted == "data_dir" && key == "setup_complete") {
                assert_eq!(&loaded[key], expected, "missing {omitted} changed {key}");
            }
        }
        let persisted: Value =
            serde_json::from_slice(&fs::read(store.config_path()).unwrap()).unwrap();
        assert_eq!(persisted, loaded, "missing {omitted} was not materialized");
        assert_eq!(
            store.load().unwrap().unwrap(),
            config,
            "missing {omitted} changed on reread"
        );
        let mut options = ServerStartOptions::phase1_defaults(
            store.clone(),
            static_approver(PairingDecision::Approve),
        );
        options.port_candidates = vec![0];
        if omitted == "data_dir" {
            assert!(!config.is_configured());
            assert!(
                start_server(options).await.is_err(),
                "a missing data folder must require setup"
            );
        } else {
            assert!(config.is_configured(), "missing {omitted} lost setup");
            let server = start_server(options)
                .await
                .unwrap_or_else(|error| panic!("missing {omitted} failed startup: {error}"));
            assert!(matches!(
                server.snapshot().await.service_state,
                ServiceState::Running
            ));
            server.shutdown().await;
        }
    }
}

#[test]
fn empty_configuration_and_updates_use_the_same_defaults_without_a_second_lock() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    fs::write(store.config_path(), b"{}").unwrap();
    // update() already owns the writer lock; normalization must not acquire it again.
    store
        .update(|config| {
            config.log_level = "debug".into();
            Ok(())
        })
        .unwrap();
    let config = store.load().unwrap().unwrap();
    assert!(!config.is_configured());
    assert!(!config.device_id.is_empty());
    assert!(config.data_dir.as_os_str().is_empty());
    assert_eq!(config.log_level, "debug");
    let persisted: Value = serde_json::from_slice(&fs::read(store.config_path()).unwrap()).unwrap();
    assert_eq!(persisted, serde_json::to_value(&config).unwrap());
    assert_eq!(
        ConfigStore::new(directory.path()).load().unwrap().unwrap(),
        config
    );
}

#[test]
fn missing_fields_do_not_hide_malformed_present_values_or_rewrite_rejected_files() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let original =
        serde_json::to_value(configured_fixture(&directory.path().join("collection"))).unwrap();
    for (field, value) in original.as_object().unwrap() {
        let mut malformed = original.clone();
        malformed
            .as_object_mut()
            .unwrap()
            .remove(if field == "review_requests" {
                "log_level"
            } else {
                "review_requests"
            });
        malformed[field] = match value {
            Value::String(_) => json!(123),
            Value::Bool(_) | Value::Number(_) => json!("invalid"),
            Value::Array(_) => json!({}),
            _ => json!([]),
        };
        let bytes = serde_json::to_vec(&malformed).unwrap();
        fs::write(store.config_path(), &bytes).unwrap();
        assert_eq!(
            store.load().unwrap_err().kind(),
            std::io::ErrorKind::InvalidData,
            "malformed {field}"
        );
        assert_eq!(fs::read(store.config_path()).unwrap(), bytes);
    }
    for malformed in [
        json!([]),
        json!({"launch_at_login": null}),
        json!({"unknown_setting": true}),
    ] {
        let bytes = serde_json::to_vec(&malformed).unwrap();
        fs::write(store.config_path(), &bytes).unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(store.config_path()).unwrap(), bytes);
    }
    for duplicate in [
        r#"{"device_id":"first-device","device_id":"second-device"}"#,
        r#"{"sync_devices":{"device":{"last_pushed":1,"last_pushed":2}}}"#,
    ] {
        fs::write(store.config_path(), duplicate).unwrap();
        assert!(store.load().is_err(), "duplicate keys must remain errors");
        assert_eq!(fs::read_to_string(store.config_path()).unwrap(), duplicate);
    }
}

#[test]
fn missing_nullable_connector_and_sync_metadata_preserves_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let mut older =
        serde_json::to_value(configured_fixture(&directory.path().join("collection"))).unwrap();
    older["connectors"][0]
        .as_object_mut()
        .unwrap()
        .remove("browser_profile");
    older["connectors"][0]
        .as_object_mut()
        .unwrap()
        .remove("last_seen_at");
    older["sync_devices"]["synced-device"]
        .as_object_mut()
        .unwrap()
        .remove("last_pushed");
    older["sync_devices"]["synced-device"]
        .as_object_mut()
        .unwrap()
        .remove("last_pulled");
    fs::write(store.config_path(), serde_json::to_vec(&older).unwrap()).unwrap();
    let config = store.load().unwrap().unwrap();
    assert_eq!(config.connectors[0].token, Token("pairing-secret".into()));
    assert!(config.connectors[0].browser_profile.is_none());
    assert!(config.connectors[0].last_seen_at.is_none());
    assert_eq!(
        config.sync_devices["synced-device"],
        SyncDeviceRecord::default()
    );
    let persisted: Value = serde_json::from_slice(&fs::read(store.config_path()).unwrap()).unwrap();
    assert_eq!(persisted, serde_json::to_value(config).unwrap());
}

#[test]
fn nested_review_history_defaults_preserve_existing_attempts_and_are_persisted_once() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let original =
        serde_json::to_value(configured_fixture(&directory.path().join("collection"))).unwrap();
    let opened = original["review_requests"]["first_opened_at"]
        .as_i64()
        .unwrap();
    let first = opened + 7 * 86_400_000;
    let second = first + 30 * 86_400_000;
    let omissions: Vec<Vec<&str>> = original["review_requests"]
        .as_object()
        .unwrap()
        .keys()
        .map(|field| vec![field.as_str()])
        .chain(std::iter::once(vec!["first_opened_at", "requested_at"]))
        .collect();
    for attempts in [vec![], vec![first], vec![first, second]] {
        for omit in &omissions {
            let mut older = original.clone();
            older["review_requests"]["requested_at"] = json!(attempts);
            for field in omit {
                older["review_requests"]
                    .as_object_mut()
                    .unwrap()
                    .remove(*field);
            }
            fs::write(store.config_path(), serde_json::to_vec(&older).unwrap()).unwrap();
            let before = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            let config = store
                .load()
                .unwrap_or_else(|error| panic!("attempts {attempts:?}, omitted {omit:?}: {error}"))
                .unwrap();
            let after = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            let history = config.review_requests.as_ref().unwrap();
            let loaded_history = serde_json::to_value(history).unwrap();
            for (field, expected) in older["review_requests"].as_object().unwrap() {
                assert_eq!(
                    &loaded_history[field], expected,
                    "missing {omit:?} changed {field}"
                );
            }
            let expected_attempts = if omit.contains(&"requested_at") {
                &[][..]
            } else {
                &attempts[..]
            };
            assert_eq!(history.requested_at, expected_attempts);
            if !omit.contains(&"first_opened_at") {
                assert_eq!(history.first_opened_at, opened);
            } else if let Some(first) = expected_attempts.first() {
                assert_eq!(history.first_opened_at, first - 7 * 86_400_000);
            } else {
                assert!((before..=after).contains(&history.first_opened_at));
            }
            let mut expected = original.clone();
            expected["review_requests"] = serde_json::to_value(history).unwrap();
            assert_eq!(serde_json::to_value(&config).unwrap(), expected);
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(store.config_path()).unwrap()).unwrap(),
                expected
            );
            assert_eq!(store.load().unwrap().unwrap(), config);
        }
    }
}

#[test]
fn omitted_connector_metadata_keeps_pairing_and_does_not_default_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let original =
        serde_json::to_value(configured_fixture(&directory.path().join("collection"))).unwrap();
    let credential_fields = ["browser_id", "extension_id", "token"];
    for field in original["connectors"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .filter(|field| !credential_fields.contains(field))
    {
        let mut older = original.clone();
        older["connectors"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        fs::write(store.config_path(), serde_json::to_vec(&older).unwrap()).unwrap();
        let loaded = store
            .load()
            .unwrap_or_else(|error| panic!("missing {field}: {error}"))
            .unwrap();
        assert_eq!(loaded.connectors[0].token, Token("pairing-secret".into()));
        assert!(!loaded.connectors[0].browser_name.is_empty());
        let loaded_connector = serde_json::to_value(&loaded.connectors[0]).unwrap();
        for (key, expected) in original["connectors"][0].as_object().unwrap() {
            if key != field {
                assert_eq!(&loaded_connector[key], expected);
            }
        }
        if field == "approved_at" {
            assert_eq!(loaded.connectors[0].approved_at, 0);
        }
    }
    for field in credential_fields {
        let mut older = original.clone();
        older["connectors"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        let bytes = serde_json::to_vec(&older).unwrap();
        fs::write(store.config_path(), &bytes).unwrap();
        assert!(
            store.load().is_err(),
            "pairing identity cannot be invented: {field}"
        );
        assert_eq!(fs::read(store.config_path()).unwrap(), bytes);
    }
}

#[test]
fn nested_defaults_do_not_hide_invalid_supplied_values() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    for history in [
        json!({"first_opened_at": null}),
        json!({"requested_at": null}),
        json!({"requested_at": [0]}),
        json!({"requested_at": [i64::MIN]}),
        json!({"requested_at": ["invalid"]}),
        json!({"first_opened_at": 0}),
        json!({"requested_at": [], "unknown": true}),
    ] {
        let bytes = serde_json::to_vec(&json!({"review_requests": history})).unwrap();
        fs::write(store.config_path(), &bytes).unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(store.config_path()).unwrap(), bytes);
    }
    for (field, value) in [
        ("browser_name", json!(null)),
        ("browser_name", json!("")),
        ("approved_at", json!(null)),
    ] {
        let mut config =
            serde_json::to_value(configured_fixture(&directory.path().join("collection"))).unwrap();
        config["connectors"][0][field] = value;
        config["review_requests"]
            .as_object_mut()
            .unwrap()
            .remove("first_opened_at");
        let bytes = serde_json::to_vec(&config).unwrap();
        fs::write(store.config_path(), &bytes).unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(store.config_path()).unwrap(), bytes);
    }
}
