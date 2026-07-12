use browser_recall_replay::entities::PageEntity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const CONNECTOR_PROTOCOL_VERSION: u32 = 2;

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
    #[serde(default)]
    pub config: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleBatchEntry {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, rename = "bodyPreview")]
    pub body_preview: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub action: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
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
    #[serde(default)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_title: Option<String>,
    #[serde(
        default,
        rename = "scrollDepth",
        skip_serializing_if = "Option::is_none"
    )]
    pub scroll_depth: Option<i64>,
    #[serde(
        default,
        rename = "timeOnPage",
        skip_serializing_if = "Option::is_none"
    )]
    pub time_on_page: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub likes: Option<i64>,
    #[serde(default, rename = "visitDates")]
    pub visit_dates: Vec<i32>,
    #[serde(default)]
    pub timestamps: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PopupNoteResult {
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, rename = "cssPath", skip_serializing_if = "Option::is_none")]
    pub css_path: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub total_seconds: i64,
    #[serde(default, rename = "lastVisit", skip_serializing_if = "Option::is_none")]
    pub last_visit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PopupAccessResult {
    pub blacklisted: bool,
    pub has_visit_history: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MutationPayload {
    #[serde(rename = "type")]
    pub mutation_type: String,
    #[serde(default, rename = "listId", skip_serializing_if = "Option::is_none")]
    pub list_id: Option<String>,
    #[serde(default, rename = "pageSlug", skip_serializing_if = "Option::is_none")]
    pub page_slug: Option<String>,
    #[serde(default, rename = "noteSlug", skip_serializing_if = "Option::is_none")]
    pub note_slug: Option<String>,
    #[serde(
        default,
        rename = "oldNoteSlug",
        skip_serializing_if = "Option::is_none"
    )]
    pub old_note_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectorMessage {
    PairRequest {
        #[serde(default, rename = "protocolVersion")]
        protocol_version: Option<u32>,
        #[serde(rename = "browserId")]
        browser_id: String,
        #[serde(rename = "browserName")]
        browser_name: String,
        #[serde(rename = "extensionId")]
        extension_id: String,
        #[serde(default, rename = "browserProfile")]
        browser_profile: Option<String>,
    },
    Auth {
        #[serde(default, rename = "protocolVersion")]
        protocol_version: Option<u32>,
        token: String,
    },
    Ping,
    GetStatus,
    GetDirectoryInfo,
    GetDirectorySize,
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
    ListHistoryFiles {
        #[serde(default, rename = "includeSizes")]
        include_sizes: bool,
    },
    LoadHistoryBatch {
        files: Vec<String>,
    },
    GetAllPages,
    GetPageInfo {
        slug: String,
    },
    GetPageSummary {
        url: String,
        #[serde(default)]
        title: Option<String>,
    },
    GetSettings,
    GetSnapshotHtml {
        slug: String,
        ts: i64,
    },
    GetEntity {
        key: String,
    },
    PermanentDelete {
        keys: Vec<String>,
    },
    RunCommand {
        action: String,
        #[serde(default)]
        request: Value,
        #[serde(default, rename = "bufferDepth")]
        buffer_depth: Option<usize>,
        #[serde(default, rename = "bufferBytes")]
        buffer_bytes: Option<usize>,
    },
    Event {
        entry: Value,
        source: String,
        #[serde(default, rename = "bufferDepth")]
        buffer_depth: Option<usize>,
        #[serde(default, rename = "bufferBytes")]
        buffer_bytes: Option<usize>,
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
        #[serde(default)]
        limit: Option<usize>,
    },
    SearchSnapshots {
        query: String,
        #[serde(default)]
        limit: Option<usize>,
    },
    TestResetData,
    TestSeedData {
        files: Vec<TestSeedFilePayload>,
    },
    Note {
        slug: String,
        #[serde(default)]
        excerpt: Option<serde_json::Value>,
        note: String,
        #[serde(default, rename = "cssPath")]
        css_path: Option<serde_json::Value>,
        #[serde(default, rename = "oldSlug")]
        old_slug: Option<String>,
        url: String,
        #[serde(default)]
        title: Option<String>,
        ts: i64,
        source: String,
        #[serde(default, rename = "bufferDepth")]
        buffer_depth: Option<usize>,
        #[serde(default, rename = "bufferBytes")]
        buffer_bytes: Option<usize>,
    },
    Snapshot {
        slug: String,
        ts: i64,
        url: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        markdown: Option<String>,
        html: String,
        source: String,
        #[serde(default, rename = "bufferDepth")]
        buffer_depth: Option<usize>,
        #[serde(default, rename = "bufferBytes")]
        buffer_bytes: Option<usize>,
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
    },
    Change {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mutations: Vec<MutationPayload>,
    },
    DirectoryInfoResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        info: Option<DirectoryInfoPayload>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    DirectorySizeResult {
        success: bool,
        size: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    ClearAllDataResult {
        success: bool,
        #[serde(rename = "deletedCount")]
        deleted_count: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    RemoteReplayResult {
        success: bool,
        #[serde(rename = "replayedEntries")]
        replayed_entries: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SetDeviceIdResult {
        success: bool,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    HistoryFilesResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        devices: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sizes: Option<BTreeMap<String, u64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    HistoryBatchResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        entries: Vec<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    AllPagesResult {
        success: bool,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        pages: BTreeMap<String, PageEntity>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    PageInfoResult {
        success: bool,
        slug: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entry: Option<PopupPageInfoEntry>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<PopupNoteResult>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        snapshots: Vec<PopupSnapshotResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    PageSummaryResult {
        success: bool,
        url: String,
        #[serde(rename = "displayTitle")]
        display_title: String,
        access: PopupAccessResult,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page: Option<PopupPageInfoEntry>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<PopupNoteResult>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        snapshots: Vec<PopupSnapshotResult>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        lists: Vec<PopupListResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attention: Option<PopupAttentionResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SettingsResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settings: Option<BTreeMap<String, Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SnapshotHtmlResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        html: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    EntityResult {
        success: bool,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entity: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    PermanentDeleteResult {
        success: bool,
        #[serde(default, rename = "deletedKeys", skip_serializing_if = "Vec::is_empty")]
        deleted_keys: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    CommandResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    RuleBatchResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        results: Vec<RuleBatchHit>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    PreviewRuleResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        results: Vec<PreviewRuleHit>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SearchNotesResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        results: Vec<NoteSearchResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SearchSnapshotsResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        results: Vec<SnapshotSearchResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    TestResetDataResult {
        success: bool,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    TestSeedDataResult {
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Error {
        error: String,
        code: String,
        message: String,
    },
}
