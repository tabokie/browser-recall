use browser_recall_replay::entities::PageEntity;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const CONNECTOR_PROTOCOL_VERSION: u32 = 2;

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DirectoryInfoPayload {
    pub name: String,
    #[serde(rename = "hasPermission")]
    pub has_permission: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RulePayload {
    #[serde(rename = "type")]
    pub rule_type: String,
    pub config: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleBatchEntry {
    pub url: String,
    pub title: String,
    #[serde(
        rename = "bodyPreview",
        deserialize_with = "deserialize_required_option"
    )]
    pub body_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleMatchResult {
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    pub r#match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleBatchHit {
    #[serde(rename = "listId")]
    pub list_id: String,
    pub url: String,
    pub title: Option<String>,
    pub matches: Vec<RuleMatchResult>,
    #[serde(rename = "pinnedAt")]
    pub pinned_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreviewRuleHit {
    pub url: String,
    pub title: String,
    pub r#match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchRequestPayload {
    pub query: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TestSeedFilePayload {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteSearchResult {
    pub url: String,
    #[serde(rename = "noteSlug")]
    pub note_slug: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotSearchResult {
    pub slug: String,
    pub timestamp: i64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PopupPageInfoEntry {
    pub slug: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub user_title: Option<String>,
    #[serde(rename = "scrollDepth")]
    pub scroll_depth: Option<i64>,
    #[serde(rename = "timeOnPage")]
    pub time_on_page: Option<i64>,
    pub likes: Option<i64>,
    #[serde(rename = "visitDates")]
    pub visit_dates: Vec<i32>,
    pub timestamps: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PopupNoteResult {
    pub slug: String,
    pub excerpt: Option<serde_json::Value>,
    pub note: Option<String>,
    #[serde(rename = "cssPath")]
    pub css_path: Option<serde_json::Value>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PopupSnapshotResult {
    pub timestamp: i64,
    #[serde(rename = "hasMd")]
    pub has_md: bool,
    #[serde(rename = "hasHtml")]
    pub has_html: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PopupListResult {
    pub slug: String,
    pub name: String,
    pub contains_page: bool,
    pub last_activity: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PopupAttentionResult {
    #[serde(rename = "totalSeconds")]
    pub total_seconds: Option<i64>,
    #[serde(rename = "lastVisit")]
    pub last_visit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PopupAccessResult {
    pub blacklisted: bool,
    pub has_visit_history: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryMutationEntry {
    pub action: String,
    pub timestamp: i64,
    pub url: String,
    pub title: Option<String>,
    pub user_title: Option<String>,
    pub scroll_depth: Option<i64>,
    pub time_on_page: Option<i64>,
    pub likes: Option<i64>,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct MutationPayload {
    #[serde(rename = "type")]
    pub mutation_type: String,
    #[serde(rename = "listId")]
    pub list_id: Option<String>,
    #[serde(rename = "pageSlug")]
    pub page_slug: Option<String>,
    #[serde(rename = "noteSlug")]
    pub note_slug: Option<String>,
    #[serde(rename = "oldNoteSlug")]
    pub old_note_slug: Option<String>,
    pub slug: Option<String>,
    pub url: Option<String>,
    pub urls: Option<Vec<String>>,
    pub key: Option<String>,
    #[serde(rename = "historyEntry")]
    pub history_entry: Option<HistoryMutationEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectorMessage {
    PairRequest {
        #[serde(
            rename = "protocolVersion",
            deserialize_with = "deserialize_required_option"
        )]
        protocol_version: Option<u32>,
        #[serde(rename = "browserId")]
        browser_id: String,
        #[serde(rename = "browserName")]
        browser_name: String,
        #[serde(rename = "extensionId")]
        extension_id: String,
        #[serde(
            rename = "browserProfile",
            deserialize_with = "deserialize_required_option"
        )]
        browser_profile: Option<String>,
    },
    Auth {
        #[serde(
            rename = "protocolVersion",
            deserialize_with = "deserialize_required_option"
        )]
        protocol_version: Option<u32>,
        token: String,
    },
    Ping,
    GetStatus,
    GetDirectoryInfo,
    GetDirectorySize,
    ListHistoryFiles {
        #[serde(rename = "includeSizes")]
        include_sizes: bool,
    },
    LoadHistoryBatch {
        files: Vec<String>,
    },
    GetPageInfo {
        slug: String,
    },
    GetPageSummary {
        url: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        title: Option<String>,
    },
    GetSettings,
    GetSnapshotHtml {
        slug: String,
        ts: i64,
    },
    RunCommand {
        action: String,
        request: Value,
        #[serde(rename = "bufferDepth")]
        buffer_depth: usize,
        #[serde(rename = "bufferBytes")]
        buffer_bytes: usize,
    },
    TestControl {
        request: TestControlMessage,
    },
    Snapshot {
        slug: String,
        ts: i64,
        url: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        title: Option<String>,
        #[serde(deserialize_with = "deserialize_required_option")]
        markdown: Option<String>,
        html: String,
        source: String,
        #[serde(rename = "bufferDepth")]
        buffer_depth: usize,
        #[serde(rename = "bufferBytes")]
        buffer_bytes: usize,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TestControlMessage {
    ClearAllData,
    ReplayRemoteEntries {
        #[serde(rename = "deviceId")]
        device_id: String,
        entries: Vec<Value>,
    },
    SetDeviceId {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    GetAllPages,
    GetEntity {
        key: String,
    },
    PermanentDelete {
        keys: Vec<String>,
    },
    Event {
        entry: Value,
        source: String,
        #[serde(rename = "bufferDepth")]
        buffer_depth: usize,
        #[serde(rename = "bufferBytes")]
        buffer_bytes: usize,
    },
    RunRuleBatch {
        #[serde(rename = "listIds")]
        list_ids: Vec<String>,
        entries: Vec<RuleBatchEntry>,
    },
    PreviewRule {
        rule: RulePayload,
        entries: Vec<RuleBatchEntry>,
    },
    SearchNotes {
        query: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        limit: Option<usize>,
    },
    SearchSnapshots {
        query: String,
        #[serde(deserialize_with = "deserialize_required_option")]
        limit: Option<usize>,
    },
    ResetData,
    SeedData {
        files: Vec<TestSeedFilePayload>,
    },
    Note {
        slug: String,
        excerpt: Option<serde_json::Value>,
        note: String,
        #[serde(rename = "cssPath")]
        css_path: Option<serde_json::Value>,
        #[serde(rename = "oldSlug")]
        old_slug: Option<String>,
        url: String,
        title: Option<String>,
        ts: i64,
        source: String,
        #[serde(rename = "bufferDepth")]
        buffer_depth: usize,
        #[serde(rename = "bufferBytes")]
        buffer_bytes: usize,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonMessage {
    PairPending {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    PairApproved {
        token: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    PairDenied,
    AuthOk {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    AuthFail {
        reason: String,
    },
    Pong,
    Ack {
        #[serde(rename = "ackedAt")]
        acked_at: i64,
        #[serde(rename = "bufferDepth")]
        buffer_depth: usize,
        #[serde(rename = "lastDrainedAt")]
        last_drained_at: i64,
    },
    Status {
        #[serde(rename = "connectedBrowsers")]
        connected_browsers: Vec<String>,
        #[serde(rename = "bufferDepth")]
        buffer_depth: usize,
        #[serde(rename = "bufferBytes")]
        buffer_bytes: usize,
        #[serde(rename = "daemonBufferDepth")]
        daemon_buffer_depth: usize,
        #[serde(rename = "lastDrainedAt")]
        last_drained_at: Option<i64>,
        #[serde(rename = "dataFolder")]
        data_folder: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "maxMessageBytes")]
        max_message_bytes: usize,
    },
    Change {
        mutations: Vec<MutationPayload>,
    },
    DirectoryInfoResult {
        success: bool,
        info: Option<DirectoryInfoPayload>,
        error: Option<String>,
    },
    DirectorySizeResult {
        success: bool,
        size: u64,
        error: Option<String>,
    },
    ClearAllDataResult {
        success: bool,
        #[serde(rename = "deletedCount")]
        deleted_count: usize,
        error: Option<String>,
    },
    RemoteReplayResult {
        success: bool,
        #[serde(rename = "replayedEntries")]
        replayed_entries: usize,
        error: Option<String>,
    },
    SetDeviceIdResult {
        success: bool,
        #[serde(rename = "deviceId")]
        device_id: String,
        error: Option<String>,
    },
    HistoryFilesResult {
        success: bool,
        files: Vec<String>,
        devices: Vec<String>,
        sizes: Option<BTreeMap<String, u64>>,
        error: Option<String>,
    },
    HistoryBatchResult {
        success: bool,
        entries: Vec<Value>,
        error: Option<String>,
    },
    AllPagesResult {
        success: bool,
        pages: BTreeMap<String, PageEntity>,
        error: Option<String>,
    },
    PageInfoResult {
        success: bool,
        slug: String,
        entry: Option<PopupPageInfoEntry>,
        notes: Vec<PopupNoteResult>,
        snapshots: Vec<PopupSnapshotResult>,
        error: Option<String>,
    },
    PageSummaryResult {
        success: bool,
        url: String,
        #[serde(rename = "displayTitle")]
        display_title: Option<String>,
        access: Option<PopupAccessResult>,
        page: Option<PopupPageInfoEntry>,
        notes: Vec<PopupNoteResult>,
        snapshots: Vec<PopupSnapshotResult>,
        lists: Vec<PopupListResult>,
        attention: Option<PopupAttentionResult>,
        error: Option<String>,
    },
    SettingsResult {
        success: bool,
        settings: Option<BTreeMap<String, Value>>,
        error: Option<String>,
    },
    SnapshotHtmlResult {
        success: bool,
        html: Option<String>,
        error: Option<String>,
    },
    EntityResult {
        success: bool,
        key: String,
        entity: Option<Value>,
        error: Option<String>,
    },
    PermanentDeleteResult {
        success: bool,
        #[serde(rename = "deletedKeys")]
        deleted_keys: Vec<String>,
        error: Option<String>,
    },
    CommandResult {
        success: bool,
        response: Option<Value>,
        error: Option<String>,
    },
    RuleBatchResult {
        success: bool,
        results: Vec<RuleBatchHit>,
        error: Option<String>,
    },
    PreviewRuleResult {
        success: bool,
        results: Vec<PreviewRuleHit>,
        error: Option<String>,
    },
    SearchNotesResult {
        success: bool,
        results: Vec<NoteSearchResult>,
        error: Option<String>,
    },
    SearchSnapshotsResult {
        success: bool,
        results: Vec<SnapshotSearchResult>,
        error: Option<String>,
    },
    TestResetDataResult {
        success: bool,
        #[serde(rename = "deviceId")]
        device_id: String,
        error: Option<String>,
    },
    TestSeedDataResult {
        success: bool,
        error: Option<String>,
    },
    Error {
        error: String,
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::{ConnectorMessage, CONNECTOR_PROTOCOL_VERSION};
    use serde_json::json;

    #[test]
    fn raw_replay_operations_are_not_connector_messages() {
        let raw_event = json!({
            "type": "event",
            "entry": {},
            "source": "extension",
            "bufferDepth": 0,
            "bufferBytes": 0
        });
        assert!(serde_json::from_value::<ConnectorMessage>(raw_event).is_err());

        let wrapped = json!({
            "type": "test_control",
            "request": {
                "type": "event",
                "entry": {},
                "source": "extension",
                "bufferDepth": 0,
                "bufferBytes": 0
            }
        });
        assert!(serde_json::from_value::<ConnectorMessage>(wrapped).is_ok());
    }

    #[test]
    fn connector_v2_accepts_additive_message_fields() {
        assert_eq!(CONNECTOR_PROTOCOL_VERSION, 2);

        let message = json!({
            "type": "run_command",
            "action": "createList",
            "request": { "name": "Reading" },
            "bufferDepth": 0,
            "bufferBytes": 0,
            "futureTracingContext": { "spanId": "additive-v2-field" }
        });

        assert!(serde_json::from_value::<ConnectorMessage>(message).is_ok());
    }

    #[test]
    fn connector_v2_still_requires_current_fields() {
        let missing_request = json!({
            "type": "run_command",
            "action": "createList",
            "bufferDepth": 0,
            "bufferBytes": 0
        });

        assert!(serde_json::from_value::<ConnectorMessage>(missing_request).is_err());
    }

    #[test]
    fn connector_v2_rejects_missing_nullable_snapshot_fields_even_with_additions() {
        let misspelled_markdown = json!({
            "type": "snapshot",
            "slug": "snapshot-page",
            "ts": 1_710_000_000_000_i64,
            "url": "https://example.com/snapshot",
            "title": null,
            "markdonw": null,
            "html": "<html></html>",
            "source": "extension",
            "bufferDepth": 0,
            "bufferBytes": 0,
            "futureTracingContext": { "spanId": "additive-v2-field" }
        });

        assert!(serde_json::from_value::<ConnectorMessage>(misspelled_markdown).is_err());
    }
}
