use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use browser_recall_replay::generate_slug_from_url;
use serde_json::json;

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

fn write_json(path: &Path, value: &serde_json::Value) {
    fs::create_dir_all(path.parent().expect("JSON parent directory"))
        .expect("create JSON parent directory");
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).expect("serialize JSON")
        ),
    )
    .expect("write JSON");
}

fn run_verifier(data_dir: &Path, output_dir: &Path) -> String {
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
        "verifier failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("UTF-8 verifier output")
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

#[test]
fn verifier_replays_side_effects_for_logged_note_tombstones() {
    let data_dir = temp_path("logged-note-tombstone-data");
    let output_dir = temp_path("logged-note-tombstone-output");
    let device_dir = data_dir.join("logs/device-a");
    fs::create_dir_all(&device_dir).expect("device log directory");
    fs::write(
        device_dir.join("2026-01-01.jsonl"),
        [
            r#"{"action":"create_note","timestamp":10,"url":"https://example.com/","path":"objects/notes/n1.json","title":"Example","excerpt":["one"],"note":"","cssPath":["body"]}"#,
            r#"{"action":"delete_note","timestamp":20,"url":"https://example.com/","path":"objects/notes/n1.json"}"#,
            r#"{"action":"create_note","timestamp":30,"url":"https://example.com/","path":"objects/notes/n2.json","title":"Example","excerpt":["two"],"note":"","cssPath":["body"]}"#,
            r#"{"action":"delete_note","timestamp":40,"url":"https://example.com/","path":"objects/notes/n2.json"}"#,
        ]
        .join("\n"),
    )
    .expect("write note logs");
    write_json(
        &data_dir.join("objects/notes/n1.json"),
        &json!({
            "slug": "n1",
            "excerpt": ["one"],
            "note": "",
            "cssPath": ["body"],
            "url": "https://example.com/",
            "deleted": true,
            "deletedTs": 20,
            "deletionReason": null,
            "replacedBy": null
        }),
    );
    write_json(
        &data_dir.join("views/manifest/orphaned.json"),
        &json!({
            "timestamps": {"device-a": 40},
            "entries": [
                {"key": "note:n1", "url": "https://example.com/"},
                {"key": "note:n2", "url": "https://example.com/"}
            ]
        }),
    );

    let stdout = run_verifier(&data_dir, &output_dir);

    assert!(
        stdout.contains("data:           0"),
        "logged tombstone side effects should replay from their logs:\n{stdout}"
    );
    assert!(
        stdout.contains("Existing-only:  0"),
        "logged tombstone side effects should not be checkpoint-only:\n{stdout}"
    );

    fs::remove_dir_all(data_dir).expect("remove data tempdir");
    fs::remove_dir_all(output_dir).expect("remove output tempdir");
}

#[test]
fn verifier_treats_selective_checkpoint_created_at_as_timing_drift() {
    let data_dir = temp_path("created-at-drift-data");
    let output_dir = temp_path("created-at-drift-output");
    let device_dir = data_dir.join("logs/device-a");
    fs::create_dir_all(&device_dir).expect("device log directory");
    fs::write(
        device_dir.join("1970-01-01.jsonl"),
        [
            r#"{"action":"create_list","timestamp":1,"name":"List A","listOwner":"device-a","listId":"list-a","parentListId":null}"#,
            r#"{"action":"visit_page","timestamp":10,"url":"https://example.com/page","title":"Page","referrerUrl":null}"#,
            r#"{"action":"pin_to_list","timestamp":20,"name":"List A","listOwner":"device-a","urls":["https://example.com/page"],"titles":["Page"],"source":null}"#,
        ]
        .join("\n"),
    )
    .expect("write page logs");
    let slug = generate_slug_from_url("https://example.com/page").expect("page slug");
    write_json(
        &data_dir.join(format!("views/pages/fixture/{slug}.json")),
        &json!({
            "slug": slug,
            "parentIds": ["list:list-a"],
            "childIds": [],
            "timestamps": {"device-a": 20},
            "url": "https://example.com/page",
            "title": "Page",
            "createdAt": 20,
            "visitDates": [19700101],
            "scrollDepth": null,
            "timeOnPage": null,
            "user_title": null,
            "likes": null
        }),
    );

    let stdout = run_verifier(&data_dir, &output_dir);

    assert!(
        stdout.contains("data:           0"),
        "an earlier visit recovered by full replay should be timing drift:\n{stdout}"
    );
    assert!(
        stdout.contains("timing-drift:   1"),
        "createdAt reconstruction should remain visible as timing drift:\n{stdout}"
    );

    fs::remove_dir_all(data_dir).expect("remove data tempdir");
    fs::remove_dir_all(output_dir).expect("remove output tempdir");
}

#[test]
fn verifier_treats_unlogged_locale_migration_as_schema_gap() {
    let data_dir = temp_path("locale-schema-gap-data");
    let output_dir = temp_path("locale-schema-gap-output");
    let device_dir = data_dir.join("logs/device-a");
    fs::create_dir_all(&device_dir).expect("device log directory");
    fs::write(
        device_dir.join("2026-01-01.jsonl"),
        r#"{"action":"update_setting","timestamp":10,"key":"theme","value":"dark"}"#,
    )
    .expect("write setting log");
    write_json(
        &data_dir.join("views/manifest/settings.json"),
        &json!({
            "timestamps": {"device-a": 10},
            "theme": "dark",
            "localeOverride": "en"
        }),
    );

    let stdout = run_verifier(&data_dir, &output_dir);

    assert!(
        stdout.contains("data:           0"),
        "a setting introduced through legacy checkpoint migration is a schema gap:\n{stdout}"
    );
    assert!(
        stdout.contains("schema-gap:     1"),
        "the unlogged locale field should remain visible as a schema gap:\n{stdout}"
    );

    fs::remove_dir_all(data_dir).expect("remove data tempdir");
    fs::remove_dir_all(output_dir).expect("remove output tempdir");
}
