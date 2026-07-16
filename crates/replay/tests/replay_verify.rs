use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_path(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "browser-recall-replay-verify-{label}-{}-{nonce}",
        std::process::id()
    ))
}

#[test]
fn verifier_ignores_files_outside_the_log_namespace() {
    let data_dir = temp_path("data");
    let output_dir = temp_path("output");
    let device_dir = data_dir.join("logs/device-a");
    fs::create_dir_all(&device_dir).expect("device log directory");
    fs::write(data_dir.join("logs/.DS_Store"), "metadata").expect("root metadata file");
    fs::write(device_dir.join("README.txt"), "unowned").expect("device metadata file");

    let output = Command::new(env!("CARGO_BIN_EXE_replay-verify"))
        .args([
            "--data-dir",
            data_dir.to_str().expect("UTF-8 data path"),
            "--write",
            output_dir.to_str().expect("UTF-8 output path"),
        ])
        .output()
        .expect("run replay verifier");

    assert!(
        output.status.success(),
        "verifier rejected an unowned file: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    fs::remove_dir_all(data_dir).expect("remove data tempdir");
    fs::remove_dir_all(output_dir).expect("remove output tempdir");
}
