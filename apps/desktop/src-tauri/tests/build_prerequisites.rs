#[path = "../build_support.rs"]
mod build_support;

use std::fs;

#[test]
fn missing_frontend_dist_error_names_the_staging_command() {
    let temp = tempfile::tempdir().expect("create temporary Tauri directory");
    let config_path = temp.path().join("tauri.conf.json");
    fs::write(
        &config_path,
        r#"{"build":{"frontendDist":"dist/desktop/ui"}}"#,
    )
    .expect("write Tauri config");

    let error = build_support::require_frontend_dist(&config_path)
        .expect_err("missing frontendDist should fail before Tauri code generation");

    assert!(error.contains("npm run build:desktop-ui"), "{error}");
    assert!(error.contains("dist/desktop/ui"), "{error}");
}
