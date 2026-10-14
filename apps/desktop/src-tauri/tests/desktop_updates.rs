#[path = "../src/updates.rs"]
mod updates;

use serde_json::json;
use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::test::{mock_builder, mock_context, noop_assets};
#[cfg(target_os = "macos")]
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct TestLifecycle {
    prepared: AtomicUsize,
    recovered: AtomicUsize,
    recovery_gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    recovery_error: Option<String>,
}

impl updates::UpdateLifecycle for TestLifecycle {
    type Guard = ();

    async fn prepare(&self) -> Result<(), String> {
        self.prepared.fetch_add(1, Ordering::SeqCst);
        Err("checkpoint flush failed".into())
    }

    async fn recover(&self) -> Result<(), String> {
        self.recovered.fetch_add(1, Ordering::SeqCst);
        if let Some((started, finish)) = &self.recovery_gate {
            started.notify_one();
            finish.notified().await;
        }
        self.recovery_error.clone().map_or(Ok(()), Err)
    }

    fn restart(&self) {
        panic!("failed installation must never restart");
    }
}

#[tokio::test]
async fn update_download_authenticates_before_stopping_the_daemon() {
    let work = tempfile::tempdir().expect("temporary signing directory");
    let cli = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../node_modules/@tauri-apps/cli/tauri.js");
    let key = work.path().join("test.key");
    let package = work.path().join("update.bin");
    std::fs::write(&package, b"authenticated update package").expect("package");
    let generated = Command::new("node")
        .arg(&cli)
        .args(["signer", "generate", "--ci", "-p", "", "-w"])
        .arg(&key)
        .output()
        .expect("generate test key");
    assert!(
        generated.status.success(),
        "test signing key generation failed"
    );
    let signed = Command::new("node")
        .arg(&cli)
        .args(["signer", "sign", "-f"])
        .arg(&key)
        .args(["-p", ""])
        .arg(&package)
        .output()
        .expect("sign package");
    assert!(signed.status.success(), "test package signing failed");
    let signature = std::fs::read_to_string(package.with_extension("bin.sig")).expect("signature");
    let public_key = std::fs::read_to_string(key.with_extension("key.pub")).expect("public key");
    verify_download_contract(
        public_key,
        signature,
        b"authenticated update package".to_vec(),
    )
    .await;
}

#[tokio::test]
#[ignore = "release pipeline supplies a signed package"]
async fn release_package_matches_embedded_public_key() {
    let package =
        std::env::var("BROWSER_RECALL_VERIFY_UPDATE_PACKAGE").expect("release package path");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("desktop config");
    let public_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("embedded public key")
        .to_string();
    let signature = std::fs::read_to_string(format!("{package}.sig")).expect("package signature");
    verify_download_contract(
        public_key,
        signature,
        std::fs::read(package).expect("release package"),
    )
    .await;
}

async fn verify_download_contract(public_key: String, signature: String, package: Vec<u8>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test server");
    let address = listener.local_addr().expect("server address");
    let tampered = Arc::new(AtomicBool::new(true));
    let content_changed = tampered.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = [0; 4096];
            let length = socket.read(&mut request).await.expect("request");
            let manifest = json!({ "version": "9.0.0", "url": format!("http://{address}/package"), "signature": signature.trim() });
            let body = if String::from_utf8_lossy(&request[..length]).starts_with("GET /manifest ")
            {
                manifest.to_string().into_bytes()
            } else if content_changed.load(Ordering::SeqCst) {
                b"tampered package".to_vec()
            } else {
                package.clone()
            };
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .expect("response headers");
            socket.write_all(&body).await.expect("response body");
        }
    });
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "pubkey": public_key.trim(), "endpoints": [format!("http://{address}/manifest")],
            "dangerousInsecureTransportProtocol": true
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .expect("updater app");
    let state = updates::DesktopUpdates::new(app.package_info().version.to_string());
    assert_eq!(
        state
            .check(app.handle())
            .await
            .expect("check manifest")
            .phase,
        "available"
    );
    let lifecycle = TestLifecycle::default();
    let error = state
        .install(app.handle(), &lifecycle)
        .await
        .expect_err("tampered package must fail");
    assert!(
        error.contains("signature") || error.contains("Signature"),
        "unexpected failure: {error}"
    );
    assert_eq!(
        lifecycle.prepared.load(Ordering::SeqCst),
        0,
        "unauthenticated download must not stop the daemon"
    );
    assert_eq!(state.snapshot().phase, "error");
    assert_eq!(lifecycle.recovered.load(Ordering::SeqCst), 0);
    tampered.store(false, Ordering::SeqCst);
    let error = state
        .install(app.handle(), &lifecycle)
        .await
        .expect_err("checkpoint failure must abort installation");
    assert_eq!(error, "checkpoint flush failed");
    assert_eq!(
        lifecycle.prepared.load(Ordering::SeqCst),
        1,
        "authenticated download reaches shutdown exactly once"
    );
    assert_eq!(lifecycle.recovered.load(Ordering::SeqCst), 1);
    let recovering = Arc::new(tokio::sync::Notify::new());
    let recovered = Arc::new(tokio::sync::Notify::new());
    let blocked_lifecycle = TestLifecycle {
        recovery_gate: Some((recovering.clone(), recovered.clone())),
        ..Default::default()
    };
    let first = async {
        state
            .install(app.handle(), &blocked_lifecycle)
            .await
            .expect_err("preparation failure");
    };
    let retry = async {
        recovering.notified().await;
        assert_eq!(
            state.snapshot().phase,
            "installing",
            "error is not retryable before recovery"
        );
        let result = state.install(app.handle(), &lifecycle).await;
        recovered.notify_one();
        assert_eq!(
            result.expect_err("retry must remain blocked during recovery"),
            "An update operation is already in progress"
        );
    };
    tokio::join!(first, retry);
    let failed_recovery = TestLifecycle {
        recovery_error: Some("storage repair required".into()),
        ..Default::default()
    };
    assert_eq!(
        state
            .install(app.handle(), &failed_recovery)
            .await
            .unwrap_err(),
        "checkpoint flush failed; daemon recovery failed: storage repair required"
    );
    assert_eq!(
        state.snapshot().error.as_deref(),
        Some("checkpoint flush failed; daemon recovery failed: storage repair required")
    );
    #[cfg(target_os = "macos")]
    if std::env::var_os("BROWSER_RECALL_VERIFY_UPDATE_PACKAGE").is_some() {
        let install_dir = tempfile::tempdir().expect("isolated installation directory");
        let bundle = install_dir.path().join("Browser Recall.app");
        let executable = bundle.join("Contents/MacOS/browser-recall-desktop");
        std::fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("old bundle");
        std::fs::write(&executable, b"old application").expect("old executable");
        let update = app
            .handle()
            .updater_builder()
            .executable_path(&executable)
            .build()
            .expect("isolated updater")
            .check()
            .await
            .expect("check")
            .expect("available update");
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .expect("authenticated package");
        update.install(bytes).expect("install into isolated bundle");
        assert_ne!(
            std::fs::read(&executable).expect("installed executable"),
            b"old application"
        );
        let verifier = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/verify-macos-app-bundle.mjs");
        let verified = Command::new("node")
            .arg(verifier)
            .arg(bundle)
            .output()
            .expect("verify installed bundle");
        assert!(
            verified.status.success(),
            "installed bundle failed production signature verification"
        );
    }
    task.abort();
}
