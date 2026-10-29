#[cfg(target_os = "macos")]
#[path = "../src/snapshot_open.rs"]
mod snapshot_open;

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "opens and inspects a Finder window; requires a macOS desktop session"]
async fn snapshot_directory_selects_snapshot_files_in_finder() {
    use browser_recall_daemon::storage::Storage;
    use std::{
        fs,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    let work = tempfile::Builder::new()
        .prefix("browser-recall snapshot files ")
        .tempdir()
        .expect("create snapshot test directory");
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
    let markdown_path = storage
        .save_snapshot_markdown(slug, timestamp, "Snapshot folder test")
        .await
        .expect("write snapshot Markdown fixture");
    fs::write(directory.join("unrelated.html"), "Unrelated snapshot")
        .expect("write unrelated snapshot fixture");

    let script = r#"
on run arguments
  set expectedFolder to (POSIX file (item 1 of arguments)) as alias
  set expectedFiles to {}
  repeat with argumentIndex from 2 to count arguments
    set end of expectedFiles to (POSIX file (item argumentIndex of arguments)) as alias
  end repeat
  set lastObservation to "Finder window unavailable"
  with timeout of 3 seconds
    tell application "Finder"
      repeat 20 times
        try
          set candidateWindow to get front Finder window
          set candidateFolder to (get target of candidateWindow) as alias
          set lastObservation to "Finder folder: " & POSIX path of candidateFolder
          if candidateFolder is expectedFolder then
            set selectedFiles to selection as alias list
            set lastObservation to "Selected files: " & (count selectedFiles) & "; expected: " & (count expectedFiles)
            set selectionMatches to (count selectedFiles) is (count expectedFiles)
            repeat with expectedFile in expectedFiles
              if selectedFiles does not contain (contents of expectedFile) then
                set selectionMatches to false
              end if
            end repeat
            if selectionMatches then
              close candidateWindow
              return "verified"
            end if
          end if
        on error errorMessage
          set lastObservation to errorMessage
        end try
        delay 0.1
      end repeat
      repeat with candidateWindow in Finder windows
        try
          if (get target of candidateWindow) as alias is expectedFolder then
            close candidateWindow
          end if
        end try
      end repeat
    end tell
  end timeout
  error "Finder did not select the snapshot files in the snapshot shard directory. " & lastObservation
end run
"#;
    for include_markdown in [true, false] {
        if !include_markdown {
            fs::remove_file(&markdown_path).expect("remove optional snapshot Markdown fixture");
        }
        snapshot_open::open_snapshot(&storage, slug, timestamp, true)
            .expect("reveal the snapshot files through production code");
        let mut command = Command::new("osascript");
        command
            .args(["-e", script])
            .arg(directory)
            .arg(&snapshot_path);
        if include_markdown {
            command.arg(&markdown_path);
        }
        let mut process = command
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

    fs::remove_file(&snapshot_path).expect("remove snapshot HTML fixture");
    assert!(
        snapshot_open::open_snapshot(&storage, slug, timestamp, true).is_err(),
        "an existing shard directory must not hide a missing snapshot HTML file"
    );
}
