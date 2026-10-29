use tauri::AppHandle;

pub fn start(app: &AppHandle) -> Result<(), String> {
    #[cfg(all(target_os = "macos", feature = "mac-app-store"))]
    if crate::distribution::reviews_enabled() {
        unsafe extern "C" {
            fn browser_recall_monitor_review_activity();
        }
        return app
            .run_on_main_thread(|| unsafe { browser_recall_monitor_review_activity() })
            .map_err(|error| error.to_string());
    }
    let _ = app;
    Ok(())
}

#[cfg(all(target_os = "macos", feature = "mac-app-store"))]
// AppKit callbacks must avoid configuration locks and file I/O. Persist on a
// blocking worker, then revalidate the request immediately before presentation.
async fn on_main(
    app: &AppHandle,
    request: Option<(u64, crate::reviews::Permit)>,
) -> Result<u64, String> {
    use crate::DesktopState;
    use std::ffi::c_void;
    use tauri::Manager;
    unsafe extern "C" {
        fn browser_recall_prepare_review(window: *const c_void) -> u64;
        fn browser_recall_request_review(window: *const c_void, epoch: u64) -> bool;
    }
    let handle = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let state = handle.state::<DesktopState>();
            let Ok(_operation) = state.operations.try_read() else {
                return Ok(0);
            };
            let shell = state.shell.lock();
            if handle
                .state::<crate::updates::DesktopUpdates>()
                .snapshot()
                .phase
                == "installing"
                || state.sync.is_in_progress()
                || !shell.setup_complete
                || shell.error.is_some()
                || !matches!(
                    shell.snapshot.service_state,
                    browser_recall_daemon::ServiceState::Running
                )
            {
                return Ok(0);
            }
            drop(shell);
            let window = handle
                .get_webview_window("main")
                .ok_or("main window is unavailable")?;
            let pointer = window.ns_window().map_err(|error| error.to_string())?;
            match request {
                Some((epoch, permit)) => {
                    // No await or file access between this check and StoreKit.
                    Ok(u64::from(
                        permit.is_current()
                            && unsafe { browser_recall_request_review(pointer, epoch) },
                    ))
                }
                None => Ok(unsafe { browser_recall_prepare_review(pointer) }),
            }
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

pub async fn prepare(app: &AppHandle) -> Result<Option<u64>, String> {
    #[cfg(all(target_os = "macos", feature = "mac-app-store"))]
    {
        let epoch = on_main(app, None).await?;
        Ok((epoch != 0).then_some(epoch))
    }
    #[cfg(not(all(target_os = "macos", feature = "mac-app-store")))]
    {
        let _ = app;
        Ok(None)
    }
}

pub async fn present(
    app: &AppHandle,
    epoch: u64,
    permit: crate::reviews::Permit,
) -> Result<bool, String> {
    #[cfg(all(target_os = "macos", feature = "mac-app-store"))]
    {
        Ok(on_main(app, Some((epoch, permit))).await? != 0)
    }
    #[cfg(not(all(target_os = "macos", feature = "mac-app-store")))]
    {
        let _ = (app, epoch, permit);
        Ok(false)
    }
}
