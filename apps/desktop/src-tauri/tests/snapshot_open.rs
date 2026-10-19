#[cfg(target_os = "macos")]
#[path = "../src/snapshot_open.rs"]
mod snapshot_open;

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "opens and inspects a Finder window; requires a macOS desktop session"]
async fn snapshot_directory_opens_the_storage_shard_in_finder() {
    use browser_recall_daemon::storage::Storage;
    use std::{
        fs,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    let work = tempfile::tempdir().expect("create snapshot test directory");
    let storage = Storage::new(work.path());
    let slug = "example-snapshot-folder";
    let timestamp = 1792407994618;
    let snapshot_path = storage.snapshot_html_file_path(slug, timestamp);
    let directory = snapshot_path.parent().expect("snapshot shard directory");
    fs::create_dir_all(directory).expect("create snapshot shard");
    fs::write(
        &snapshot_path,
        "<!doctype html><title>Snapshot folder test</title>",
    )
    .expect("write snapshot fixture");

    snapshot_open::open_snapshot(&storage, slug, timestamp, true)
        .expect("open the snapshot directory through production code");
    let script = r#"
on run arguments
  set expectedFolder to (POSIX file (item 1 of arguments)) as alias
  with timeout of 3 seconds
    tell application "Finder"
      repeat 20 times
        try
          set candidateWindow to get front Finder window
          set candidateFolder to (get target of candidateWindow) as alias
          if candidateFolder is expectedFolder then
            close candidateWindow
            return "verified"
          end if
        end try
        delay 0.1
      end repeat
    end tell
  end timeout
  error "Finder did not open the snapshot shard directory"
end run
"#;
    let mut process = Command::new("osascript")
        .args(["-e", script])
        .arg(directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("inspect the Finder window");
    let started = Instant::now();
    let mut timed_out = false;
    while process
        .try_wait()
        .expect("check Finder verification")
        .is_none()
    {
        if started.elapsed() >= Duration::from_secs(15) {
            timed_out = true;
            process.kill().expect("stop timed-out Finder verification");
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let output = process
        .wait_with_output()
        .expect("read Finder verification");
    assert!(!timed_out, "Finder verification exceeded 15 seconds");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "verified");
}
