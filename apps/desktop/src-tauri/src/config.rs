use crate::login_item;
use browser_recall_daemon::{ConfigStore, DaemonConfig};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

type BoxError = Box<dyn Error>;
const DESKTOP_TEST_PROFILE_DIR_ENV: &str = "BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR";

pub struct DesktopBootstrap {
    pub config_store: ConfigStore,
    pub config: DaemonConfig,
    pub log_dir: PathBuf,
    pub login_item_error: Option<String>,
}

pub fn bootstrap<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopBootstrap, BoxError> {
    let config_store = daemon_config_store(app)?;
    let log_dir = desktop_log_dir(app)?;
    let mut config = config_store.load_or_create()?;
    let login_item = login_item::SystemLoginItem::new(app);

    if !login_item.supported() && config.launch_at_login {
        config.launch_at_login = false;
        config_store.save(&config)?;
    }

    let login_item_error = if config.is_configured() {
        fs::create_dir_all(&config.data_dir)?;
        login_item::reconcile_for_startup(&login_item, config.launch_at_login)
    } else {
        None
    };

    Ok(DesktopBootstrap {
        config_store,
        config,
        log_dir,
        login_item_error,
    })
}

pub fn daemon_config_store<R: Runtime>(app: &AppHandle<R>) -> Result<ConfigStore, tauri::Error> {
    if let Some(profile_dir) = desktop_test_profile_dir()? {
        return Ok(ConfigStore::new(profile_dir.join("daemon")));
    }
    let config_dir = app.path().app_config_dir()?.join("daemon");
    Ok(ConfigStore::new(config_dir))
}

pub fn desktop_log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, tauri::Error> {
    if let Some(profile_dir) = desktop_test_profile_dir()? {
        return Ok(profile_dir.join("logs"));
    }

    #[cfg(target_os = "macos")]
    {
        Ok(app.path().home_dir()?.join("Library/Logs/browser-recall"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        app.path().app_log_dir()
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
