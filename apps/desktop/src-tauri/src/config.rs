use crate::login_item;
use browser_recall_daemon::{ConfigStore, DaemonConfig};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

type BoxError = Box<dyn Error>;

pub struct DesktopBootstrap {
    pub config_store: ConfigStore,
    pub config: DaemonConfig,
    pub log_dir: PathBuf,
}

pub fn bootstrap<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopBootstrap, BoxError> {
    let config_store = daemon_config_store(app)?;
    let log_dir = desktop_log_dir(app)?;
    let mut config = config_store.load_or_create()?;

    if !config.setup_complete && config.data_dir == config_store.default_data_dir() {
        config.data_dir = PathBuf::new();
        config_store.save(&config)?;
    }

    if !login_item::is_supported() && config.launch_at_login {
        config.launch_at_login = false;
        config_store.save(&config)?;
    }

    if config.setup_complete {
        fs::create_dir_all(&config.data_dir)?;
        if config.launch_at_login {
            login_item::sync_login_item(true)?;
        }
    }

    Ok(DesktopBootstrap {
        config_store,
        config,
        log_dir,
    })
}

pub fn daemon_config_store<R: Runtime>(app: &AppHandle<R>) -> Result<ConfigStore, tauri::Error> {
    let config_dir = app.path().app_config_dir()?.join("daemon");
    Ok(ConfigStore::new(config_dir))
}

pub fn desktop_log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, tauri::Error> {
    #[cfg(target_os = "macos")]
    {
        Ok(app.path().home_dir()?.join("Library/Logs/browser-recall"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        app.path().app_log_dir()
    }
}
