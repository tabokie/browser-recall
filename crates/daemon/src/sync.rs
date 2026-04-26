use crate::config::{ConfigStore, DaemonConfig, SyncDeviceRecord, Token};
use crate::storage::Storage;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::TimeZone;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
        let state = self.state.lock().expect("sync state poisoned");
        collect_sync_device_entries(&state, &self.device_id)
    }

    pub fn device_entries_json(&self) -> Value {
        sync_device_entries_json(&self.device_entries())
    }

    pub fn auth_state_json(&self) -> Value {
        let state = self.state.lock().expect("sync state poisoned");
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
            let state = self.state.lock().expect("sync state poisoned");
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
            .map(|branch| SyncDeviceEntry {
                paused: paused_devices.contains(&branch.name),
                last_pushed: device_records
                    .get(&branch.name)
                    .and_then(|record| record.last_pushed),
                last_pulled: device_records
                    .get(&branch.name)
                    .and_then(|record| record.last_pulled),
                device_id: branch.name,
            })
            .collect::<Vec<_>>();

        {
            let mut state = self.state.lock().expect("sync state poisoned");
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
            let mut state = self.state.lock().expect("sync state poisoned");
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
            let mut state = self.state.lock().expect("sync state poisoned");
            state.rate_limited_until_ms = None;
        }
        self.request_worker();
        Ok(())
    }

    pub fn cancel(&self) {
        let state = self.state.lock().expect("sync state poisoned");
        if let Some(flag) = &state.cancel_flag {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn clear_token(&self) -> Result<(), String> {
        {
            let mut state = self.state.lock().expect("sync state poisoned");
            state.session_token = None;
            state.github_user = None;
            state.remember_token = true;
            state.rate_limited_until_ms = None;
        }
        self.persist_state()
    }

    pub fn toggle_remember(&self, remember: bool) -> Result<(), String> {
        {
            let mut state = self.state.lock().expect("sync state poisoned");
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
            let mut state = self.state.lock().expect("sync state poisoned");
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
        let start_response = {
            let mut state = self.state.lock().expect("sync state poisoned");
            if state.sync_in_progress {
                json!({
                    "success": true,
                    "skipped": true,
                    "error": "Sync already in progress",
                })
            } else if state
                .rate_limited_until_ms
                .is_some_and(|retry_at_ms| retry_at_ms > chrono::Local::now().timestamp_millis())
            {
                let retry_at_ms = state.rate_limited_until_ms.expect("rate limit set");
                json!({
                    "success": true,
                    "skipped": true,
                    "error": retry_time_message(retry_at_ms),
                })
            } else {
                state.sync_in_progress = true;
                state.cancel_flag = Some(Arc::new(AtomicBool::new(false)));
                Value::Null
            }
        };
        if !start_response.is_null() {
            return start_response;
        }

        let outcome = self.execute_sync(storage).await;
        let response = match outcome {
            Ok(execution) => {
                {
                    let mut state = self.state.lock().expect("sync state poisoned");
                    state.devices = execution.devices;
                    state.rate_limited_until_ms = None;
                    state.last_result = Some(execution.result.clone());
                }
                if let Err(error) = self.persist_state() {
                    json!({
                        "success": true,
                        "error": error,
                    })
                } else {
                    json!({
                        "success": true,
                        "pushed": execution.result.pushed,
                        "pulled": execution.result.pulled,
                        "entriesReplayed": execution.result.entries_replayed,
                    })
                }
            }
            Err(SyncError::RateLimited {
                retry_at_ms,
                message: _,
            }) => {
                {
                    let mut state = self.state.lock().expect("sync state poisoned");
                    state.rate_limited_until_ms = Some(retry_at_ms);
                }
                json!({
                    "success": true,
                    "error": retry_time_message(retry_at_ms),
                    "rateLimitedUntil": retry_at_ms,
                })
            }
            Err(SyncError::AuthExpired(message)) => {
                {
                    let mut state = self.state.lock().expect("sync state poisoned");
                    state.session_token = None;
                    state.github_user = None;
                    state.last_result = None;
                }
                if let Err(error) = self.persist_state() {
                    json!({
                        "success": true,
                        "error": error,
                        "authExpired": true,
                    })
                } else {
                    json!({
                        "success": true,
                        "error": message,
                        "authExpired": true,
                    })
                }
            }
            Err(SyncError::Message(message)) if message == "Cancelled" => json!({
                "success": true,
                "skipped": true,
                "error": "Cancelled",
            }),
            Err(SyncError::Message(message)) => json!({
                "success": true,
                "error": message,
            }),
        };

        {
            let mut state = self.state.lock().expect("sync state poisoned");
            state.sync_in_progress = false;
            state.cancel_flag = None;
        }
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

        {
            let mut state = self.state.lock().expect("sync state poisoned");
            if state.session_token.is_none() || state.sync_in_progress {
                return Ok(SyncBackgroundOutcome::Idle);
            }
            if state
                .rate_limited_until_ms
                .is_some_and(|retry_at_ms| retry_at_ms > chrono::Local::now().timestamp_millis())
            {
                return Ok(SyncBackgroundOutcome::Idle);
            }
            state.sync_in_progress = true;
            state.cancel_flag = Some(Arc::new(AtomicBool::new(false)));
        }

        let outcome = self.execute_sync(storage).await;
        let result = match outcome {
            Ok(execution) => {
                let entries_replayed = execution.result.entries_replayed;
                {
                    let mut state = self.state.lock().expect("sync state poisoned");
                    state.devices = execution.devices;
                    state.rate_limited_until_ms = None;
                    state.last_result = Some(execution.result);
                }
                self.persist_state().map_err(SyncError::Message)?;
                Ok(if entries_replayed > 0 {
                    SyncBackgroundOutcome::Refreshed
                } else {
                    SyncBackgroundOutcome::Idle
                })
            }
            Err(SyncError::RateLimited { retry_at_ms, .. }) => {
                let mut state = self.state.lock().expect("sync state poisoned");
                state.rate_limited_until_ms = Some(retry_at_ms);
                Ok(SyncBackgroundOutcome::Idle)
            }
            Err(SyncError::AuthExpired(message)) => {
                {
                    let mut state = self.state.lock().expect("sync state poisoned");
                    state.session_token = None;
                    state.github_user = None;
                    state.last_result = None;
                }
                self.persist_state().map_err(SyncError::Message)?;
                Err(SyncError::AuthExpired(message))
            }
            Err(error) => Err(error),
        };

        {
            let mut state = self.state.lock().expect("sync state poisoned");
            state.sync_in_progress = false;
            state.cancel_flag = None;
        }
        result
    }

    pub async fn delete_device(&self, storage: &Storage, target: &str) -> Result<(), String> {
        let settings = load_sync_settings(storage).await?;
        let token = {
            let state = self.state.lock().expect("sync state poisoned");
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
            let mut state = self.state.lock().expect("sync state poisoned");
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
            let state = self.state.lock().expect("sync state poisoned");
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
            .map(|branch| SyncDeviceEntry {
                paused: paused_devices.contains(&branch.name),
                last_pushed: device_records
                    .get(&branch.name)
                    .and_then(|record| record.last_pushed),
                last_pulled: device_records
                    .get(&branch.name)
                    .and_then(|record| record.last_pulled),
                device_id: branch.name,
            })
            .collect::<Vec<_>>();

        if !devices
            .iter()
            .any(|entry| entry.device_id == self.device_id)
        {
            devices.insert(
                0,
                SyncDeviceEntry {
                    device_id: self.device_id.clone(),
                    last_pushed: device_records
                        .get(&self.device_id)
                        .and_then(|record| record.last_pushed),
                    last_pulled: device_records
                        .get(&self.device_id)
                        .and_then(|record| record.last_pulled),
                    paused: paused_devices.contains(&self.device_id),
                },
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

    fn persist_state(&self) -> Result<(), String> {
        let state = self.state.lock().expect("sync state poisoned");
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
        .unwrap_or_default();
    let enabled = settings
        .values
        .get("syncEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let method = settings
        .values
        .get("syncMethod")
        .and_then(Value::as_str)
        .unwrap_or("github");
    if method != "github" {
        return Err("Desktop sync only supports GitHub".to_string());
    }
    let repo_url = settings
        .values
        .get("syncRepoUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let retention_days = settings
        .values
        .get("syncRetentionDays")
        .and_then(Value::as_i64)
        .or_else(|| {
            settings
                .values
                .get("syncRetentionDays")
                .and_then(Value::as_u64)
                .and_then(|value| i64::try_from(value).ok())
        })
        .unwrap_or(7)
        .max(1);
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
        .iter()
        .map(|(device_id, record)| SyncDeviceEntry {
            device_id: device_id.clone(),
            last_pushed: record.last_pushed,
            last_pulled: record.last_pulled,
            paused: state.paused_devices.contains(device_id),
        })
        .collect::<Vec<_>>();

    if !entries
        .iter()
        .any(|entry| entry.device_id == local_device_id)
    {
        entries.insert(
            0,
            SyncDeviceEntry {
                device_id: local_device_id.to_string(),
                last_pushed: None,
                last_pulled: None,
                paused: state.paused_devices.contains(local_device_id),
            },
        );
    }

    entries
}

fn retry_time_message(retry_at_ms: i64) -> String {
    let timestamp = chrono::Local
        .timestamp_millis_opt(retry_at_ms)
        .single()
        .unwrap_or_else(chrono::Local::now);
    format!(
        "Rate limited, will retry at {}",
        timestamp.format("%H:%M:%S")
    )
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
                .map(|seconds| seconds * 1000 + 60_000)
                .unwrap_or_else(|| chrono::Local::now().timestamp_millis() + 60 * 60 * 1000);
            return Err(SyncError::RateLimited {
                retry_at_ms,
                message: "GitHub API rate limit exceeded".to_string(),
            });
        }

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
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
        let Some(branches) = value.as_array() else {
            return Ok(Vec::new());
        };
        Ok(branches
            .iter()
            .filter_map(|branch| {
                Some(SyncBranch {
                    name: branch.get("name")?.as_str()?.to_string(),
                    sha: branch.get("commit")?.get("sha")?.as_str()?.to_string(),
                })
            })
            .collect())
    }

    async fn get_tree(&self, sha: &str) -> Result<Vec<(String, String)>, SyncError> {
        let value = self
            .request_json(
                reqwest::Method::GET,
                &format!("{}/git/trees/{sha}?recursive=1", self.repo_path()),
                None,
            )
            .await?;
        let Some(entries) = value.get("tree").and_then(Value::as_array) else {
            return Ok(Vec::new());
        };
        Ok(entries
            .iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("blob"))
            .filter_map(|entry| {
                Some((
                    entry.get("path")?.as_str()?.to_string(),
                    entry.get("sha")?.as_str()?.to_string(),
                ))
            })
            .collect())
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

    pub async fn collect_remote_entries(
        &self,
        device_id: &str,
        paused_devices: &std::collections::BTreeSet<String>,
        device_records: &mut BTreeMap<String, crate::SyncDeviceRecord>,
        storage: &crate::storage::Storage,
        cancellation_requested: impl Fn() -> bool,
    ) -> Result<usize, SyncError> {
        let branches = self.list_branches().await?;
        let peers = branches
            .iter()
            .filter(|branch| branch.name != device_id)
            .cloned()
            .collect::<Vec<_>>();

        let mut cursors = storage
            .load_sync_manifest("sync-cursors")
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?
            .unwrap_or_else(|| json!({ "cursors": {} }));
        let cursor_map = cursors
            .get_mut("cursors")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| SyncError::Message("sync-cursors manifest malformed".to_string()))?;

        let mut replayed = 0usize;
        let now = chrono::Local::now().timestamp_millis();

        for peer in peers {
            if cancellation_requested() {
                return Err(SyncError::Message("Cancelled".to_string()));
            }

            let old_cursor = cursor_map
                .get(&peer.name)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let old_tree_sha = old_cursor.get("treeSha").and_then(Value::as_str);
            if old_tree_sha == Some(peer.sha.as_str()) {
                continue;
            }

            let tree = self.get_tree(&peer.sha).await?;
            let old_files = old_cursor
                .get("files")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let changed = tree
                .iter()
                .filter(|(path, sha)| {
                    old_files.get(path).and_then(Value::as_str) != Some(sha.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();

            let mut note_files = Vec::new();
            let mut log_files = Vec::new();
            for (path, sha) in changed {
                let content = self.get_blob(&sha).await?;
                if path.starts_with("data/notes/") {
                    note_files.push(SyncFile { path, content });
                } else if path.starts_with("data/logs/") {
                    log_files.push(SyncFile { path, content });
                }
            }

            let mut downloaded = Vec::new();
            downloaded.extend(note_files.iter().cloned());
            downloaded.extend(log_files.iter().cloned());
            if !downloaded.is_empty() {
                let write_files = downloaded
                    .iter()
                    .map(|file| (file.path.clone(), file.content.clone()))
                    .collect::<Vec<_>>();
                storage
                    .write_sync_files(&write_files)
                    .await
                    .map_err(|error| SyncError::Message(error.to_string()))?;
            }

            if !paused_devices.contains(&peer.name) {
                let entries = log_files
                    .iter()
                    .flat_map(|file| file.content.lines())
                    .filter(|line| !line.trim().is_empty())
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .collect::<Vec<_>>();
                replayed += entries.len();
                for entry in entries {
                    let parsed: browser_recall_replay::LogEntry = serde_json::from_value(entry)
                        .map_err(|error| SyncError::Message(error.to_string()))?;
                    let effects = browser_recall_replay::effect_of(
                        parsed,
                        {
                            let storage = storage.clone();
                            move |key| {
                                let storage = storage.clone();
                                let key = key.to_string();
                                async move { storage.load_entity(&key).await.ok().flatten() }
                            }
                        },
                        browser_recall_replay::Context {
                            device_id: peer.name.clone(),
                        },
                    )
                    .await
                    .map_err(|error| SyncError::Message(error.to_string()))?;
                    for (key, effect) in &effects {
                        storage
                            .apply_effect(key, effect)
                            .await
                            .map_err(|error| SyncError::Message(error.to_string()))?;
                    }
                }
            }

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

        let push_state = storage
            .load_sync_manifest("sync-push-state")
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?
            .unwrap_or_else(|| json!({ "files": {} }));
        let old_hashes = push_state
            .get("files")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

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
        let mut cursors = storage
            .load_sync_manifest("sync-cursors")
            .await
            .map_err(|error| SyncError::Message(error.to_string()))?
            .unwrap_or_else(|| json!({ "cursors": {} }));
        if let Some(map) = cursors.get_mut("cursors").and_then(Value::as_object_mut) {
            map.remove(device_id);
        }
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
        let text = response.text().await.unwrap_or_default();
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
