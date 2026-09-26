use rand::{distributions::Alphanumeric, thread_rng, Rng};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static CONFIG_WRITE_ID: AtomicU64 = AtomicU64::new(0);

const DEVICE_ID_MAX_LEN: usize = 48;
const DEVICE_ID_MACHINE_SUFFIX_LEN: usize = 12;

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Token(pub String);

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ApprovedConnector {
    pub browser_id: String,
    pub browser_name: String,
    pub extension_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub browser_profile: Option<String>,
    pub token: Token,
    pub approved_at: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct SyncDeviceRecord {
    #[serde(deserialize_with = "deserialize_required_option")]
    pub last_pushed: Option<i64>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub last_pulled: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DaemonConfig {
    pub device_id: String,
    pub data_dir: PathBuf,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub last_port: Option<u16>,
    pub launch_at_login: bool,
    pub log_level: String,
    pub setup_complete: bool,
    pub connectors: Vec<ApprovedConnector>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub sync_github_token: Option<Token>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub sync_github_user: Option<String>,
    pub sync_remember_token: bool,
    pub sync_paused_devices: Vec<String>,
    pub sync_devices: BTreeMap<String, SyncDeviceRecord>,
}

impl DaemonConfig {
    pub fn new_unconfigured() -> std::io::Result<Self> {
        Ok(Self {
            device_id: default_device_id()?,
            data_dir: PathBuf::new(),
            last_port: None,
            launch_at_login: true,
            log_level: default_log_level(),
            setup_complete: false,
            connectors: Vec::new(),
            sync_github_token: None,
            sync_github_user: None,
            sync_remember_token: true,
            sync_paused_devices: Vec::new(),
            sync_devices: BTreeMap::new(),
        })
    }

    pub fn new_configured(data_dir: PathBuf) -> std::io::Result<Self> {
        let mut config = Self::new_unconfigured()?;
        config
            .select_data_directory(data_dir)
            .map_err(invalid_data)?;
        config.complete_setup().map_err(invalid_data)?;
        Ok(config)
    }

    pub fn select_data_directory(&mut self, data_dir: PathBuf) -> Result<(), &'static str> {
        if data_dir.as_os_str().is_empty() {
            return Err("data directory is not configured");
        }
        self.data_dir = data_dir;
        self.setup_complete = false;
        Ok(())
    }

    pub fn complete_setup(&mut self) -> Result<(), &'static str> {
        if self.data_dir.as_os_str().is_empty() {
            return Err("data directory is not configured");
        }
        self.setup_complete = true;
        Ok(())
    }

    pub fn is_configured(&self) -> bool {
        self.setup_complete && !self.data_dir.as_os_str().is_empty()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.device_id.is_empty()
            || self.device_id.len() > DEVICE_ID_MAX_LEN
            || !self
                .device_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("device_id must be a lowercase path-safe identifier".to_string());
        }
        if self.setup_complete && self.data_dir.as_os_str().is_empty() {
            return Err("configured daemon is missing data_dir".to_string());
        }
        if !matches!(self.log_level.as_str(), "info" | "debug") {
            return Err("log_level must be info or debug".to_string());
        }
        for connector in &self.connectors {
            if connector.browser_id.trim().is_empty()
                || connector.browser_name.trim().is_empty()
                || connector.extension_id.trim().is_empty()
                || connector.token.0.is_empty()
            {
                return Err("connector identity and token fields must not be empty".to_string());
            }
            if connector
                .browser_profile
                .as_deref()
                .is_some_and(|profile| profile.trim().is_empty())
            {
                return Err("browser_profile must be non-empty when present".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ConfigStore {
    root_dir: PathBuf,
}

impl ConfigStore {
    pub fn new(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
        }
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    pub fn config_path(&self) -> PathBuf {
        self.root_dir.join("config.json")
    }

    pub fn exists(&self) -> bool {
        self.config_path().exists()
    }

    pub fn load(&self) -> std::io::Result<Option<DaemonConfig>> {
        fs::create_dir_all(&self.root_dir)?;
        let path = self.config_path();
        if !path.exists() {
            return Ok(None);
        }

        let raw = fs::read_to_string(path)?;
        let config = serde_json::from_str::<DaemonConfig>(&raw).map_err(invalid_data)?;
        config.validate().map_err(invalid_data)?;
        Ok(Some(config))
    }

    fn lock_writer(&self) -> std::io::Result<fs::File> {
        fs::create_dir_all(&self.root_dir)?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root_dir.join("config.lock"))?;
        lock.lock()?;
        Ok(lock)
    }

    pub fn load_or_create(&self) -> std::io::Result<DaemonConfig> {
        self.update(|config| Ok(config.clone()))
    }

    /// Serialize a mutation against the latest persisted configuration. The
    /// file lock also coordinates independently constructed stores/processes.
    pub fn update<T>(
        &self,
        edit: impl FnOnce(&mut DaemonConfig) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        let _writer = self.lock_writer()?;
        let existing = self.load()?;
        let mut config = match &existing {
            Some(config) => config.clone(),
            None => DaemonConfig::new_unconfigured()?,
        };
        let result = edit(&mut config)?;
        if existing.as_ref() != Some(&config) {
            self.write_atomic(&config)?;
        }
        Ok(result)
    }

    /// Replace a complete configuration during initialization/test seeding.
    /// Runtime callers must use `update` to preserve other owners' fields.
    pub fn save(&self, config: &DaemonConfig) -> std::io::Result<()> {
        let _writer = self.lock_writer()?;
        self.write_atomic(config)
    }

    fn write_atomic(&self, config: &DaemonConfig) -> std::io::Result<()> {
        config.validate().map_err(invalid_data)?;
        let payload = serde_json::to_vec_pretty(config).map_err(invalid_data)?;
        let id = CONFIG_WRITE_ID.fetch_add(1, Ordering::Relaxed);
        let temporary = self
            .root_dir
            .join(format!(".config.{}.{id}.tmp", std::process::id()));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&payload)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, self.config_path())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn invalid_data(error: impl ToString) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
}

fn default_log_level() -> String {
    "info".to_string()
}

pub fn random_string(len: usize) -> String {
    thread_rng()
        .sample_iter(Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

pub fn default_device_id() -> std::io::Result<String> {
    let hostname = current_hostname();
    let machine_identifier = stable_os_device_identifier()?;
    device_id_from_os_parts(hostname.as_deref(), machine_identifier.as_deref())
        .ok_or_else(|| invalid_data("platform machine identifier did not produce a device ID"))
}

pub fn device_id_from_os_parts(
    hostname: Option<&str>,
    machine_identifier: Option<&str>,
) -> Option<String> {
    let suffix = machine_identifier
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(stable_device_suffix);
    let base_max_len = if suffix.is_some() {
        DEVICE_ID_MAX_LEN - DEVICE_ID_MACHINE_SUFFIX_LEN - 1
    } else {
        DEVICE_ID_MAX_LEN
    };
    let base = hostname.and_then(|value| device_id_component_from_hostname(value, base_max_len));

    match suffix {
        Some(suffix) => Some(format!(
            "{}-{suffix}",
            base.unwrap_or_else(|| "machine".to_string())
        )),
        None => base,
    }
}

pub fn device_id_from_hostname(hostname: &str) -> Option<String> {
    device_id_component_from_hostname(hostname, DEVICE_ID_MAX_LEN)
}

fn device_id_component_from_hostname(hostname: &str, max_len: usize) -> Option<String> {
    let mut result = String::new();
    let mut last_was_separator = false;

    for ch in hostname.trim().chars() {
        if result.len() >= max_len {
            break;
        }

        let next = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch == '-' || ch == '_' || ch == '.' || ch.is_whitespace() {
            Some('-')
        } else {
            None
        };

        match next {
            Some('-') => {
                if !result.is_empty() && !last_was_separator {
                    result.push('-');
                    last_was_separator = true;
                }
            }
            Some(ch) => {
                result.push(ch);
                last_was_separator = false;
            }
            None => {}
        }
    }

    let trimmed = result.trim_matches('-').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn stable_device_suffix(machine_identifier: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in machine_identifier.trim().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
        .chars()
        .take(DEVICE_ID_MACHINE_SUFFIX_LEN)
        .collect()
}

fn stable_os_device_identifier() -> std::io::Result<Option<String>> {
    let value = platform_machine_identifier()?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(invalid_data("platform machine identifier is empty"));
    }
    Ok(Some(value))
}

#[cfg(target_os = "macos")]
fn platform_machine_identifier() -> std::io::Result<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()?;
    if !output.status.success() {
        return Err(invalid_data(format!(
            "ioreg failed while reading IOPlatformUUID with status {}",
            output.status
        )));
    }
    parse_ioreg_platform_uuid(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| invalid_data("ioreg output is missing IOPlatformUUID"))
}

#[cfg(target_os = "macos")]
fn parse_ioreg_platform_uuid(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        if !line.contains("\"IOPlatformUUID\"") {
            return None;
        }
        let (_, value) = line.split_once('=')?;
        Some(value.trim().trim_matches('"').to_string()).filter(|value| !value.is_empty())
    })
}

#[cfg(target_os = "linux")]
fn platform_machine_identifier() -> std::io::Result<String> {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        match fs::read_to_string(path) {
            Ok(value) => return Ok(value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(std::io::Error::new(
                    error.kind(),
                    format!("failed to read {path}: {error}"),
                ))
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "platform machine identifier is unavailable: neither /etc/machine-id nor /var/lib/dbus/machine-id exists",
    ))
}

#[cfg(target_os = "windows")]
fn platform_machine_identifier() -> std::io::Result<String> {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()?;
    if !output.status.success() {
        return Err(invalid_data(format!(
            "registry query for MachineGuid failed with status {}",
            output.status
        )));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.contains("MachineGuid"))
        .and_then(|line| line.split_whitespace().last())
        .map(str::to_string)
        .ok_or_else(|| invalid_data("registry output is missing MachineGuid"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_machine_identifier() -> std::io::Result<String> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "platform machine identity is not implemented for this operating system",
    ))
}

pub fn current_hostname() -> Option<String> {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::{
        current_hostname, device_id_from_hostname, device_id_from_os_parts, stable_device_suffix,
        ConfigStore, DaemonConfig, Token,
    };
    use tempfile::tempdir;

    #[test]
    fn new_unconfigured_uses_os_derived_device_id() {
        let config = DaemonConfig::new_unconfigured().expect("platform device identity");
        assert!(!config.device_id.is_empty());
        assert_ne!(config.device_id, "desktop");
        assert_ne!(config.device_id, "unknown");
        assert!(!config.is_configured());
    }

    #[test]
    fn hostname_device_id_is_path_safe() {
        assert_eq!(
            device_id_from_hostname("John's MacBook Pro.local"),
            Some("johns-macbook-pro-local".to_string())
        );
        assert_eq!(
            device_id_from_hostname("  OFFICE_PC__02  "),
            Some("office-pc-02".to_string())
        );
        assert_eq!(device_id_from_hostname("東京"), None);
        assert_eq!(device_id_from_hostname("...---___"), None);
        assert_eq!(
            device_id_from_hostname("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
            Some("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv".to_string())
        );
    }

    #[test]
    fn os_device_id_includes_stable_machine_suffix() {
        let suffix = stable_device_suffix("machine-id-123");
        assert_eq!(
            device_id_from_os_parts(Some("John's MacBook Pro.local"), Some("machine-id-123")),
            Some(format!("johns-macbook-pro-local-{suffix}"))
        );
        assert_eq!(
            device_id_from_os_parts(Some("東京"), Some("machine-id-123")),
            Some(format!("machine-{suffix}"))
        );
        assert_eq!(
            device_id_from_os_parts(
                Some("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
                Some("machine-id-123"),
            ),
            Some(format!("abcdefghijklmnopqrstuvwxyzabcdefghi-{suffix}"))
        );
        assert_eq!(
            device_id_from_os_parts(Some("Office"), Some("  ")),
            Some("office".to_string())
        );
        assert_eq!(device_id_from_os_parts(None, None), None);
    }

    #[test]
    fn config_store_round_trips_and_redacts_tokens() {
        let dir = tempdir().expect("tempdir");
        let store = ConfigStore::new(dir.path());
        assert_eq!(store.root_dir(), dir.path());
        assert!(!store.exists());
        assert!(store.load().expect("load missing").is_none());

        let mut config = store.load_or_create().expect("create default config");
        assert!(config.data_dir.as_os_str().is_empty());
        config.sync_github_token = Some(Token("secret".to_string()));
        store.save(&config).expect("save config");
        assert!(store.exists());
        let loaded = store.load().expect("load saved").expect("config exists");
        assert_eq!(loaded.sync_github_token, Some(Token("secret".to_string())));
        assert_eq!(format!("{:?}", Token("secret".to_string())), "<redacted>");
        if let Some(hostname) = current_hostname() {
            assert!(!hostname.trim().is_empty());
        }

        std::fs::write(store.config_path(), "{not json").expect("write invalid json");
        let error = store.load().expect_err("invalid config should fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
