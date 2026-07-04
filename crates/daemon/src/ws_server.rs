use crate::capture_policy::{blacklist_prefixes, should_record_visit, trim_title_from_settings};
use crate::command_authority::CommandAuthority;
use crate::commands::{self, permanent_delete_candidates};
use crate::config::{random_string, ApprovedConnector, ConfigStore, Token};
use crate::connectors::{
    connector_key, current_local_day_start_unix, prune_inactive_connectors, ConnectorKey,
};
use crate::mutations::{build_mutations, dedupe_mutations};
use crate::pairing::{with_timeout, PairingApprover, PairingDecision, PairingRequest};
use crate::protocol::{
    ConnectorMessage, DaemonMessage, DirectoryInfoPayload, MutationPayload, NoteSearchResult,
    PopupAttentionResult, PopupListResult, PopupNoteResult, PopupPageInfoEntry, PopupPinResult,
    PopupSnapshotResult, PreviewRuleHit, RuleBatchEntry, RuleBatchHit, RuleMatchResult,
    RulePayload, SnapshotSearchResult, TestSeedFilePayload,
};
use crate::rules::{
    list_matches_page, match_list_rules_strict, page_data_from_raw_entry, preview_rule,
    validate_rule, PageData, RuleSpec,
};
use crate::runtime::{self, EntityMapView, ReplayTransaction};
use crate::search::{search_notes_in_data_dir, search_snapshots_in_data_dir};
use crate::storage::Storage;
use browser_recall_replay::entities::{Entity, ListOrderManifest, TreeNode};
use browser_recall_replay::{generate_slug_from_url, EntityEffect, LogEntry};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::panic::AssertUnwindSafe;
use std::path::Component;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, oneshot, watch, Mutex, RwLock};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{accept_hdr_async_with_config, tungstenite::protocol::WebSocketConfig};
use tracing::{info, warn};

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const CONNECTOR_SOURCE_EXTENSION: &str = "extension";
const UNAUTHENTICATED_IDLE_TIMEOUT: Duration = Duration::from_secs(3);
#[derive(Debug)]
pub enum WsServerError {
    Io(std::io::Error),
    Json(serde_json::Error),
    NoPortsAvailable,
    Handshake(String),
    Ingest(String),
}

impl fmt::Display for WsServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::NoPortsAvailable => f.write_str("no ports available"),
            Self::Handshake(reason) => write!(f, "{reason}"),
            Self::Ingest(reason) => write!(f, "{reason}"),
        }
    }
}

impl std::error::Error for WsServerError {}

impl From<std::io::Error> for WsServerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for WsServerError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceStatus {
    Running,
    Paused,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ErrorCode {
    FsError,
    SyncError,
    ReplayError,
    ManualPause,
}

impl ErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::FsError => "fs_error",
            Self::SyncError => "sync_error",
            Self::ReplayError => "replay_error",
            Self::ManualPause => "manual_pause",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ServiceState {
    Running,
    Paused { code: ErrorCode, message: String },
}

#[derive(Debug, Clone)]
pub struct ConnectedConnector {
    pub browser_id: String,
    pub browser_name: String,
    pub extension_id: String,
}

impl ConnectedConnector {
    fn key(&self) -> (&str, &str) {
        (&self.browser_id, &self.extension_id)
    }
}

#[derive(Debug, Clone)]
pub struct ServerSnapshot {
    pub port: u16,
    pub device_id: String,
    pub service_status: ServiceStatus,
    pub connected_browsers: Vec<String>,
    pub connected_connectors: Vec<ConnectedConnector>,
    pub last_error: Option<String>,
    pub last_error_code: Option<String>,
}

#[derive(Clone)]
struct SharedState {
    snapshot: Arc<RwLock<ServerSnapshot>>,
    snapshot_tx: watch::Sender<ServerSnapshot>,
    change_message_tx: broadcast::Sender<DaemonMessage>,
    revoke_tx: broadcast::Sender<ConnectorKey>,
    config_store: ConfigStore,
    config: Arc<Mutex<crate::config::DaemonConfig>>,
    storage: Storage,
    ingest_status: Arc<Mutex<IngestStatus>>,
    connector_buffer_status: Arc<Mutex<ConnectorBufferStatus>>,
    service_state: Arc<RwLock<ServiceState>>,
    approver: PairingApprover,
    pair_timeout: Duration,
    test_control_enabled: bool,
    active_connections: Arc<Mutex<HashMap<u64, ConnectedConnector>>>,
    next_connection_id: Arc<AtomicU64>,
}

#[derive(Debug, Default)]
struct IngestStatus {
    buffer_depth: usize,
    last_drained_at: Option<i64>,
}

#[derive(Debug, Default)]
struct ConnectorBufferStatus {
    buffer_depth: usize,
    buffer_bytes: usize,
}

#[derive(Debug, Clone)]
struct SyntheticLogEntry {
    parsed: LogEntry,
}

struct IngestSuccess {
    ack: DaemonMessage,
    mutations: Vec<MutationPayload>,
}

pub struct ServerHandle {
    port: u16,
    shared: SharedState,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub async fn snapshot(&self) -> ServerSnapshot {
        self.shared.snapshot.read().await.clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<ServerSnapshot> {
        self.shared.snapshot_tx.subscribe()
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<DaemonMessage> {
        self.shared.change_message_tx.subscribe()
    }

    pub fn storage(&self) -> Storage {
        self.shared.storage.clone()
    }

    pub fn control_handle(&self) -> ServerControlHandle {
        ServerControlHandle {
            shared: self.shared.clone(),
        }
    }

    pub async fn resume(&self) {
        resume_service(&self.shared).await;
    }

    pub async fn shutdown(mut self) {
        let storage = self.shared.storage.clone();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = self.task.await;
        let _ = storage.flush_checkpoints().await;
    }
}

#[derive(Clone)]
pub struct ServerControlHandle {
    shared: SharedState,
}

impl ServerControlHandle {
    pub async fn revoke_connector(
        &self,
        browser_id: &str,
        extension_id: &str,
    ) -> Result<bool, WsServerError> {
        revoke_connector(&self.shared, browser_id, extension_id).await
    }

    pub fn storage(&self) -> Storage {
        self.shared.storage.clone()
    }

    pub async fn run_command(&self, action: &str, request: Value) -> Result<Value, WsServerError> {
        run_shared_command(&self.shared, action, request).await
    }
}

pub struct ServerStartOptions {
    pub config_store: ConfigStore,
    pub approver: PairingApprover,
    pub port_candidates: Vec<u16>,
    pub pair_timeout: Duration,
    pub test_control_enabled: bool,
}

impl ServerStartOptions {
    pub fn phase1_defaults(config_store: ConfigStore, approver: PairingApprover) -> Self {
        Self {
            config_store,
            approver,
            port_candidates: vec![28471, 28472, 28473],
            pair_timeout: Duration::from_secs(60),
            test_control_enabled: false,
        }
    }
}

pub async fn start_server(options: ServerStartOptions) -> Result<ServerHandle, WsServerError> {
    let mut config = options.config_store.load_or_create()?;
    let storage = Storage::new(config.data_dir.clone());
    storage.ensure_layout(&config.device_id).await?;
    commands::recover_checkpoint_tail(&storage)
        .await
        .map_err(WsServerError::Ingest)?;
    let (listener, port) = bind_first_available(&options.port_candidates).await?;
    config.last_port = Some(port);
    options.config_store.save(&config)?;

    let snapshot = ServerSnapshot {
        port,
        device_id: config.device_id.clone(),
        service_status: ServiceStatus::Running,
        connected_browsers: Vec::new(),
        connected_connectors: Vec::new(),
        last_error: None,
        last_error_code: None,
    };
    let (snapshot_tx, _) = watch::channel(snapshot.clone());
    let (change_message_tx, _) = broadcast::channel(128);
    let (revoke_tx, _) = broadcast::channel(128);
    let shared = SharedState {
        snapshot: Arc::new(RwLock::new(snapshot)),
        snapshot_tx,
        change_message_tx,
        revoke_tx,
        config_store: options.config_store.clone(),
        config: Arc::new(Mutex::new(config)),
        storage,
        ingest_status: Arc::new(Mutex::new(IngestStatus::default())),
        connector_buffer_status: Arc::new(Mutex::new(ConnectorBufferStatus::default())),
        service_state: Arc::new(RwLock::new(ServiceState::Running)),
        approver: options.approver,
        pair_timeout: options.pair_timeout,
        test_control_enabled: options.test_control_enabled,
        active_connections: Arc::new(Mutex::new(HashMap::new())),
        next_connection_id: Arc::new(AtomicU64::new(1)),
    };
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let task_shared = shared.clone();
    info!(port, "browser recall daemon listening");
    let task = tokio::spawn(async move {
        let pause_shared = task_shared.clone();
        let accept_loop = AssertUnwindSafe(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept_result = listener.accept() => {
                        let Ok((stream, _)) = accept_result else {
                            continue;
                        };
                        let shared = task_shared.clone();
                        tokio::spawn(async move {
                            match AssertUnwindSafe(handle_connection(stream, shared.clone()))
                                .catch_unwind()
                                .await
                            {
                                Ok(Ok(())) => {}
                                Ok(Err(error)) => {
                                    warn!(error = %error, "websocket connection task failed");
                                }
                                Err(_) => {
                                    warn!("websocket connection task panicked");
                                }
                            }
                        });
                    }
                }
            }
        });

        if accept_loop.catch_unwind().await.is_err() {
            warn!("core daemon accept loop panicked");
            pause_service(
                &pause_shared,
                ErrorCode::ReplayError,
                "A core daemon task crashed. Browser Recall paused until restart.",
            )
            .await;
        }
    });

    Ok(ServerHandle {
        port,
        shared,
        shutdown_tx: Some(shutdown_tx),
        task,
    })
}

async fn bind_first_available(candidates: &[u16]) -> Result<(TcpListener, u16), WsServerError> {
    for port in candidates {
        match TcpListener::bind(("127.0.0.1", *port)).await {
            Ok(listener) => {
                let bound_port = listener.local_addr()?.port();
                return Ok((listener, bound_port));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(WsServerError::Io(error)),
        }
    }
    Err(WsServerError::NoPortsAvailable)
}

#[allow(clippy::result_large_err)]
async fn handle_connection(stream: TcpStream, shared: SharedState) -> Result<(), WsServerError> {
    let origin_slot = Arc::new(std::sync::Mutex::new(None::<String>));
    let origin_slot_clone = origin_slot.clone();
    let ws_stream = accept_hdr_async_with_config(
        stream,
        move |request: &Request, response: Response| {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_string());
            *origin_slot_clone.lock().expect("origin mutex poisoned") = origin.clone();
            Ok(response)
        },
        Some(websocket_config()),
    )
    .await
    .map_err(|error| WsServerError::Handshake(error.to_string()))?;

    let origin = origin_slot.lock().expect("origin mutex poisoned").clone();
    info!(
        origin = origin.as_deref().unwrap_or("unknown"),
        "accepted websocket connection"
    );
    let (mut write, mut read) = ws_stream.split();
    let connection_id = shared.next_connection_id.fetch_add(1, Ordering::Relaxed);
    let mut revoke_rx = shared.revoke_tx.subscribe();
    let mut change_rx = shared.change_message_tx.subscribe();
    let mut connected_connector = None::<ConnectedConnector>;
    let mut authenticated = false;
    loop {
        let message = tokio::select! {
            revoked = revoke_rx.recv(), if authenticated => {
                match revoked {
                    Ok(key) => {
                        let revoked_key = (key.0.as_str(), key.1.as_str());
                        if connected_connector
                            .as_ref()
                            .is_some_and(|connector| connector.key() == revoked_key)
                        {
                            send_json(
                                &mut write,
                                &DaemonMessage::AuthFail {
                                    reason: "token_revoked".into(),
                                },
                            )
                            .await?;
                            break;
                        }
                        continue;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => continue,
                }
            }
            changed = change_rx.recv(), if authenticated => {
                match changed {
                    Ok(message) => {
                        send_json(&mut write, &message).await?;
                        continue;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => continue,
                }
            }
            maybe_message = read.next() => {
                match maybe_message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => return Err(WsServerError::Handshake(error.to_string())),
                }
            }
            _ = tokio::time::sleep(UNAUTHENTICATED_IDLE_TIMEOUT), if !authenticated => {
                send_json(&mut write, &unauthorized_error()).await?;
                break;
            }
        };

        let incoming = match serde_json::from_str::<ConnectorMessage>(&message) {
            Ok(incoming) => incoming,
            Err(error) => {
                warn!(error = %error, "invalid connector message");
                send_json(&mut write, &invalid_message_error(error.to_string())).await?;
                continue;
            }
        };
        if message_requires_running_service(&incoming) {
            if let Some(message) = paused_error(&shared).await {
                send_json(&mut write, &message).await?;
                continue;
            }
        }
        let requires_authentication = message_requires_authentication(&incoming);
        if requires_authentication && !authenticated {
            send_json(&mut write, &unauthorized_error()).await?;
            continue;
        }
        if authenticated && requires_authentication {
            if let Some(connector) = connected_connector.as_ref() {
                if !connector_is_approved(&shared, connector).await {
                    send_json(
                        &mut write,
                        &DaemonMessage::AuthFail {
                            reason: "token_revoked".into(),
                        },
                    )
                    .await?;
                    break;
                }
            }
        }
        match incoming {
            ConnectorMessage::Ping => {
                send_json(&mut write, &DaemonMessage::Pong).await?;
            }
            ConnectorMessage::GetStatus => {
                send_json(&mut write, &build_status_message(&shared).await).await?;
            }
            ConnectorMessage::GetDirectoryInfo => {
                send_json(&mut write, &handle_get_directory_info(&shared).await).await?;
            }
            ConnectorMessage::GetDirectorySize => {
                send_json(&mut write, &handle_get_directory_size(&shared).await).await?;
            }
            ConnectorMessage::ClearAllData => {
                send_json(&mut write, &handle_clear_all_data(&shared).await).await?;
            }
            ConnectorMessage::ReplayRemoteEntries { device_id, entries } => {
                match handle_replay_remote_entries(&shared, device_id, entries).await {
                    Ok((result, mutations)) => {
                        send_json(&mut write, &result).await?;
                        broadcast_mutations(&shared, mutations);
                    }
                    Err(error) => {
                        send_json(
                            &mut write,
                            &DaemonMessage::RemoteReplayResult {
                                success: false,
                                replayed_entries: 0,
                                error: Some(error.to_string()),
                            },
                        )
                        .await?;
                    }
                }
            }
            ConnectorMessage::SetDeviceId { device_id } => {
                send_json(&mut write, &handle_set_device_id(&shared, device_id).await).await?;
            }
            ConnectorMessage::ListHistoryFiles { include_sizes } => {
                send_json(
                    &mut write,
                    &handle_list_history_files(&shared, include_sizes).await,
                )
                .await?;
            }
            ConnectorMessage::LoadHistoryBatch { files } => {
                send_json(&mut write, &handle_load_history_batch(&shared, files).await).await?;
            }
            ConnectorMessage::GetAllPages => {
                let message = if shared.test_control_enabled {
                    handle_get_all_pages(&shared).await
                } else {
                    test_control_disabled_error()
                };
                send_json(&mut write, &message).await?;
            }
            ConnectorMessage::GetPageInfo { slug } => {
                send_json(&mut write, &handle_get_page_info(&shared, slug).await).await?;
            }
            ConnectorMessage::GetPageSummary { url } => {
                send_json(&mut write, &handle_get_page_summary(&shared, url).await).await?;
            }
            ConnectorMessage::GetSettings => {
                let message =
                    match crate::read_projections::ReadProjections::new(shared.storage.clone())
                        .settings()
                        .await
                    {
                        Ok(settings) => DaemonMessage::SettingsResult {
                            success: true,
                            settings,
                            error: None,
                        },
                        Err(error) => DaemonMessage::SettingsResult {
                            success: false,
                            settings: None,
                            error: Some(error),
                        },
                    };
                send_json(&mut write, &message).await?;
            }
            ConnectorMessage::GetSnapshotHtml { slug, ts } => {
                send_json(
                    &mut write,
                    &handle_get_snapshot_html(&shared, slug, ts).await,
                )
                .await?;
            }
            ConnectorMessage::GetEntity { key } => {
                let message = if shared.test_control_enabled {
                    handle_get_entity(&shared, key).await
                } else {
                    test_control_disabled_error()
                };
                send_json(&mut write, &message).await?;
            }
            ConnectorMessage::PermanentDelete { keys } => {
                match handle_permanent_delete(&shared, keys).await {
                    Ok(result) => send_json(&mut write, &result).await?,
                    Err(error) => {
                        warn!(error = %error, "permanent delete failed");
                        let message = format!("Permanent delete failed: {error}");
                        pause_service(&shared, ErrorCode::FsError, message).await;
                        if let Some(message) = paused_error(&shared).await {
                            send_json(&mut write, &message).await?;
                        }
                    }
                }
            }
            ConnectorMessage::GetPopupLists => {
                send_json(&mut write, &handle_get_popup_lists(&shared).await).await?;
            }
            ConnectorMessage::RunCommand {
                action,
                request,
                buffer_depth,
                buffer_bytes,
            } => match run_connector_command(&shared, &action, request).await {
                Ok(response) => {
                    record_connector_buffer(&shared, buffer_depth, buffer_bytes).await;
                    let success = response
                        .get("success")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    send_json(
                        &mut write,
                        &DaemonMessage::CommandResult {
                            success,
                            response: Some(response),
                            error: None,
                        },
                    )
                    .await?;
                }
                Err(error) => {
                    send_json(
                        &mut write,
                        &DaemonMessage::CommandResult {
                            success: false,
                            response: None,
                            error: Some(error.to_string()),
                        },
                    )
                    .await?;
                }
            },
            ConnectorMessage::SearchNotes { query, limit } => {
                send_json(
                    &mut write,
                    &handle_search_notes(&shared, query, limit).await,
                )
                .await?;
            }
            ConnectorMessage::SearchSnapshots { query, limit } => {
                send_json(
                    &mut write,
                    &handle_search_snapshots(&shared, query, limit).await,
                )
                .await?;
            }
            ConnectorMessage::TestResetData => {
                send_json(&mut write, &handle_test_reset_data(&shared).await).await?;
            }
            ConnectorMessage::TestSeedData { files } => {
                send_json(&mut write, &handle_test_seed_data(&shared, files).await).await?;
            }
            ConnectorMessage::Auth { token } => {
                let maybe_browser = {
                    let config = shared.config.lock().await;
                    config.connectors.iter().find_map(|connector| {
                        (connector.token.0 == token).then(|| ConnectedConnector {
                            browser_id: connector.browser_id.clone(),
                            browser_name: connector.browser_name.clone(),
                            extension_id: connector.extension_id.clone(),
                        })
                    })
                };

                if let Some(active_connector) = maybe_browser {
                    {
                        let mut config = shared.config.lock().await;
                        if let Some(connector) = config.connectors.iter_mut().find(|connector| {
                            connector.browser_id == active_connector.browser_id
                                && connector.extension_id == active_connector.extension_id
                        }) {
                            connector.last_seen_at = Some(unix_timestamp());
                            let _ = shared.config_store.save(&config);
                        }
                    }
                    connected_connector = Some(active_connector.clone());
                    authenticated = true;
                    set_connected(&shared, connection_id, active_connector, true).await;
                    info!("connector authenticated");
                    send_json(&mut write, &DaemonMessage::AuthOk).await?;
                } else {
                    warn!("connector auth failed");
                    send_json(
                        &mut write,
                        &DaemonMessage::AuthFail {
                            reason: "token_not_found".into(),
                        },
                    )
                    .await?;
                    break;
                }
            }
            ConnectorMessage::PairRequest {
                browser_id,
                browser_name,
                extension_id,
                browser_profile,
            } => {
                let request = PairingRequest {
                    request_id: random_string(12),
                    browser_id,
                    browser_name,
                    extension_id,
                    browser_profile,
                    origin: origin.clone(),
                };
                send_json(
                    &mut write,
                    &DaemonMessage::PairPending {
                        request_id: request.request_id.clone(),
                    },
                )
                .await?;
                info!(
                    browser = request.browser_name.as_str(),
                    extension_id = request.extension_id.as_str(),
                    "pairing request pending"
                );

                let decision =
                    with_timeout(&shared.approver, request.clone(), shared.pair_timeout).await;
                match decision {
                    PairingDecision::Approve => {
                        let token = Token(random_string(32));
                        let now = unix_timestamp();
                        let active = {
                            let active_connections = shared.active_connections.lock().await;
                            active_connector_keys(&active_connections)
                        };
                        let device_id = {
                            let mut config = shared.config.lock().await;
                            upsert_connector(
                                &mut config.connectors,
                                ApprovedConnector {
                                    browser_id: request.browser_id.clone(),
                                    browser_name: request.browser_name.clone(),
                                    extension_id: request.extension_id.clone(),
                                    browser_profile: request.browser_profile.clone(),
                                    token: token.clone(),
                                    approved_at: now,
                                    last_seen_at: Some(now),
                                },
                            );
                            prune_inactive_connectors(
                                &mut config.connectors,
                                &active,
                                current_local_day_start_unix(),
                            );
                            shared.config_store.save(&config)?;
                            config.device_id.clone()
                        };
                        let connector = ConnectedConnector {
                            browser_id: request.browser_id.clone(),
                            browser_name: request.browser_name.clone(),
                            extension_id: request.extension_id.clone(),
                        };
                        connected_connector = Some(connector.clone());
                        authenticated = true;
                        set_connected(&shared, connection_id, connector, true).await;
                        info!("pairing approved");
                        send_json(
                            &mut write,
                            &DaemonMessage::PairApproved {
                                token: token.0,
                                device_id,
                            },
                        )
                        .await?;
                    }
                    PairingDecision::Deny => {
                        warn!("pairing denied");
                        send_json(&mut write, &DaemonMessage::PairDenied).await?;
                        break;
                    }
                }
            }
            ConnectorMessage::Event {
                entry,
                source,
                buffer_depth,
                buffer_bytes,
            } => {
                if let Err(error) = validate_connector_source(&source) {
                    send_json(&mut write, &invalid_message_error(error.to_string())).await?;
                    continue;
                }
                let parsed: LogEntry = match serde_json::from_value(entry.clone()) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        warn!(error = %error, "invalid event payload");
                        send_json(&mut write, &invalid_message_error(error.to_string())).await?;
                        continue;
                    }
                };
                match ingest_typed_entry(&shared, parsed, entry).await {
                    Ok(IngestSuccess { ack, mutations }) => {
                        record_connector_buffer(&shared, buffer_depth, buffer_bytes).await;
                        send_json(&mut write, &ack).await?;
                        broadcast_mutations(&shared, mutations);
                    }
                    Err(error) => {
                        warn!(error = %error, "event ingest failed");
                        let message = format!("Event ingest failed: {error}");
                        pause_service(&shared, ErrorCode::ReplayError, message).await;
                        if let Some(message) = paused_error(&shared).await {
                            send_json(&mut write, &message).await?;
                        }
                    }
                }
            }
            ConnectorMessage::RunRuleBatch { list_ids, entries } => {
                match run_rule_batch(&shared, list_ids, entries).await {
                    Ok(result) => send_json(&mut write, &result).await?,
                    Err(error) => {
                        warn!(error = %error, "rule batch failed");
                        send_json(
                            &mut write,
                            &DaemonMessage::RuleBatchResult {
                                success: false,
                                results: Vec::new(),
                                error: Some(error.to_string()),
                            },
                        )
                        .await?;
                    }
                }
            }
            ConnectorMessage::PreviewRule { rule, entries } => {
                match preview_rule_batch(rule, entries).await {
                    Ok(result) => send_json(&mut write, &result).await?,
                    Err(error) => {
                        warn!(error = %error, "rule preview failed");
                        send_json(
                            &mut write,
                            &DaemonMessage::PreviewRuleResult {
                                success: false,
                                results: Vec::new(),
                                error: Some(error.to_string()),
                            },
                        )
                        .await?;
                    }
                }
            }
            ConnectorMessage::Snapshot {
                slug,
                ts,
                url,
                title,
                markdown,
                html,
                source,
                buffer_depth,
                buffer_bytes,
            } => {
                if let Err(error) = validate_connector_source(&source) {
                    send_json(&mut write, &invalid_message_error(error.to_string())).await?;
                    continue;
                }
                match ingest_snapshot(&shared, slug, ts, url, title, markdown, html).await {
                    Ok(IngestSuccess { ack, mutations }) => {
                        record_connector_buffer(&shared, buffer_depth, buffer_bytes).await;
                        send_json(&mut write, &ack).await?;
                        broadcast_mutations(&shared, mutations);
                    }
                    Err(error) => {
                        warn!(error = %error, "snapshot ingest failed");
                        let message = format!("Snapshot ingest failed: {error}");
                        pause_service(&shared, ErrorCode::FsError, message).await;
                        if let Some(message) = paused_error(&shared).await {
                            send_json(&mut write, &message).await?;
                        }
                    }
                }
            }
            ConnectorMessage::Note {
                slug,
                excerpt,
                note,
                css_path,
                old_slug,
                url,
                title,
                ts,
                source,
                buffer_depth,
                buffer_bytes,
            } => {
                if let Err(error) = validate_connector_source(&source) {
                    send_json(&mut write, &invalid_message_error(error.to_string())).await?;
                    continue;
                }
                match ingest_note(
                    &shared, slug, excerpt, note, css_path, old_slug, url, title, ts,
                )
                .await
                {
                    Ok(IngestSuccess { ack, mutations }) => {
                        record_connector_buffer(&shared, buffer_depth, buffer_bytes).await;
                        send_json(&mut write, &ack).await?;
                        broadcast_mutations(&shared, mutations);
                    }
                    Err(error) => {
                        warn!(error = %error, "note ingest failed");
                        let message = format!("Note ingest failed: {error}");
                        pause_service(&shared, ErrorCode::FsError, message).await;
                        if let Some(message) = paused_error(&shared).await {
                            send_json(&mut write, &message).await?;
                        }
                    }
                }
            }
        }
    }

    if let Some(connector) = connected_connector {
        set_connected(&shared, connection_id, connector, false).await;
    }
    Ok(())
}

fn message_requires_authentication(message: &ConnectorMessage) -> bool {
    !matches!(
        message,
        ConnectorMessage::Ping
            | ConnectorMessage::Auth { .. }
            | ConnectorMessage::PairRequest { .. }
            | ConnectorMessage::TestResetData
            | ConnectorMessage::TestSeedData { .. }
    )
}

fn message_requires_running_service(message: &ConnectorMessage) -> bool {
    matches!(
        message,
        ConnectorMessage::ClearAllData
            | ConnectorMessage::ReplayRemoteEntries { .. }
            | ConnectorMessage::SetDeviceId { .. }
            | ConnectorMessage::PermanentDelete { .. }
            | ConnectorMessage::RunCommand { .. }
            | ConnectorMessage::Event { .. }
            | ConnectorMessage::RunRuleBatch { .. }
            | ConnectorMessage::Snapshot { .. }
            | ConnectorMessage::Note { .. }
    )
}

async fn connector_is_approved(shared: &SharedState, active: &ConnectedConnector) -> bool {
    let config = shared.config.lock().await;
    config.connectors.iter().any(|connector| {
        connector.browser_id == active.browser_id && connector.extension_id == active.extension_id
    })
}

fn connected_snapshot_fields(
    active_connections: &HashMap<u64, ConnectedConnector>,
) -> (Vec<String>, Vec<ConnectedConnector>) {
    let mut unique_connectors = HashMap::<ConnectorKey, ConnectedConnector>::new();
    for connector in active_connections.values() {
        unique_connectors.insert(
            connector_key(&connector.browser_id, &connector.extension_id),
            connector.clone(),
        );
    }
    let mut connected_connectors = unique_connectors.into_values().collect::<Vec<_>>();
    connected_connectors.sort_by(|left, right| {
        left.browser_name
            .cmp(&right.browser_name)
            .then_with(|| left.browser_id.cmp(&right.browser_id))
            .then_with(|| left.extension_id.cmp(&right.extension_id))
    });
    let mut connected_browsers = connected_connectors
        .iter()
        .map(|connector| connector.browser_name.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    connected_browsers.sort();
    (connected_browsers, connected_connectors)
}

fn active_connector_keys(
    active_connections: &HashMap<u64, ConnectedConnector>,
) -> HashSet<ConnectorKey> {
    active_connections
        .values()
        .map(|connector| connector_key(&connector.browser_id, &connector.extension_id))
        .collect()
}

fn upsert_connector(connectors: &mut Vec<ApprovedConnector>, candidate: ApprovedConnector) {
    if let Some(existing) = connectors.iter_mut().find(|connector| {
        connector.browser_id == candidate.browser_id
            && connector.extension_id == candidate.extension_id
    }) {
        *existing = candidate;
    } else {
        connectors.push(candidate);
    }
}

async fn send_json(
    write: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<TcpStream>,
        Message,
    >,
    message: &DaemonMessage,
) -> Result<(), WsServerError> {
    let payload = serde_json::to_string(message)?;
    write
        .send(Message::Text(payload))
        .await
        .map_err(|error| WsServerError::Handshake(error.to_string()))
}

async fn ingest_snapshot(
    shared: &SharedState,
    slug: String,
    ts: i64,
    url: String,
    title: Option<String>,
    markdown: Option<String>,
    html: String,
) -> Result<IngestSuccess, WsServerError> {
    if let Some(markdown) = markdown.filter(|markdown| !markdown.is_empty()) {
        shared
            .storage
            .save_snapshot_markdown(&slug, ts, &markdown)
            .await?;
    }
    shared.storage.save_snapshot_html(&slug, ts, &html).await?;
    let entry = json!({
        "timestamp": ts,
        "action": "create_snapshot",
        "url": url,
        "path": shared.storage.snapshot_sidecar_relative_path(&slug, ts),
        "title": title,
    });
    let parsed: LogEntry = serde_json::from_value(entry.clone())?;
    ingest_typed_entry(shared, parsed, entry).await
}

#[allow(clippy::too_many_arguments)]
async fn ingest_note(
    shared: &SharedState,
    slug: String,
    excerpt: Option<Value>,
    note: String,
    css_path: Option<Value>,
    old_slug: Option<String>,
    url: String,
    title: Option<String>,
    ts: i64,
) -> Result<IngestSuccess, WsServerError> {
    let mut entry = json!({
        "timestamp": ts,
        "action": if old_slug.is_some() { "replace_note" } else { "create_note" },
        "url": url,
        "path": format!("objects/notes/{slug}.json"),
        "excerpt": excerpt,
        "note": note,
        "cssPath": css_path,
    });
    if let Some(old_slug) = old_slug {
        if let Some(object) = entry.as_object_mut() {
            object.insert(
                "oldPath".to_string(),
                Value::String(format!("objects/notes/{old_slug}.json")),
            );
        }
    } else if let Some(object) = entry.as_object_mut() {
        object.insert(
            "title".to_string(),
            title.map(Value::String).unwrap_or(Value::Null),
        );
    }
    let parsed: LogEntry = serde_json::from_value(entry.clone())?;
    ingest_typed_entry(shared, parsed, entry).await
}

async fn ingest_typed_entry(
    shared: &SharedState,
    entry: LogEntry,
    raw_entry: Value,
) -> Result<IngestSuccess, WsServerError> {
    {
        let mut ingest = shared.ingest_status.lock().await;
        ingest.buffer_depth += 1;
    }

    let outcome = async {
        let device_id = {
            let config = shared.config.lock().await;
            config.device_id.clone()
        };
        let transaction = ReplayTransaction::begin(&shared.storage, &device_id)
            .await
            .map_err(WsServerError::Ingest)?;
        let effects = commit_entry_with_auto_pins(
            shared,
            &device_id,
            transaction,
            entry.clone(),
            raw_entry.clone(),
        )
        .await?;

        let mutations = build_mutations(&entry, &raw_entry, &effects);
        let acked_at = current_timestamp_millis();
        let last_drained_at = entry.timestamp();
        let mut ingest = shared.ingest_status.lock().await;
        ingest.last_drained_at = Some(last_drained_at);
        Ok(IngestSuccess {
            ack: DaemonMessage::Ack {
                acked_at,
                buffer_depth: ingest.buffer_depth.saturating_sub(1),
                last_drained_at,
            },
            mutations,
        })
    }
    .await;

    let mut ingest = shared.ingest_status.lock().await;
    ingest.buffer_depth = ingest.buffer_depth.saturating_sub(1);
    outcome
}

async fn commit_entry_with_auto_pins(
    shared: &SharedState,
    device_id: &str,
    mut transaction: ReplayTransaction<'_>,
    entry: LogEntry,
    raw_entry: Value,
) -> Result<EntityMapView, WsServerError> {
    transaction
        .apply(entry.clone())
        .await
        .map_err(WsServerError::Ingest)?;
    let synthetic_entries = synthesize_auto_pin_entries(
        &entry,
        &raw_entry,
        &shared.storage,
        transaction.effects(),
        device_id,
    )
    .await
    .map_err(|error| WsServerError::Ingest(error.to_string()))?;

    for synthetic in &synthetic_entries {
        transaction
            .apply(synthetic.parsed.clone())
            .await
            .map_err(WsServerError::Ingest)?;
    }
    let result = transaction.commit().await.map_err(WsServerError::Ingest)?;
    Ok(result.effects)
}

async fn synthesize_auto_pin_entries(
    entry: &LogEntry,
    raw_entry: &Value,
    storage: &Storage,
    overlay: &EntityMapView,
    device_id: &str,
) -> Result<Vec<SyntheticLogEntry>, browser_recall_replay::ReplayError> {
    let LogEntry::VisitPage {
        timestamp,
        url,
        title,
        ..
    } = entry
    else {
        return Ok(Vec::new());
    };
    let Some(page_data) = page_data_from_raw_entry(raw_entry) else {
        return Ok(Vec::new());
    };
    let Some(Entity::ListOrder(list_order)) =
        load_entity_with_overlay(storage, overlay, "manifest:list-order").await
    else {
        return Ok(Vec::new());
    };

    let page_key = format!("page:{}", generate_slug_from_url(url)?);
    let mut synthetic = Vec::new();
    for list_key in flatten_tree_ids(&list_order) {
        let Some(Entity::List(list)) =
            load_entity_with_overlay(storage, overlay, list_key.as_str()).await
        else {
            continue;
        };
        if list.deleted || list.rules.is_empty() || !list_matches_page(&list, &page_data) {
            continue;
        }
        if list.pins.iter().any(|pin| pin.id == page_key) {
            continue;
        }
        let list_owner = list.owner.clone().unwrap_or_else(|| device_id.to_string());
        synthetic.push(build_auto_pin_entry(
            *timestamp,
            url,
            title.as_deref(),
            &list.name,
            &list_owner,
        ));
    }

    Ok(synthetic)
}

async fn load_entity_with_overlay(
    storage: &Storage,
    overlay: &EntityMapView,
    key: &str,
) -> Option<Entity> {
    if let Some(effect) = overlay.get(key) {
        return match effect {
            EntityEffect::Upsert(entity) => Some(entity.clone()),
            EntityEffect::Delete => None,
        };
    }
    storage.load_entity(key).await.ok().flatten()
}

fn flatten_tree_ids(list_order: &ListOrderManifest) -> Vec<String> {
    fn walk(nodes: &[TreeNode], output: &mut Vec<String>) {
        for node in nodes {
            output.push(node.id.clone());
            walk(&node.children, output);
        }
    }

    let mut output = Vec::new();
    walk(&list_order.tree, &mut output);
    output
}

fn build_auto_pin_entry(
    timestamp: i64,
    url: &str,
    title: Option<&str>,
    list_name: &str,
    list_owner: &str,
) -> SyntheticLogEntry {
    let parsed = LogEntry::PinToList {
        timestamp,
        name: list_name.to_string(),
        list_owner: list_owner.to_string(),
        urls: vec![url.to_string()],
        titles: title
            .filter(|value| !value.is_empty())
            .map(|value| vec![Some(value.to_string())]),
        source: Some("auto".to_string()),
    };
    SyntheticLogEntry { parsed }
}

async fn run_rule_batch(
    shared: &SharedState,
    list_ids: Vec<String>,
    entries: Vec<RuleBatchEntry>,
) -> Result<DaemonMessage, WsServerError> {
    let results = {
        let device_id = {
            let config = shared.config.lock().await;
            config.device_id.clone()
        };
        let mut transaction = ReplayTransaction::begin(&shared.storage, &device_id)
            .await
            .map_err(WsServerError::Ingest)?;
        let mut results = Vec::new();

        for list_id in list_ids {
            let list_key = format!("list:{list_id}");
            let Some(Entity::List(list)) =
                load_entity_with_overlay(&shared.storage, transaction.effects(), &list_key).await
            else {
                continue;
            };
            if list.deleted || list.rules.is_empty() {
                continue;
            }

            for entry in &entries {
                let page_data = page_data_from_batch_entry(entry);
                let matches = match match_list_rules_strict(&list, &page_data) {
                    Ok(matches) => matches,
                    Err(error) => {
                        return Ok(DaemonMessage::RuleBatchResult {
                            success: false,
                            results: Vec::new(),
                            error: Some(error),
                        });
                    }
                };
                if matches.is_empty() {
                    continue;
                }

                let page_key = format!(
                    "page:{}",
                    generate_slug_from_url(&entry.url)
                        .map_err(|error| WsServerError::Ingest(error.to_string()))?
                );
                let current_list = match load_entity_with_overlay(
                    &shared.storage,
                    transaction.effects(),
                    &list_key,
                )
                .await
                {
                    Some(Entity::List(list)) => list,
                    _ => continue,
                };
                if current_list.pins.iter().any(|pin| pin.id == page_key) {
                    continue;
                }

                let pinned_at = current_timestamp_millis();
                let synthetic = build_auto_pin_entry(
                    pinned_at,
                    &entry.url,
                    entry.title.as_deref(),
                    &current_list.name,
                    current_list.owner.as_deref().unwrap_or(&device_id),
                );
                transaction
                    .apply(synthetic.parsed)
                    .await
                    .map_err(WsServerError::Ingest)?;
                results.push(RuleBatchHit {
                    list_id: list_id.clone(),
                    url: entry.url.clone(),
                    title: entry.title.clone(),
                    matches: matches
                        .into_iter()
                        .map(|item| RuleMatchResult {
                            rule_id: item.rule_id,
                            r#match: item.r#match,
                        })
                        .collect(),
                    pinned_at,
                });
            }
        }

        transaction.commit().await.map_err(WsServerError::Ingest)?;
        results
    };

    Ok(DaemonMessage::RuleBatchResult {
        success: true,
        results,
        error: None,
    })
}

async fn preview_rule_batch(
    rule: RulePayload,
    entries: Vec<RuleBatchEntry>,
) -> Result<DaemonMessage, WsServerError> {
    let rule_spec = RuleSpec {
        rule_type: rule.rule_type,
        config: rule.config,
    };
    if let Err(error) = validate_rule(&rule_spec) {
        return Ok(DaemonMessage::PreviewRuleResult {
            success: false,
            results: Vec::new(),
            error: Some(error),
        });
    }

    let mut results = Vec::new();
    for entry in entries {
        let title = entry.title.clone().unwrap_or_default();
        let page_data = page_data_from_batch_entry(&entry);
        let matched = match preview_rule(&rule_spec, &page_data) {
            Ok(matched) => matched,
            Err(error) => {
                return Ok(DaemonMessage::PreviewRuleResult {
                    success: false,
                    results: Vec::new(),
                    error: Some(error),
                });
            }
        };
        results.push(PreviewRuleHit {
            url: entry.url,
            title,
            r#match: matched,
        });
    }

    Ok(DaemonMessage::PreviewRuleResult {
        success: true,
        results,
        error: None,
    })
}

fn page_data_from_batch_entry(entry: &RuleBatchEntry) -> PageData {
    PageData {
        title: entry.title.clone().unwrap_or_default(),
        url: entry.url.clone(),
        body: entry.body_preview.clone().or_else(|| entry.body.clone()),
    }
}

fn validate_connector_source(source: &str) -> Result<(), WsServerError> {
    if source != CONNECTOR_SOURCE_EXTENSION {
        return Err(WsServerError::Handshake(format!(
            "invalid connector source: {source}"
        )));
    }
    Ok(())
}

async fn record_connector_buffer(
    shared: &SharedState,
    buffer_depth: Option<usize>,
    buffer_bytes: Option<usize>,
) {
    let mut status = shared.connector_buffer_status.lock().await;
    status.buffer_depth = buffer_depth.unwrap_or(0);
    status.buffer_bytes = buffer_bytes.unwrap_or(0);
}

async fn commit_report_entry(
    shared: &SharedState,
    device_id: &str,
    transaction: ReplayTransaction<'_>,
    entry: LogEntry,
    raw_entry: Value,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let effects = commit_entry_with_auto_pins(
        shared,
        device_id,
        transaction,
        entry.clone(),
        raw_entry.clone(),
    )
    .await?;

    Ok((
        json!({ "success": true, "timestamp": entry.timestamp() }),
        build_mutations(&entry, &raw_entry, &effects),
    ))
}

async fn report_visit_command(
    shared: &SharedState,
    request: &Value,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };
    let transaction = ReplayTransaction::begin(&shared.storage, &device_id)
        .await
        .map_err(WsServerError::Ingest)?;
    let url = request
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| WsServerError::Ingest("reportVisit missing url".into()))?;
    let timestamp = request
        .get("timestamp")
        .or_else(|| request.get("observedAt"))
        .and_then(Value::as_i64)
        .unwrap_or_else(current_timestamp_millis);
    let settings = shared.storage.load_entity("manifest:settings").await?;
    if !should_record_visit(
        &shared.storage,
        settings.as_ref(),
        url,
        timestamp,
        request
            .get("bypassBlacklist")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
    .await
    .map_err(WsServerError::Ingest)?
    {
        return Ok((
            json!({ "success": true, "skipped": true, "timestamp": timestamp }),
            Vec::new(),
        ));
    }

    let title = request
        .get("title")
        .and_then(Value::as_str)
        .map(|title| trim_title_from_settings(settings.as_ref(), title, url))
        .filter(|title| !title.is_empty());
    let mut referrer_url = request
        .get("referrer")
        .or_else(|| request.get("referrerUrl"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(referrer) = &referrer_url {
        if generate_slug_from_url(referrer).ok() == generate_slug_from_url(url).ok() {
            referrer_url = None;
        }
    }

    let entry = LogEntry::VisitPage {
        timestamp,
        url: url.to_string(),
        title,
        referrer_url,
    };
    let mut raw_entry =
        serde_json::to_value(&entry).map_err(|error| WsServerError::Ingest(error.to_string()))?;
    if let Some(body_preview) = request.get("bodyPreview").and_then(Value::as_str) {
        if let Some(object) = raw_entry.as_object_mut() {
            object.insert(
                "bodyPreview".to_string(),
                Value::String(body_preview.to_string()),
            );
        }
    }
    commit_report_entry(shared, &device_id, transaction, entry, raw_entry).await
}

async fn report_leave_command(
    shared: &SharedState,
    request: &Value,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };
    let transaction = ReplayTransaction::begin(&shared.storage, &device_id)
        .await
        .map_err(WsServerError::Ingest)?;
    let url = request
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| WsServerError::Ingest("reportLeave missing url".into()))?;
    let timestamp = request
        .get("timestamp")
        .or_else(|| request.get("observedAt"))
        .and_then(Value::as_i64)
        .unwrap_or_else(current_timestamp_millis);
    let settings = shared.storage.load_entity("manifest:settings").await?;
    let title = request
        .get("title")
        .and_then(Value::as_str)
        .map(|title| trim_title_from_settings(settings.as_ref(), title, url))
        .filter(|title| !title.is_empty());
    let entry = LogEntry::LeavePage {
        timestamp,
        url: url.to_string(),
        title,
        scroll_depth: request.get("scrollDepth").and_then(Value::as_i64),
        time_on_page: request.get("timeOnPage").and_then(Value::as_i64),
    };
    let raw_entry =
        serde_json::to_value(&entry).map_err(|error| WsServerError::Ingest(error.to_string()))?;
    commit_report_entry(shared, &device_id, transaction, entry, raw_entry).await
}

async fn trim_title_command(
    shared: &SharedState,
    request: &Value,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let title = request.get("title").and_then(Value::as_str).unwrap_or("");
    let url = request.get("url").and_then(Value::as_str).unwrap_or("");
    let settings = shared.storage.load_entity("manifest:settings").await?;
    Ok((
        json!({
            "success": true,
            "title": trim_title_from_settings(settings.as_ref(), title, url),
        }),
        Vec::new(),
    ))
}

async fn popup_access_state_command(
    shared: &SharedState,
    request: &Value,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let url = request
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| WsServerError::Ingest("getPopupAccessState missing url".into()))?;
    let settings = shared.storage.load_entity("manifest:settings").await?;
    let blacklisted_by_policy = blacklist_prefixes(settings.as_ref())
        .iter()
        .any(|prefix| url.starts_with(prefix));
    let slug =
        generate_slug_from_url(url).map_err(|error| WsServerError::Ingest(error.to_string()))?;
    let has_visit_history = shared
        .storage
        .load_entity(&format!("page:{slug}"))
        .await?
        .is_some();
    Ok((
        json!({
            "success": true,
            "blacklisted": blacklisted_by_policy && !has_visit_history,
            "hasVisitHistory": has_visit_history,
        }),
        Vec::new(),
    ))
}

async fn run_shared_command(
    shared: &SharedState,
    action: &str,
    request: Value,
) -> Result<Value, WsServerError> {
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };
    let outcome = CommandAuthority::new(shared.storage.clone(), device_id)
        .execute(action, request)
        .await
        .map_err(WsServerError::Ingest)?;
    let success = outcome
        .response
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if success {
        broadcast_mutations(shared, outcome.mutations);
    }
    if action == "clearAllData" {
        let mut status = shared.ingest_status.lock().await;
        status.buffer_depth = 0;
        status.last_drained_at = None;
    }
    Ok(outcome.response)
}

async fn run_connector_command(
    shared: &SharedState,
    action: &str,
    request: Value,
) -> Result<Value, WsServerError> {
    if CommandAuthority::supports(action) {
        return run_shared_command(shared, action, request).await;
    }

    let (response, mutations) = match action {
        "trimTitle" => trim_title_command(shared, &request).await?,
        "getPopupAccessState" => popup_access_state_command(shared, &request).await?,
        "reportVisit" => report_visit_command(shared, &request).await?,
        "reportLeave" => report_leave_command(shared, &request).await?,
        other => {
            return Err(WsServerError::Ingest(format!(
                "unsupported connector command: {other}"
            )))
        }
    };
    let success = response
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if success {
        broadcast_mutations(shared, mutations);
    }
    Ok(response)
}

fn broadcast_mutations(shared: &SharedState, mutations: Vec<MutationPayload>) {
    if mutations.is_empty() {
        return;
    }
    let message = DaemonMessage::Change { mutations };
    let _ = shared.change_message_tx.send(message);
}

async fn build_status_message(shared: &SharedState) -> DaemonMessage {
    let snapshot = shared.snapshot.read().await.clone();
    let ingest = shared.ingest_status.lock().await;
    let connector = shared.connector_buffer_status.lock().await;
    let config = shared.config.lock().await;
    DaemonMessage::Status {
        connected_browsers: snapshot.connected_browsers,
        buffer_depth: connector.buffer_depth,
        buffer_bytes: connector.buffer_bytes,
        daemon_buffer_depth: ingest.buffer_depth,
        last_drained_at: ingest.last_drained_at,
        data_folder: config.data_dir.to_string_lossy().into_owned(),
        device_id: config.device_id.clone(),
    }
}

async fn handle_search_notes(
    shared: &SharedState,
    query: String,
    limit: Option<usize>,
) -> DaemonMessage {
    let data_dir = {
        let config = shared.config.lock().await;
        config.data_dir.clone()
    };
    match tokio::task::spawn_blocking(move || search_notes_in_data_dir(&data_dir, &query, limit))
        .await
    {
        Ok(Ok(results)) => DaemonMessage::SearchNotesResult {
            success: true,
            results: results
                .into_iter()
                .map(|result| NoteSearchResult {
                    url: result.url,
                    note_slug: result.note_slug,
                    score: result.score,
                })
                .collect(),
            error: None,
        },
        Ok(Err(error)) => DaemonMessage::SearchNotesResult {
            success: false,
            results: Vec::new(),
            error: Some(error.to_string()),
        },
        Err(error) => DaemonMessage::SearchNotesResult {
            success: false,
            results: Vec::new(),
            error: Some(error.to_string()),
        },
    }
}

async fn handle_search_snapshots(
    shared: &SharedState,
    query: String,
    limit: Option<usize>,
) -> DaemonMessage {
    let data_dir = {
        let config = shared.config.lock().await;
        config.data_dir.clone()
    };
    match tokio::task::spawn_blocking(move || {
        search_snapshots_in_data_dir(&data_dir, &query, limit)
    })
    .await
    {
        Ok(Ok(results)) => DaemonMessage::SearchSnapshotsResult {
            success: true,
            results: results
                .into_iter()
                .map(|result| SnapshotSearchResult {
                    slug: result.slug,
                    timestamp: result.timestamp,
                    score: result.score,
                })
                .collect(),
            error: None,
        },
        Ok(Err(error)) => DaemonMessage::SearchSnapshotsResult {
            success: false,
            results: Vec::new(),
            error: Some(error.to_string()),
        },
        Err(error) => DaemonMessage::SearchSnapshotsResult {
            success: false,
            results: Vec::new(),
            error: Some(error.to_string()),
        },
    }
}

async fn handle_get_page_info(shared: &SharedState, slug: String) -> DaemonMessage {
    let (page, notes, snapshots) = match load_page_info_parts(shared, &slug).await {
        Ok(parts) => parts,
        Err((page, notes, snapshots, error)) => {
            return DaemonMessage::PageInfoResult {
                success: false,
                slug,
                entry: page.as_ref().map(map_popup_page_entry),
                notes,
                snapshots,
                error: Some(error),
            };
        }
    };

    DaemonMessage::PageInfoResult {
        success: true,
        slug,
        entry: page.as_ref().map(map_popup_page_entry),
        notes,
        snapshots,
        error: None,
    }
}

async fn handle_get_page_summary(shared: &SharedState, url: String) -> DaemonMessage {
    let slug = match generate_slug_from_url(&url) {
        Ok(slug) => slug,
        Err(error) => {
            return DaemonMessage::PageSummaryResult {
                success: false,
                url,
                page: None,
                notes: Vec::new(),
                snapshots: Vec::new(),
                lists: Vec::new(),
                attention: None,
                error: Some(error.to_string()),
            };
        }
    };

    let (page, notes, snapshots) = match load_page_info_parts(shared, &slug).await {
        Ok(parts) => parts,
        Err((page, notes, snapshots, error)) => {
            return DaemonMessage::PageSummaryResult {
                success: false,
                url,
                page: page.as_ref().map(map_popup_page_entry),
                notes,
                snapshots,
                lists: Vec::new(),
                attention: None,
                error: Some(error),
            };
        }
    };

    let lists = match load_popup_lists(shared).await {
        Ok(lists) => lists,
        Err(error) => {
            return DaemonMessage::PageSummaryResult {
                success: false,
                url,
                page: page.as_ref().map(map_popup_page_entry),
                notes,
                snapshots,
                lists: Vec::new(),
                attention: None,
                error: Some(error),
            };
        }
    };

    let attention = page.as_ref().map(|page| PopupAttentionResult {
        total_seconds: page.time_on_page.unwrap_or(0) / 1000,
        last_visit: page.timestamps.values().copied().max(),
    });

    DaemonMessage::PageSummaryResult {
        success: true,
        url,
        page: page.as_ref().map(map_popup_page_entry),
        notes,
        snapshots,
        lists,
        attention,
        error: None,
    }
}

async fn handle_get_snapshot_html(shared: &SharedState, slug: String, ts: i64) -> DaemonMessage {
    match shared.storage.load_snapshot_html(&slug, ts).await {
        Ok(Some(html)) => DaemonMessage::SnapshotHtmlResult {
            success: true,
            html: Some(html),
            error: None,
        },
        Ok(None) => DaemonMessage::SnapshotHtmlResult {
            success: false,
            html: None,
            error: Some("Not found".to_string()),
        },
        Err(error) => DaemonMessage::SnapshotHtmlResult {
            success: false,
            html: None,
            error: Some(error.to_string()),
        },
    }
}

async fn handle_get_entity(shared: &SharedState, key: String) -> DaemonMessage {
    match shared.storage.load_entity_coordinated(&key).await {
        Ok(Some(entity)) => DaemonMessage::EntityResult {
            success: true,
            key,
            entity: Some(entity_to_value(entity)),
            error: None,
        },
        Ok(None) => DaemonMessage::EntityResult {
            success: true,
            key,
            entity: None,
            error: None,
        },
        Err(error) => DaemonMessage::EntityResult {
            success: false,
            key,
            entity: None,
            error: Some(error.to_string()),
        },
    }
}

async fn handle_get_directory_info(shared: &SharedState) -> DaemonMessage {
    let data_folder = shared.storage.root().to_string_lossy().to_string();
    let name = shared
        .storage
        .root()
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or(data_folder);
    DaemonMessage::DirectoryInfoResult {
        success: true,
        info: Some(DirectoryInfoPayload {
            name,
            has_permission: true,
        }),
        error: None,
    }
}

async fn handle_get_directory_size(shared: &SharedState) -> DaemonMessage {
    match shared.storage.directory_size().await {
        Ok(size) => DaemonMessage::DirectorySizeResult {
            success: true,
            size,
            error: None,
        },
        Err(error) => DaemonMessage::DirectorySizeResult {
            success: false,
            size: 0,
            error: Some(error.to_string()),
        },
    }
}

async fn handle_clear_all_data(shared: &SharedState) -> DaemonMessage {
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };

    let result = runtime::clear_all_data(&shared.storage, &device_id).await;

    match result {
        Ok(deleted_count) => {
            {
                let mut status = shared.ingest_status.lock().await;
                status.buffer_depth = 0;
                status.last_drained_at = None;
            }
            DaemonMessage::ClearAllDataResult {
                success: true,
                deleted_count,
                error: None,
            }
        }
        Err(error) => DaemonMessage::ClearAllDataResult {
            success: false,
            deleted_count: 0,
            error: Some(error.to_string()),
        },
    }
}

async fn handle_replay_remote_entries(
    shared: &SharedState,
    device_id: String,
    entries: Vec<Value>,
) -> Result<(DaemonMessage, Vec<MutationPayload>), WsServerError> {
    let mutations = {
        let mut transaction = ReplayTransaction::begin(&shared.storage, &device_id)
            .await
            .map_err(WsServerError::Ingest)?;
        let mut mutations = Vec::new();

        for raw_entry in &entries {
            let parsed: LogEntry = serde_json::from_value(raw_entry.clone())?;
            let effects = transaction
                .apply(parsed.clone())
                .await
                .map_err(WsServerError::Ingest)?;

            mutations.extend(build_mutations(&parsed, raw_entry, &effects));
        }

        transaction.commit().await.map_err(WsServerError::Ingest)?;
        mutations
    };

    Ok((
        DaemonMessage::RemoteReplayResult {
            success: true,
            replayed_entries: entries.len(),
            error: None,
        },
        dedupe_mutations(mutations),
    ))
}

async fn set_device_id_internal(
    shared: &SharedState,
    device_id: String,
) -> Result<(), WsServerError> {
    {
        let mut config = shared.config.lock().await;
        config.device_id = device_id.clone();
        shared.config_store.save(&config)?;
    }
    shared.storage.ensure_layout(&device_id).await?;
    {
        let mut snapshot = shared.snapshot.write().await;
        snapshot.device_id = device_id;
        let _ = shared.snapshot_tx.send(snapshot.clone());
    }
    Ok(())
}

async fn handle_set_device_id(shared: &SharedState, device_id: String) -> DaemonMessage {
    let result = async {
        let _guard = shared.storage.write_guard().await;
        set_device_id_internal(shared, device_id.clone()).await
    }
    .await;

    match result {
        Ok(()) => DaemonMessage::SetDeviceIdResult {
            success: true,
            device_id,
            error: None,
        },
        Err(error) => DaemonMessage::SetDeviceIdResult {
            success: false,
            device_id,
            error: Some(error.to_string()),
        },
    }
}

async fn handle_test_reset_data(shared: &SharedState) -> DaemonMessage {
    if !shared.test_control_enabled {
        return test_control_disabled_error();
    }

    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };

    let result = async {
        runtime::clear_all_data(&shared.storage, &device_id)
            .await
            .map_err(WsServerError::Ingest)?;
        set_device_id_internal(shared, device_id.clone()).await?;
        shared.storage.reset_cache();
        {
            let mut ingest = shared.ingest_status.lock().await;
            *ingest = IngestStatus::default();
        }
        {
            let mut connector = shared.connector_buffer_status.lock().await;
            *connector = ConnectorBufferStatus::default();
        }
        resume_service(shared).await;
        Ok::<(), WsServerError>(())
    }
    .await;

    match result {
        Ok(()) => DaemonMessage::TestResetDataResult {
            success: true,
            device_id,
            error: None,
        },
        Err(error) => DaemonMessage::TestResetDataResult {
            success: false,
            device_id,
            error: Some(error.to_string()),
        },
    }
}

async fn handle_test_seed_data(
    shared: &SharedState,
    files: Vec<TestSeedFilePayload>,
) -> DaemonMessage {
    if !shared.test_control_enabled {
        return test_control_disabled_error();
    }

    let files = match files
        .into_iter()
        .map(|file| validate_test_seed_path(file.path).map(|path| (path, file.content)))
        .collect::<Result<Vec<_>, WsServerError>>()
    {
        Ok(files) => files,
        Err(error) => {
            return DaemonMessage::TestSeedDataResult {
                success: false,
                error: Some(error.to_string()),
            };
        }
    };

    let result = async {
        runtime::install_remote_files(&shared.storage, "test-seed", &files, Vec::new())
            .await
            .map_err(WsServerError::Ingest)?;
        commands::recover_checkpoint_tail(&shared.storage)
            .await
            .map_err(WsServerError::Ingest)?;
        Ok::<(), WsServerError>(())
    }
    .await;

    match result {
        Ok(()) => DaemonMessage::TestSeedDataResult {
            success: true,
            error: None,
        },
        Err(error) => DaemonMessage::TestSeedDataResult {
            success: false,
            error: Some(error.to_string()),
        },
    }
}

fn validate_test_seed_path(path: String) -> Result<String, WsServerError> {
    let path = path.trim().trim_start_matches('/').to_string();
    if path.is_empty() {
        return Err(WsServerError::Ingest(
            "test seed path cannot be empty".into(),
        ));
    }
    let components = std::path::Path::new(&path).components();
    for component in components {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(WsServerError::Ingest(format!(
                    "invalid test seed path: {path}"
                )));
            }
        }
    }
    Ok(path)
}

async fn handle_list_history_files(shared: &SharedState, include_sizes: bool) -> DaemonMessage {
    match shared.storage.list_history_files(include_sizes).await {
        Ok(listing) => DaemonMessage::HistoryFilesResult {
            success: true,
            files: listing.files,
            devices: listing.devices,
            sizes: listing.sizes,
            error: None,
        },
        Err(error) => DaemonMessage::HistoryFilesResult {
            success: false,
            files: Vec::new(),
            devices: Vec::new(),
            sizes: None,
            error: Some(error.to_string()),
        },
    }
}

async fn handle_load_history_batch(shared: &SharedState, files: Vec<String>) -> DaemonMessage {
    match shared.storage.load_history_batch(&files).await {
        Ok(entries) => DaemonMessage::HistoryBatchResult {
            success: true,
            entries,
            error: None,
        },
        Err(error) => DaemonMessage::HistoryBatchResult {
            success: false,
            entries: Vec::new(),
            error: Some(error.to_string()),
        },
    }
}

async fn handle_get_all_pages(shared: &SharedState) -> DaemonMessage {
    match shared.storage.load_all_pages().await {
        Ok(pages) => DaemonMessage::AllPagesResult {
            success: true,
            pages,
            error: None,
        },
        Err(error) => DaemonMessage::AllPagesResult {
            success: false,
            pages: std::collections::BTreeMap::new(),
            error: Some(error.to_string()),
        },
    }
}

async fn handle_permanent_delete(
    shared: &SharedState,
    keys: Vec<String>,
) -> Result<DaemonMessage, WsServerError> {
    let deleted_keys = permanent_delete_candidates(&keys);
    if !deleted_keys.is_empty() {
        let raw = json!({
            "timestamp": current_timestamp_millis(),
            "action": "permanent_delete",
            "keys": deleted_keys.clone(),
        });
        let parsed: LogEntry = serde_json::from_value(raw.clone())?;
        ingest_typed_entry(shared, parsed, raw).await?;
    }

    Ok(DaemonMessage::PermanentDeleteResult {
        success: true,
        deleted_keys,
        error: None,
    })
}

async fn handle_get_popup_lists(shared: &SharedState) -> DaemonMessage {
    match load_popup_lists(shared).await {
        Ok(lists) => DaemonMessage::PopupListsResult {
            success: true,
            lists,
            error: None,
        },
        Err(error) => DaemonMessage::PopupListsResult {
            success: false,
            lists: Vec::new(),
            error: Some(error),
        },
    }
}

async fn load_page_info_parts(
    shared: &SharedState,
    slug: &str,
) -> Result<
    (
        Option<crate::read_projections::PageProjection>,
        Vec<PopupNoteResult>,
        Vec<PopupSnapshotResult>,
    ),
    (
        Option<crate::read_projections::PageProjection>,
        Vec<PopupNoteResult>,
        Vec<PopupSnapshotResult>,
        String,
    ),
> {
    match crate::read_projections::ReadProjections::new(shared.storage.clone())
        .page_info(slug)
        .await
    {
        Ok(info) => Ok((
            info.page,
            info.notes
                .into_iter()
                .map(|note| PopupNoteResult {
                    slug: note.slug,
                    excerpt: note.excerpt,
                    note: note.note,
                    css_path: note.css_path,
                    url: note.url,
                })
                .collect(),
            info.snapshots
                .into_iter()
                .map(|snapshot| PopupSnapshotResult {
                    timestamp: snapshot.timestamp,
                    has_md: snapshot.has_md,
                    has_html: snapshot.has_html,
                })
                .collect(),
        )),
        Err(error) => Err((None, Vec::new(), Vec::new(), error)),
    }
}

async fn load_popup_lists(shared: &SharedState) -> Result<Vec<PopupListResult>, String> {
    Ok(
        crate::read_projections::ReadProjections::new(shared.storage.clone())
            .list_summaries()
            .await?
            .into_iter()
            .map(|list| PopupListResult {
                slug: list.slug,
                name: list.name,
                pins: list
                    .pins
                    .into_iter()
                    .map(|pin| PopupPinResult {
                        kind: pin.kind,
                        slug: pin.slug,
                        pinned_at: pin.pinned_at,
                        source: pin.source,
                    })
                    .collect(),
            })
            .collect(),
    )
}

fn map_popup_page_entry(page: &crate::read_projections::PageProjection) -> PopupPageInfoEntry {
    PopupPageInfoEntry {
        slug: page.slug.clone(),
        url: page.url.clone(),
        title: page.title.clone(),
        user_title: page.user_title.clone(),
        scroll_depth: page.scroll_depth,
        time_on_page: page.time_on_page,
        likes: page.likes,
        visit_dates: page.visit_dates.clone(),
        timestamps: page
            .timestamps
            .iter()
            .map(|(key, value)| (key.clone(), *value))
            .collect(),
    }
}

fn entity_to_value(entity: Entity) -> Value {
    match entity {
        Entity::Page(page) => serde_json::to_value(page).expect("page serializes"),
        Entity::Note(note) => serde_json::to_value(note).expect("note serializes"),
        Entity::List(list) => serde_json::to_value(list).expect("list serializes"),
        Entity::Settings(settings) => serde_json::to_value(settings).expect("settings serialize"),
        Entity::NameToId(manifest) => serde_json::to_value(manifest).expect("name map serializes"),
        Entity::ListOrder(manifest) => {
            serde_json::to_value(manifest).expect("list order serializes")
        }
        Entity::Orphaned(manifest) => serde_json::to_value(manifest).expect("orphaned serializes"),
    }
}

fn websocket_config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_WEBSOCKET_MESSAGE_BYTES),
        max_frame_size: Some(MAX_WEBSOCKET_MESSAGE_BYTES),
        ..Default::default()
    }
}

async fn paused_error(shared: &SharedState) -> Option<DaemonMessage> {
    let state = shared.service_state.read().await;
    if let ServiceState::Paused { code, message } = &*state {
        Some(DaemonMessage::Error {
            error: "paused".into(),
            code: code.as_str().into(),
            message: message.clone(),
        })
    } else {
        None
    }
}

fn unauthorized_error() -> DaemonMessage {
    DaemonMessage::Error {
        error: "unauthorized".into(),
        code: "auth_required".into(),
        message: "Authenticate or pair before sending daemon events.".into(),
    }
}

fn invalid_message_error(reason: impl Into<String>) -> DaemonMessage {
    DaemonMessage::Error {
        error: "invalid_message".into(),
        code: "invalid_message".into(),
        message: format!("Invalid connector message: {}", reason.into()),
    }
}

fn test_control_disabled_error() -> DaemonMessage {
    DaemonMessage::Error {
        error: "test_control_disabled".into(),
        code: "test_control_disabled".into(),
        message: "Daemon test control is disabled for this process.".into(),
    }
}

async fn set_connected(
    shared: &SharedState,
    connection_id: u64,
    connector: ConnectedConnector,
    connected: bool,
) {
    let mut active_connections = shared.active_connections.lock().await;
    if connected {
        let replacement_browser_id = connector.browser_id.clone();
        let replacement_extension_id = connector.extension_id.clone();
        active_connections.retain(|existing_id, existing_connector| {
            *existing_id == connection_id
                || existing_connector.browser_id != replacement_browser_id
                || existing_connector.extension_id != replacement_extension_id
        });
        active_connections.insert(connection_id, connector);
    } else {
        active_connections.remove(&connection_id);
    }
    let no_connected_browsers = active_connections.is_empty();
    let running = {
        let service_state = shared.service_state.read().await;
        matches!(*service_state, ServiceState::Running)
    };
    let mut snapshot = shared.snapshot.write().await;
    let (connected_browsers, connected_connectors) = connected_snapshot_fields(&active_connections);
    snapshot.connected_browsers = connected_browsers;
    snapshot.connected_connectors = connected_connectors;
    if running {
        snapshot.service_status = ServiceStatus::Running;
        snapshot.last_error = None;
        snapshot.last_error_code = None;
    }
    let _ = shared.snapshot_tx.send(snapshot.clone());
    drop(snapshot);
    if no_connected_browsers {
        let mut connector = shared.connector_buffer_status.lock().await;
        *connector = ConnectorBufferStatus::default();
    }
}

async fn revoke_connector(
    shared: &SharedState,
    browser_id: &str,
    extension_id: &str,
) -> Result<bool, WsServerError> {
    let active = {
        let active_connections = shared.active_connections.lock().await;
        active_connector_keys(&active_connections)
    };
    let changed = {
        let mut config = shared.config.lock().await;
        let before = config.connectors.len();
        config.connectors.retain(|connector| {
            !(connector.browser_id == browser_id && connector.extension_id == extension_id)
        });
        prune_inactive_connectors(
            &mut config.connectors,
            &active,
            current_local_day_start_unix(),
        );
        let changed = config.connectors.len() != before;
        if changed {
            shared.config_store.save(&config)?;
        }
        changed
    };

    if changed {
        let _ = shared
            .revoke_tx
            .send(connector_key(browser_id, extension_id));
        let mut active_connections = shared.active_connections.lock().await;
        active_connections.retain(|_, connector| {
            !(connector.browser_id == browser_id && connector.extension_id == extension_id)
        });
        let no_connected_browsers = active_connections.is_empty();
        let (connected_browsers, connected_connectors) =
            connected_snapshot_fields(&active_connections);
        let mut snapshot = shared.snapshot.write().await;
        snapshot.connected_browsers = connected_browsers;
        snapshot.connected_connectors = connected_connectors;
        let _ = shared.snapshot_tx.send(snapshot.clone());
        drop(snapshot);
        if no_connected_browsers {
            let mut connector = shared.connector_buffer_status.lock().await;
            *connector = ConnectorBufferStatus::default();
        }
    }

    Ok(changed)
}

async fn pause_service(shared: &SharedState, code: ErrorCode, reason: impl Into<String>) {
    let reason = reason.into();
    {
        let mut service_state = shared.service_state.write().await;
        *service_state = ServiceState::Paused {
            code,
            message: reason.clone(),
        };
    }
    let mut snapshot = shared.snapshot.write().await;
    snapshot.service_status = ServiceStatus::Paused;
    snapshot.last_error = Some(reason);
    snapshot.last_error_code = Some(code.as_str().to_string());
    let _ = shared.snapshot_tx.send(snapshot.clone());
}

async fn resume_service(shared: &SharedState) {
    {
        let mut service_state = shared.service_state.write().await;
        if matches!(*service_state, ServiceState::Running) {
            return;
        }
        *service_state = ServiceState::Running;
    }

    let (connected_browsers, connected_connectors) = {
        let active_connections = shared.active_connections.lock().await;
        connected_snapshot_fields(&active_connections)
    };

    let mut snapshot = shared.snapshot.write().await;
    snapshot.connected_browsers = connected_browsers;
    snapshot.connected_connectors = connected_connectors;
    snapshot.service_status = ServiceStatus::Running;
    snapshot.last_error = None;
    snapshot.last_error_code = None;
    let _ = shared.snapshot_tx.send(snapshot.clone());
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn current_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::{websocket_config, MAX_WEBSOCKET_MESSAGE_BYTES};

    #[test]
    fn websocket_config_caps_snapshot_payloads_at_64mb() {
        let config = websocket_config();
        assert_eq!(config.max_message_size, Some(MAX_WEBSOCKET_MESSAGE_BYTES));
        assert_eq!(config.max_frame_size, Some(MAX_WEBSOCKET_MESSAGE_BYTES));
    }
}
