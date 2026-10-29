use browser_recall_daemon::storage::Storage;

pub fn open_snapshot(
    storage: &Storage,
    slug: &str,
    timestamp: i64,
    directory: bool,
) -> Result<(), String> {
    let snapshot_path = storage.snapshot_html_file_path(slug, timestamp);
    if !snapshot_path
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        return Err("Snapshot not found".to_string());
    }
    if directory {
        let markdown_path = snapshot_path.with_extension("md");
        let mut snapshot_paths = vec![snapshot_path];
        if markdown_path
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            snapshot_paths.push(markdown_path);
        }
        tauri_plugin_opener::reveal_items_in_dir(snapshot_paths).map_err(|error| error.to_string())
    } else {
        tauri_plugin_opener::open_path(snapshot_path, None::<&str>)
            .map_err(|error| error.to_string())
    }
}
