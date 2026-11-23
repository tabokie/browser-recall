use crate::login_item;
use browser_recall_daemon::{ConfigStore, DaemonConfig};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
#[cfg(not(feature = "mac-app-store"))]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

type BoxError = Box<dyn Error>;
const DESKTOP_TEST_PROFILE_DIR_ENV: &str = "BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR";

pub struct DesktopBootstrap {
    pub config_store: ConfigStore,
    pub config: DaemonConfig,
    pub log_dir: PathBuf,
    pub login_item_error: Option<String>,
    #[cfg(feature = "mac-app-store")]
    pub library_access: Option<crate::library_access::LibraryAccess>,
    #[cfg(feature = "mac-app-store")]
    pub library_access_error: Option<String>,
}

pub fn bootstrap<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopBootstrap, BoxError> {
    #[cfg(target_os = "windows")]
    crate::windows_startup::record("configuration paths resolving");
    let config_store = daemon_config_store(app)?;
    let log_dir = desktop_log_dir(app)?;
    #[cfg(target_os = "windows")]
    crate::windows_startup::record("configuration load/create entered");
    let mut config = config_store.load_or_create()?;
    #[cfg(target_os = "windows")]
    crate::windows_startup::record("configuration load/create finished");
    let login_item = login_item::SystemLoginItem::new(app);

    if !login_item.supported() && config.launch_at_login {
        config = config_store.update(|config| {
            config.launch_at_login = false;
            Ok(config.clone())
        })?;
    }

    #[cfg(feature = "mac-app-store")]
    let (library_access, library_access_error) =
        match crate::library_access::LibraryAccess::restore(&config_store, &mut config) {
            Ok(access) => (access, None),
            Err(error) => {
                // Keep the saved configuration so setup can offer the previous folder again.
                config.setup_complete = false;
                config.data_dir.clear();
                (None, Some(error))
            }
        };

    #[cfg(target_os = "windows")]
    crate::windows_startup::record("login item reconciliation entered");
    let login_item_error = if config.is_configured() {
        fs::create_dir_all(&config.data_dir)?;
        login_item::reconcile_for_startup(&login_item, config.launch_at_login)
    } else {
        None
    };
    #[cfg(target_os = "windows")]
    crate::windows_startup::record("login item reconciliation finished");

    Ok(DesktopBootstrap {
        config_store,
        config,
        log_dir,
        login_item_error,
        #[cfg(feature = "mac-app-store")]
        library_access,
        #[cfg(feature = "mac-app-store")]
        library_access_error,
    })
}

pub fn daemon_config_store<R: Runtime>(app: &AppHandle<R>) -> Result<ConfigStore, tauri::Error> {
    let path = match desktop_test_profile_dir()? {
        Some(profile_dir) => profile_dir,
        #[cfg(feature = "mac-app-store")]
        None => crate::library_access::app_home()
            .join("Library/Application Support")
            .join(&app.config().identifier),
        #[cfg(not(feature = "mac-app-store"))]
        None => app.path().app_config_dir()?,
    };
    let store = ConfigStore::new(path);
    #[cfg(feature = "mac-app-store")]
    let store = store.with_installation_device_id();
    Ok(store)
}

pub fn desktop_log_dir<R: Runtime>(_app: &AppHandle<R>) -> Result<PathBuf, tauri::Error> {
    if let Some(profile_dir) = desktop_test_profile_dir()? {
        return Ok(profile_dir.join("logs"));
    }

    #[cfg(feature = "mac-app-store")]
    return Ok(crate::library_access::app_home().join("Library/Logs/browser-recall"));

    #[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
    {
        Ok(_app.path().home_dir()?.join("Library/Logs/browser-recall"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        _app.path().app_log_dir()
    }
}

fn desktop_test_profile_dir() -> std::io::Result<Option<PathBuf>> {
    let Some(value) = std::env::var_os(DESKTOP_TEST_PROFILE_DIR_ENV) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{DESKTOP_TEST_PROFILE_DIR_ENV} must not be empty"),
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{DESKTOP_TEST_PROFILE_DIR_ENV} must be absolute"),
        ));
    }
    Ok(Some(path))
}
