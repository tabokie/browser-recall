mod build_support;

use std::{env, path::PathBuf, process};

fn try_build() -> Result<(), String> {
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| "Cargo did not provide CARGO_MANIFEST_DIR".to_string())?;
    let config_path = manifest_dir.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config_path.display());
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    build_support::require_frontend_dist(&config_path)?;
    tauri_build::try_build(tauri_build::Attributes::default())
        .map_err(|error| format!("failed to generate the Tauri build context: {error:#}"))
}

fn main() {
    if let Err(error) = try_build() {
        eprintln!("error: {error}");
        process::exit(1);
    }
}
