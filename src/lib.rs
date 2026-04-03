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

/// Optimal string alignment distance (restricted Damerau-Levenshtein).
/// Handles insertion, deletion, substitution, and adjacent transposition.
fn damerau_levenshtein(a: &str, b: &str) -> usize {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let a_len = a_bytes.len();
    let b_len = b_bytes.len();

    if a_len == 0 { return b_len; }
    if b_len == 0 { return a_len; }

    let mut prev2 = vec![0usize; b_len + 1];
    let mut prev = (0..=b_len).collect::<Vec<_>>();
    let mut curr = vec![0usize; b_len + 1];

    for i in 1..=a_len {
        curr[0] = i;
        for j in 1..=b_len {
            let cost = if a_bytes[i - 1] == b_bytes[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j - 1] + cost)       // substitution
                .min(curr[j - 1] + 1)             // insertion
                .min(prev[j] + 1);                // deletion
            // Transposition
            if i > 1 && j > 1
                && a_bytes[i - 1] == b_bytes[j - 2]
                && a_bytes[i - 2] == b_bytes[j - 1]
            {
                curr[j] = curr[j].min(prev2[j - 2] + cost);
            }
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b_len]
}

/// Split text into word tokens on non-alphanumeric boundaries.
fn tokenize(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut start = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b.is_ascii_alphanumeric() {
            if start.is_none() { start = Some(i); }
        } else if let Some(s) = start {
            tokens.push(&text[s..i]);
            start = None;
        }
    }
    if let Some(s) = start {
        tokens.push(&text[s..]);
    }
    tokens
}

/// Match quality for scoring: exact/substring match vs fuzzy with edit distance.
#[derive(Debug, Clone, Copy)]
enum MatchQuality {
    Exact,
    Fuzzy(usize),
}

/// Max allowed edit distance based on query word length (Algolia-style thresholds).
fn max_fuzzy_distance(word_len: usize) -> Option<usize> {
    match word_len {
        0..=2 => None,  // too short for fuzzy
        3..=4 => Some(1),
        _ => Some(2),
    }
}

/// Check if a word matches within text, returning match quality.
/// Exact words use word-boundary matching. Non-exact words try substring first,
/// then fuzzy matching against individual tokens.
fn word_match_quality(word: &QueryWord, text: &str) -> Option<MatchQuality> {
    let lower = text.to_lowercase();
    if word.exact {
        // Word-boundary match (unchanged logic)
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
                return Some(MatchQuality::Exact);
            }
            start = abs_pos + 1;
            if start >= lower.len() { break; }
        }
        return None;
    }

    // Non-exact: try substring first (fast path, covers prefix matching)
    if lower.contains(&word.text) {
        return Some(MatchQuality::Exact);
    }

    // Fuzzy: tokenize field, check DL distance against each token
    let max_dist = max_fuzzy_distance(word.text.len())?;
    let mut best_dist = usize::MAX;
    for token in tokenize(&lower) {
        let d = damerau_levenshtein(&word.text, token);
        best_dist = best_dist.min(d);
        // Also check token prefixes around query length (handles typo + incomplete typing)
        if token.len() > word.text.len() {
            for prefix_len in [word.text.len().saturating_sub(1), word.text.len(), word.text.len() + 1] {
                if prefix_len > 0 && prefix_len <= token.len() {
                    let d = damerau_levenshtein(&word.text, &token[..prefix_len]);
                    best_dist = best_dist.min(d);
                }
            }
        }
        if best_dist == 0 { break; }
    }
    if best_dist <= max_dist {
        Some(MatchQuality::Fuzzy(best_dist))
    } else {
        None
    }
}

/// Bool wrapper: does this word match in text at any quality?
fn word_matches_text(word: &QueryWord, text: &str) -> bool {
    word_match_quality(word, text).is_some()
}

/// Check if ALL query words match in at least one of the given text fields.
fn words_match_fields(words: &[QueryWord], fields: &[&str]) -> bool {
    words.iter().all(|w| {
        fields.iter().any(|f| word_matches_text(w, f))
    })
}

/// Compute match quality for all words against a single text field.
/// Returns None if any word fails to match, else average quality factor (0.0-1.0).
fn field_match_quality(words: &[QueryWord], text: &str) -> Option<f64> {
    let mut total = 0.0;
    for word in words {
        match word_match_quality(word, text) {
            None => return None,
            Some(MatchQuality::Exact) => total += 1.0,
            Some(MatchQuality::Fuzzy(d)) => total += (1.0 - d as f64 * 0.3).max(0.1),
        }
    }
    Some(total / words.len().max(1) as f64)
}

fn content_score(entry: &HistoryEntry, words: &[QueryWord]) -> f64 {
    let mut score = 0.0;

    if let Some(q) = field_match_quality(words, &entry.title) {
        score += 2.0 * q;
    }

    if !entry.content.is_empty() {
        if let Some(q) = field_match_quality(words, &entry.content) {
            score += 1.0 * q;
        }
    }

    if !entry.intent.is_empty() {
        if let Some(q) = field_match_quality(words, &entry.intent) {
            score += 1.5 * q;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    // --- Damerau-Levenshtein ---

    #[test]
    fn dl_identical() {
        assert_eq!(damerau_levenshtein("react", "react"), 0);
    }

    #[test]
    fn dl_empty() {
        assert_eq!(damerau_levenshtein("", "abc"), 3);
        assert_eq!(damerau_levenshtein("abc", ""), 3);
        assert_eq!(damerau_levenshtein("", ""), 0);
    }

    #[test]
    fn dl_substitution() {
        assert_eq!(damerau_levenshtein("cat", "car"), 1);
        assert_eq!(damerau_levenshtein("react", "reaxt"), 1);
    }

    #[test]
    fn dl_insertion() {
        assert_eq!(damerau_levenshtein("rect", "react"), 1);
        assert_eq!(damerau_levenshtein("hook", "hooks"), 1);
    }

    #[test]
    fn dl_deletion() {
        assert_eq!(damerau_levenshtein("reacts", "react"), 1);
    }

    #[test]
    fn dl_transposition() {
        assert_eq!(damerau_levenshtein("raect", "react"), 1);
        assert_eq!(damerau_levenshtein("teh", "the"), 1);
    }

    #[test]
    fn dl_multiple_edits() {
        assert_eq!(damerau_levenshtein("kitten", "sitting"), 3);
    }

    // --- Tokenize ---

    #[test]
    fn tokenize_simple() {
        assert_eq!(tokenize("hello world"), vec!["hello", "world"]);
    }

    #[test]
    fn tokenize_url() {
        assert_eq!(
            tokenize("https://example.com/path"),
            vec!["https", "example", "com", "path"]
        );
    }

    #[test]
    fn tokenize_mixed() {
        assert_eq!(tokenize("React.js v18"), vec!["React", "js", "v18"]);
    }

    #[test]
    fn tokenize_empty() {
        assert_eq!(tokenize(""), Vec::<&str>::new());
        assert_eq!(tokenize("---"), Vec::<&str>::new());
    }

    // --- max_fuzzy_distance ---

    #[test]
    fn fuzzy_distance_thresholds() {
        assert_eq!(max_fuzzy_distance(1), None);
        assert_eq!(max_fuzzy_distance(2), None);
        assert_eq!(max_fuzzy_distance(3), Some(1));
        assert_eq!(max_fuzzy_distance(4), Some(1));
        assert_eq!(max_fuzzy_distance(5), Some(2));
        assert_eq!(max_fuzzy_distance(10), Some(2));
    }

    // --- word_match_quality ---

    #[test]
    fn exact_quoted_match() {
        let w = QueryWord { text: "react".into(), exact: true };
        assert!(matches!(word_match_quality(&w, "Learn React Today"), Some(MatchQuality::Exact)));
        // "react" not at word boundary inside "reactivity"
        assert!(word_match_quality(&w, "reactivity is key").is_none());
    }

    #[test]
    fn substring_match() {
        let w = QueryWord { text: "reac".into(), exact: false };
        // "reac" is a substring of "react" → Exact
        assert!(matches!(word_match_quality(&w, "react hooks"), Some(MatchQuality::Exact)));
    }

    #[test]
    fn fuzzy_match_typo() {
        let w = QueryWord { text: "raect".into(), exact: false };
        // "raect" vs token "react": DL distance 1, word len 5 → max_dist 2
        match word_match_quality(&w, "react hooks tutorial") {
            Some(MatchQuality::Fuzzy(d)) => assert!(d <= 2),
            other => panic!("expected Fuzzy match, got {:?}", other),
        }
    }

    #[test]
    fn fuzzy_match_prefix_typo() {
        let w = QueryWord { text: "raect".into(), exact: false };
        // "raect" vs prefix "reacti"[..7] of "reactivity": should fuzzy-match
        match word_match_quality(&w, "reactivity overview") {
            Some(MatchQuality::Fuzzy(d)) => assert!(d <= 2),
            other => panic!("expected Fuzzy match, got {:?}", other),
        }
    }

    #[test]
    fn no_fuzzy_for_short_words() {
        // 2-char words don't get fuzzy matching
        let w = QueryWord { text: "ab".into(), exact: false };
        assert!(word_match_quality(&w, "xy zz").is_none());
    }

    #[test]
    fn fuzzy_too_distant() {
        // "react" vs "python": way too different
        let w = QueryWord { text: "react".into(), exact: false };
        assert!(word_match_quality(&w, "python tutorial").is_none());
    }

    // --- field_match_quality ---

    #[test]
    fn field_quality_all_exact() {
        let words = vec![
            QueryWord { text: "react".into(), exact: false },
            QueryWord { text: "hooks".into(), exact: false },
        ];
        let q = field_match_quality(&words, "react hooks tutorial").unwrap();
        assert!((q - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn field_quality_mixed() {
        let words = vec![
            QueryWord { text: "react".into(), exact: false }, // substring match → 1.0
            QueryWord { text: "hokos".into(), exact: false }, // fuzzy match "hooks" → 0.7
        ];
        let q = field_match_quality(&words, "react hooks tutorial").unwrap();
        // (1.0 + 0.7) / 2 = 0.85
        assert!(q > 0.8 && q < 0.9, "expected ~0.85, got {}", q);
    }

    #[test]
    fn field_quality_none_when_word_misses() {
        let words = vec![
            QueryWord { text: "react".into(), exact: false },
            QueryWord { text: "zzzzz".into(), exact: false },
        ];
        assert!(field_match_quality(&words, "react hooks tutorial").is_none());
    }

    // --- content_score ---

    #[test]
    fn content_score_exact_title() {
        let words = vec![QueryWord { text: "react".into(), exact: false }];
        let entry = HistoryEntry {
            timestamp: 0, url: String::new(), title: "React Tutorial".into(),
            intent: String::new(), content: String::new(), attention: String::new(),
        };
        let s = content_score(&entry, &words);
        assert!((s - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn content_score_fuzzy_title() {
        let words = vec![QueryWord { text: "raect".into(), exact: false }];
        let entry = HistoryEntry {
            timestamp: 0, url: String::new(), title: "React Tutorial".into(),
            intent: String::new(), content: String::new(), attention: String::new(),
        };
        let s = content_score(&entry, &words);
        // Fuzzy distance 1 → quality 0.7 → title score 2.0 * 0.7 = 1.4
        assert!(s > 1.3 && s < 1.5, "expected ~1.4, got {}", s);
    }
}
