use rand::{distributions::Alphanumeric, thread_rng, Rng};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

const DEVICE_ID_MAX_LEN: usize = 48;
const DEVICE_ID_MACHINE_SUFFIX_LEN: usize = 12;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Token(pub String);

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovedConnector {
    pub browser_id: String,
    pub browser_name: String,
    pub extension_id: String,
    #[serde(default)]
    pub browser_profile: Option<String>,
    pub token: Token,
    pub approved_at: u64,
    #[serde(default)]
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SyncDeviceRecord {
    #[serde(default)]
    pub last_pushed: Option<i64>,
    #[serde(default)]
    pub last_pulled: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DaemonConfig {
    pub device_id: String,
    pub data_dir: PathBuf,
    pub last_port: Option<u16>,
    #[serde(default)]
    pub launch_at_login: bool,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default)]
    pub setup_complete: bool,
    #[serde(default)]
    pub connectors: Vec<ApprovedConnector>,
    #[serde(default)]
    pub sync_github_token: Option<Token>,
    #[serde(default)]
    pub sync_github_user: Option<String>,
    #[serde(default = "default_sync_remember_token")]
    pub sync_remember_token: bool,
    #[serde(default)]
    pub sync_paused_devices: Vec<String>,
    #[serde(default)]
    pub sync_devices: BTreeMap<String, SyncDeviceRecord>,
}

impl DaemonConfig {
    pub fn new_unconfigured() -> Self {
        Self {
            device_id: default_device_id(),
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
        }
    }

    pub fn new_configured(data_dir: PathBuf) -> Result<Self, &'static str> {
        let mut config = Self::new_unconfigured();
        config.select_data_directory(data_dir)?;
        config.complete_setup()?;
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
        Ok(Some(config))
    }

    pub fn load_or_create(&self) -> std::io::Result<DaemonConfig> {
        if let Some(config) = self.load()? {
            Ok(config)
        } else {
            let config = DaemonConfig::new_unconfigured();
            self.save(&config)?;
            Ok(config)
        }
    }

    pub fn save(&self, config: &DaemonConfig) -> std::io::Result<()> {
        fs::create_dir_all(&self.root_dir)?;
        let payload = serde_json::to_string_pretty(config).map_err(invalid_data)?;
        fs::write(self.config_path(), payload)
    }
}

fn invalid_data(error: impl ToString) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_sync_remember_token() -> bool {
    true
}

pub fn random_string(len: usize) -> String {
    thread_rng()
        .sample_iter(Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

pub fn default_device_id() -> String {
    device_id_from_os_parts(
        &current_hostname(),
        stable_os_device_identifier().as_deref(),
    )
}

pub fn device_id_from_os_parts(hostname: &str, machine_identifier: Option<&str>) -> String {
    let suffix = machine_identifier
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(stable_device_suffix);
    let base_max_len = if suffix.is_some() {
        DEVICE_ID_MAX_LEN - DEVICE_ID_MACHINE_SUFFIX_LEN - 1
    } else {
        DEVICE_ID_MAX_LEN
    };
    let base = device_id_component_from_hostname(hostname, base_max_len)
        .unwrap_or_else(|| "desktop".to_string());

    match suffix {
        Some(suffix) => format!("{base}-{suffix}"),
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

fn stable_os_device_identifier() -> Option<String> {
    platform_machine_identifier()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "macos")]
fn platform_machine_identifier() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_ioreg_platform_uuid(&String::from_utf8_lossy(&output.stdout))
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
fn platform_machine_identifier() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| fs::read_to_string(path).ok())
}

#[cfg(target_os = "windows")]
fn platform_machine_identifier() -> Option<String> {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.contains("MachineGuid"))
        .and_then(|line| line.split_whitespace().last())
        .map(str::to_string)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_machine_identifier() -> Option<String> {
    None
}

pub fn current_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        current_hostname, default_device_id, device_id_from_hostname, device_id_from_os_parts,
        stable_device_suffix, ConfigStore, DaemonConfig, Token,
    };
    use tempfile::tempdir;

    #[test]
    fn new_unconfigured_uses_os_derived_device_id() {
        let config = DaemonConfig::new_unconfigured();
        assert_eq!(config.device_id, default_device_id());
        assert!(!config.device_id.is_empty());
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
            device_id_from_os_parts("John's MacBook Pro.local", Some("machine-id-123")),
            format!("johns-macbook-pro-local-{suffix}")
        );
        assert_eq!(
            device_id_from_os_parts("東京", Some("machine-id-123")),
            format!("desktop-{suffix}")
        );
        assert_eq!(
            device_id_from_os_parts(
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
                Some("machine-id-123"),
            ),
            format!("abcdefghijklmnopqrstuvwxyzabcdefghi-{suffix}")
        );
        assert_eq!(
            device_id_from_os_parts("Office", Some("  ")),
            "office".to_string()
        );
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
        assert!(!current_hostname().trim().is_empty());

        std::fs::write(store.config_path(), "{not json").expect("write invalid json");
        let error = store.load().expect_err("invalid config should fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
