#[path = "../src/shell_contract.rs"]
mod shell_contract;

#[test]
fn unconfigured_data_directory_serializes_as_null() {
    assert_eq!(shell_contract::data_dir_payload(""), None);
    assert_eq!(
        shell_contract::data_dir_payload("C:\\browser-data"),
        Some("C:\\browser-data"),
    );
}

#[test]
fn desktop_shell_state_keeps_nullable_native_diagnostics_typed() {
    let response = shell_contract::DesktopShellStateResponse {
        success: true,
        login_item_supported: true,
        login_item_error: None,
        launch_at_login: true,
        debug_logging: false,
        setup_complete: false,
        data_dir: None,
        system_locale: None,
        paired_browsers: Vec::new(),
    };

    let value = serde_json::to_value(response).expect("serialize desktop shell state");
    assert!(value["loginItemError"].is_null());
    assert!(value["dataDir"].is_null());
}

#[test]
fn injected_shell_state_contains_only_the_pending_route() {
    let value = serde_json::to_value(shell_contract::ShellRoute {
        route: Some("settings"),
    })
    .expect("serialize injected shell route");

    assert_eq!(value, serde_json::json!({ "route": "settings" }));
}
