pub const MAC_APP_STORE_BUILD: bool = cfg!(all(target_os = "macos", feature = "mac-app-store"));

pub fn reviews_enabled() -> bool {
    MAC_APP_STORE_BUILD && std::env::var_os("BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR").is_none()
}
