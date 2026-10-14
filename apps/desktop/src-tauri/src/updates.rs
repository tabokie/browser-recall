use parking_lot::Mutex;
use serde::Serialize;
use std::{future::Future, time::Duration};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const EVENT: &str = "desktop-update-state";

pub trait UpdateLifecycle: Sync {
    type Guard: Send;
    fn prepare(&self) -> impl Future<Output = Result<Self::Guard, String>> + Send;
    fn recover(&self) -> impl Future<Output = Result<(), String>> + Send;
    fn restart(&self);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub phase: &'static str,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

pub struct DesktopUpdates {
    status: Mutex<UpdateStatus>,
    pending: Mutex<Option<Update>>,
    operation: tokio::sync::Mutex<()>,
}

impl DesktopUpdates {
    pub fn new(version: String) -> Self {
        Self {
            status: Mutex::new(UpdateStatus {
                current_version: version,
                phase: "idle",
                version: None,
                notes: None,
                downloaded_bytes: 0,
                total_bytes: None,
                error: None,
            }),
            pending: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
        }
    }

    pub fn snapshot(&self) -> UpdateStatus {
        self.status.lock().clone()
    }

    fn publish<R: Runtime>(&self, app: &AppHandle<R>, change: impl FnOnce(&mut UpdateStatus)) {
        let status = {
            let mut status = self.status.lock();
            change(&mut status);
            status.clone()
        };
        if let Err(error) = app.emit(EVENT, status) {
            tracing::warn!(%error, "could not publish desktop update status");
        }
    }

    fn fail<R: Runtime>(&self, app: &AppHandle<R>, error: String) -> String {
        self.publish(app, |status| {
            status.phase = "error";
            status.error = Some(error.clone());
        });
        error
    }

    pub async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> Result<UpdateStatus, String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "An update operation is already in progress".to_string())?;
        self.publish(app, |status| {
            status.phase = "checking";
            status.error = None;
        });
        let result = async {
            app.updater_builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| error.to_string())?
                .check()
                .await
                .map_err(|error| error.to_string())
        }
        .await;
        match result {
            Ok(update) => {
                self.publish(app, |status| {
                    status.phase = if update.is_some() {
                        "available"
                    } else {
                        "current"
                    };
                    status.version = update.as_ref().map(|update| update.version.clone());
                    status.notes = update.as_ref().and_then(|update| update.body.clone());
                    status.downloaded_bytes = 0;
                    status.total_bytes = None;
                });
                *self.pending.lock() = update;
                Ok(self.snapshot())
            }
            Err(error) => Err(self.fail(app, error)),
        }
    }

    // Serialize the entire transaction, including recovery and restart. Do not
    // expose a retryable error until the daemon is available again.
    pub async fn install<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        lifecycle: &impl UpdateLifecycle,
    ) -> Result<(), String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "An update operation is already in progress".to_string())?;
        let mut update = self
            .pending
            .lock()
            .clone()
            .ok_or_else(|| "Check for an available update before installing".to_string())?;
        // Manifest requests are small; application packages need enough time
        // to download over a slower connection.
        update.timeout = Some(Duration::from_secs(10 * 60));
        self.publish(app, |status| {
            status.phase = "downloading";
            status.error = None;
            status.downloaded_bytes = 0;
            status.total_bytes = None;
        });
        let bytes = update
            .download(
                |length, total| {
                    self.publish(app, |status| {
                        status.downloaded_bytes += length as u64;
                        status.total_bytes = total;
                    });
                },
                || {},
            )
            .await
            .map_err(|error| self.fail(app, error.to_string()))?;
        self.publish(app, |status| status.phase = "installing");
        let preparation = lifecycle.prepare().await;
        // Keep the native command guard through recovery or restart.
        let result = match &preparation {
            Err(error) => Err(error.clone()),
            Ok(_) => tauri::async_runtime::spawn_blocking(move || update.install(bytes))
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result.map_err(|error| error.to_string())),
        };
        match result {
            Ok(()) => {
                lifecycle.restart();
                Ok(())
            }
            Err(error) => {
                let error = match lifecycle.recover().await {
                    Ok(()) => error,
                    Err(recovery) => format!("{error}; daemon recovery failed: {recovery}"),
                };
                Err(self.fail(app, error))
            }
        }
    }
}
