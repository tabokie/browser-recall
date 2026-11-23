mod build_support;
#[cfg(feature = "mac-app-store")]
mod store_frontend;
#[cfg(feature = "mac-app-store")]
mod storekit_build;

use std::{env, path::PathBuf, process};

fn try_build() -> Result<(), String> {
    if cfg!(all(
        feature = "mac-app-store",
        feature = "javascript-list-rules"
    )) {
        return Err("Mac App Store builds require --no-default-features and cannot enable javascript-list-rules".into());
    }
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| "Cargo did not provide CARGO_MANIFEST_DIR".to_string())?;
    let config_path = manifest_dir.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config_path.display());
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    // Tauri embeds the application's manifest only in binary targets. MSVC
    // integration tests also need Common Controls v6 before their harness starts.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let test_manifest = manifest_dir.join("tests/windows-app.manifest");
        println!("cargo:rerun-if-changed={}", test_manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            test_manifest.display()
        );
    }
    let _frontend_dist = build_support::require_frontend_dist(&config_path)?;
    #[cfg(feature = "mac-app-store")]
    {
        store_frontend::prepare(&manifest_dir, &_frontend_dist)?;
        storekit_build::build(&manifest_dir)?;
    }
    tauri_build::try_build(tauri_build::Attributes::default())
        .map_err(|error| format!("failed to generate the Tauri build context: {error:#}"))
}

fn main() {
    if let Err(error) = try_build() {
        eprintln!("error: {error}");
        process::exit(1);
    }
}
