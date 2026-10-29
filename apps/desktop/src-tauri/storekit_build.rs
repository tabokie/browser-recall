use std::{env, path::Path, process::Command};

fn output(arguments: &[&str]) -> Result<String, String> {
    let result = Command::new("xcrun")
        .args(arguments)
        .output()
        .map_err(|error| format!("could not run the StoreKit Swift build: {error}"))?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).into_owned());
    }
    String::from_utf8(result.stdout).map_err(|error| error.to_string())
}

pub fn build(manifest_dir: &Path) -> Result<(), String> {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return Err("mac-app-store builds require a macOS target".into());
    }
    let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => return Err("unsupported Mac App Store architecture".into()),
    };
    let deployment = env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| {
        if architecture == "arm64" {
            "11.0"
        } else {
            "10.13"
        }
        .into()
    });
    let target = format!("{architecture}-apple-macosx{deployment}");
    let out = env::var("OUT_DIR").map_err(|error| error.to_string())?;
    let source = manifest_dir.join("src/reviews.swift");
    let source = source.to_str().ok_or("StoreKit source path is not UTF-8")?;
    let sdk = output(&["--sdk", "macosx", "--show-sdk-path"])?;
    let library = format!("{out}/libbrowser_recall_reviews.a");
    let cache = format!("{out}/swift-module-cache");
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    output(&[
        "swiftc",
        "-warnings-as-errors",
        "-parse-as-library",
        "-emit-library",
        "-static",
        "-O",
        "-module-name",
        "BrowserRecallReviews",
        "-target",
        &target,
        "-sdk",
        sdk.trim(),
        "-module-cache-path",
        &cache,
        source,
        "-o",
        &library,
    ])?;
    let info: serde_json::Value = serde_json::from_str(&output(&[
        "swiftc",
        "-print-target-info",
        "-target",
        &target,
        "-sdk",
        sdk.trim(),
    ])?)
    .map_err(|error| error.to_string())?;
    let paths = info["paths"]["runtimeLibraryPaths"]
        .as_array()
        .ok_or("Swift did not report runtime library paths")?;
    for path in paths {
        let path = path.as_str().ok_or("Swift runtime path is not a string")?;
        println!("cargo:rustc-link-search=native={path}");
    }
    println!(
        "cargo:rustc-link-search=native={}/usr/lib/swift",
        sdk.trim()
    );
    println!("cargo:rustc-link-search=native={out}");
    println!("cargo:rustc-link-lib=static=browser_recall_reviews");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    Ok(())
}
