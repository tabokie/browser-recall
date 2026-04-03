use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

    // File System Access API bindings
    type FileSystemDirectoryHandle;

    #[wasm_bindgen(method, catch, js_name = "getDirectoryHandle")]
    async fn get_directory_handle(
        this: &FileSystemDirectoryHandle,
        name: &str,
    ) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = "getFileHandle")]
    async fn get_file_handle(
        this: &FileSystemDirectoryHandle,
        name: &str,
    ) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method)]
    fn values(this: &FileSystemDirectoryHandle) -> js_sys::AsyncIterator;

    type FileSystemFileHandle;

    #[wasm_bindgen(method, catch, js_name = "getFile")]
    async fn get_file(this: &FileSystemFileHandle) -> Result<JsValue, JsValue>;

    type WebFile;

    #[wasm_bindgen(method, catch)]
    async fn text(this: &WebFile) -> Result<JsValue, JsValue>;
}

/// Represents a history entry (webpage visit, document read, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[wasm_bindgen(getter_with_clone)]
pub struct HistoryEntry {
    pub timestamp: i64,
    pub url: String,
    pub title: String,
    pub intent: String,  // Search keywords, prompts
    pub content: String,  // External data
    pub attention: String,  // JSON string of engagement patterns
}

#[wasm_bindgen]
impl HistoryEntry {
    #[wasm_bindgen(constructor)]
    pub fn new(url: String, title: String) -> HistoryEntry {
        let timestamp = js_sys::Date::now() as i64;
        HistoryEntry {
            timestamp,
            url,
            title,
            intent: String::new(),
            content: String::new(),
            attention: String::new(),
        }
    }

    #[wasm_bindgen(js_name = setIntent)]
    pub fn set_intent(&mut self, intent: String) {
        self.intent = intent;
    }

    #[wasm_bindgen(js_name = setContent)]
    pub fn set_content(&mut self, content: String) {
        self.content = content;
    }

    #[wasm_bindgen(js_name = setAttention)]
    pub fn set_attention(&mut self, attention: String) {
        self.attention = attention;
    }

    #[wasm_bindgen(js_name = toJSON)]
    pub fn to_json(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(self)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }
}

/// A single search result with its relevance score.
#[derive(Serialize)]
struct SearchResult {
    url: String,
    title: String,
    timestamp: i64,
    intent: String,
    attention: String,
    score: f64,
}

/// Raw history data from JSONL files (deserialization target)
#[derive(Deserialize)]
struct HistoryData {
    timestamp: i64,
    url: String,
    title: String,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    intent: String,
    #[serde(default)]
    attention: String,
}

/// Search result ranking algorithms
#[wasm_bindgen]
pub enum RankingAlgorithm {
    Content,
    Context,
    Lineage,
    Attention,
    Hybrid,
}

/// Text search engine. Currently only handles flat query strings.
/// TODO: Move the query builder tree evaluation (AND/OR operators, keyword/range/smartFilter
/// predicates) from options.js into WASM so all filtering and scoring happens in one pass.
#[wasm_bindgen]
pub struct SearchEngine {
    entries: Vec<HistoryEntry>,
}

#[wasm_bindgen]
impl SearchEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SearchEngine {
        SearchEngine {
            entries: Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = addEntry)]
    pub fn add_entry(&mut self, entry: HistoryEntry) {
        self.entries.push(entry);
    }

    #[wasm_bindgen(js_name = search)]
    pub fn search(&self, query: &str, algorithm: RankingAlgorithm) -> Result<JsValue, JsValue> {
        let results = self.search_internal(query, algorithm);
        serde_wasm_bindgen::to_value(&results)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    fn search_internal(&self, query: &str, algorithm: RankingAlgorithm) -> Vec<SearchResult> {
        let words = parse_query_words(query);
        if words.is_empty() {
            return Vec::new();
        }
        let mut results: Vec<SearchResult> = self.entries
            .iter()
            .filter(|i| {
                words_match_fields(&words, &[&i.title, &i.content, &i.intent])
            })
            .map(|i| SearchResult {
                url: i.url.clone(),
                title: i.title.clone(),
                timestamp: i.timestamp,
                intent: i.intent.clone(),
                attention: i.attention.clone(),
                score: content_score(i, &words),
            })
            .collect();

        // Simple ranking implementation (can be enhanced)
        match algorithm {
            RankingAlgorithm::Content => {
                results.sort_by(|a, b| {
                    b.score.partial_cmp(&a.score).unwrap()
                });
            }
            RankingAlgorithm::Context => {
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
            RankingAlgorithm::Lineage => {
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
            RankingAlgorithm::Attention => {
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
            RankingAlgorithm::Hybrid => {
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
        }

        results
    }
}

/// A parsed query word: either an exact (quoted) phrase or a substring match.
#[derive(Debug, Clone)]
struct QueryWord {
    text: String, // lowercased
    exact: bool,
}

/// Parse a query string into words, matching JS `parseSearchWords` semantics.
/// Quoted phrases stay together ("react hooks" → one exact word).
/// Unquoted tokens are individual substring matches. ALL words must match (AND).
fn parse_query_words(query: &str) -> Vec<QueryWord> {
    let mut words = Vec::new();
    let mut chars = query.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch == '"' {
            chars.next(); // consume opening quote
            let mut phrase = String::new();
            while let Some(&c) = chars.peek() {
                if c == '"' {
                    chars.next(); // consume closing quote
                    break;
                }
                phrase.push(c);
                chars.next();
            }
            if !phrase.is_empty() {
                words.push(QueryWord { text: phrase.to_lowercase(), exact: true });
            }
        } else if ch.is_whitespace() {
            chars.next();
        } else {
            let mut token = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() || c == '"' {
                    break;
                }
                token.push(c);
                chars.next();
            }
            if !token.is_empty() {
                words.push(QueryWord { text: token.to_lowercase(), exact: false });
            }
        }
    }

    words
}

/// Check if a word matches within text. Exact words use word-boundary matching.
fn word_matches_text(word: &QueryWord, text: &str) -> bool {
    let lower = text.to_lowercase();
    if word.exact {
        // Word-boundary match: look for the phrase surrounded by non-alphanumeric chars (or string edges)
        let needle = &word.text;
        let mut start = 0;
        while let Some(pos) = lower[start..].find(needle) {
            let abs_pos = start + pos;
            let end_pos = abs_pos + needle.len();
            let at_word_start = abs_pos == 0
                || !lower.as_bytes()[abs_pos - 1].is_ascii_alphanumeric();
            let at_word_end = end_pos == lower.len()
                || !lower.as_bytes()[end_pos].is_ascii_alphanumeric();
            if at_word_start && at_word_end {
                return true;
            }
            start = abs_pos + 1;
            if start >= lower.len() {
                break;
            }
        }
        false
    } else {
        lower.contains(&word.text)
    }
}

/// Check if ALL query words match in at least one of the given text fields.
/// Each word must match in at least one field (AND across words, OR across fields per word).
fn words_match_fields(words: &[QueryWord], fields: &[&str]) -> bool {
    words.iter().all(|w| {
        fields.iter().any(|f| word_matches_text(w, f))
    })
}

fn content_score(entry: &HistoryEntry, words: &[QueryWord]) -> f64 {
    let mut score = 0.0;

    if words.iter().all(|w| word_matches_text(w, &entry.title)) {
        score += 2.0;
    }

    if !entry.content.is_empty() && words.iter().all(|w| word_matches_text(w, &entry.content)) {
        score += 1.0;
    }

    if !entry.intent.is_empty() && words.iter().all(|w| word_matches_text(w, &entry.intent)) {
        score += 1.5;
    }

    score
}

/// Read text content of a FileSystemFileHandle
async fn read_file_text(fh: &FileSystemFileHandle) -> Result<String, JsValue> {
    let file: WebFile = fh.get_file().await?.unchecked_into();
    let text_val = file.text().await?;
    Ok(text_val.as_string().unwrap_or_default())
}

/// Find latest .md file in a slug directory and return its content
async fn read_latest_md(slug_dir: &FileSystemDirectoryHandle) -> Result<String, JsValue> {
    let iter = slug_dir.values();
    let mut latest_ts: i64 = 0;
    let mut latest_name = String::new();

    loop {
        let next = JsFuture::from(iter.next()?).await?;
        let done = js_sys::Reflect::get(&next, &JsValue::from_str("done"))?;
        if done.as_bool().unwrap_or(true) {
            break;
        }
        let entry = js_sys::Reflect::get(&next, &JsValue::from_str("value"))?;
        let name: String = js_sys::Reflect::get(&entry, &JsValue::from_str("name"))?
            .as_string()
            .unwrap_or_default();
        if name.ends_with(".md") {
            if let Ok(ts) = name.trim_end_matches(".md").parse::<i64>() {
                if ts > latest_ts {
                    latest_ts = ts;
                    latest_name = name;
                }
            }
        }
    }

    if latest_name.is_empty() {
        return Ok(String::new());
    }

    let fh: FileSystemFileHandle = slug_dir.get_file_handle(&latest_name).await?.unchecked_into();
    read_file_text(&fh).await
}

/// Search a batch of JSONL files + their content, returning scored results.
/// Called from JS with FileSystemDirectoryHandle references.
#[wasm_bindgen(js_name = "searchBatch")]
pub async fn search_batch(
    history_dir: JsValue,
    pages_dir: JsValue,
    query: String,
    file_names: Vec<String>,
) -> Result<JsValue, JsValue> {
    let history: &FileSystemDirectoryHandle = history_dir.unchecked_ref();
    let pages: &FileSystemDirectoryHandle = pages_dir.unchecked_ref();

    let mut seen_urls = HashSet::new();
    let mut entries: Vec<HistoryData> = Vec::new();

    // 1. Read JSONL files, dedup by URL (first occurrence = newest file wins)
    for name in &file_names {
        let fh_val = match history.get_file_handle(name).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let fh: &FileSystemFileHandle = fh_val.unchecked_ref();
        let text = read_file_text(fh).await.unwrap_or_default();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(item) = serde_json::from_str::<HistoryData>(line) {
                if seen_urls.insert(item.url.clone()) {
                    entries.push(item);
                }
            }
        }
    }

    // 2. Load content for each slug
    let mut content_map: HashMap<String, String> = HashMap::new();
    let slugs: HashSet<&str> = entries
        .iter()
        .filter_map(|i| i.slug.as_deref())
        .collect();

    for slug in slugs {
        if let Ok(slug_dir_val) = pages.get_directory_handle(slug).await {
            let slug_dir: &FileSystemDirectoryHandle = slug_dir_val.unchecked_ref();
            if let Ok(md) = read_latest_md(slug_dir).await {
                if !md.is_empty() {
                    content_map.insert(slug.to_string(), md);
                }
            }
        }
    }

    // 3. Build engine + search
    let mut engine = SearchEngine::new();
    for item in &entries {
        let c = item
            .slug
            .as_deref()
            .and_then(|s| content_map.get(s))
            .cloned()
            .unwrap_or_default();
        engine.add_entry(HistoryEntry {
            timestamp: item.timestamp,
            url: item.url.clone(),
            title: item.title.clone(),
            intent: item.intent.clone(),
            content: c,
            attention: item.attention.clone(),
        });
    }

    engine.search(&query, RankingAlgorithm::Content)
}

/// Note JSON structure from data/notes/{slug}.json
#[derive(Deserialize)]
struct NoteData {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    excerpt: serde_json::Value, // string or array of strings
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// Result from searchNotes: the note's URL and slug
#[derive(Serialize)]
struct NoteMatch {
    url: String,
    #[serde(rename = "noteSlug")]
    note_slug: String,
}

/// Result from searchSnapshots: the page slug
#[derive(Serialize)]
struct SnapshotMatch {
    slug: String,
}

/// Iterate all entries in a FileSystemDirectoryHandle, returning (name, kind) pairs.
async fn list_directory(dir: &FileSystemDirectoryHandle) -> Result<Vec<(String, String)>, JsValue> {
    let iter = dir.values();
    let mut entries = Vec::new();
    loop {
        let next = JsFuture::from(iter.next()?).await?;
        let done = js_sys::Reflect::get(&next, &JsValue::from_str("done"))?;
        if done.as_bool().unwrap_or(true) {
            break;
        }
        let entry = js_sys::Reflect::get(&next, &JsValue::from_str("value"))?;
        let name = js_sys::Reflect::get(&entry, &JsValue::from_str("name"))?
            .as_string()
            .unwrap_or_default();
        let kind = js_sys::Reflect::get(&entry, &JsValue::from_str("kind"))?
            .as_string()
            .unwrap_or_default();
        entries.push((name, kind));
    }
    Ok(entries)
}

/// Search all note JSON files in a directory for query matches.
/// Returns matching notes with their URL and slug.
#[wasm_bindgen(js_name = "searchNotes")]
pub async fn search_notes(
    notes_dir: JsValue,
    query: String,
) -> Result<JsValue, JsValue> {
    let dir: &FileSystemDirectoryHandle = notes_dir.unchecked_ref();
    let words = parse_query_words(&query);
    if words.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<NoteMatch>::new())
            .map_err(|e| JsValue::from_str(&e.to_string()));
    }

    let entries = list_directory(dir).await?;
    let mut matches = Vec::new();

    for (name, kind) in &entries {
        if kind != "file" || !name.ends_with(".json") {
            continue;
        }
        let fh_val = match dir.get_file_handle(name).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let fh: &FileSystemFileHandle = fh_val.unchecked_ref();
        let text = match read_file_text(fh).await {
            Ok(t) => t,
            Err(_) => continue,
        };
        let note: NoteData = match serde_json::from_str(&text) {
            Ok(n) => n,
            Err(_) => continue,
        };

        // Collect searchable text fields from the note
        let mut fields: Vec<String> = Vec::new();
        match &note.excerpt {
            serde_json::Value::String(s) => fields.push(s.clone()),
            serde_json::Value::Array(arr) => {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        fields.push(s.to_string());
                    }
                }
            }
            _ => {}
        }
        if let Some(ref n) = note.note {
            fields.push(n.clone());
        }

        let field_refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
        if words_match_fields(&words, &field_refs) {
            if let Some(url) = note.url {
                let note_slug = note.slug.unwrap_or_else(|| {
                    name.trim_end_matches(".json").to_string()
                });
                matches.push(NoteMatch { url, note_slug });
            }
        }
    }

    serde_wasm_bindgen::to_value(&matches)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Search a batch of snapshot .md files for query matches.
/// file_names are pre-filtered (latest per slug only) and chunked by JS.
/// Returns matching slugs extracted from filenames.
#[wasm_bindgen(js_name = "searchSnapshots")]
pub async fn search_snapshots(
    snapshots_dir: JsValue,
    query: String,
    file_names: Vec<String>,
) -> Result<JsValue, JsValue> {
    let dir: &FileSystemDirectoryHandle = snapshots_dir.unchecked_ref();
    let words = parse_query_words(&query);
    if words.is_empty() {
        return serde_wasm_bindgen::to_value(&Vec::<SnapshotMatch>::new())
            .map_err(|e| JsValue::from_str(&e.to_string()));
    }

    let mut matches = Vec::new();

    for name in &file_names {
        // Extract slug from filename: {slug}-{timestamp13}.md
        let slug = match extract_slug_from_snapshot_name(name) {
            Some(s) => s,
            None => continue,
        };

        let fh_val = match dir.get_file_handle(name).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let fh: &FileSystemFileHandle = fh_val.unchecked_ref();
        let content = match read_file_text(fh).await {
            Ok(t) => t,
            Err(_) => continue,
        };

        if words_match_fields(&words, &[&content]) {
            matches.push(SnapshotMatch { slug });
        }
    }

    serde_wasm_bindgen::to_value(&matches)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Extract page slug from snapshot filename like "my-page-slug-1709251200000.md"
fn extract_slug_from_snapshot_name(name: &str) -> Option<String> {
    let name = name.strip_suffix(".md")?;
    // Find the last '-' followed by exactly 13 digits (Unix ms timestamp)
    let last_dash = name.rfind('-')?;
    let ts_part = &name[last_dash + 1..];
    if ts_part.len() == 13 && ts_part.chars().all(|c| c.is_ascii_digit()) {
        Some(name[..last_dash].to_string())
    } else {
        None
    }
}

#[wasm_bindgen(start)]
pub fn main() {
    log("Portal Extension WASM module initialized");
}
