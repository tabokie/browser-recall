use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShellStateResponse<'a> {
    pub success: bool,
    pub login_item_supported: bool,
    pub login_item_error: Option<&'a str>,
    pub launch_at_login: bool,
    pub debug_logging: bool,
    pub setup_complete: bool,
    pub data_dir: Option<&'a str>,
    pub system_locale: Option<String>,
    pub paired_browsers: Vec<Value>,
}

#[derive(Serialize)]
pub struct ShellRoute<'a> {
    pub route: Option<&'a str>,
}

pub fn data_dir_payload(data_dir: &str) -> Option<&str> {
    (!data_dir.is_empty()).then_some(data_dir)
}
