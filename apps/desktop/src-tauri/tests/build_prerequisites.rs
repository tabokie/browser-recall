#[path = "../build_support.rs"]
mod build_support;

use std::fs;

#[cfg(feature = "mac-app-store")]
#[test]
fn mac_app_store_context_excludes_github_sync_and_javascript_rule_editor() {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!(test = true);
    let assets = context.assets();
    for module in [
        "desktop-sync.js",
        "desktop-sync.css",
        "desktop-sync-markup.js",
        "desktop-javascript-rules.js",
    ] {
        assert!(
            assets.get(&module.into()).is_none(),
            "embedded optional asset {module}"
        );
    }
    let features = assets
        .get(&"desktop-features.js".into())
        .expect("feature exports");
    let features = std::str::from_utf8(&features).expect("UTF-8 feature exports");
    assert!(features.contains("export const createDesktopSync = null;"));
    assert!(features.contains("export const javascriptRuleEditor = null;"));
    for (file, sync_control, local_control) in [
        ("index.html", "syncConfigFields", "settingsModal"),
        ("index.js", "getSyncAuthState", "flushDesktopQueue"),
    ] {
        let content = assets.get(&file.into()).expect("embedded desktop asset");
        let source = std::str::from_utf8(&content).expect("UTF-8 desktop asset");
        assert!(
            source.contains(local_control),
            "missing {local_control} in {file}"
        );
        assert!(
            !source.contains(sync_control),
            "GitHub sync bundled in {file}"
        );
    }
    let content = assets
        .get(&"index.js".into())
        .expect("embedded desktop script");
    let script = std::str::from_utf8(&content).expect("UTF-8 desktop script");
    assert!(!script.contains("fnSource"));
    assert!(!script.contains("function highlightJS("));
    assert!(script.contains("desktopJavaScriptRuleUnavailable"));
}

#[test]
fn release_build_uses_the_windows_gui_subsystem() {
    let main_source = include_str!("../src/main.rs");

    assert!(
        main_source
            .contains(r#"#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]"#),
        "release builds must not allocate a Windows console before the Tauri window"
    );
}

#[test]
fn single_instance_precedes_deep_link_and_forwards_protocol_activations() {
    let manifest = include_str!("../Cargo.toml");
    let main_source = include_str!("../src/main.rs");

    assert!(
        manifest.contains(
            r#"tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }"#
        ),
        "desktop builds must enable the single-instance plugin's deep-link integration"
    );

    let single_instance = main_source
        .find(".plugin(tauri_plugin_single_instance::init")
        .expect("the single-instance plugin must be registered");
    let first_existing_plugin = main_source
        .find(".plugin(tauri_plugin_dialog::init())")
        .expect("the dialog plugin registration must remain present");
    assert!(
        single_instance < first_existing_plugin,
        "single-instance must be the first Tauri plugin"
    );
    assert!(
        main_source[single_instance..first_existing_plugin].contains("show_main_window(app)"),
        "a second protocol activation must reveal and focus the existing window"
    );
}

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

#[test]
fn icon_changes_invalidate_the_tauri_build_context() {
    let build_source = include_str!("../build.rs");

    for icon in ["icons/icon.png", "icons/icon.ico", "icons/icon.icns"] {
        assert!(
            build_source.contains(&format!("cargo:rerun-if-changed={icon}")),
            "desktop build script must watch {icon}"
        );
    }
}
