#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

mod config;
mod logging;
mod login_item;
mod search;
mod shell_contract;
#[cfg(target_os = "windows")]
mod windows_icon;

use browser_recall_daemon::command_authority::CommandAuthority;
use browser_recall_daemon::commands::{
    list_history_files, list_paired_browsers, load_history_batch, page_relations_payload,
    pair_browser_revoke, preview_rule_payload, search_notes as command_search_notes,
    search_snapshots as command_search_snapshots,
};
use browser_recall_daemon::pairing::{
    ApprovalFuture, PairingApprover, PairingDecision, PairingRequest,
};
use browser_recall_daemon::protocol::{MutationPayload, RuleBatchEntry, RulePayload};
use browser_recall_daemon::read_projections::ReadProjections;
use browser_recall_daemon::search::{
    search_history_parallel_in_data_dir, search_notes_in_storage, search_snapshots_in_data_dir,
    NoteSearchHit, SnapshotSearchHit,
};
use browser_recall_daemon::storage::Storage;
use browser_recall_daemon::sync::{
    background_worker_loop, sync_device_entries_json, SyncBackgroundOutcome, SyncController,
    SyncError,
};
use browser_recall_daemon::ws_server::{
    start_server, ServerControlHandle, ServerHandle, ServerSnapshot, ServerStartOptions,
    ServiceState,
};
use browser_recall_daemon::{ConfigStore, DaemonConfig};
use parking_lot::Mutex;
use search::{CancelSearchRequest, SearchRequest, StreamingSearchRequest};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Notify;
use tracing::{info, warn};

const TRAY_ID: &str = "browser-recall";
const BRIDGE_RUNTIME_MESSAGE_EVENT: &str = "bridge-runtime-message";
const BRIDGE_SEARCH_HISTORY_EVENT: &str = "bridge-search-history";
const BRIDGE_STORAGE_CHANGE_EVENT: &str = "bridge-storage-change";
const NORMAL_WINDOW_WIDTH: f64 = 1120.0;
const NORMAL_WINDOW_HEIGHT: f64 = 760.0;

#[derive(Clone)]
struct ShellState {
    snapshot: ServerSnapshot,
    data_dir: String,
    log_dir: String,
    login_item_supported: bool,
    login_item_error: Option<String>,
    launch_at_login: bool,
    debug_logging: bool,
    setup_complete: bool,
    route: Option<String>,
    error: Option<String>,
}

struct DesktopState {
    server: Mutex<Option<ServerHandle>>,
    server_start: StartGate,
    config_store: ConfigStore,
    shell: Mutex<ShellState>,
    sync: SyncController,
    storage_bridge: Mutex<StorageBridgeState>,
    active_history_search: Mutex<Option<ActiveHistorySearch>>,
    logging: logging::LoggingHandle,
    quit_requested: Mutex<bool>,
    main_window_focus_pending: AtomicBool,
    main_window_frame: Mutex<Option<WindowFrame>>,
}

#[derive(Clone, Copy)]
struct WindowFrame {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[derive(Default)]
struct StartGate(tokio::sync::Mutex<()>);

impl StartGate {
    async fn run<T, E, Present, Start, StartFuture>(
        &self,
        present: Present,
        start: Start,
    ) -> Result<T, E>
    where
        Present: FnOnce() -> Option<T>,
        Start: FnOnce() -> StartFuture,
        StartFuture: std::future::Future<Output = Result<T, E>>,
    {
        let _guard = self.0.lock().await;
        if let Some(value) = present() {
            return Ok(value);
        }
        start().await
    }
}

struct ActiveHistorySearch {
    search_id: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct StorageBridgeState {
    session: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellSettingsUpdate {
    launch_at_login: bool,
    debug_logging: bool,
}

#[derive(Debug, Deserialize)]
struct OpenPathRequest {
    kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStorageGetRequest {
    area_name: String,
    keys: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStorageSetRequest {
    area_name: String,
    source_id: Option<String>,
    items: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStorageRemoveRequest {
    area_name: String,
    source_id: Option<String>,
    keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStorageClearRequest {
    area_name: String,
    source_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStorageBroadcastRequest {
    area_name: String,
    source_id: Option<String>,
    changes: Value,
}

fn pairing_approver(app: AppHandle) -> PairingApprover {
    std::sync::Arc::new(move |request: PairingRequest| -> ApprovalFuture {
        let app = app.clone();
        Box::pin(async move {
            let message = format!(
                "Browser: {} (extension ID: {})",
                request.browser_name, request.extension_id
            );
            let approved = app
                .dialog()
                .message(message)
                .title("Allow connection?")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Allow".to_string(),
                    "Deny".to_string(),
                ))
                .blocking_show();

            if approved {
                PairingDecision::Approve
            } else {
                PairingDecision::Deny
            }
        })
    })
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open").build(app)?;
    let logs = MenuItemBuilder::with_id("logs", "Logs").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&logs)
        .item(&settings)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("Browser Recall")
        .show_menu_on_left_click(tray_menu_shows_on_left_click())
        .on_tray_icon_event(|tray, event| {
            if tray_event_opens_main_window(&event) {
                let app = tray.app_handle();
                update_shell_state(app, |state| state.route = Some("open".to_string()));
                show_main_window(app);
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                update_shell_state(app, |state| state.route = Some("open".to_string()));
                show_main_window(app);
            }
            "settings" => {
                update_shell_state(app, |state| {
                    state.route = Some("settings".to_string());
                });
                show_main_window(app);
            }
            "logs" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    let log_dir = state.shell.lock().log_dir.clone();
                    if let Err(error) = app.opener().open_path(log_dir, None::<&str>) {
                        warn!(%error, "failed to open log directory");
                    }
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    *state.quit_requested.lock() = true;
                }
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn tray_menu_shows_on_left_click() -> bool {
    false
}

#[cfg(test)]
fn tray_menu_shows_on_right_click() -> bool {
    true
}

fn tray_event_opens_main_window(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

fn set_dock_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = app.set_dock_visibility(visible) {
            warn!(%error, visible, "failed to update dock visibility");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }
}

fn log_window_error(result: tauri::Result<()>, action: &str) {
    if let Err(error) = result {
        warn!(%error, action, "failed to update main window");
    }
}

fn capture_window_frame(window: &WebviewWindow) -> Option<WindowFrame> {
    Some(WindowFrame {
        position: window.outer_position().ok()?,
        size: window.outer_size().ok()?,
    })
}

fn window_frame_intersects_work_area(
    frame: WindowFrame,
    work_area: PhysicalRect<i32, u32>,
) -> bool {
    let frame_left = i64::from(frame.position.x);
    let frame_top = i64::from(frame.position.y);
    let frame_right = frame_left + i64::from(frame.size.width);
    let frame_bottom = frame_top + i64::from(frame.size.height);
    let work_left = i64::from(work_area.position.x);
    let work_top = i64::from(work_area.position.y);
    let work_right = work_left + i64::from(work_area.size.width);
    let work_bottom = work_top + i64::from(work_area.size.height);

    frame_left < work_right
        && frame_right > work_left
        && frame_top < work_bottom
        && frame_bottom > work_top
}

fn window_frame_intersects_any_work_area(
    frame: WindowFrame,
    work_areas: &[PhysicalRect<i32, u32>],
) -> bool {
    work_areas
        .iter()
        .copied()
        .any(|work_area| window_frame_intersects_work_area(frame, work_area))
}

fn retained_window_frame_is_visible(window: &WebviewWindow, frame: WindowFrame) -> bool {
    match window.available_monitors() {
        Ok(monitors) => {
            let work_areas = monitors
                .iter()
                .map(|monitor| *monitor.work_area())
                .collect::<Vec<_>>();
            window_frame_intersects_any_work_area(frame, &work_areas)
        }
        Err(error) => {
            warn!(%error, "failed to inspect displays before restoring retained main window frame");
            false
        }
    }
}

fn restore_window_frame(window: &WebviewWindow, frame: WindowFrame) {
    log_window_error(window.set_size(frame.size), "restore retained size");
    log_window_error(
        window.set_position(frame.position),
        "restore retained position",
    );
}

fn show_main_window(app: &AppHandle) {
    set_main_window_focus_pending(app, true);
    let retained_frame = app
        .try_state::<DesktopState>()
        .and_then(|state| *state.main_window_frame.lock());
    set_dock_visible(app, true);
    let (window, created) = match app.get_webview_window("main") {
        Some(window) => (window, false),
        None => match create_main_window(app) {
            Ok(window) => (window, true),
            Err(error) => {
                warn!(%error, "failed to create main window");
                return;
            }
        },
    };

    log_window_error(window.unminimize(), "unminimize");
    log_window_error(window.show(), "show");
    match retained_frame {
        Some(frame) if retained_window_frame_is_visible(&window, frame) => {
            restore_window_frame(&window, frame);
        }
        Some(_) => {
            warn!("retained main window frame is outside the current displays; restoring the normal frame");
            if let Some(state) = app.try_state::<DesktopState>() {
                *state.main_window_frame.lock() = None;
            }
            restore_normal_webview_window_frame(&window);
        }
        None if created => restore_normal_webview_window_frame(&window),
        None => {}
    }
    log_window_error(window.set_focus(), "focus");
    retry_main_window_focus(app.clone());
    apply_shell_state(app);
}

#[cfg(target_os = "macos")]
fn retry_main_window_focus(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let should_retry = app.try_state::<DesktopState>().is_some_and(|state| {
            state
                .main_window_focus_pending
                .swap(false, Ordering::Relaxed)
        });
        if !should_retry {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            match (window.is_visible(), window.is_focused()) {
                (Ok(true), Ok(false)) => log_window_error(window.set_focus(), "focus retry"),
                (Ok(_), Ok(_)) => {}
                (Err(error), _) | (_, Err(error)) => {
                    warn!(%error, "failed to inspect main window before focus retry")
                }
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn retry_main_window_focus(_app: AppHandle) {}

fn set_main_window_focus_pending(app: &AppHandle, pending: bool) {
    if let Some(state) = app.try_state::<DesktopState>() {
        state
            .main_window_focus_pending
            .store(pending, Ordering::Relaxed);
    }
}

fn close_main_window(app: &AppHandle) {
    set_main_window_focus_pending(app, false);
    if let Some(window) = app.get_webview_window("main") {
        if let Some(frame) = capture_window_frame(&window) {
            if let Some(state) = app.try_state::<DesktopState>() {
                *state.main_window_frame.lock() = Some(frame);
            }
        }
        log_window_error(window.hide(), "hide");
    }
    set_dock_visible(app, false);
}

fn restore_normal_webview_window_frame(window: &WebviewWindow) {
    match window.is_fullscreen() {
        Ok(true) => log_window_error(window.set_fullscreen(false), "exit fullscreen"),
        Ok(false) => {}
        Err(error) => warn!(%error, "failed to inspect main window fullscreen state"),
    }
    log_window_error(
        window.set_size(LogicalSize::new(NORMAL_WINDOW_WIDTH, NORMAL_WINDOW_HEIGHT)),
        "restore size",
    );
    log_window_error(window.center(), "center");
}

fn create_main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| "main window config is missing".to_string())?;
    WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())
}

fn shell_has_error(state: &ShellState) -> bool {
    !matches!(&state.snapshot.service_state, ServiceState::Running) || state.error.is_some()
}

fn window_title(state: &ShellState) -> String {
    if shell_has_error(state) {
        "Browser Recall - Error".to_string()
    } else {
        "Browser Recall".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use browser_recall_daemon::pairing::static_approver;
    use std::sync::atomic::AtomicUsize;

    fn shell_state(service_state: ServiceState) -> ShellState {
        ShellState {
            snapshot: ServerSnapshot {
                port: 0,
                device_id: "test-device".to_string(),
                service_state,
                connected_connectors: Vec::new(),
            },
            data_dir: String::new(),
            log_dir: String::new(),
            login_item_supported: true,
            login_item_error: None,
            launch_at_login: false,
            debug_logging: false,
            setup_complete: true,
            route: None,
            error: None,
        }
    }

    #[test]
    fn window_title_is_plain_when_connected() {
        let state = shell_state(ServiceState::Running);
        assert_eq!(window_title(&state), "Browser Recall");
    }

    #[test]
    fn window_title_keeps_error_state() {
        let state = shell_state(ServiceState::Paused {
            code: "test".to_string(),
            message: "test failure".to_string(),
        });
        assert_eq!(window_title(&state), "Browser Recall - Error");
    }

    #[test]
    fn login_item_diagnostic_does_not_pause_the_desktop_shell() {
        let mut state = shell_state(ServiceState::Running);
        state.login_item_error = Some("registration failed".to_string());

        assert_eq!(window_title(&state), "Browser Recall");
        assert!(!shell_has_error(&state));
    }

    #[test]
    fn tray_left_click_opens_window_instead_of_menu() {
        assert!(!tray_menu_shows_on_left_click());
    }

    #[test]
    fn tray_right_click_keeps_menu_available() {
        assert!(tray_menu_shows_on_right_click());
    }

    #[test]
    fn retained_window_frame_must_intersect_a_current_work_area() {
        let retained = WindowFrame {
            position: PhysicalPosition::new(2_100, 120),
            size: PhysicalSize::new(980, 680),
        };
        let laptop_work_area = PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1_920, 1_080),
        };

        assert!(!window_frame_intersects_any_work_area(
            retained,
            &[laptop_work_area]
        ));
    }

    #[test]
    fn retained_window_frame_can_intersect_a_negative_origin_display() {
        let retained = WindowFrame {
            position: PhysicalPosition::new(-1_200, 100),
            size: PhysicalSize::new(980, 680),
        };
        let left_display_work_area = PhysicalRect {
            position: PhysicalPosition::new(-1_440, 0),
            size: PhysicalSize::new(1_440, 900),
        };

        assert!(window_frame_intersects_any_work_area(
            retained,
            &[left_display_work_area]
        ));
    }

    #[tokio::test]
    async fn daemon_start_gate_runs_only_one_absent_start() {
        let gate = Arc::new(StartGate::default());
        let running = Arc::new(AtomicBool::new(false));
        let starts = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();

        for _ in 0..2 {
            let gate = Arc::clone(&gate);
            let running = Arc::clone(&running);
            let starts = Arc::clone(&starts);
            tasks.push(tokio::spawn(async move {
                gate.run(
                    || running.load(Ordering::SeqCst).then_some(()),
                    || async {
                        starts.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        running.store(true, Ordering::SeqCst);
                        Ok::<(), ()>(())
                    },
                )
                .await
            }));
        }

        for task in tasks {
            assert!(task.await.is_ok());
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn absent_daemon_start_recovers_after_startup_storage_is_repaired() {
        let dir = tempfile::tempdir().expect("temporary daemon directory");
        let config_store = ConfigStore::new(dir.path().join("config"));
        let config = DaemonConfig::new_configured(dir.path().join("browser-data"))
            .expect("configured data directory");
        config_store.save(&config).expect("save daemon config");
        let log_path = config
            .data_dir
            .join("logs")
            .join(&config.device_id)
            .join("2026-07-19.jsonl");
        std::fs::create_dir_all(log_path.parent().expect("log parent"))
            .expect("create log directory");
        std::fs::write(
            &log_path,
            format!(
                "{}\n",
                json!({
                    "timestamp": 1_710_000_000_000_i64,
                    "action": "visit_page",
                    "url": "https://resume.example/page",
                    "title": "Resume Test"
                })
            ),
        )
        .expect("write malformed startup log");

        let test_server_options = || {
            let mut options = ServerStartOptions::phase1_defaults(
                config_store.clone(),
                static_approver(PairingDecision::Approve),
            );
            options.port_candidates = vec![0];
            options
        };
        let first_start = start_configured_shell_server(test_server_options()).await;
        assert!(first_start.is_err());

        std::fs::write(&log_path, "").expect("repair malformed startup log");
        let (server, recovered_config) = start_configured_shell_server(test_server_options())
            .await
            .expect("resume start after storage repair");

        assert_eq!(recovered_config.data_dir, config.data_dir);
        assert!(server.port() > 0);
        server.shutdown().await;
    }

    #[test]
    fn configured_shell_without_daemon_has_no_storage_authority() {
        assert_eq!(
            require_running_storage(None::<()>)
                .expect_err("absent daemon must reject storage access"),
            "Browser Recall daemon is not running"
        );
    }
}

fn apply_shell_state(app: &AppHandle) {
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    let shell = state.shell.lock().clone();
    let route = shell_contract::ShellRoute {
        route: shell.route.as_deref(),
    };

    if let Some(window) = app.get_webview_window("main") {
        log_window_error(window.set_title(&window_title(&shell)), "set title");
        match serde_json::to_string(&route) {
            Ok(payload) => {
                let script = format!(
                    "window.__BR_STATE__ = {payload}; if (window.__renderBrowserRecall) window.__renderBrowserRecall();"
                );
                log_window_error(window.eval(&script), "apply shell state");
            }
            Err(error) => warn!(%error, "failed to serialize desktop shell state"),
        }
    }

    if route.route.is_some() {
        let mut shell = state.shell.lock();
        shell.route = None;
    }
}

fn update_shell_state<F>(app: &AppHandle, mutator: F)
where
    F: FnOnce(&mut ShellState),
{
    let state = app.state::<DesktopState>();
    {
        let mut shell = state.shell.lock();
        mutator(&mut shell);
    }
    apply_shell_state(app);
}

#[tauri::command]
fn update_shell_settings(app: AppHandle, payload: ShellSettingsUpdate) -> Result<(), String> {
    let login_item = login_item::SystemLoginItem::new(&app);
    if payload.launch_at_login && !login_item.supported() {
        return Err("Launch at login is unavailable on this OS".to_string());
    }

    let desired_log_level = if payload.debug_logging {
        "debug".to_string()
    } else {
        "info".to_string()
    };

    {
        let state = app.state::<DesktopState>();
        let mut config = state
            .config_store
            .load_or_create()
            .map_err(|error| error.to_string())?;
        let previous_log_level = config.log_level.clone();
        config.launch_at_login = payload.launch_at_login;
        config.log_level = desired_log_level.clone();

        state
            .logging
            .set_level(&desired_log_level)
            .map_err(|error| error.to_string())?;
        if let Err(error) =
            login_item.persist(payload.launch_at_login, || state.config_store.save(&config))
        {
            let error = if let Err(rollback_error) = state.logging.set_level(&previous_log_level) {
                format!(
                    "{error}; restoring the previous logging level also failed: {rollback_error}"
                )
            } else {
                error.to_string()
            };
            state.shell.lock().login_item_error = Some(error.clone());
            return Err(error);
        }
    }

    update_shell_state(&app, |state| {
        state.launch_at_login = payload.launch_at_login;
        state.login_item_error = None;
        state.debug_logging = payload.debug_logging;
        state.route = Some("settings".to_string());
    });
    Ok(())
}

async fn resume_daemon(app: &AppHandle) -> Result<(), String> {
    if let Some(server) = server_control_for_app(app) {
        server.resume().await;
    } else {
        start_shell_server(app).await?;
    }
    update_shell_state(app, |state| state.route = Some("settings".to_string()));
    Ok(())
}

#[tauri::command]
fn open_shell_path(app: AppHandle, request: OpenPathRequest) -> Result<(), String> {
    let path = {
        let state = app.state::<DesktopState>();
        let shell = state.shell.lock();
        match request.kind.as_str() {
            "data" => shell.data_dir.clone(),
            "logs" => shell.log_dir.clone(),
            other => return Err(format!("unknown path kind: {other}")),
        }
    };

    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn bridge_storage_get(app: AppHandle, request: BridgeStorageGetRequest) -> Result<Value, String> {
    match request.area_name.as_str() {
        "session" => {
            let state = app.state::<DesktopState>();
            let storage = state.storage_bridge.lock();
            Ok(Value::Object(session_bridge_snapshot(
                &storage,
                request.keys.as_deref(),
            )))
        }
        other => Err(format!("unsupported storage area: {other}")),
    }
}

#[tauri::command]
fn bridge_storage_set(app: AppHandle, request: BridgeStorageSetRequest) -> Result<Value, String> {
    let changes = match request.area_name.as_str() {
        "session" => {
            let state = app.state::<DesktopState>();
            let mut storage = state.storage_bridge.lock();
            session_bridge_set(&mut storage, request.items)
        }
        other => return Err(format!("unsupported storage area: {other}")),
    };
    emit_storage_change_message(
        &app,
        &request.area_name,
        request.source_id.as_deref(),
        changes.clone(),
    );
    Ok(Value::Object(changes))
}

#[tauri::command]
fn bridge_storage_remove(
    app: AppHandle,
    request: BridgeStorageRemoveRequest,
) -> Result<Value, String> {
    let changes = match request.area_name.as_str() {
        "session" => {
            let state = app.state::<DesktopState>();
            let mut storage = state.storage_bridge.lock();
            session_bridge_remove(&mut storage, &request.keys)
        }
        other => return Err(format!("unsupported storage area: {other}")),
    };
    emit_storage_change_message(
        &app,
        &request.area_name,
        request.source_id.as_deref(),
        changes.clone(),
    );
    Ok(Value::Object(changes))
}

#[tauri::command]
fn bridge_storage_clear(
    app: AppHandle,
    request: BridgeStorageClearRequest,
) -> Result<Value, String> {
    let changes = match request.area_name.as_str() {
        "session" => {
            let state = app.state::<DesktopState>();
            let mut storage = state.storage_bridge.lock();
            session_bridge_clear(&mut storage)
        }
        other => return Err(format!("unsupported storage area: {other}")),
    };
    emit_storage_change_message(
        &app,
        &request.area_name,
        request.source_id.as_deref(),
        changes.clone(),
    );
    Ok(Value::Object(changes))
}

#[tauri::command]
fn bridge_storage_broadcast(
    app: AppHandle,
    request: BridgeStorageBroadcastRequest,
) -> Result<(), String> {
    let Value::Object(changes) = request.changes else {
        return Err("bridge storage broadcast requires object changes".to_string());
    };
    emit_storage_change_message(
        &app,
        &request.area_name,
        request.source_id.as_deref(),
        changes,
    );
    Ok(())
}

fn shell_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<DesktopState>();
    let shell = state.shell.lock();
    Ok(PathBuf::from(shell.data_dir.clone()))
}

fn shell_setup_complete(app: &AppHandle) -> bool {
    let state = app.state::<DesktopState>();
    let shell = state.shell.lock();
    shell.setup_complete
}

fn shell_snapshot(app: &AppHandle) -> ServerSnapshot {
    let state = app.state::<DesktopState>();
    let shell = state.shell.lock();
    shell.snapshot.clone()
}

fn require_running_storage<T>(storage: Option<T>) -> Result<T, String> {
    storage.ok_or_else(|| "Browser Recall daemon is not running".to_string())
}

fn server_storage_for_app(app: &AppHandle) -> Option<Storage> {
    {
        let state = app.state::<DesktopState>();
        let server = state.server.lock();
        server.as_ref().map(ServerHandle::storage)
    }
}

fn storage_for_app(app: &AppHandle) -> Result<Storage, String> {
    require_running_storage(server_storage_for_app(app))
}

fn server_control_for_app(app: &AppHandle) -> Option<ServerControlHandle> {
    let state = app.state::<DesktopState>();
    let server = state.server.lock();
    server.as_ref().map(ServerHandle::control_handle)
}

fn shell_device_id(app: &AppHandle) -> String {
    shell_snapshot(app).device_id
}

fn inactive_server_snapshot(config: &DaemonConfig) -> ServerSnapshot {
    ServerSnapshot {
        port: 0,
        device_id: config.device_id.clone(),
        service_state: ServiceState::Running,
        connected_connectors: Vec::new(),
    }
}

fn spawn_server_watchers(
    app: AppHandle,
    mut snapshot_rx: tokio::sync::watch::Receiver<ServerSnapshot>,
    mut change_rx: tokio::sync::broadcast::Receiver<Vec<MutationPayload>>,
) {
    tauri::async_runtime::spawn({
        let app = app.clone();
        async move {
            loop {
                if snapshot_rx.changed().await.is_err() {
                    break;
                }
                let snapshot = snapshot_rx.borrow().clone();
                update_shell_state(&app, |state| state.snapshot = snapshot);
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            match change_rx.recv().await {
                Ok(mutations) => emit_protocol_mutations(&app, &mutations),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

async fn start_configured_shell_server(
    options: ServerStartOptions,
) -> Result<(ServerHandle, DaemonConfig), String> {
    let config_store = options.config_store.clone();
    let config = config_store
        .load_or_create()
        .map_err(|error| error.to_string())?;
    if !config.is_configured() {
        return Err("Browser Recall setup is not complete".to_string());
    }
    let server = start_server(options)
        .await
        .map_err(|error| error.to_string())?;
    Ok((server, config))
}

async fn start_shell_server(app: &AppHandle) -> Result<ServerSnapshot, String> {
    let state = app.state::<DesktopState>();
    state
        .server_start
        .run(
            || {
                let running = state.server.lock().is_some();
                running.then(|| shell_snapshot(app))
            },
            || async {
                let config_store = state.config_store.clone();
                let options = ServerStartOptions::phase1_defaults(
                    config_store,
                    pairing_approver(app.clone()),
                );
                let (server, config) = start_configured_shell_server(options).await?;
                let snapshot_rx = server.subscribe();
                let change_rx = server.subscribe_changes();
                let snapshot = snapshot_rx.borrow().clone();

                *state.server.lock() = Some(server);
                update_shell_state(app, |shell| {
                    shell.snapshot = snapshot.clone();
                    shell.data_dir = config.data_dir.display().to_string();
                    shell.setup_complete = true;
                });
                spawn_server_watchers(app.clone(), snapshot_rx, change_rx);
                state.sync.request_worker();
                Ok(snapshot)
            },
        )
        .await
}

fn emit_runtime_message(app: &AppHandle, payload: Value) {
    if let Err(error) = app.emit(BRIDGE_RUNTIME_MESSAGE_EVENT, payload) {
        warn!(%error, "failed to emit runtime message");
    }
}

fn emit_history_search_event(app: &AppHandle, payload: Value) {
    if let Err(error) = app.emit(BRIDGE_SEARCH_HISTORY_EVENT, payload) {
        warn!(%error, "failed to emit history search event");
    }
}

fn emit_storage_change_message(
    app: &AppHandle,
    area_name: &str,
    source_id: Option<&str>,
    changes: Map<String, Value>,
) {
    if changes.is_empty() {
        return;
    }
    if let Err(error) = app.emit(
        BRIDGE_STORAGE_CHANGE_EVENT,
        json!({
            "areaName": area_name,
            "sourceId": source_id,
            "changes": changes,
        }),
    ) {
        warn!(%error, "failed to emit storage change event");
    }
}

fn emit_protocol_mutation(app: &AppHandle, mutation: &MutationPayload) {
    let mut payload = match serde_json::to_value(mutation) {
        Ok(Value::Object(payload)) => payload,
        Ok(_) => {
            warn!("serialized protocol mutation was not an object");
            return;
        }
        Err(error) => {
            warn!(%error, "failed to serialize protocol mutation");
            return;
        }
    };
    payload.insert("action".to_string(), Value::String("mutation".to_string()));
    emit_runtime_message(app, Value::Object(payload));
}

fn emit_protocol_mutations(app: &AppHandle, mutations: &[MutationPayload]) {
    for mutation in mutations {
        emit_protocol_mutation(app, mutation);
    }
}

fn session_bridge_snapshot(
    state: &StorageBridgeState,
    keys: Option<&[String]>,
) -> Map<String, Value> {
    match keys {
        Some(keys) => keys
            .iter()
            .filter_map(|key| {
                state
                    .session
                    .get(key)
                    .cloned()
                    .map(|value| (key.clone(), value))
            })
            .collect(),
        None => state
            .session
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    }
}

fn session_bridge_set(
    state: &mut StorageBridgeState,
    items: BTreeMap<String, Value>,
) -> Map<String, Value> {
    let mut changes = Map::new();
    for (key, value) in items {
        let old_value = state.session.insert(key.clone(), value.clone());
        if old_value.as_ref() == Some(&value) {
            continue;
        }
        changes.insert(
            key,
            json!({
                "oldValue": old_value,
                "newValue": value,
            }),
        );
    }
    changes
}

fn session_bridge_remove(state: &mut StorageBridgeState, keys: &[String]) -> Map<String, Value> {
    let mut changes = Map::new();
    for key in keys {
        let old_value = state.session.remove(key);
        if old_value.is_none() {
            continue;
        }
        changes.insert(
            key.clone(),
            json!({
                "oldValue": old_value,
                "newValue": Value::Null,
            }),
        );
    }
    changes
}

fn session_bridge_clear(state: &mut StorageBridgeState) -> Map<String, Value> {
    let keys = state.session.keys().cloned().collect::<Vec<_>>();
    session_bridge_remove(state, &keys)
}

fn emit_passive_mutation(app: &AppHandle, mutation_type: &str) {
    emit_runtime_message(
        app,
        json!({
            "action": "mutation",
            "type": mutation_type,
        }),
    );
}

fn emit_sync_refresh_mutations(app: &AppHandle) {
    for mutation_type in [
        "history", "note", "snapshot", "lists", "orphaned", "settings",
    ] {
        emit_passive_mutation(app, mutation_type);
    }
}

async fn run_background_sync_once(app: AppHandle) {
    let storage = match storage_for_app(&app) {
        Ok(storage) => storage,
        Err(error) => {
            warn!(%error, "failed to access storage for background sync");
            return;
        }
    };

    let state = app.state::<DesktopState>();
    match state.sync.run_background_once(&storage).await {
        Ok(SyncBackgroundOutcome::Refreshed) => {
            emit_sync_refresh_mutations(&app);
        }
        Ok(SyncBackgroundOutcome::Idle) => {}
        Err(SyncError::AuthExpired(message)) => {
            warn!(%message, "background sync auth expired");
        }
        Err(SyncError::Message(message)) if message == "Cancelled" => {}
        Err(SyncError::RateLimited { message, .. }) => {
            warn!(%message, "background sync rate limited");
        }
        Err(SyncError::Message(message)) => {
            warn!(%message, "background sync failed");
        }
    }
}

fn desktop_connector_state_response(
    snapshot: &ServerSnapshot,
    data_dir: &str,
    setup_complete: bool,
) -> Value {
    if !setup_complete {
        return json!({
            "success": true,
            "state": "setup_required",
            "port": null,
            "deviceId": null,
            "hasToken": false,
            "lastError": null,
            "lastErrorCode": null,
            "dataFolder": null,
        });
    }

    let (state, last_error, last_error_code) = match &snapshot.service_state {
        ServiceState::Running => ("connected", None, None),
        ServiceState::Paused { code, message } => {
            ("paused", Some(message.as_str()), Some(code.as_str()))
        }
    };
    json!({
        "success": true,
        "state": state,
        "port": snapshot.port,
        "deviceId": snapshot.device_id,
        "hasToken": true,
        "lastError": last_error,
        "lastErrorCode": last_error_code,
        "dataFolder": data_dir,
    })
}

fn paired_browser_payloads(
    config_store: &ConfigStore,
    snapshot: &ServerSnapshot,
) -> Result<Vec<Value>, String> {
    let connected = snapshot
        .connected_connectors
        .iter()
        .map(|connector| (connector.browser_id.clone(), connector.extension_id.clone()))
        .collect::<std::collections::BTreeSet<_>>();
    let mut paired_browsers = list_paired_browsers(config_store)?
        .into_iter()
        .map(|connector| {
            let is_connected =
                connected.contains(&(connector.browser_id.clone(), connector.extension_id.clone()));
            (is_connected, connector)
        })
        .collect::<Vec<_>>();
    paired_browsers.sort_by(|(left_connected, left), (right_connected, right)| {
        right_connected
            .cmp(left_connected)
            .then_with(|| right.last_seen.cmp(&left.last_seen))
            .then_with(|| right.approved_at.cmp(&left.approved_at))
            .then_with(|| left.browser_name.cmp(&right.browser_name))
            .then_with(|| left.browser_profile.cmp(&right.browser_profile))
            .then_with(|| left.browser_id.cmp(&right.browser_id))
            .then_with(|| left.extension_id.cmp(&right.extension_id))
    });
    Ok(paired_browsers
        .into_iter()
        .map(|(connected, connector)| {
            json!({
                "browserId": connector.browser_id,
                "browserName": connector.browser_name,
                "browserProfile": connector.browser_profile,
                "extensionId": connector.extension_id,
                "approvedAt": connector.approved_at,
                "lastSeen": connector.last_seen,
                "connected": connected,
            })
        })
        .collect())
}

fn choose_desktop_data_folder(app: &AppHandle) -> Result<Value, String> {
    if app.state::<DesktopState>().server.lock().is_some() {
        return Err("The data folder can only be changed before setup starts.".to_string());
    }

    let folder = app
        .dialog()
        .file()
        .set_title("Choose Browser Recall Data Folder")
        .blocking_pick_folder();
    let Some(folder) = folder else {
        return Ok(json!({
            "success": true,
            "cancelled": true,
        }));
    };
    let data_dir = folder.into_path().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;

    let config_store = app.state::<DesktopState>().config_store.clone();
    let mut config = config_store
        .load_or_create()
        .map_err(|error| error.to_string())?;
    config
        .select_data_directory(data_dir.clone())
        .map_err(str::to_string)?;
    config_store
        .save(&config)
        .map_err(|error| error.to_string())?;
    drop(config);

    update_shell_state(app, |state| {
        state.data_dir = data_dir.display().to_string();
        state.setup_complete = false;
    });
    Ok(json!({
        "success": true,
        "cancelled": false,
        "dataFolder": data_dir.to_string_lossy().to_string(),
    }))
}

async fn complete_desktop_setup(app: &AppHandle, request: &Value) -> Result<Value, String> {
    let config_store = app.state::<DesktopState>().config_store.clone();
    let login_item = login_item::SystemLoginItem::new(app);
    let mut config = config_store
        .load_or_create()
        .map_err(|error| error.to_string())?;
    config
        .complete_setup()
        .map_err(|_| "Choose a data folder before starting Browser Recall.".to_string())?;
    let launch_at_login = request
        .get("launchAtLogin")
        .and_then(Value::as_bool)
        .ok_or_else(|| "completeDesktopSetup missing launchAtLogin".to_string())?;
    if launch_at_login && !login_item.supported() {
        return Err("Launch at login is unavailable on this OS".to_string());
    }

    config.launch_at_login = launch_at_login;
    if let Err(error) = login_item.persist(launch_at_login, || config_store.save(&config)) {
        let error = error.to_string();
        app.state::<DesktopState>().shell.lock().login_item_error = Some(error.clone());
        return Err(error);
    }
    update_shell_state(app, |state| {
        state.data_dir = config.data_dir.display().to_string();
        state.setup_complete = true;
        state.launch_at_login = launch_at_login;
        state.login_item_error = None;
    });
    let snapshot = start_shell_server(app).await?;

    Ok(json!({
        "success": true,
        "dataFolder": config.data_dir.to_string_lossy().to_string(),
        "deviceId": snapshot.device_id,
        "port": snapshot.port,
    }))
}

#[tauri::command]
async fn bridge_action(app: AppHandle, request: Value) -> Result<Value, String> {
    let request_object = request
        .as_object()
        .ok_or_else(|| "bridge request must be an object".to_string())?;
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "bridge action missing `action`".to_string())?;
    if CommandAuthority::supports(action) {
        if let Some(server) = server_control_for_app(&app) {
            let mut daemon_request = request_object.clone();
            daemon_request.remove("action");
            return server
                .run_command(action, Value::Object(daemon_request))
                .await
                .map_err(|error| error.to_string());
        }
        return Err("Browser Recall daemon is not running".to_string());
    }
    validate_desktop_bridge_fields(action, request_object)?;
    if action == "getDesktopSystemLocale" {
        return Ok(json!({
            "success": true,
            "locale": sys_locale::get_locale(),
        }));
    }
    let server_storage = server_storage_for_app(&app);
    let storage = || require_running_storage(server_storage.as_ref());
    let snapshot = shell_snapshot(&app);
    let device_id = shell_device_id(&app);
    let setup_complete = shell_setup_complete(&app);

    let response = match action {
        "getDeviceId" => json!({
            "success": true,
            "deviceId": if setup_complete {
                Value::String(snapshot.device_id.clone())
            } else {
                Value::Null
            },
            "setupComplete": setup_complete,
        }),
        "getDesktopConnectorState" | "triggerDesktopPairing" => {
            let data_dir = shell_data_dir(&app)?;
            desktop_connector_state_response(&snapshot, &data_dir.to_string_lossy(), setup_complete)
        }
        "getDesktopShellState" => {
            let state = app.state::<DesktopState>();
            let shell = state.shell.lock();
            let paired_browsers = paired_browser_payloads(&state.config_store, &snapshot)?;
            serde_json::to_value(shell_contract::DesktopShellStateResponse {
                success: true,
                login_item_supported: shell.login_item_supported,
                login_item_error: shell.login_item_error.as_deref(),
                launch_at_login: shell.launch_at_login,
                debug_logging: shell.debug_logging,
                setup_complete: shell.setup_complete,
                data_dir: shell_contract::data_dir_payload(&shell.data_dir),
                system_locale: sys_locale::get_locale(),
                paired_browsers,
            })
            .map_err(|error| error.to_string())?
        }
        "startWindowDrag" => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window is unavailable".to_string())?;
            window.start_dragging().map_err(|error| error.to_string())?;
            json!({ "success": true })
        }
        "toggleWindowFullscreen" => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window is unavailable".to_string())?;
            let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
            window
                .set_fullscreen(!fullscreen)
                .map_err(|error| error.to_string())?;
            json!({ "success": true, "fullscreen": !fullscreen })
        }
        "openExternalUrl" => {
            let url = request
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "openExternalUrl missing url".to_string())?;
            app.opener()
                .open_url(url.to_string(), None::<&str>)
                .map_err(|error| error.to_string())?;
            json!({ "success": true })
        }
        "chooseDesktopDataFolder" => choose_desktop_data_folder(&app)?,
        "completeDesktopSetup" => complete_desktop_setup(&app, &request).await?,
        "updateDesktopShellSettings" => {
            let launch_at_login = request
                .get("launchAtLogin")
                .and_then(Value::as_bool)
                .ok_or_else(|| "updateDesktopShellSettings missing launchAtLogin".to_string())?;
            let debug_logging = request
                .get("debugLogging")
                .and_then(Value::as_bool)
                .ok_or_else(|| "updateDesktopShellSettings missing debugLogging".to_string())?;
            update_shell_settings(
                app.clone(),
                ShellSettingsUpdate {
                    launch_at_login,
                    debug_logging,
                },
            )?;
            json!({ "success": true })
        }
        "revokePairedBrowser" => {
            let browser_id = request
                .get("browserId")
                .and_then(Value::as_str)
                .ok_or_else(|| "revokePairedBrowser missing browserId".to_string())?;
            let extension_id = request
                .get("extensionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "revokePairedBrowser missing extensionId".to_string())?;
            let state = app.state::<DesktopState>();
            let server = {
                state
                    .server
                    .lock()
                    .as_ref()
                    .map(ServerHandle::control_handle)
            };
            let revoked = if let Some(server) = server {
                server
                    .revoke_connector(browser_id, extension_id)
                    .await
                    .map_err(|error| error.to_string())?
            } else {
                pair_browser_revoke(&state.config_store, browser_id, extension_id)?
            };
            json!({ "success": true, "revoked": revoked })
        }
        "getDirectoryInfo" => {
            if !setup_complete {
                return Ok(json!({
                    "success": true,
                    "info": null,
                }));
            }
            let name = storage()?
                .root()
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
                .ok_or_else(|| "data directory has no UTF-8 folder name".to_string())?;
            let _entries = tokio::fs::read_dir(storage()?.root())
                .await
                .map_err(|error| format!("data directory is not readable: {error}"))?;
            json!({
                "success": true,
                "info": {
                    "name": name,
                    "hasPermission": true,
                }
            })
        }
        "getDirectorySize" => json!({
            "success": true,
            "size": storage()?.directory_size().await.map_err(|error| error.to_string())?,
        }),
        "getListDisplay" => {
            let list_id = request
                .get("listId")
                .and_then(Value::as_str)
                .ok_or_else(|| "getListDisplay missing listId".to_string())?;
            let list = ReadProjections::new(storage()?.clone())
                .list_display(list_id)
                .await?;
            json!({
                "success": true,
                "list": list,
            })
        }
        "getPageContext" => {
            let slugs = request
                .get("slugs")
                .and_then(Value::as_array)
                .ok_or_else(|| "getPageContext missing slugs".to_string())?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "getPageContext slugs must be strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let pages = ReadProjections::new(storage()?.clone())
                .page_context(&slugs)
                .await?;
            json!({ "success": true, "pages": pages })
        }
        "getAllPageContext" => {
            let pages = ReadProjections::new(storage()?.clone())
                .all_page_context()
                .await?;
            json!({ "success": true, "pages": pages })
        }
        "getHighlightHistory" => {
            let highlights = ReadProjections::new(storage()?.clone())
                .highlight_history()
                .await?;
            json!({ "success": true, "highlights": highlights })
        }
        "getListTree" => {
            let projection = ReadProjections::new(storage()?.clone()).list_tree().await?;
            json!({
                "success": true,
                "tree": projection.tree,
                "order": projection.order,
            })
        }
        "getRecycleBin" => {
            let entries = ReadProjections::new(storage()?.clone())
                .recycle_bin()
                .await?;
            json!({ "success": true, "entries": entries })
        }
        "getSettings" => {
            let settings = ReadProjections::new(storage()?.clone()).settings().await?;
            json!({ "success": true, "settings": settings })
        }
        "listHistoryFiles" => {
            let include_sizes = request
                .get("includeSizes")
                .and_then(Value::as_bool)
                .ok_or_else(|| "listHistoryFiles missing includeSizes".to_string())?;
            let listing = list_history_files(storage()?, include_sizes).await?;
            let sizes = if include_sizes {
                listing
                    .sizes
                    .ok_or_else(|| "history file listing omitted requested sizes".to_string())?
            } else {
                std::collections::BTreeMap::new()
            };
            json!({
                "success": true,
                "files": listing.files,
                "sizes": sizes,
                "devices": listing.devices,
            })
        }
        "loadHistoryBatch" => {
            let files = request
                .get("files")
                .and_then(Value::as_array)
                .ok_or_else(|| "loadHistoryBatch missing files".to_string())?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "loadHistoryBatch files must be strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let entries = load_history_batch(storage()?, &files).await?;
            json!({
                "success": true,
                "entries": entries,
            })
        }
        "searchNotes" => {
            let query = request
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| "searchNotes missing query".to_string())?;
            let results = command_search_notes(storage()?, query).await?;
            json!({
                "success": true,
                "results": results,
            })
        }
        "searchSnapshots" => {
            let query = request
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| "searchSnapshots missing query".to_string())?;
            let results = command_search_snapshots(storage()?, query)?;
            json!({
                "success": true,
                "results": results,
            })
        }
        "loadPageNotes" => {
            let slug = request
                .get("slug")
                .and_then(Value::as_str)
                .ok_or_else(|| "loadPageNotes missing slug".to_string())?;
            let page = ReadProjections::new(storage()?.clone())
                .page_info(slug)
                .await?;
            json!({ "success": true, "notes": page.notes })
        }
        "listSnapshots" => {
            let slug = request
                .get("slug")
                .and_then(Value::as_str)
                .ok_or_else(|| "listSnapshots missing slug".to_string())?;
            let page = ReadProjections::new(storage()?.clone())
                .page_info(slug)
                .await?;
            json!({ "success": true, "snapshots": page.snapshots })
        }
        "getSnapshotHtml" => {
            let slug = request
                .get("slug")
                .and_then(Value::as_str)
                .ok_or_else(|| "getSnapshotHtml missing slug".to_string())?;
            let timestamp = request
                .get("timestamp")
                .and_then(Value::as_i64)
                .ok_or_else(|| "getSnapshotHtml missing timestamp".to_string())?;
            let html =
                browser_recall_daemon::commands::get_snapshot_html(storage()?, slug, timestamp)
                    .await?;
            match html {
                Some(html) => json!({
                    "success": true,
                    "html": html,
                }),
                None => json!({
                    "success": false,
                    "error": "Not found",
                }),
            }
        }
        "getPageRelations" => {
            let url = request
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "getPageRelations missing url".to_string())?;
            let payload = page_relations_payload(storage()?, url).await?;
            json!({
                "success": true,
                "parents": payload["parents"].clone(),
                "children": payload["children"].clone(),
            })
        }
        "openSnapshot" => {
            let slug = request
                .get("slug")
                .and_then(Value::as_str)
                .ok_or_else(|| "openSnapshot missing slug".to_string())?;
            let timestamp = request
                .get("timestamp")
                .and_then(Value::as_i64)
                .ok_or_else(|| "openSnapshot missing timestamp".to_string())?;
            let snapshot_path = storage()?.snapshot_html_file_path(slug, timestamp);
            if !snapshot_path.exists() {
                return Err("Snapshot not found".to_string());
            }
            app.opener()
                .open_path(snapshot_path.to_string_lossy().to_string(), None::<&str>)
                .map_err(|error| error.to_string())?;
            json!({ "success": true })
        }
        "previewRule" => {
            let rule = serde_json::from_value::<RulePayload>(
                request
                    .get("rule")
                    .cloned()
                    .ok_or_else(|| "previewRule missing rule".to_string())?,
            )
            .map_err(|error| error.to_string())?;
            let entries = serde_json::from_value::<Vec<RuleBatchEntry>>(
                request
                    .get("entries")
                    .cloned()
                    .ok_or_else(|| "previewRule missing entries".to_string())?,
            )
            .map_err(|error| error.to_string())?;
            preview_rule_payload(rule, entries)?
        }
        "resumeService" => {
            resume_daemon(&app).await?;
            json!({ "success": true })
        }
        "getSyncDevices" => {
            let state = app.state::<DesktopState>();
            json!({
                "success": true,
                "devices": state.sync.device_entries_json(),
                "localDeviceId": device_id,
            })
        }
        "syncListDevices" => {
            let state = app.state::<DesktopState>();
            match state.sync.refresh_devices(storage()?).await {
                Ok(devices) => json!({
                    "success": true,
                    "devices": sync_device_entries_json(&devices),
                    "localDeviceId": device_id,
                }),
                Err(error) => json!({
                    "success": false,
                    "devices": [],
                    "localDeviceId": device_id,
                    "error": error,
                }),
            }
        }
        "toggleSyncDevicePaused" => {
            let target = request
                .get("deviceId")
                .and_then(Value::as_str)
                .ok_or_else(|| "toggleSyncDevicePaused missing deviceId".to_string())?;
            let state = app.state::<DesktopState>();
            let paused = state.sync.toggle_device_paused(target)?;
            json!({
                "success": true,
                "paused": paused,
            })
        }
        "updateSyncSettings" | "clearSyncFolder" | "flushDesktopQueue" | "initializeFilesystem" => {
            let state = app.state::<DesktopState>();
            state.sync.settings_changed(storage()?).await?;
            json!({ "success": true })
        }
        "cancelSync" => {
            let state = app.state::<DesktopState>();
            state.sync.cancel();
            json!({ "success": true })
        }
        "clearSyncToken" => {
            let state = app.state::<DesktopState>();
            state.sync.clear_token()?;
            json!({ "success": true })
        }
        "toggleSyncRemember" => {
            let remember = request
                .get("remember")
                .and_then(Value::as_bool)
                .ok_or_else(|| "toggleSyncRemember missing remember".to_string())?;
            let state = app.state::<DesktopState>();
            state.sync.toggle_remember(remember)?;
            json!({ "success": true })
        }
        "syncNow" => {
            let state = app.state::<DesktopState>();
            let response = state.sync.sync_now_response(storage()?).await;
            if response
                .get("entriesReplayed")
                .and_then(Value::as_u64)
                .is_some_and(|count| count > 0)
            {
                emit_sync_refresh_mutations(&app);
            }
            response
        }
        "setSyncToken" => {
            let token = request
                .get("token")
                .and_then(Value::as_str)
                .ok_or_else(|| "setSyncToken missing token".to_string())?;
            let remember = request
                .get("remember")
                .and_then(Value::as_bool)
                .ok_or_else(|| "setSyncToken missing remember".to_string())?;
            let state = app.state::<DesktopState>();
            let github_user = state.sync.set_token(token, remember).await?;
            json!({
                "success": true,
                "githubUser": github_user,
            })
        }
        "getSyncAuthState" => {
            let state = app.state::<DesktopState>();
            state.sync.auth_state_json()
        }
        "deleteSyncDevice" => {
            let target = request
                .get("deviceId")
                .and_then(Value::as_str)
                .ok_or_else(|| "deleteSyncDevice missing deviceId".to_string())?;
            let state = app.state::<DesktopState>();
            state.sync.delete_device(storage()?, target).await?;
            json!({ "success": true })
        }
        other => json!({
            "success": false,
            "error": format!("unsupported desktop bridge action: {other}"),
        }),
    };

    Ok(response)
}

fn validate_desktop_bridge_fields(
    action: &str,
    request: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let fields: &[&str] = match action {
        "openExternalUrl" | "getPageRelations" => &["url"],
        "completeDesktopSetup" => &["launchAtLogin"],
        "updateDesktopShellSettings" => &["launchAtLogin", "debugLogging"],
        "revokePairedBrowser" => &["browserId", "extensionId"],
        "getListDisplay" => &["listId"],
        "getPageContext" => &["slugs"],
        "listHistoryFiles" => &["includeSizes"],
        "loadHistoryBatch" => &["files"],
        "searchNotes" | "searchSnapshots" => &["query"],
        "loadPageNotes" | "listSnapshots" => &["slug"],
        "getSnapshotHtml" | "openSnapshot" => &["slug", "timestamp"],
        "previewRule" => &["rule", "entries"],
        "toggleSyncDevicePaused" | "deleteSyncDevice" => &["deviceId"],
        "toggleSyncRemember" => &["remember"],
        "setSyncToken" => &["token", "remember"],
        "getDesktopSystemLocale"
        | "getDeviceId"
        | "getDesktopConnectorState"
        | "triggerDesktopPairing"
        | "getDesktopShellState"
        | "startWindowDrag"
        | "toggleWindowFullscreen"
        | "chooseDesktopDataFolder"
        | "getDirectoryInfo"
        | "getDirectorySize"
        | "getAllPageContext"
        | "getHighlightHistory"
        | "getListTree"
        | "getRecycleBin"
        | "getSettings"
        | "resumeService"
        | "getSyncDevices"
        | "syncListDevices"
        | "updateSyncSettings"
        | "clearSyncFolder"
        | "flushDesktopQueue"
        | "initializeFilesystem"
        | "cancelSync"
        | "clearSyncToken"
        | "syncNow"
        | "getSyncAuthState" => &[],
        _ => return Ok(()),
    };
    for key in request.keys() {
        if key != "action" && !fields.contains(&key.as_str()) {
            return Err(format!(
                "{action} bridge request contains unknown field: {key}"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
async fn search_history_stream(
    app: AppHandle,
    request: StreamingSearchRequest,
) -> Result<serde_json::Value, String> {
    let data_dir = shell_data_dir(&app)?;
    let state = app.state::<DesktopState>();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.active_history_search.lock();
        if let Some(previous) = active.take() {
            previous.cancel.store(true, Ordering::Relaxed);
        }
        *active = Some(ActiveHistorySearch {
            search_id: request.search_id.clone(),
            cancel: Arc::clone(&cancel),
        });
    }

    let search_id = request.search_id.clone();
    let query = request.query.clone();
    let limit = request.limit;
    let app_for_task = app.clone();
    let task_cancel = Arc::clone(&cancel);

    tauri::async_runtime::spawn_blocking(move || {
        let result = search_history_parallel_in_data_dir(
            &data_dir,
            &query,
            limit,
            Arc::clone(&task_cancel),
            |chunk| {
                let results =
                    serde_json::to_value(&chunk.results).map_err(std::io::Error::other)?;
                emit_history_search_event(
                    &app_for_task,
                    json!({
                        "type": "historySearchChunk",
                        "searchId": search_id,
                        "workerId": chunk.worker_id,
                        "results": results,
                    }),
                );
                Ok(())
            },
        );
        let success = result.is_ok() && !task_cancel.load(Ordering::Relaxed);
        let error = result.err().map(|error| error.to_string());
        emit_history_search_event(
            &app_for_task,
            json!({
                "type": "historySearchDone",
                "searchId": search_id,
                "success": success,
                "cancelled": task_cancel.load(Ordering::Relaxed),
                "error": error,
            }),
        );
        let state = app_for_task.state::<DesktopState>();
        let mut active = state.active_history_search.lock();
        if active
            .as_ref()
            .is_some_and(|active| active.search_id == search_id)
        {
            *active = None;
        }
    });

    Ok(json!({ "success": true, "searchId": request.search_id }))
}

#[tauri::command]
async fn cancel_history_search(
    app: AppHandle,
    request: CancelSearchRequest,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DesktopState>();
    let mut cancelled = false;
    {
        let mut active = state.active_history_search.lock();
        if active
            .as_ref()
            .is_some_and(|active| active.search_id == request.search_id)
        {
            if let Some(active) = active.take() {
                active.cancel.store(true, Ordering::Relaxed);
                cancelled = true;
            }
        }
    }
    Ok(json!({ "success": true, "cancelled": cancelled }))
}

#[tauri::command]
async fn search_notes(app: AppHandle, request: SearchRequest) -> Result<serde_json::Value, String> {
    let storage = storage_for_app(&app)?;
    let hits: Vec<NoteSearchHit> = search_notes_in_storage(&storage, &request.query, request.limit)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(hits).map_err(|error| error.to_string())
}

#[tauri::command]
fn search_snapshots(app: AppHandle, request: SearchRequest) -> Result<serde_json::Value, String> {
    let data_dir = shell_data_dir(&app)?;
    let hits: Vec<SnapshotSearchHit> =
        search_snapshots_in_data_dir(&data_dir, &request.query, request.limit)
            .map_err(|error| error.to_string())?;
    serde_json::to_value(hits).map_err(|error| error.to_string())
}

fn parse_deep_link_route(url: &str) -> Option<String> {
    let route = url
        .strip_prefix("browser-recall://")?
        .trim_start_matches('/');
    if route.is_empty() {
        None
    } else {
        Some(route.to_string())
    }
}

fn configure_deep_links(app: &AppHandle) {
    if std::env::var_os("BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION").is_some() {
        info!("skipping deep-link registration for isolated runtime test");
    } else if let Err(error) = app.deep_link().register("browser-recall") {
        warn!(%error, "failed to register deep-link scheme");
    }
    app.deep_link().on_open_url({
        let app = app.clone();
        move |event| {
            let route = event
                .urls()
                .into_iter()
                .find_map(|url| parse_deep_link_route(url.as_ref()));
            if let Some(route) = route {
                info!(route, "received deep link");
                update_shell_state(&app, |state| state.route = Some(route));
                show_main_window(&app);
            }
        }
    });

    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(route) = urls
            .into_iter()
            .find_map(|url| parse_deep_link_route(url.as_ref()))
        {
            info!(route, "restored launch deep link");
            update_shell_state(app, |state| state.route = Some(route));
            show_main_window(app);
        }
    }
}

fn main() -> tauri::Result<()> {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main_window(app);
    }));
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));
    let app = builder
        .invoke_handler(tauri::generate_handler![
            bridge_action,
            update_shell_settings,
            open_shell_path,
            search_history_stream,
            cancel_history_search,
            search_notes,
            search_snapshots,
            bridge_storage_get,
            bridge_storage_set,
            bridge_storage_remove,
            bridge_storage_clear,
            bridge_storage_broadcast
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                windows_icon::install_webview(&window).map_err(std::io::Error::other)?;
            }
            let app_handle = app.handle().clone();
            let bootstrap = config::bootstrap(&app_handle)?;
            let logging = logging::init(&bootstrap.log_dir, &bootstrap.config.log_level)?;
            info!(
                data_dir = %bootstrap.config.data_dir.display(),
                log_dir = %bootstrap.log_dir.display(),
                "starting browser recall desktop shell"
            );
            if let Some(error) = &bootstrap.login_item_error {
                warn!(%error, "could not reconcile launch-at-login registration");
            }

            let (server_handle, initial_snapshot, watcher_bundle) =
                if bootstrap.config.is_configured() {
                    let server_result = tauri::async_runtime::block_on(start_server(
                        ServerStartOptions::phase1_defaults(
                            bootstrap.config_store.clone(),
                            pairing_approver(app_handle.clone()),
                        ),
                    ));
                    match server_result {
                        Ok(server) => {
                            let snapshot_rx = server.subscribe();
                            let change_rx = server.subscribe_changes();
                            let initial_snapshot = snapshot_rx.borrow().clone();
                            (
                                Some(server),
                                initial_snapshot,
                                Some((snapshot_rx, change_rx)),
                            )
                        }
                        Err(error) => {
                            warn!(%error, "failed to start Browser Recall daemon");
                            let mut snapshot = inactive_server_snapshot(&bootstrap.config);
                            snapshot.service_state = ServiceState::Paused {
                                code: "daemon_start_failed".into(),
                                message: format!("Failed to start Browser Recall daemon: {error}"),
                            };
                            (None, snapshot, None)
                        }
                    }
                } else {
                    (None, inactive_server_snapshot(&bootstrap.config), None)
                };
            let daemon_started = server_handle.is_some();
            create_tray(app.handle())?;
            let sync_notify = Arc::new(Notify::new());
            app.manage(DesktopState {
                server: Mutex::new(server_handle),
                server_start: StartGate::default(),
                config_store: bootstrap.config_store.clone(),
                shell: Mutex::new(ShellState {
                    snapshot: initial_snapshot,
                    data_dir: bootstrap.config.data_dir.display().to_string(),
                    log_dir: bootstrap.log_dir.display().to_string(),
                    login_item_supported: login_item::SystemLoginItem::new(app.handle())
                        .supported(),
                    login_item_error: bootstrap.login_item_error.clone(),
                    launch_at_login: bootstrap.config.launch_at_login,
                    debug_logging: bootstrap.config.log_level == "debug",
                    setup_complete: bootstrap.config.is_configured(),
                    route: None,
                    error: None,
                }),
                sync: SyncController::new(
                    bootstrap.config_store.clone(),
                    &bootstrap.config,
                    bootstrap.config.device_id.clone(),
                    sync_notify.clone(),
                ),
                storage_bridge: Mutex::new(StorageBridgeState::default()),
                active_history_search: Mutex::new(None),
                logging,
                quit_requested: Mutex::new(false),
                main_window_focus_pending: AtomicBool::new(false),
                main_window_frame: Mutex::new(None),
            });
            apply_shell_state(app.handle());
            if let Some((snapshot_rx, change_rx)) = watcher_bundle {
                spawn_server_watchers(app.handle().clone(), snapshot_rx, change_rx);
            }
            let sync_notify = app.state::<DesktopState>().sync.worker_notify();
            tauri::async_runtime::spawn(background_worker_loop(sync_notify, {
                let app = app.handle().clone();
                move || {
                    let app = app.clone();
                    async move {
                        run_background_sync_once(app).await;
                    }
                }
            }));
            configure_deep_links(app.handle());
            if daemon_started {
                app.state::<DesktopState>().sync.request_worker();
            }
            show_main_window(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                close_main_window(window.app_handle());
            }
            WindowEvent::Focused(true) if window.label() == "main" => {
                set_main_window_focus_pending(window.app_handle(), false);
            }
            #[cfg(target_os = "windows")]
            WindowEvent::ScaleFactorChanged { .. } if window.label() == "main" => {
                if let Err(error) = windows_icon::install(window) {
                    warn!(%error, "failed to refresh DPI-specific Windows icons");
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let quit_requested = app
                .try_state::<DesktopState>()
                .map(|state| *state.quit_requested.lock())
                .unwrap_or(false);
            if !quit_requested {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            show_main_window(app);
        }
        _ => {}
    });
    Ok(())
}
