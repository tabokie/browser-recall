use crate::config::{ConfigStore, DaemonConfig, SyncDeviceRecord, Token};
use crate::runtime::install_remote_files;
use crate::storage::Storage;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use browser_recall_replay::LogEntry;
use chrono::TimeZone;
use parking_lot::Mutex;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

const API_BASE: &str = "https://api.github.com";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncBranch {
    pub name: String,
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncDeviceEntry {
    pub device_id: String,
    pub last_pushed: Option<i64>,
    pub last_pulled: Option<i64>,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncRunResult {
    pub pushed: bool,
    pub pulled: bool,
    pub entries_replayed: usize,
    pub devices: Vec<SyncDeviceEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Message(String),
    AuthExpired(String),
    RateLimited { retry_at_ms: i64, message: String },
}

impl SyncError {
    pub fn message(&self) -> &str {
        match self {
            Self::Message(message) => message,
            Self::AuthExpired(message) => message,
            Self::RateLimited { message, .. } => message,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncSettingsPayload {
    pub enabled: bool,
    pub repo_url: String,
    pub retention_days: i64,
}

struct SyncExecution {
    result: SyncRunResult,
    devices: BTreeMap<String, SyncDeviceRecord>,
}

struct RemoteChanges {
    files: Vec<SyncFile>,
    entries: Vec<Value>,
}

async fn load_or_initialize_sync_manifest(
    storage: &Storage,
    key: &str,
    initial: Value,
) -> Result<Value, SyncError> {
    match storage
        .load_sync_manifest(key)
        .await
        .map_err(|error| SyncError::Message(error.to_string()))?
    {
        Some(value) => Ok(value),
        None => {
            storage
                .save_sync_manifest(key, &initial)
                .await
                .map_err(|error| SyncError::Message(error.to_string()))?;
            Ok(initial)
        }
    }
}

fn require_single_object_field<'a>(
    manifest: &'a mut Value,
    manifest_name: &str,
    field: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, SyncError> {
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| SyncError::Message(format!("{manifest_name} manifest must be an object")))?;
    if object.len() != 1 || !object.contains_key(field) {
        return Err(SyncError::Message(format!(
            "{manifest_name} manifest must contain exactly `{field}`"
        )));
    }
    object
        .get_mut(field)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| SyncError::Message(format!("{manifest_name}.{field} must be an object")))
}

fn validate_string_map(
    values: &serde_json::Map<String, Value>,
    context: &str,
) -> Result<(), SyncError> {
    for (key, value) in values {
        if key.is_empty() || value.as_str().is_none() {
            return Err(SyncError::Message(format!(
                "{context} must map non-empty paths to string hashes"
            )));
        }
    }
    Ok(())
}

fn parse_remote_log_entries(log_files: &[SyncFile]) -> Result<Vec<Value>, SyncError> {
    let mut entries = Vec::new();
    for file in log_files {
        for (index, line) in file.content.lines().enumerate() {
            if line.trim().is_empty() {
                return Err(SyncError::Message(format!(
                    "{} line {} is blank; JSONL records must be canonical entries",
                    file.path,
                    index + 1
                )));
            }
            let entry = serde_json::from_str::<Value>(line).map_err(|error| {
                SyncError::Message(format!(
                    "{} line {} contains invalid JSON: {error}",
                    file.path,
                    index + 1
                ))
            })?;
            entries.push(entry);
        }
    }
    Ok(entries)
}

enum SyncStart {
    Started,
    Unavailable,
    RateLimited(i64),
}

#[derive(Default)]
struct SyncState {
    session_token: Option<String>,
    github_user: Option<String>,
    remember_token: bool,
    paused_devices: BTreeSet<String>,
    devices: BTreeMap<String, SyncDeviceRecord>,
    rate_limited_until_ms: Option<i64>,
    sync_in_progress: bool,
    cancel_flag: Option<Arc<AtomicBool>>,
    last_result: Option<SyncRunResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncBackgroundOutcome {
    Idle,
    Refreshed,
}

pub struct SyncController {
    config_store: ConfigStore,
    device_id: String,
    state: Mutex<SyncState>,
    worker_notify: Arc<Notify>,
}

impl SyncController {
    pub fn new(
        config_store: ConfigStore,
        config: &DaemonConfig,
        device_id: impl Into<String>,
        worker_notify: Arc<Notify>,
    ) -> Self {
        Self {
            config_store,
            device_id: device_id.into(),
            state: Mutex::new(SyncState {
                session_token: config.sync_github_token.clone().map(|token| token.0),
                github_user: config.sync_github_user.clone(),
                remember_token: config.sync_remember_token,
                paused_devices: config.sync_paused_devices.iter().cloned().collect(),
                devices: config.sync_devices.clone(),
                rate_limited_until_ms: None,
                sync_in_progress: false,
                cancel_flag: None,
                last_result: None,
            }),
            worker_notify,
        }
    }

    pub fn request_worker(&self) {
        self.worker_notify.notify_one();
    }

    pub fn worker_notify(&self) -> Arc<Notify> {
        self.worker_notify.clone()
    }

    pub fn device_entries(&self) -> Vec<SyncDeviceEntry> {
        let state = self.state.lock();
        collect_sync_device_entries(&state, &self.device_id)
    }

    pub fn device_entries_json(&self) -> Value {
        sync_device_entries_json(&self.device_entries())
    }

    pub fn auth_state_json(&self) -> Value {
        let state = self.state.lock();
        json!({
            "success": true,
            "hasToken": state.session_token.is_some(),
            "githubUser": state.github_user,
            "rememberToken": state.remember_token,
        })
    }

    pub async fn refresh_devices(&self, storage: &Storage) -> Result<Vec<SyncDeviceEntry>, String> {
        let settings = load_sync_settings(storage).await?;
        if !settings.enabled || settings.repo_url.is_empty() {
            return Ok(Vec::new());
        }

        let (token, paused_devices, mut device_records) = {
            let state = self.state.lock();
            (
                state.session_token.clone(),
                state.paused_devices.clone(),
                state.devices.clone(),
            )
        };

        let Some(token) = token else {
            return Ok(Vec::new());
        };

        let transport = GitHubTransport::new(&settings.repo_url, &token)
            .map_err(|error| error.message().to_string())?;
        let branches = transport
            .list_branches()
            .await
            .map_err(|error| error.message().to_string())?;
        for branch in &branches {
            device_records.entry(branch.name.clone()).or_default();
        }

        let entries = branches
            .into_iter()
            .map(|branch| sync_device_entry(&branch.name, &device_records, &paused_devices))
            .collect::<Vec<_>>();

        {
            let mut state = self.state.lock();
            state.devices = device_records;
        }
        self.persist_state()?;

        if entries.is_empty() {
            Ok(self.device_entries())
        } else {
            Ok(entries)
        }
    }

    pub fn toggle_device_paused(&self, target: &str) -> Result<bool, String> {
        let paused = {
            let mut state = self.state.lock();
            if state.paused_devices.contains(target) {
                state.paused_devices.remove(target);
                false
            } else {
                state.paused_devices.insert(target.to_string());
                true
            }
        };
        self.persist_state()?;
        Ok(paused)
    }

    pub async fn settings_changed(&self, storage: &Storage) -> Result<(), String> {
        let settings = load_sync_settings(storage).await?;
        if !settings.enabled {
            let mut state = self.state.lock();
            state.rate_limited_until_ms = None;
        }
        self.request_worker();
        Ok(())
    }

    pub fn cancel(&self) {
        let state = self.state.lock();
        if let Some(flag) = &state.cancel_flag {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn clear_token(&self) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            state.session_token = None;
            state.github_user = None;
            state.remember_token = true;
            state.rate_limited_until_ms = None;
        }
        self.persist_state()
    }

    pub fn toggle_remember(&self, remember: bool) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            state.remember_token = remember;
        }
        self.persist_state()?;
        self.request_worker();
        Ok(())
    }

    pub async fn set_token(&self, token: &str, remember: bool) -> Result<String, String> {
        let github_user = fetch_github_user(token)
            .await
            .map_err(|error| error.message().to_string())?;
        {
            let mut state = self.state.lock();
            state.session_token = Some(token.to_string());
            state.github_user = Some(github_user.clone());
            state.remember_token = remember;
            state.rate_limited_until_ms = None;
        }
        self.persist_state()?;
        self.request_worker();
        Ok(github_user)
    }

    pub async fn sync_now_response(&self, storage: &Storage) -> Value {
        match self.start_manual_sync() {
            SyncStart::Unavailable => {
                return json!({
                    "success": false,
                    "skipped": true,
                    "error": "Sync already in progress",
                });
            }
            SyncStart::RateLimited(retry_at_ms) => {
                return json!({
                    "success": false,
                    "skipped": true,
                    "error": retry_time_message(retry_at_ms),
                });
            }
            SyncStart::Started => {}
        }

        let outcome = self.execute_sync(storage).await;
        let response = match outcome {
            Ok(execution) => {
                let result = self.complete_execution(execution);
                if let Err(error) = self.persist_state() {
                    json!({
                        "success": false,
                        "error": error,
                    })
                } else {
                    json!({
                        "success": true,
                        "pushed": result.pushed,
                        "pulled": result.pulled,
                        "entriesReplayed": result.entries_replayed,
                    })
                }
            }
            Err(SyncError::RateLimited {
                retry_at_ms,
                message: _,
            }) => {
                self.record_rate_limit(retry_at_ms);
                json!({
                    "success": false,
                    "error": retry_time_message(retry_at_ms),
                    "rateLimitedUntil": retry_at_ms,
                })
            }
            Err(SyncError::AuthExpired(message)) => {
                self.expire_auth();
                if let Err(error) = self.persist_state() {
                    json!({
                        "success": false,
                        "error": error,
                        "authExpired": true,
                    })
                } else {
                    json!({
                        "success": false,
                        "error": message,
                        "authExpired": true,
                    })
                }
            }
            Err(SyncError::Message(message)) if message == "Cancelled" => json!({
                "success": false,
                "skipped": true,
                "error": "Cancelled",
            }),
            Err(SyncError::Message(message)) => json!({
                "success": false,
                "error": message,
            }),
        };

        self.finish_sync();
        response
    }

    pub async fn run_background_once(
        &self,
        storage: &Storage,
    ) -> Result<SyncBackgroundOutcome, SyncError> {
        let settings = load_sync_settings(storage)
            .await
            .map_err(SyncError::Message)?;
        if !settings.enabled || settings.repo_url.is_empty() {
            return Ok(SyncBackgroundOutcome::Idle);
        }

        if !matches!(self.start_background_sync(), SyncStart::Started) {
            return Ok(SyncBackgroundOutcome::Idle);
        }

        let outcome = self.execute_sync(storage).await;
        let result = match outcome {
            Ok(execution) => {
                let entries_replayed = self.complete_execution(execution).entries_replayed;
                self.persist_state().map_err(SyncError::Message)?;
                Ok(if entries_replayed > 0 {
                    SyncBackgroundOutcome::Refreshed
                } else {
                    SyncBackgroundOutcome::Idle
                })
            }
            Err(SyncError::RateLimited { retry_at_ms, .. }) => {
                self.record_rate_limit(retry_at_ms);
                Err(SyncError::RateLimited {
                    retry_at_ms,
                    message: retry_time_message(retry_at_ms),
                })
            }
            Err(SyncError::AuthExpired(message)) => {
                self.expire_auth();
                self.persist_state().map_err(SyncError::Message)?;
                Err(SyncError::AuthExpired(message))
            }
            Err(error) => Err(error),
        };

        self.finish_sync();
        result
    }

    pub async fn delete_device(&self, storage: &Storage, target: &str) -> Result<(), String> {
        let settings = load_sync_settings(storage).await?;
        let token = {
            let state = self.state.lock();
            state.session_token.clone()
        }
        .ok_or_else(|| "GitHub not connected".to_string())?;
        let transport = GitHubTransport::new(&settings.repo_url, &token)
            .map_err(|error| error.message().to_string())?;
        transport
            .delete_device(target, storage)
            .await
            .map_err(|error| error.message().to_string())?;
        {
            let mut state = self.state.lock();
            state.devices.remove(target);
            state.paused_devices.remove(target);
        }
        self.persist_state()
    }

    async fn execute_sync(&self, storage: &Storage) -> Result<SyncExecution, SyncError> {
        let settings = load_sync_settings(storage)
            .await
            .map_err(SyncError::Message)?;
        if !settings.enabled {
            return Err(SyncError::Message("Sync is disabled".to_string()));
        }
        if settings.repo_url.is_empty() {
            return Err(SyncError::Message("Repository URL is required".to_string()));
        }

        let (token, paused_devices, mut device_records, cancel_flag) = {
            let state = self.state.lock();
            (
                state.session_token.clone(),
                state.paused_devices.clone(),
                state.devices.clone(),
                state.cancel_flag.clone(),
            )
        };
        let token = token.ok_or_else(|| SyncError::Message("GitHub not connected".to_string()))?;
        let transport = GitHubTransport::new(&settings.repo_url, &token)?;
        let cancellation_requested = || {
            cancel_flag
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
        };

        let pushed = if paused_devices.contains(&self.device_id) {
            false
        } else {
            transport
                .push_local_files(
                    &self.device_id,
                    settings.retention_days,
                    &mut device_records,
                    storage,
                )
                .await?
        };

        if cancellation_requested() {
            return Err(SyncError::Message("Cancelled".to_string()));
        }

        let entries_replayed = transport
            .collect_remote_entries(
                &self.device_id,
                &paused_devices,
                &mut device_records,
                storage,
                cancellation_requested,
            )
            .await?;

        let branches = transport.list_branches().await?;
        for branch in &branches {
            device_records.entry(branch.name.clone()).or_default();
        }

        let mut devices = branches
            .into_iter()
            .map(|branch| sync_device_entry(&branch.name, &device_records, &paused_devices))
            .collect::<Vec<_>>();

        if !devices
            .iter()
            .any(|entry| entry.device_id == self.device_id)
        {
            devices.insert(
                0,
                sync_device_entry(&self.device_id, &device_records, &paused_devices),
            );
        }

        Ok(SyncExecution {
            result: SyncRunResult {
                pushed,
                pulled: entries_replayed > 0,
                entries_replayed,
                devices: devices.clone(),
            },
            devices: device_records,
        })
    }

    fn start_manual_sync(&self) -> SyncStart {
        let mut state = self.state.lock();
        Self::start_sync(&mut state)
    }

    fn start_background_sync(&self) -> SyncStart {
        let mut state = self.state.lock();
        if state.session_token.is_none() {
            return SyncStart::Unavailable;
        }
        Self::start_sync(&mut state)
    }

    fn start_sync(state: &mut SyncState) -> SyncStart {
        if state.sync_in_progress {
            return SyncStart::Unavailable;
        }
        if let Some(retry_at_ms) = state
            .rate_limited_until_ms
            .filter(|retry_at_ms| *retry_at_ms > chrono::Local::now().timestamp_millis())
        {
            return SyncStart::RateLimited(retry_at_ms);
        }

        state.sync_in_progress = true;
        state.cancel_flag = Some(Arc::new(AtomicBool::new(false)));
        SyncStart::Started
    }

    fn complete_execution(&self, execution: SyncExecution) -> SyncRunResult {
        let mut state = self.state.lock();
        state.devices = execution.devices;
        state.rate_limited_until_ms = None;
        state.last_result = Some(execution.result.clone());
        execution.result
    }

    fn record_rate_limit(&self, retry_at_ms: i64) {
        let mut state = self.state.lock();
        state.rate_limited_until_ms = Some(retry_at_ms);
    }

    fn expire_auth(&self) {
        let mut state = self.state.lock();
        state.session_token = None;
        state.github_user = None;
        state.last_result = None;
    }

    fn finish_sync(&self) {
        let mut state = self.state.lock();
        state.sync_in_progress = false;
        state.cancel_flag = None;
    }

    fn persist_state(&self) -> Result<(), String> {
        let state = self.state.lock();
        let mut config = self
            .config_store
            .load_or_create()
            .map_err(|error| error.to_string())?;
        config.sync_remember_token = state.remember_token;
        config.sync_paused_devices = state.paused_devices.iter().cloned().collect();
        config.sync_devices = state.devices.clone();
        if state.remember_token {
            config.sync_github_token = state.session_token.clone().map(Token);
            config.sync_github_user = state.github_user.clone();
        } else {
            config.sync_github_token = None;
            config.sync_github_user = None;
        }
        self.config_store
            .save(&config)
            .map_err(|error| error.to_string())
    }
}

pub async fn load_sync_settings(storage: &Storage) -> Result<SyncSettingsPayload, String> {
    let settings = storage
        .load_settings()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "settings manifest is missing".to_string())?;
    crate::settings::validate_complete(&settings.values)?;
    let enabled = settings.values["syncEnabled"]
        .as_bool()
        .ok_or_else(|| "syncEnabled must be a boolean".to_string())?;
    let repo_url = settings.values["syncRepoUrl"]
        .as_str()
        .ok_or_else(|| "syncRepoUrl must be a string".to_string())?
        .trim()
        .to_string();
    let retention_days = settings.values["syncRetentionDays"]
        .as_i64()
        .ok_or_else(|| "syncRetentionDays must be an integer".to_string())?;
    Ok(SyncSettingsPayload {
        enabled,
        repo_url,
        retention_days,
    })
}

pub fn sync_device_entries_json(entries: &[SyncDeviceEntry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|entry| {
                json!({
                    "deviceId": entry.device_id,
                    "lastPushed": entry.last_pushed,
                    "lastPulled": entry.last_pulled,
                    "paused": entry.paused,
                })
            })
            .collect(),
    )
}

pub async fn background_worker_loop<F, Fut>(notify: Arc<Notify>, mut run_once: F)
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    loop {
        tokio::select! {
            _ = notify.notified() => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {}
        }
        run_once().await;
    }
}

fn collect_sync_device_entries(state: &SyncState, local_device_id: &str) -> Vec<SyncDeviceEntry> {
    let mut entries = state
        .devices
        .keys()
        .map(|device_id| sync_device_entry(device_id, &state.devices, &state.paused_devices))
        .collect::<Vec<_>>();

    if !entries
        .iter()
        .any(|entry| entry.device_id == local_device_id)
    {
        entries.insert(
            0,
            sync_device_entry(local_device_id, &state.devices, &state.paused_devices),
        );
    }

    entries
}

fn sync_device_entry(
    device_id: &str,
    devices: &BTreeMap<String, SyncDeviceRecord>,
    paused_devices: &BTreeSet<String>,
) -> SyncDeviceEntry {
    let record = devices.get(device_id);
    SyncDeviceEntry {
        device_id: device_id.to_string(),
        last_pushed: record.and_then(|record| record.last_pushed),
        last_pulled: record.and_then(|record| record.last_pulled),
        paused: paused_devices.contains(device_id),
    }
}

fn retry_time_message(retry_at_ms: i64) -> String {
    let Some(timestamp) = chrono::Local.timestamp_millis_opt(retry_at_ms).single() else {
        return "GitHub rate-limit timestamp is out of range".into();
    };
    format!(
        "Rate limited, will retry at {}",
        timestamp.format("%H:%M:%S")
    )
}

fn rate_limit_retry_at_ms(reset_seconds: i64) -> Option<i64> {
    reset_seconds
        .checked_mul(1000)?
        .checked_add(60_000)
        .filter(|value| {
            chrono::Local
                .timestamp_millis_opt(*value)
                .single()
                .is_some()
        })
}

pub fn hash_content(content: &str) -> String {
    let mut hash: i32 = 0;
    for ch in content.chars() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(ch as i32);
    }
    hash.to_string()
}

pub fn parse_repo_url(url: &str) -> Result<(String, String), SyncError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| SyncError::Message(format!("Invalid repo URL: {url}")))?;
    let parts = parsed
        .path()
        .trim_end_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(SyncError::Message(format!(
            "Invalid repo URL (need owner/repo): {url}"
        )));
    }
    Ok((
        parts[0].to_string(),
        parts[1].trim_end_matches(".git").to_string(),
    ))
}

pub struct GitHubTransport {
    client: reqwest::Client,
    owner: String,
    repo: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct GitHubBranchPayload {
    name: String,
    commit: GitHubCommitPayload,
}

#[derive(Debug, Deserialize)]
struct GitHubCommitPayload {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitHubTreePayload {
    tree: Vec<GitHubTreeEntryPayload>,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeEntryPayload {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    sha: Option<String>,
}

fn parse_github_branches(value: Value) -> Result<Vec<SyncBranch>, SyncError> {
    let branches = serde_json::from_value::<Vec<GitHubBranchPayload>>(value).map_err(|error| {
        SyncError::Message(format!(
            "GitHub branches payload has an invalid shape: {error}"
        ))
    })?;
    Ok(branches
        .into_iter()
        .map(|branch| SyncBranch {
            name: branch.name,
            sha: branch.commit.sha,
        })
        .collect())
}

fn parse_github_tree(value: Value) -> Result<Vec<(String, String)>, SyncError> {
    let payload = serde_json::from_value::<GitHubTreePayload>(value).map_err(|error| {
        SyncError::Message(format!("GitHub tree payload has an invalid shape: {error}"))
    })?;
    payload
        .tree
        .into_iter()
        .filter(|entry| entry.entry_type == "blob")
        .map(|entry| {
            let sha = entry.sha.ok_or_else(|| {
                SyncError::Message(format!(
                    "GitHub tree blob {} is missing its sha",
                    entry.path
                ))
            })?;
            Ok((entry.path, sha))
        })
        .collect()
}

impl GitHubTransport {
    pub fn new(repo_url: &str, token: &str) -> Result<Self, SyncError> {
        let (owner, repo) = parse_repo_url(repo_url)?;
        let client = reqwest::Client::builder()
            .user_agent("browser-recall-desktop")
            .build()
            .map_err(|error| SyncError::Message(error.to_string()))?;
        Ok(Self {
            client,
            owner,
            repo,
            token: token.to_string(),
        })
    }

    fn repo_path(&self) -> String {
        format!("/repos/{}/{}", self.owner, self.repo)
    }

    async fn request_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, SyncError> {
        let url = format!("{API_BASE}{path}");
        let mut request = self
            .client
            .request(method, &url)
            .header(AUTHORIZATION, format!("token {}", self.token))
            .header(ACCEPT, "application/vnd.github+json");

        if let Some(body) = body {
            request = request.header(CONTENT_TYPE, "application/json").json(&body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?;

        if response.status().is_success() {
            if response.status() == reqwest::StatusCode::NO_CONTENT {
                return Ok(Value::Null);
            }
            return response
                .json::<Value>()
                .await
                .map_err(|error| SyncError::Message(error.to_string()));
        }

        if response.status() == reqwest::StatusCode::FORBIDDEN
            && response
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                == Some("0")
        {
            let retry_at_ms = response
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<i64>().ok())
                .and_then(rate_limit_retry_at_ms)
                .ok_or_else(|| {
                    SyncError::Message(
                        "GitHub rate-limit response is missing a valid reset timestamp".to_string(),
                    )
                })?;
            return Err(SyncError::RateLimited {
                retry_at_ms,
                message: "GitHub API rate limit exceeded".to_string(),
            });
        }

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?;
        let message = format!("GitHub API error {}: {}", status.as_u16(), text);
        if status == reqwest::StatusCode::UNAUTHORIZED
            || (status == reqwest::StatusCode::FORBIDDEN && !message.contains("rate limit"))
        {
            return Err(SyncError::AuthExpired(message));
        }
        Err(SyncError::Message(message))
    }

    pub async fn list_branches(&self) -> Result<Vec<SyncBranch>, SyncError> {
        let value = self
            .request_json(
                reqwest::Method::GET,
                &format!("{}/branches", self.repo_path()),
                None,
            )
            .await?;
        parse_github_branches(value)
    }

    async fn get_tree(&self, sha: &str) -> Result<Vec<(String, String)>, SyncError> {
        let value = self
            .request_json(
                reqwest::Method::GET,
                &format!("{}/git/trees/{sha}?recursive=1", self.repo_path()),
                None,
            )
            .await?;
        parse_github_tree(value)
    }

    async fn get_blob(&self, sha: &str) -> Result<String, SyncError> {
        let value = self
            .request_json(
                reqwest::Method::GET,
                &format!("{}/git/blobs/{sha}", self.repo_path()),
                None,
            )
            .await?;
        let encoded = value
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| SyncError::Message("GitHub blob missing content".to_string()))?
            .replace('\n', "");
        let bytes = BASE64_STANDARD
            .decode(encoded)
            .map_err(|error| SyncError::Message(error.to_string()))?;
        String::from_utf8(bytes).map_err(|error| SyncError::Message(error.to_string()))
    }

    async fn initialize_empty_repo(&self, branch: &str) -> Result<(), SyncError> {
        let _ = self
            .request_json(
                reqwest::Method::PUT,
                &format!("{}/contents/.gitkeep", self.repo_path()),
                Some(json!({
                    "message": "initialize repository",
                    "content": BASE64_STANDARD.encode(""),
                    "branch": branch,
                })),
            )
            .await?;
        Ok(())
    }

    pub async fn push_tree(&self, branch: &str, files: &[SyncFile]) -> Result<(), SyncError> {
        let mut blob_shas = Vec::with_capacity(files.len());
        for (index, file) in files.iter().enumerate() {
            let create_blob = self
                .request_json(
                    reqwest::Method::POST,
                    &format!("{}/git/blobs", self.repo_path()),
                    Some(json!({
                        "content": BASE64_STANDARD.encode(&file.content),
                        "encoding": "base64",
                    })),
                )
                .await;

            let blob = match create_blob {
                Ok(value) => value,
                Err(SyncError::Message(message))
                    if index == 0 && message.contains("GitHub API error 409") =>
                {
                    self.initialize_empty_repo(branch).await?;
                    self.request_json(
                        reqwest::Method::POST,
                        &format!("{}/git/blobs", self.repo_path()),
                        Some(json!({
                            "content": BASE64_STANDARD.encode(&file.content),
                            "encoding": "base64",
                        })),
                    )
                    .await?
                }
                Err(error) => return Err(error),
            };
            let sha = blob
                .get("sha")
                .and_then(Value::as_str)
                .ok_or_else(|| SyncError::Message("GitHub blob missing sha".to_string()))?;
            blob_shas.push(sha.to_string());
        }

        let tree = self
            .request_json(
                reqwest::Method::POST,
                &format!("{}/git/trees", self.repo_path()),
                Some(json!({
                    "tree": files
                        .iter()
                        .zip(blob_shas.iter())
                        .map(|(file, sha)| {
                            json!({
                                "path": file.path,
                                "mode": "100644",
                                "type": "blob",
                                "sha": sha,
                            })
                        })
                        .collect::<Vec<_>>(),
                })),
            )
            .await?;
        let tree_sha = tree
            .get("sha")
            .and_then(Value::as_str)
            .ok_or_else(|| SyncError::Message("GitHub tree missing sha".to_string()))?;

        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let commit = self
            .request_json(
                reqwest::Method::POST,
                &format!("{}/git/commits", self.repo_path()),
                Some(json!({
                    "message": format!("sync {branch} at {timestamp} ({} files)", files.len()),
                    "tree": tree_sha,
                    "parents": Vec::<String>::new(),
                })),
            )
            .await?;
        let commit_sha = commit
            .get("sha")
            .and_then(Value::as_str)
            .ok_or_else(|| SyncError::Message("GitHub commit missing sha".to_string()))?;

        let update_ref = self
            .request_json(
                reqwest::Method::PATCH,
                &format!("{}/git/refs/heads/{branch}", self.repo_path()),
                Some(json!({
                    "sha": commit_sha,
                    "force": true,
                })),
            )
            .await;
        if let Err(SyncError::Message(message)) = update_ref {
            if message.contains("GitHub API error 422") {
                let _ = self
                    .request_json(
                        reqwest::Method::POST,
                        &format!("{}/git/refs", self.repo_path()),
                        Some(json!({
                            "ref": format!("refs/heads/{branch}"),
                            "sha": commit_sha,
                        })),
                    )
                    .await?;
            } else {
                return Err(SyncError::Message(message));
            }
        } else {
            update_ref?;
        }

        Ok(())
    }

    pub async fn delete_branch(&self, branch: &str) -> Result<(), SyncError> {
        let _ = self
            .request_json(
                reqwest::Method::DELETE,
                &format!("{}/git/refs/heads/{branch}", self.repo_path()),
                None,
            )
            .await?;
        Ok(())
    }

    async fn download_remote_changes(
        &self,
        tree: &[(String, String)],
        old_files: &serde_json::Map<String, Value>,
        paused: bool,
    ) -> Result<RemoteChanges, SyncError> {
        let mut note_files = Vec::new();
        let mut log_files = Vec::new();
        for (path, sha) in tree {
            if old_files.get(path).and_then(Value::as_str) == Some(sha) {
                continue;
            }

            let content = self.get_blob(sha).await?;
            if path.starts_with("objects/notes/") {
                note_files.push(SyncFile {
                    path: path.clone(),
                    content,
                });
            } else if path.starts_with("logs/") {
                log_files.push(SyncFile {
                    path: path.clone(),
                    content,
                });
            }
        }

        let entries = if paused {
            Vec::new()
        } else {
            parse_remote_log_entries(&log_files)?
        };
        note_files.extend(log_files);
        Ok(RemoteChanges {
            files: note_files,
            entries,
        })
    }

    async fn ingest_remote_changes(
        peer_name: &str,
        changes: RemoteChanges,
        storage: &Storage,
    ) -> Result<(), SyncError> {
        if changes.files.is_empty() && changes.entries.is_empty() {
            return Ok(());
        }

        let write_files = changes
            .files
            .into_iter()
            .map(|file| (file.path, file.content))
            .collect::<Vec<_>>();
        let entries = changes
            .entries
            .into_iter()
            .map(serde_json::from_value::<LogEntry>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| SyncError::Message(error.to_string()))?;
        install_remote_files(storage, peer_name, &write_files, entries)
            .await
            .map_err(SyncError::Message)?;
        Ok(())
    }

    pub async fn collect_remote_entries(
        &self,
        device_id: &str,
        paused_devices: &BTreeSet<String>,
        device_records: &mut BTreeMap<String, SyncDeviceRecord>,
        storage: &Storage,
        cancellation_requested: impl Fn() -> bool,
    ) -> Result<usize, SyncError> {
        let branches = self.list_branches().await?;
        let peers = branches
            .iter()
            .filter(|branch| branch.name != device_id)
            .cloned()
            .collect::<Vec<_>>();

        let mut cursors =
            load_or_initialize_sync_manifest(storage, "sync-cursors", json!({ "cursors": {} }))
                .await?;
        let cursor_map = require_single_object_field(&mut cursors, "sync-cursors", "cursors")?;

        let mut replayed = 0usize;
        let now = chrono::Local::now().timestamp_millis();

        for peer in peers {
            if cancellation_requested() {
                return Err(SyncError::Message("Cancelled".to_string()));
            }

            let old_cursor = match cursor_map.get(&peer.name) {
                Some(value) => {
                    let cursor = value.as_object().cloned().ok_or_else(|| {
                        SyncError::Message(format!("sync cursor for {} is malformed", peer.name))
                    })?;
                    if cursor.len() != 2
                        || !cursor.contains_key("treeSha")
                        || !cursor.contains_key("files")
                    {
                        return Err(SyncError::Message(format!(
                            "sync cursor for {} must contain exactly treeSha and files",
                            peer.name
                        )));
                    }
                    cursor
                }
                None => serde_json::Map::new(),
            };
            let old_tree_sha = match old_cursor.get("treeSha") {
                Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
                Some(_) => {
                    return Err(SyncError::Message(format!(
                        "sync cursor treeSha for {} must be a non-empty string",
                        peer.name
                    )))
                }
                None => None,
            };
            if old_tree_sha == Some(peer.sha.as_str()) {
                continue;
            }

            let tree = self.get_tree(&peer.sha).await?;
            let old_files = match old_cursor.get("files") {
                Some(value) => value.as_object().cloned().ok_or_else(|| {
                    SyncError::Message(format!("sync cursor files for {} are malformed", peer.name))
                })?,
                None if old_cursor.is_empty() => serde_json::Map::new(),
                None => {
                    return Err(SyncError::Message(format!(
                        "sync cursor files for {} are missing",
                        peer.name
                    )))
                }
            };
            validate_string_map(&old_files, &format!("sync cursor files for {}", peer.name))?;
            let changes = self
                .download_remote_changes(&tree, &old_files, paused_devices.contains(&peer.name))
                .await?;
            replayed += changes.entries.len();
            Self::ingest_remote_changes(&peer.name, changes, storage).await?;

            let mut new_files = serde_json::Map::new();
            for (path, sha) in tree {
                new_files.insert(path, Value::String(sha));
            }
            cursor_map.insert(
                peer.name.clone(),
                json!({
                    "treeSha": peer.sha,
                    "files": Value::Object(new_files),
                }),
            );
            device_records.entry(peer.name).or_default().last_pulled = Some(now);
        }

        storage
            .save_sync_manifest("sync-cursors", &cursors)
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?;

        Ok(replayed)
    }

    pub async fn push_local_files(
        &self,
        device_id: &str,
        retention_days: i64,
        device_records: &mut BTreeMap<String, crate::SyncDeviceRecord>,
        storage: &crate::storage::Storage,
    ) -> Result<bool, SyncError> {
        let files = storage
            .collect_sync_files(device_id, retention_days)
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?
            .into_iter()
            .map(|(path, content)| SyncFile { path, content })
            .collect::<Vec<_>>();
        if files.is_empty() {
            return Ok(false);
        }

        let new_hashes = files
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    Value::String(hash_content(&file.content)),
                )
            })
            .collect::<serde_json::Map<String, Value>>();

        let mut push_state =
            load_or_initialize_sync_manifest(storage, "sync-push-state", json!({ "files": {} }))
                .await?;
        let old_hashes =
            require_single_object_field(&mut push_state, "sync-push-state", "files")?.clone();
        validate_string_map(&old_hashes, "sync-push-state files")?;

        let changed = new_hashes.len() != old_hashes.len()
            || new_hashes
                .iter()
                .any(|(path, hash)| old_hashes.get(path) != Some(hash));
        if !changed {
            return Ok(false);
        }

        self.push_tree(device_id, &files).await?;
        storage
            .save_sync_manifest(
                "sync-push-state",
                &json!({ "files": Value::Object(new_hashes) }),
            )
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?;
        device_records
            .entry(device_id.to_string())
            .or_default()
            .last_pushed = Some(chrono::Local::now().timestamp_millis());
        Ok(true)
    }

    pub async fn delete_device(
        &self,
        device_id: &str,
        storage: &crate::storage::Storage,
    ) -> Result<(), SyncError> {
        self.delete_branch(device_id).await?;
        let mut cursors =
            load_or_initialize_sync_manifest(storage, "sync-cursors", json!({ "cursors": {} }))
                .await?;
        let map = require_single_object_field(&mut cursors, "sync-cursors", "cursors")?;
        map.remove(device_id);
        storage
            .save_sync_manifest("sync-cursors", &cursors)
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?;
        Ok(())
    }
}

pub async fn fetch_github_user(token: &str) -> Result<String, SyncError> {
    let client = reqwest::Client::builder()
        .user_agent("browser-recall-desktop")
        .build()
        .map_err(|error| SyncError::Message(error.to_string()))?;
    let response = client
        .get(format!("{API_BASE}/user"))
        .header(AUTHORIZATION, format!("token {token}"))
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| SyncError::Message(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?;
        let message = format!("GitHub API error {}: {}", status.as_u16(), text);
        if status == reqwest::StatusCode::UNAUTHORIZED
            || (status == reqwest::StatusCode::FORBIDDEN && !message.contains("rate limit"))
        {
            return Err(SyncError::AuthExpired(message));
        }
        return Err(SyncError::Message(message));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| SyncError::Message(error.to_string()))?;
    payload
        .get("login")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| SyncError::Message("GitHub user payload missing login".to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_github_branches, parse_github_tree, parse_remote_log_entries, rate_limit_retry_at_ms,
        retry_time_message, SyncFile,
    };
    use serde_json::json;

    #[test]
    fn malformed_remote_log_line_is_rejected_with_file_and_line_context() {
        let files = vec![SyncFile {
            path: "logs/peer/2026-07-04.jsonl".to_string(),
            content: concat!(
                "{\"timestamp\":1,\"action\":\"visit_page\",\"url\":\"https://example.com\"}\n",
                "{not-json}\n"
            )
            .to_string(),
        }];

        let error = parse_remote_log_entries(&files).expect_err("malformed line must fail sync");
        let message = error.message();
        assert!(message.contains("logs/peer/2026-07-04.jsonl"));
        assert!(message.contains("line 2"));
    }

    #[test]
    fn malformed_github_branch_payload_is_rejected_instead_of_dropped() {
        let error = parse_github_branches(json!([
            { "name": "device-a", "commit": { "sha": "abc" } },
            { "name": "device-b", "commit": {} }
        ]))
        .expect_err("a malformed branch must fail the whole response");

        assert!(error.message().contains("invalid shape"));
        assert!(error.message().contains("sha"));
    }

    #[test]
    fn malformed_github_tree_payload_is_rejected_instead_of_becoming_empty() {
        let error = parse_github_tree(json!({ "truncated": false }))
            .expect_err("a response without tree must fail");
        assert!(error.message().contains("invalid shape"));
        assert!(error.message().contains("tree"));

        let error = parse_github_tree(json!({
            "tree": [{ "path": "logs/device-a/2026-07-14.jsonl", "type": "blob" }]
        }))
        .expect_err("a blob without sha must fail");
        assert!(error.message().contains("missing its sha"));
    }

    #[test]
    fn github_rate_limit_timestamps_are_range_checked_without_panicking() {
        assert_eq!(rate_limit_retry_at_ms(i64::MAX), None);
        assert_eq!(
            retry_time_message(i64::MAX),
            "GitHub rate-limit timestamp is out of range"
        );
    }
}
