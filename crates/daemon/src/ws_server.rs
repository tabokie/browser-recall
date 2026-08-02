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
    AuthorityStatus, ConnectorMessage, DaemonMessage, MutationPayload, NoteSearchResult,
    PopupAccessResult, PopupAttentionResult, PopupListResult, PopupNoteResult, PopupPageInfoEntry,
    PopupSnapshotResult, PreviewRuleHit, RuleBatchEntry, RuleBatchHit, RuleMatchResult,
    RulePayload, SnapshotSearchResult, TestControlMessage, TestSeedFilePayload,
    CONNECTOR_PROTOCOL_VERSION,
};
use crate::rules::{
    match_list_rules_strict, page_data_from_raw_entry, preview_rule, validate_rule, PageData,
    RuleSpec,
};
use crate::runtime::{self, EntityMapView, ReplayTransaction};
use crate::search::{search_notes_in_storage, search_snapshots_in_data_dir};
use crate::storage::Storage;
use browser_recall_replay::entities::{Entity, ListOrderManifest, TreeNode};
use browser_recall_replay::{generate_slug_from_url, EntityEffect, LogEntry};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Deserializer};
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

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportVisitRequest {
    timestamp: i64,
    url: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    title: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    referrer: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    body_preview: Option<String>,
    bypass_blacklist: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportLeaveRequest {
    timestamp: i64,
    url: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    title: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    scroll_depth: Option<i64>,
    #[serde(deserialize_with = "deserialize_required_option")]
    time_on_page: Option<i64>,
}

#[derive(Debug)]
pub enum WsServerError {
    Io(std::io::Error),
    Json(serde_json::Error),
    NoPortsAvailable,
    Configuration(String),
    Handshake(String),
    Ingest(String),
}

impl fmt::Display for WsServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::NoPortsAvailable => f.write_str("no ports available"),
            Self::Configuration(reason) => write!(f, "{reason}"),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ErrorCode {
    FsError,
    ReplayError,
}

impl ErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::FsError => "fs_error",
            Self::ReplayError => "replay_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceState {
    Running,
    Paused { code: String, message: String },
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
    pub service_state: ServiceState,
    pub connected_connectors: Vec<ConnectedConnector>,
}

#[derive(Clone)]
struct SharedState {
    snapshot: Arc<RwLock<ServerSnapshot>>,
    snapshot_tx: watch::Sender<ServerSnapshot>,
    change_message_tx: broadcast::Sender<Vec<MutationPayload>>,
    revoke_tx: broadcast::Sender<ConnectorKey>,
    config_store: ConfigStore,
    config: Arc<Mutex<crate::config::DaemonConfig>>,
    storage: Storage,
    approver: PairingApprover,
    pair_timeout: Duration,
    test_control_enabled: bool,
    active_connections: Arc<Mutex<HashMap<u64, ConnectedConnector>>>,
    next_connection_id: Arc<AtomicU64>,
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

    pub fn subscribe_changes(&self) -> broadcast::Receiver<Vec<MutationPayload>> {
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

    pub async fn shutdown(mut self) {
        let storage = self.shared.storage.clone();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Err(error) = self.task.await {
            tracing::error!(%error, "daemon server task failed during shutdown");
        }
        if let Err(error) = storage.flush_checkpoints().await {
            tracing::error!(%error, "checkpoint flush failed during shutdown");
        }
    }
}

#[derive(Clone)]
pub struct ServerControlHandle {
    shared: SharedState,
}

impl ServerControlHandle {
    pub async fn resume(&self) {
        resume_service(&self.shared).await;
    }

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
    if !config.is_configured() {
        return Err(WsServerError::Configuration(
            "data directory is not configured".to_string(),
        ));
    }
    let storage = Storage::new(config.data_dir.clone());
    storage.ensure_layout(&config.device_id).await?;
    commands::recover_checkpoint_tail(&storage)
        .await
        .map_err(WsServerError::Ingest)?;
    commands::ensure_default_settings(&storage, &config.device_id)
        .await
        .map_err(WsServerError::Configuration)?;
    commands::ensure_default_lists(&storage, &config.device_id)
        .await
        .map_err(WsServerError::Configuration)?;
    let (listener, port) = bind_first_available(&options.port_candidates).await?;
    config.last_port = Some(port);
    options.config_store.save(&config)?;

    let snapshot = ServerSnapshot {
        port,
        device_id: config.device_id.clone(),
        service_state: ServiceState::Running,
        connected_connectors: Vec::new(),
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
                        let (stream, _) = match accept_result {
                            Ok(connection) => connection,
                            Err(error) => {
                                warn!(error = %error, "daemon listener accept failed");
                                continue;
                            }
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
    let origin_slot = Arc::new(parking_lot::Mutex::new(None::<String>));
    let origin_slot_clone = origin_slot.clone();
    let ws_stream = accept_hdr_async_with_config(
        stream,
        move |request: &Request, response: Response| {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_string());
            *origin_slot_clone.lock() = origin.clone();
            Ok(response)
        },
        Some(websocket_config()),
    )
    .await
    .map_err(|error| WsServerError::Handshake(error.to_string()))?;

    let origin = origin_slot.lock().clone();
    info!(?origin, "accepted websocket connection");
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
                    Ok(mutations) => {
                        let message = DaemonMessage::Change {
                            mutations: mutations.into_iter().map(Into::into).collect(),
                        };
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
        if message_requires_test_control(&incoming) && !shared.test_control_enabled {
            send_json(&mut write, &test_control_disabled_error()).await?;
            continue;
        }
        match incoming {
            ConnectorMessage::GetStatus => {
                send_json(&mut write, &build_status_message(&shared).await).await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::ClearAllData,
            } => {
                send_json(&mut write, &handle_clear_all_data(&shared).await).await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::ReplayRemoteEntries { device_id, entries },
            } => match handle_replay_remote_entries(&shared, device_id, entries).await {
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
            },
            ConnectorMessage::TestControl {
                request: TestControlMessage::SetDeviceId { device_id },
            } => {
                send_json(&mut write, &handle_set_device_id(&shared, device_id).await).await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::ListHistoryFiles { include_sizes },
            } => {
                send_json(
                    &mut write,
                    &handle_list_history_files(&shared, include_sizes).await,
                )
                .await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::LoadHistoryBatch { files },
            } => {
                send_json(&mut write, &handle_load_history_batch(&shared, files).await).await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::GetAllPages,
            } => {
                send_json(&mut write, &handle_get_all_pages(&shared).await).await?;
            }
            ConnectorMessage::GetPageInfo { slug } => {
                send_json(&mut write, &handle_get_page_info(&shared, slug).await).await?;
            }
            ConnectorMessage::GetPageSummary { url, title } => {
                send_json(
                    &mut write,
                    &handle_get_page_summary(&shared, url, title).await,
                )
                .await?;
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
            ConnectorMessage::TestControl {
                request: TestControlMessage::GetEntity { key },
            } => {
                send_json(&mut write, &handle_get_entity(&shared, key).await).await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::PermanentDelete { keys },
            } => match handle_permanent_delete(&shared, keys).await {
                Ok(result) => send_json(&mut write, &result).await?,
                Err(error) => {
                    warn!(error = %error, "permanent delete failed");
                    let message = format!("Permanent delete failed: {error}");
                    pause_service(&shared, ErrorCode::FsError, message).await;
                    if let Some(message) = paused_error(&shared).await {
                        send_json(&mut write, &message).await?;
                    }
                }
            },
            ConnectorMessage::RunCommand { action, request } => {
                match run_connector_command(&shared, &action, request).await {
                    Ok(response) => {
                        let Some(mut payload) = response.as_object().cloned() else {
                            send_json(
                                &mut write,
                                &DaemonMessage::CommandResult {
                                    success: false,
                                    response: None,
                                    error: Some(format!("{action} returned a non-object response")),
                                },
                            )
                            .await?;
                            continue;
                        };
                        let Some(success) =
                            payload.remove("success").and_then(|value| value.as_bool())
                        else {
                            send_json(
                                &mut write,
                                &DaemonMessage::CommandResult {
                                    success: false,
                                    response: None,
                                    error: Some(format!(
                                    "{action} returned an invalid response without boolean success"
                                )),
                                },
                            )
                            .await?;
                            continue;
                        };
                        let error = (!success).then(|| {
                            payload
                                .get("error")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| {
                                    format!("{action} failed without an error message")
                                })
                        });
                        send_json(
                            &mut write,
                            &DaemonMessage::CommandResult {
                                success,
                                response: success.then_some(Value::Object(payload)),
                                error,
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
                }
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::SearchNotes { query, limit },
            } => {
                send_json(
                    &mut write,
                    &handle_search_notes(&shared, query, limit).await,
                )
                .await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::SearchSnapshots { query, limit },
            } => {
                send_json(
                    &mut write,
                    &handle_search_snapshots(&shared, query, limit).await,
                )
                .await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::ResetData,
            } => {
                send_json(&mut write, &handle_test_reset_data(&shared).await).await?;
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::SeedData { files },
            } => {
                send_json(&mut write, &handle_test_seed_data(&shared, files).await).await?;
            }
            ConnectorMessage::Auth {
                token,
                protocol_version,
            } => {
                if protocol_version != Some(CONNECTOR_PROTOCOL_VERSION) {
                    send_json(&mut write, &incompatible_protocol_error(protocol_version)).await?;
                    break;
                }
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
                            connector.last_seen_at = Some(unix_timestamp()?);
                            shared.config_store.save(&config)?;
                        }
                    }
                    connected_connector = Some(active_connector.clone());
                    authenticated = true;
                    set_connected(&shared, connection_id, active_connector, true).await;
                    info!("connector authenticated");
                    send_json(
                        &mut write,
                        &DaemonMessage::AuthOk {
                            protocol_version: CONNECTOR_PROTOCOL_VERSION,
                        },
                    )
                    .await?;
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
                protocol_version,
                browser_id,
                browser_name,
                extension_id,
                browser_profile,
            } => {
                if protocol_version != Some(CONNECTOR_PROTOCOL_VERSION) {
                    send_json(&mut write, &incompatible_protocol_error(protocol_version)).await?;
                    break;
                }
                let identity_fields = [
                    ("browserId", browser_id.as_str()),
                    ("browserName", browser_name.as_str()),
                    ("extensionId", extension_id.as_str()),
                ];
                if let Some((field, _)) = identity_fields
                    .iter()
                    .find(|(_, value)| value.trim().is_empty() || value.len() > 256)
                {
                    send_json(
                        &mut write,
                        &DaemonMessage::Error {
                            error: "invalid_message".to_string(),
                            code: "invalid_message".to_string(),
                            message: format!("{field} must be 1 to 256 characters"),
                        },
                    )
                    .await?;
                    break;
                }
                if browser_profile
                    .as_deref()
                    .is_some_and(|profile| profile.trim().is_empty() || profile.len() > 256)
                {
                    send_json(
                        &mut write,
                        &DaemonMessage::Error {
                            error: "invalid_message".to_string(),
                            code: "invalid_message".to_string(),
                            message: "browserProfile must be 1 to 256 characters when present"
                                .to_string(),
                        },
                    )
                    .await?;
                    break;
                }
                if !matches!(
                    browser_name.as_str(),
                    "Brave" | "Firefox" | "Edge" | "Arc" | "Chrome" | "Chromium"
                ) {
                    send_json(
                        &mut write,
                        &DaemonMessage::Error {
                            error: "invalid_message".to_string(),
                            code: "invalid_message".to_string(),
                            message: format!("unsupported browserName: {browser_name}"),
                        },
                    )
                    .await?;
                    break;
                }
                let request = PairingRequest {
                    request_id: random_string(12),
                    browser_id,
                    browser_name,
                    extension_id,
                    browser_profile,
                    origin: origin.clone(),
                };
                send_json(&mut write, &DaemonMessage::PairPending).await?;
                info!(
                    browser = request.browser_name.as_str(),
                    extension_id = request.extension_id.as_str(),
                    "pairing request pending"
                );

                let decision =
                    with_timeout(&shared.approver, request.clone(), shared.pair_timeout).await;
                match decision {
                    Ok(PairingDecision::Approve) => {
                        let token = Token(random_string(32));
                        let now = unix_timestamp()?;
                        let active = {
                            let active_connections = shared.active_connections.lock().await;
                            active_connector_keys(&active_connections)
                        };
                        {
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
                                current_local_day_start_unix()
                                    .map_err(WsServerError::Configuration)?,
                            );
                            shared.config_store.save(&config)?;
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
                                protocol_version: CONNECTOR_PROTOCOL_VERSION,
                            },
                        )
                        .await?;
                    }
                    Ok(PairingDecision::Deny) => {
                        warn!("pairing denied");
                        send_json(&mut write, &DaemonMessage::PairDenied).await?;
                        break;
                    }
                    Err(_) => {
                        warn!("pairing approval timed out");
                        send_json(
                            &mut write,
                            &DaemonMessage::Error {
                                error: "pair_timeout".to_string(),
                                code: "pair_timeout".to_string(),
                                message: "Desktop pairing approval timed out".to_string(),
                            },
                        )
                        .await?;
                        break;
                    }
                }
            }
            ConnectorMessage::TestControl {
                request: TestControlMessage::Event { entry, source },
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
            ConnectorMessage::TestControl {
                request: TestControlMessage::RunRuleBatch { list_ids, entries },
            } => match run_rule_batch(&shared, list_ids, entries).await {
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
            },
            ConnectorMessage::TestControl {
                request: TestControlMessage::PreviewRule { rule, entries },
            } => match preview_rule_batch(rule, entries).await {
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
            },
            ConnectorMessage::Snapshot {
                slug,
                ts,
                url,
                title,
                markdown,
                html,
            } => match ingest_snapshot(&shared, slug, ts, url, title, markdown, html).await {
                Ok(IngestSuccess { ack, mutations }) => {
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
            },
            ConnectorMessage::TestControl {
                request:
                    TestControlMessage::Note {
                        slug,
                        excerpt,
                        note,
                        css_path,
                        old_slug,
                        url,
                        title,
                        ts,
                        source,
                    },
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
        ConnectorMessage::Auth { .. }
            | ConnectorMessage::PairRequest { .. }
            | ConnectorMessage::TestControl {
                request: TestControlMessage::ResetData | TestControlMessage::SeedData { .. },
            }
    )
}

fn message_requires_running_service(message: &ConnectorMessage) -> bool {
    matches!(
        message,
        ConnectorMessage::TestControl {
            request: TestControlMessage::ClearAllData
                | TestControlMessage::ReplayRemoteEntries { .. }
                | TestControlMessage::SetDeviceId { .. }
                | TestControlMessage::PermanentDelete { .. }
                | TestControlMessage::Event { .. }
                | TestControlMessage::RunRuleBatch { .. }
                | TestControlMessage::Note { .. },
        } | ConnectorMessage::RunCommand { .. }
            | ConnectorMessage::Snapshot { .. }
    )
}

fn message_requires_test_control(message: &ConnectorMessage) -> bool {
    matches!(message, ConnectorMessage::TestControl { .. })
}

async fn connector_is_approved(shared: &SharedState, active: &ConnectedConnector) -> bool {
    let config = shared.config.lock().await;
    config.connectors.iter().any(|connector| {
        connector.browser_id == active.browser_id && connector.extension_id == active.extension_id
    })
}

fn connected_connectors_snapshot(
    active_connections: &HashMap<u64, ConnectedConnector>,
) -> Vec<ConnectedConnector> {
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
    connected_connectors
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
    let excerpt =
        commands::note_text_value("excerpt", excerpt.as_ref()).map_err(WsServerError::Ingest)?;
    let css_path =
        commands::note_css_path_value(css_path.as_ref()).map_err(WsServerError::Ingest)?;
    commands::validate_note_anchor(&excerpt, &css_path).map_err(WsServerError::Ingest)?;
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
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };
    let transaction = ReplayTransaction::begin(&shared.storage, &device_id)
        .await
        .map_err(WsServerError::Ingest)?;
    let effects =
        commit_entry_with_auto_pins(shared, transaction, entry.clone(), raw_entry.clone()).await?;

    let mutations =
        build_mutations(&entry, &raw_entry, &effects, &device_id).map_err(WsServerError::Ingest)?;
    Ok(IngestSuccess {
        ack: DaemonMessage::Ack,
        mutations,
    })
}

async fn commit_entry_with_auto_pins(
    shared: &SharedState,
    mut transaction: ReplayTransaction<'_>,
    entry: LogEntry,
    raw_entry: Value,
) -> Result<EntityMapView, WsServerError> {
    transaction
        .apply(entry.clone())
        .await
        .map_err(WsServerError::Ingest)?;
    let synthetic_entries =
        synthesize_auto_pin_entries(&entry, &raw_entry, &shared.storage, transaction.effects())
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
    let page_data = page_data_from_raw_entry(raw_entry)
        .map_err(browser_recall_replay::ReplayError::InvalidEntry)?;
    let Some(Entity::ListOrder(list_order)) =
        load_entity_with_overlay(storage, overlay, "manifest:list-order").await?
    else {
        return Ok(Vec::new());
    };

    let page_key = format!("page:{}", generate_slug_from_url(url)?);
    let mut synthetic = Vec::new();
    for list_key in flatten_tree_ids(&list_order) {
        let Some(Entity::List(list)) =
            load_entity_with_overlay(storage, overlay, list_key.as_str()).await?
        else {
            continue;
        };
        if list.deleted || list.rules.is_empty() {
            continue;
        }
        let matches = match_list_rules_strict(&list, &page_data)
            .map_err(browser_recall_replay::ReplayError::InvalidEntry)?;
        if matches.is_empty() {
            continue;
        }
        if list.pins.iter().any(|pin| pin.id == page_key) {
            continue;
        }
        let list_owner = list.owner.clone();
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
) -> Result<Option<Entity>, browser_recall_replay::ReplayError> {
    if let Some(effect) = overlay.get(key) {
        return Ok(match effect {
            EntityEffect::Upsert(entity) => Some(entity.clone()),
            EntityEffect::Delete => None,
        });
    }
    storage
        .load_entity(key)
        .await
        .map_err(|error| browser_recall_replay::ReplayError::Load(error.to_string()))
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
                load_entity_with_overlay(&shared.storage, transaction.effects(), &list_key)
                    .await
                    .map_err(|error| WsServerError::Ingest(error.to_string()))?
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
                .map_err(|error| WsServerError::Ingest(error.to_string()))?
                {
                    Some(Entity::List(list)) => list,
                    _ => continue,
                };
                if current_list.pins.iter().any(|pin| pin.id == page_key) {
                    continue;
                }

                let pinned_at = current_timestamp_millis()?;
                let list_owner = current_list.owner.as_str();
                let synthetic = build_auto_pin_entry(
                    pinned_at,
                    &entry.url,
                    Some(entry.title.as_str()),
                    &current_list.name,
                    list_owner,
                );
                transaction
                    .apply(synthetic.parsed)
                    .await
                    .map_err(WsServerError::Ingest)?;
                results.push(RuleBatchHit {
                    list_id: list_id.clone(),
                    url: entry.url.clone(),
                    title: Some(entry.title.clone()),
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
        let title = entry.title.clone();
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
        title: Some(entry.title.clone()),
        url: entry.url.clone(),
        body: entry.body_preview.clone(),
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

async fn commit_report_entry(
    shared: &SharedState,
    transaction: ReplayTransaction<'_>,
    entry: LogEntry,
    raw_entry: Value,
    device_id: &str,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let effects =
        commit_entry_with_auto_pins(shared, transaction, entry.clone(), raw_entry.clone()).await?;

    Ok((
        json!({ "success": true, "timestamp": entry.timestamp() }),
        build_mutations(&entry, &raw_entry, &effects, device_id).map_err(WsServerError::Ingest)?,
    ))
}

async fn report_visit_command(
    shared: &SharedState,
    request: &Value,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let request: ReportVisitRequest = serde_json::from_value(request.clone())
        .map_err(|error| WsServerError::Ingest(format!("invalid reportVisit request: {error}")))?;
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };
    let transaction = ReplayTransaction::begin(&shared.storage, &device_id)
        .await
        .map_err(WsServerError::Ingest)?;
    let url = request.url.as_str();
    let timestamp = validate_observation_timestamp(request.timestamp, "reportVisit")?;
    let settings = shared.storage.load_entity("manifest:settings").await?;
    if !should_record_visit(
        &shared.storage,
        settings.as_ref(),
        url,
        timestamp,
        request.bypass_blacklist,
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
        .title
        .as_deref()
        .map(|title| trim_title_from_settings(settings.as_ref(), title, url))
        .transpose()
        .map_err(WsServerError::Ingest)?
        .filter(|title| !title.is_empty());
    let page_slug =
        generate_slug_from_url(url).map_err(|error| WsServerError::Ingest(error.to_string()))?;
    let referrer_url = commands::optional_page_referrer(request.referrer.as_deref())
        .map_err(WsServerError::Ingest)?
        .filter(|referrer| {
            generate_slug_from_url(referrer).is_ok_and(|referrer_slug| referrer_slug != page_slug)
        });

    let entry = LogEntry::VisitPage {
        timestamp,
        url: url.to_string(),
        title,
        referrer_url,
    };
    let mut raw_entry =
        serde_json::to_value(&entry).map_err(|error| WsServerError::Ingest(error.to_string()))?;
    if let Some(body_preview) = request.body_preview {
        if let Some(object) = raw_entry.as_object_mut() {
            object.insert("bodyPreview".to_string(), Value::String(body_preview));
        }
    }
    commit_report_entry(shared, transaction, entry, raw_entry, &device_id).await
}

async fn report_leave_command(
    shared: &SharedState,
    request: &Value,
) -> Result<(Value, Vec<MutationPayload>), WsServerError> {
    let request: ReportLeaveRequest = serde_json::from_value(request.clone())
        .map_err(|error| WsServerError::Ingest(format!("invalid reportLeave request: {error}")))?;
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };
    let transaction = ReplayTransaction::begin(&shared.storage, &device_id)
        .await
        .map_err(WsServerError::Ingest)?;
    let url = request.url.as_str();
    let timestamp = validate_observation_timestamp(request.timestamp, "reportLeave")?;
    let settings = shared.storage.load_entity("manifest:settings").await?;
    let title = request
        .title
        .as_deref()
        .map(|title| trim_title_from_settings(settings.as_ref(), title, url))
        .transpose()
        .map_err(WsServerError::Ingest)?
        .filter(|title| !title.is_empty());
    let entry = LogEntry::LeavePage {
        timestamp,
        url: url.to_string(),
        title,
        scroll_depth: request.scroll_depth,
        time_on_page: request.time_on_page,
    };
    let raw_entry =
        serde_json::to_value(&entry).map_err(|error| WsServerError::Ingest(error.to_string()))?;
    commit_report_entry(shared, transaction, entry, raw_entry, &device_id).await
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
    let response = outcome.response();
    broadcast_mutations(shared, outcome.mutations);
    Ok(response)
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
        .ok_or_else(|| {
            WsServerError::Ingest(format!("{action} response missing boolean success"))
        })?;
    if success {
        broadcast_mutations(shared, mutations);
    }
    Ok(response)
}

fn broadcast_mutations(shared: &SharedState, mutations: Vec<MutationPayload>) {
    if mutations.is_empty() {
        return;
    }
    let _ = shared.change_message_tx.send(mutations);
}

async fn build_status_message(shared: &SharedState) -> DaemonMessage {
    let authority = match &shared.snapshot.read().await.service_state {
        ServiceState::Running => AuthorityStatus::Running,
        ServiceState::Paused { code, message } => AuthorityStatus::Paused {
            code: code.clone(),
            message: message.clone(),
        },
    };
    let config = shared.config.lock().await;
    DaemonMessage::Status {
        device_id: config.device_id.clone(),
        max_message_bytes: MAX_WEBSOCKET_MESSAGE_BYTES,
        authority,
    }
}

async fn handle_search_notes(
    shared: &SharedState,
    query: String,
    limit: Option<usize>,
) -> DaemonMessage {
    match search_notes_in_storage(&shared.storage, &query, limit).await {
        Ok(results) => DaemonMessage::SearchNotesResult {
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

async fn handle_get_page_summary(
    shared: &SharedState,
    url: String,
    requested_title: Option<String>,
) -> DaemonMessage {
    let slug = match generate_slug_from_url(&url) {
        Ok(slug) => slug,
        Err(error) => return page_summary_error(url, error.to_string()),
    };

    let (page, notes, snapshots) = match load_page_info_parts(shared, &slug).await {
        Ok(parts) => parts,
        Err((_, _, _, error)) => return page_summary_error(url, error),
    };

    let settings = match shared.storage.load_entity("manifest:settings").await {
        Ok(settings) => settings,
        Err(error) => return page_summary_error(url, error.to_string()),
    };
    let Some(title) = page
        .as_ref()
        .and_then(|page| page.title.as_deref())
        .or_else(|| requested_title.as_deref().filter(|title| !title.is_empty()))
    else {
        return page_summary_error(url, "page summary requires a title".to_string());
    };
    let has_visit_history = page.is_some();
    let display_title = match trim_title_from_settings(settings.as_ref(), title, &url) {
        Ok(title) => title,
        Err(error) => return page_summary_error(url, error),
    };
    let blacklisted = match blacklist_prefixes(settings.as_ref()) {
        Ok(prefixes) => prefixes,
        Err(error) => return page_summary_error(url, error),
    }
    .iter()
    .any(|prefix| url.starts_with(prefix))
        && !has_visit_history;
    let access = PopupAccessResult {
        blacklisted,
        has_visit_history,
    };

    if blacklisted {
        return DaemonMessage::PageSummaryResult {
            success: true,
            url,
            display_title: Some(display_title),
            access: Some(access),
            page: page.as_ref().map(map_popup_page_entry),
            notes,
            snapshots,
            lists: Vec::new(),
            attention: None,
            error: None,
        };
    }

    let lists = match load_popup_lists(shared, &slug).await {
        Ok(lists) => lists,
        Err(error) => return page_summary_error(url, error),
    };

    let attention = page.as_ref().map(|page| PopupAttentionResult {
        total_seconds: page.time_on_page.map(|milliseconds| milliseconds / 1000),
        last_visit: page.timestamps.values().copied().max(),
    });

    DaemonMessage::PageSummaryResult {
        success: true,
        url,
        display_title: Some(display_title),
        access: Some(access),
        page: page.as_ref().map(map_popup_page_entry),
        notes,
        snapshots,
        lists,
        attention,
        error: None,
    }
}

fn page_summary_error(url: String, error: String) -> DaemonMessage {
    DaemonMessage::PageSummaryResult {
        success: false,
        url,
        display_title: None,
        access: None,
        page: None,
        notes: Vec::new(),
        snapshots: Vec::new(),
        lists: Vec::new(),
        attention: None,
        error: Some(error),
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
        Ok(Some(entity)) => match entity_to_value(entity) {
            Ok(entity) => DaemonMessage::EntityResult {
                success: true,
                key,
                entity: Some(entity),
                error: None,
            },
            Err(error) => DaemonMessage::EntityResult {
                success: false,
                key,
                entity: None,
                error: Some(error),
            },
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

async fn handle_clear_all_data(shared: &SharedState) -> DaemonMessage {
    let device_id = {
        let config = shared.config.lock().await;
        config.device_id.clone()
    };

    let result = runtime::clear_all_data(&shared.storage, &device_id).await;

    match result {
        Ok(deleted_count) => DaemonMessage::ClearAllDataResult {
            success: true,
            deleted_count,
            error: None,
        },
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

            mutations.extend(
                build_mutations(&parsed, raw_entry, &effects, &device_id)
                    .map_err(WsServerError::Ingest)?,
            );
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
        commands::ensure_default_settings(&shared.storage, &device_id)
            .await
            .map_err(WsServerError::Ingest)?;
        commands::ensure_default_lists(&shared.storage, &device_id)
            .await
            .map_err(WsServerError::Ingest)?;
        set_device_id_internal(shared, device_id.clone()).await?;
        shared.storage.reset_cache();
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
        .map(|file| {
            let path = validate_test_seed_path(file.path)?;
            let content = validate_test_seed_content(&path, file.content)?;
            Ok((path, content))
        })
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

fn validate_test_seed_content(path: &str, content: String) -> Result<String, WsServerError> {
    use browser_recall_replay::entities::{
        ListEntity, ListOrderManifest, NameToIdManifest, NoteEntity, OrphanedManifest, PageEntity,
        SettingsEntity,
    };

    if path.starts_with("views/pages/") && path.ends_with(".json") {
        parse_test_seed_entity::<PageEntity>(path, "page", &content)?;
    } else if path.starts_with("objects/notes/") && path.ends_with(".json") {
        parse_test_seed_entity::<NoteEntity>(path, "note", &content)?;
    } else if path.starts_with("views/lists/") && path.ends_with(".json") {
        parse_test_seed_entity::<ListEntity>(path, "list", &content)?;
    } else if path == "views/manifest/list-order.json" {
        parse_test_seed_entity::<ListOrderManifest>(path, "list order", &content)?;
    } else if path == "views/manifest/list-name-to-id.json" {
        parse_test_seed_entity::<NameToIdManifest>(path, "list name-to-id", &content)?;
    } else if path == "views/manifest/orphaned.json" {
        parse_test_seed_entity::<OrphanedManifest>(path, "orphaned", &content)?;
    } else if path == "views/manifest/settings.json" {
        let seeded = parse_test_seed_entity::<SettingsEntity>(path, "settings", &content)?;
        crate::settings::validate_complete(&seeded.values).map_err(WsServerError::Ingest)?;
    }
    Ok(content)
}

fn parse_test_seed_entity<T>(
    path: &str,
    entity_name: &str,
    content: &str,
) -> Result<T, WsServerError>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_str(content).map_err(|error| {
        WsServerError::Ingest(format!(
            "invalid {entity_name} test seed at {path}: {error}"
        ))
    })
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
    let deleted_keys = permanent_delete_candidates(&keys).map_err(WsServerError::Ingest)?;
    if !deleted_keys.is_empty() {
        let raw = json!({
            "timestamp": current_timestamp_millis()?,
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

async fn load_popup_lists(
    shared: &SharedState,
    page_slug: &str,
) -> Result<Vec<PopupListResult>, String> {
    Ok(
        crate::read_projections::ReadProjections::new(shared.storage.clone())
            .popup_lists(page_slug)
            .await?
            .into_iter()
            .map(|list| PopupListResult {
                slug: list.slug,
                name: list.name,
                contains_page: list.contains_page,
                last_activity: list.last_activity,
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

fn entity_to_value(entity: Entity) -> Result<Value, String> {
    serde_json::to_value(entity).map_err(|error| error.to_string())
}

fn websocket_config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_WEBSOCKET_MESSAGE_BYTES),
        max_frame_size: Some(MAX_WEBSOCKET_MESSAGE_BYTES),
        ..Default::default()
    }
}

async fn paused_error(shared: &SharedState) -> Option<DaemonMessage> {
    let snapshot = shared.snapshot.read().await;
    if let ServiceState::Paused { code, message } = &snapshot.service_state {
        Some(DaemonMessage::Error {
            error: "paused".into(),
            code: code.clone(),
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

fn incompatible_protocol_error(actual: Option<u32>) -> DaemonMessage {
    let actual = actual
        .map(|version| version.to_string())
        .unwrap_or_else(|| "missing".into());
    DaemonMessage::Error {
        error: "incompatible_protocol".into(),
        code: "incompatible_protocol".into(),
        message: format!(
            "Connector protocol mismatch: expected {CONNECTOR_PROTOCOL_VERSION}, received {actual}."
        ),
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
    let mut snapshot = shared.snapshot.write().await;
    snapshot.connected_connectors = connected_connectors_snapshot(&active_connections);
    let _ = shared.snapshot_tx.send(snapshot.clone());
    drop(snapshot);
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
            current_local_day_start_unix().map_err(WsServerError::Configuration)?,
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
        let mut snapshot = shared.snapshot.write().await;
        snapshot.connected_connectors = connected_connectors_snapshot(&active_connections);
        let _ = shared.snapshot_tx.send(snapshot.clone());
        drop(snapshot);
    }

    Ok(changed)
}

async fn pause_service(shared: &SharedState, code: ErrorCode, reason: impl Into<String>) {
    let reason = reason.into();
    let mut snapshot = shared.snapshot.write().await;
    snapshot.service_state = ServiceState::Paused {
        code: code.as_str().to_string(),
        message: reason,
    };
    let _ = shared.snapshot_tx.send(snapshot.clone());
}

async fn resume_service(shared: &SharedState) {
    {
        let snapshot = shared.snapshot.read().await;
        if matches!(snapshot.service_state, ServiceState::Running) {
            return;
        }
    }

    let connected_connectors = {
        let active_connections = shared.active_connections.lock().await;
        connected_connectors_snapshot(&active_connections)
    };

    let mut snapshot = shared.snapshot.write().await;
    snapshot.connected_connectors = connected_connectors;
    snapshot.service_state = ServiceState::Running;
    let _ = shared.snapshot_tx.send(snapshot.clone());
}

fn unix_timestamp() -> Result<u64, WsServerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| {
            WsServerError::Configuration(format!("system clock is before Unix epoch: {error}"))
        })
}

fn current_timestamp_millis() -> Result<i64, WsServerError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            WsServerError::Configuration(format!("system clock is before Unix epoch: {error}"))
        })?
        .as_millis();
    i64::try_from(millis).map_err(|_| {
        WsServerError::Configuration("system clock exceeds supported timestamp range".to_string())
    })
}

fn validate_observation_timestamp(timestamp: i64, action: &str) -> Result<i64, WsServerError> {
    if chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp).is_none() {
        return Err(WsServerError::Ingest(format!(
            "{action} timestamp is out of range"
        )));
    }
    Ok(timestamp)
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
