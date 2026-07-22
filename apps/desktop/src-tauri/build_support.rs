use serde_json::Value;
use std::{fs, path::Path, path::PathBuf};

pub fn require_frontend_dist(config_path: &Path) -> Result<PathBuf, String> {
    let config_text = fs::read_to_string(config_path).map_err(|error| {
        format!(
            "failed to read Tauri configuration at {}: {error}",
            config_path.display()
        )
    })?;
    let config: Value = serde_json::from_str(&config_text).map_err(|error| {
        format!(
            "failed to parse Tauri configuration at {}: {error}",
            config_path.display()
        )
    })?;
    let configured_path = config
        .pointer("/build/frontendDist")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "Tauri configuration at {} must define build.frontendDist as a directory path",
                config_path.display()
            )
        })?;
    let config_dir = config_path.parent().ok_or_else(|| {
        format!(
            "Tauri configuration path has no parent directory: {}",
            config_path.display()
        )
    })?;
    let frontend_dist = config_dir.join(configured_path);
    if !frontend_dist.is_dir() {
        return Err(format!(
            "Tauri frontendDist does not exist at {}. Run `npm run build:desktop-ui` from the repository root before invoking Cargo directly on desktop or workspace targets.",
            frontend_dist.display()
        ));
    }
    Ok(frontend_dist)
}
