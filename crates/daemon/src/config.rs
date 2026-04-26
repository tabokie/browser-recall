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
pub struct CurrentDeviceRecord {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub hostname: String,
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
    pub fn new_default(data_dir: PathBuf) -> Self {
        Self {
            device_id: default_device_id(),
            data_dir,
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

    pub fn default_data_dir(&self) -> PathBuf {
        self.root_dir.join("portal-data")
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
            let config = DaemonConfig::new_default(self.default_data_dir());
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

pub fn current_file_path(data_dir: &Path, device_id: &str) -> PathBuf {
    data_dir
        .join("data")
        .join("logs")
        .join(device_id)
        .join("CURRENT")
}

fn legacy_current_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("CURRENT")
}

pub fn write_current_device(
    data_dir: &Path,
    device_id: &str,
) -> std::io::Result<CurrentDeviceRecord> {
    let record = CurrentDeviceRecord {
        device_id: device_id.to_string(),
        hostname: current_hostname(),
    };
    let path = current_file_path(data_dir, device_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string_pretty(&record).map_err(invalid_data)?;
    fs::write(path, payload)?;
    Ok(record)
}

pub fn remove_current_device(data_dir: &Path, device_id: &str) -> std::io::Result<()> {
    let path = current_file_path(data_dir, device_id);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn detect_current_device(data_dir: &Path) -> std::io::Result<Option<CurrentDeviceRecord>> {
    let logs_root = data_dir.join("data").join("logs");
    let entries = match fs::read_dir(&logs_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return detect_legacy_current_device(data_dir);
        }
        Err(error) => return Err(error),
    };

    let local_hostname = current_hostname();
    let mut records = Vec::new();

    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let current_path = entry.path().join("CURRENT");
        if !current_path.exists() {
            continue;
        }
        let raw = fs::read_to_string(current_path)?;
        let record = serde_json::from_str::<CurrentDeviceRecord>(&raw).map_err(invalid_data)?;
        records.push(record);
    }

    if records.is_empty() {
        return detect_legacy_current_device(data_dir);
    }

    if let Some(record) = records
        .iter()
        .find(|record| record.hostname == local_hostname)
        .cloned()
    {
        return Ok(Some(record));
    }

    if records.len() == 1 {
        return Ok(records.into_iter().next());
    }

    Ok(None)
}

fn detect_legacy_current_device(data_dir: &Path) -> std::io::Result<Option<CurrentDeviceRecord>> {
    let legacy_path = legacy_current_file_path(data_dir);
    let raw = match fs::read_to_string(legacy_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if let Ok(record) = serde_json::from_str::<CurrentDeviceRecord>(trimmed) {
        return Ok(Some(record));
    }

    Ok(Some(CurrentDeviceRecord {
        device_id: trimmed.to_string(),
        hostname: current_hostname(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        current_file_path, current_hostname, default_device_id, detect_current_device,
        device_id_from_hostname, device_id_from_os_parts, remove_current_device,
        stable_device_suffix, write_current_device, CurrentDeviceRecord, DaemonConfig,
    };
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn current_device_round_trips() {
        let dir = tempdir().expect("tempdir");
        let record = write_current_device(dir.path(), "device-a").expect("write current");
        assert_eq!(record.device_id, "device-a");
        assert!(!record.hostname.is_empty());

        let detected = detect_current_device(dir.path())
            .expect("detect current")
            .expect("current exists");
        assert_eq!(detected, record);
    }

    #[test]
    fn new_default_uses_os_derived_device_id() {
        let config = DaemonConfig::new_default(tempdir().expect("tempdir").path().join("data"));
        assert_eq!(config.device_id, default_device_id());
        assert!(!config.device_id.is_empty());
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
    }

    #[test]
    fn current_device_prefers_same_hostname() {
        let dir = tempdir().expect("tempdir");
        let local_hostname = current_hostname();

        let remote_path = current_file_path(dir.path(), "remote-device");
        fs::create_dir_all(remote_path.parent().expect("remote parent")).expect("remote dirs");
        fs::write(
            &remote_path,
            serde_json::to_string_pretty(&CurrentDeviceRecord {
                device_id: "remote-device".to_string(),
                hostname: "other-machine".to_string(),
            })
            .expect("remote json"),
        )
        .expect("write remote current");

        let local_record = CurrentDeviceRecord {
            device_id: "local-device".to_string(),
            hostname: local_hostname,
        };
        let local_path = current_file_path(dir.path(), "local-device");
        fs::create_dir_all(local_path.parent().expect("local parent")).expect("local dirs");
        fs::write(
            &local_path,
            serde_json::to_string_pretty(&local_record).expect("local json"),
        )
        .expect("write local current");

        let detected = detect_current_device(dir.path())
            .expect("detect current")
            .expect("current exists");
        assert_eq!(detected, local_record);
    }

    #[test]
    fn remove_current_device_ignores_missing_file() {
        let dir = tempdir().expect("tempdir");
        remove_current_device(dir.path(), "missing-device").expect("remove missing current");
    }

    #[test]
    fn detect_current_device_from_legacy_root_current_text() {
        let dir = tempdir().expect("tempdir");
        let logs_dir = dir.path().join("data").join("logs").join("legacy-device");
        fs::create_dir_all(logs_dir).expect("logs dir");
        fs::write(dir.path().join("CURRENT"), "legacy-device\n").expect("write legacy current");

        let detected = detect_current_device(dir.path())
            .expect("detect current")
            .expect("current exists");
        assert_eq!(detected.device_id, "legacy-device");
        assert_eq!(detected.hostname, current_hostname());
    }

    #[test]
    fn detect_current_device_from_legacy_root_current_json() {
        let dir = tempdir().expect("tempdir");
        let record = CurrentDeviceRecord {
            device_id: "legacy-json-device".to_string(),
            hostname: "old-host".to_string(),
        };
        fs::create_dir_all(
            dir.path()
                .join("data")
                .join("logs")
                .join("legacy-json-device"),
        )
        .expect("logs dir");
        fs::write(
            dir.path().join("CURRENT"),
            serde_json::to_string_pretty(&record).expect("record json"),
        )
        .expect("write legacy current");

        let detected = detect_current_device(dir.path())
            .expect("detect current")
            .expect("current exists");
        assert_eq!(detected, record);
    }
}
