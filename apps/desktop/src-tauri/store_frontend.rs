use serde_json::{json, Map, Value};
use std::{env, fs, io, path::Path};

pub fn prepare(manifest_dir: &Path, default_frontend: &Path) -> Result<(), String> {
    let mut config: Map<String, Value> = match env::var("TAURI_CONFIG") {
        Ok(config) => serde_json::from_str(&config).map_err(|error| error.to_string())?,
        Err(env::VarError::NotPresent) => Map::new(),
        Err(error) => return Err(error.to_string()),
    };
    let build = config
        .entry("build")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("TAURI_CONFIG build must be an object")?;
    let configured_frontend = build
        .get("frontendDist")
        .map(|value| {
            value
                .as_str()
                .map(|path| manifest_dir.join(path))
                .ok_or("Mac App Store frontendDist must be a directory path")
        })
        .transpose()?;
    let source = configured_frontend.as_deref().unwrap_or(default_frontend);
    let out_dir = env::var_os("OUT_DIR").ok_or("Cargo did not provide OUT_DIR")?;
    let target = Path::new(&out_dir).join("app-store-ui");
    println!("cargo:rerun-if-changed={}", source.display());

    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("could not clear {}: {error}", target.display()))?;
    }
    copy_directory(source, &target).map_err(|error| {
        format!(
            "could not stage Mac App Store assets from {}: {error}",
            source.display()
        )
    })?;
    for name in [
        "desktop-sync.js",
        "desktop-sync.css",
        "desktop-sync-markup.js",
        "desktop-javascript-rules.js",
    ] {
        let asset = target.join(name);
        fs::remove_file(&asset)
            .map_err(|error| format!("could not exclude {}: {error}", asset.display()))?;
    }
    fs::write(
        target.join("desktop-features.js"),
        "export const createDesktopSync = null;\nexport const javascriptRuleEditor = null;\n",
    )
    .map_err(|error| format!("could not write Mac App Store feature exports: {error}"))?;

    // Use the same Cargo feature for Rust command registration and asset selection.
    // Keep the Tauri CLI overlay for signing and other distribution settings.
    build.insert("frontendDist".into(), json!(target));
    println!("cargo:rustc-env=TAURI_CONFIG={}", json!(config));
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}
