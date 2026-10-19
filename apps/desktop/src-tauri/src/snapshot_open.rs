use browser_recall_daemon::storage::Storage;

pub fn open_snapshot(
    storage: &Storage,
    slug: &str,
    timestamp: i64,
    directory: bool,
) -> Result<(), String> {
    let snapshot_path = storage.snapshot_html_file_path(slug, timestamp);
    let target_path = if directory {
        snapshot_path
            .parent()
            .ok_or_else(|| "Snapshot directory is unavailable".to_string())?
    } else {
        snapshot_path.as_path()
    };
    if !target_path.exists() {
        return Err("Snapshot not found".to_string());
    }
    tauri_plugin_opener::open_path(target_path, None::<&str>).map_err(|error| error.to_string())
}
