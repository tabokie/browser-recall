#[path = "../src/distribution.rs"]
mod distribution;
#[path = "../src/reviews.rs"]
mod reviews;

use browser_recall_daemon::ConfigStore;
use reviews::ReviewCoordinator;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const DAY: i64 = 86_400_000;
const OPENED: i64 = 1_792_800_000_000;

async fn attempt(coordinator: &ReviewCoordinator, now: i64, calls: &AtomicUsize) -> bool {
    let session = coordinator.begin_session();
    coordinator
        .request(
            session,
            1,
            now,
            || async { Ok(Some(1)) },
            |_, permit| async move {
                assert!(permit.is_current());
                // StoreKit may show no UI; a successful call still consumes the attempt.
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            },
        )
        .await
        .expect("request review")
}

#[tokio::test]
async fn review_requests_persist_across_restarts_collection_changes_and_suppressed_dialogs() {
    assert_eq!(
        distribution::MAC_APP_STORE_BUILD,
        cfg!(all(target_os = "macos", feature = "mac-app-store"))
    );
    let _ = distribution::reviews_enabled();
    let directory = tempfile::tempdir().expect("profile");
    let store = ConfigStore::new(directory.path());
    let github = ReviewCoordinator::new(store.clone(), false, OPENED);
    assert!(!github.enabled());
    github.initialize().await.expect("GitHub startup");
    assert!(!store.exists());
    let coordinator = ReviewCoordinator::new(store.clone(), true, OPENED);
    coordinator.initialize().await.expect("App Store startup");
    let calls = AtomicUsize::new(0);
    assert!(!attempt(&coordinator, OPENED + 7 * DAY - 1, &calls).await);
    assert!(attempt(&coordinator, OPENED + 7 * DAY, &calls).await);
    let restarted = ReviewCoordinator::new(store.clone(), true, OPENED + 10 * DAY);
    restarted.initialize().await.expect("restart");
    store
        .update(|config| {
            config
                .select_data_directory(directory.path().join("another-collection"))
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .expect("change collection");
    assert!(!attempt(&restarted, OPENED + 37 * DAY - 1, &calls).await);
    assert!(attempt(&restarted, OPENED + 37 * DAY, &calls).await);
    assert!(!attempt(&restarted, OPENED + 1000 * DAY, &calls).await);
    let history = store.load().unwrap().unwrap().review_requests.unwrap();
    assert_eq!(history.first_opened_at, OPENED);
    assert_eq!(history.requested_at, [OPENED + 7 * DAY, OPENED + 37 * DAY]);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!attempt(&github, OPENED + 1000 * DAY, &calls).await);
}

#[tokio::test]
async fn delayed_first_request_starts_the_second_delay_and_concurrent_requests_are_claimed_once() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let coordinator = ReviewCoordinator::new(store, true, OPENED);
    coordinator.initialize().await.unwrap();
    let session = coordinator.begin_session();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut workers = vec![];
    for generation in 1..=8 {
        let coordinator = coordinator.clone();
        let calls = calls.clone();
        workers.push(tokio::spawn(async move {
            coordinator
                .request(
                    session,
                    generation,
                    OPENED + 100 * DAY,
                    || async { Ok(Some(1)) },
                    |_, permit| async move {
                        if !permit.is_current() {
                            return Ok(false);
                        }
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(true)
                    },
                )
                .await
                .unwrap()
        }));
    }
    for worker in workers {
        worker.await.unwrap();
    }
    // A superseding context may cancel the first reservation; a fresh completed
    // task must then still be eligible, and concurrent requests never use two slots.
    attempt(&coordinator, OPENED + 100 * DAY, &calls).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!attempt(&coordinator, OPENED + 130 * DAY - 1, &calls).await);
    assert!(attempt(&coordinator, OPENED + 130 * DAY, &calls).await);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn locked_configuration_does_not_block_the_runtime_and_cancelled_context_consumes_no_attempt()
{
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let coordinator = ReviewCoordinator::new(store.clone(), true, OPENED);
    coordinator.initialize().await.unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.path().join("config.lock"))
        .unwrap();
    lock.lock().unwrap();
    let session = coordinator.begin_session();
    let worker = coordinator.clone();
    let (prepared, ready) = tokio::sync::oneshot::channel();
    let request = tokio::spawn(async move {
        worker
            .request(
                session,
                1,
                OPENED + 7 * DAY,
                || async {
                    prepared.send(()).unwrap();
                    Ok(Some(1))
                },
                |_, _| async { panic!("cancelled request cannot present") },
            )
            .await
    });
    ready.await.unwrap();
    // This current-thread timer cannot run if configuration locking happens inline.
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!request.is_finished());
    coordinator.cancel(session, 2);
    lock.unlock().unwrap();
    assert!(!request.await.unwrap().unwrap());
    assert!(store
        .load()
        .unwrap()
        .unwrap()
        .review_requests
        .unwrap()
        .requested_at
        .is_empty());
    let calls = AtomicUsize::new(0);
    assert!(attempt(&coordinator, OPENED + 7 * DAY, &calls).await);
}

#[tokio::test]
async fn native_rejection_and_frontend_reload_roll_back_durable_reservations() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let coordinator = ReviewCoordinator::new(store.clone(), true, OPENED);
    coordinator.initialize().await.unwrap();
    for reload in [false, true] {
        let session = coordinator.begin_session();
        let store = &store;
        let coordinator = &coordinator;
        let requested = coordinator
            .request(
                session,
                1,
                OPENED + 7 * DAY,
                || async { Ok(Some(1)) },
                |_, permit| async move {
                    assert_eq!(
                        store
                            .load()
                            .unwrap()
                            .unwrap()
                            .review_requests
                            .unwrap()
                            .requested_at
                            .len(),
                        1
                    );
                    if reload {
                        coordinator.begin_session();
                    }
                    assert_eq!(permit.is_current(), !reload);
                    Ok(false)
                },
            )
            .await
            .unwrap();
        assert!(!requested);
        assert!(store
            .load()
            .unwrap()
            .unwrap()
            .review_requests
            .unwrap()
            .requested_at
            .is_empty());
    }
    let session = coordinator.begin_session();
    // A cancellation delivered before a delayed request cannot be overwritten.
    coordinator.cancel(session, 2);
    assert!(!coordinator
        .request(
            session,
            1,
            OPENED + 7 * DAY,
            || async { panic!("stale request cannot prepare") },
            |_, _| async { Ok(true) }
        )
        .await
        .unwrap());
    assert!(coordinator
        .request(
            session,
            3,
            OPENED + 7 * DAY,
            || async { Ok(Some(1)) },
            |_, _| async { Err("native failure".into()) }
        )
        .await
        .is_err());
    assert!(store
        .load()
        .unwrap()
        .unwrap()
        .review_requests
        .unwrap()
        .requested_at
        .is_empty());
}

#[tokio::test]
async fn invalid_history_and_failed_persistence_never_call_storekit() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(directory.path());
    let coordinator = ReviewCoordinator::new(store.clone(), true, OPENED);
    coordinator.initialize().await.unwrap();
    let mut config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store.config_path()).unwrap()).unwrap();
    config["review_requests"]["requested_at"] = serde_json::json!([OPENED + DAY]);
    std::fs::write(store.config_path(), serde_json::to_vec(&config).unwrap()).unwrap();
    let session = coordinator.begin_session();
    assert!(coordinator
        .request(
            session,
            1,
            OPENED + 7 * DAY,
            || async { Ok(Some(1)) },
            |_, _| async { panic!("invalid history cannot present") }
        )
        .await
        .is_err());
    config["review_requests"]["requested_at"] = serde_json::json!([]);
    std::fs::write(store.config_path(), serde_json::to_vec(&config).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = coordinator
            .request(
                session,
                2,
                OPENED + 7 * DAY,
                || async { Ok(Some(1)) },
                |_, _| async { panic!("unsaved attempt cannot present") },
            )
            .await;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert!(store
            .load()
            .unwrap()
            .unwrap()
            .review_requests
            .unwrap()
            .requested_at
            .is_empty());
    }
}
