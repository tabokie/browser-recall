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

/// Represents a portal interaction (webpage visit, document read, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[wasm_bindgen(getter_with_clone)]
pub struct Interaction {
    pub timestamp: i64,
    pub url: String,
    pub title: String,
    pub intent: String,  // Search keywords, prompts
    pub content: String,  // External data
    pub attention: String,  // JSON string of engagement patterns
}

#[wasm_bindgen]
impl Interaction {
    #[wasm_bindgen(constructor)]
    pub fn new(url: String, title: String) -> Interaction {
        let timestamp = js_sys::Date::now() as i64;
        Interaction {
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

/// Raw interaction data from JSONL files (deserialization target)
#[derive(Deserialize)]
struct InteractionData {
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
    interactions: Vec<Interaction>,
}

#[wasm_bindgen]
impl SearchEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SearchEngine {
        SearchEngine {
            interactions: Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = addInteraction)]
    pub fn add_interaction(&mut self, interaction: Interaction) {
        self.interactions.push(interaction);
    }

    #[wasm_bindgen(js_name = search)]
    pub fn search(&self, query: &str, algorithm: RankingAlgorithm) -> Result<JsValue, JsValue> {
        let results = self.search_internal(query, algorithm);
        serde_wasm_bindgen::to_value(&results)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    fn search_internal(&self, query: &str, algorithm: RankingAlgorithm) -> Vec<SearchResult> {
        let query_lower = query.to_lowercase();
        let mut results: Vec<SearchResult> = self.interactions
            .iter()
            .filter(|i| {
                i.title.to_lowercase().contains(&query_lower) ||
                i.content.to_lowercase().contains(&query_lower) ||
                i.intent.to_lowercase().contains(&query_lower)
            })
            .map(|i| SearchResult {
                url: i.url.clone(),
                title: i.title.clone(),
                timestamp: i.timestamp,
                intent: i.intent.clone(),
                attention: i.attention.clone(),
                score: content_score(i, &query_lower),
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

fn content_score(interaction: &Interaction, query: &str) -> f64 {
    let mut score = 0.0;

    if interaction.title.to_lowercase().contains(query) {
        score += 2.0;
    }

    if interaction.content.to_lowercase().contains(query) {
        score += 1.0;
    }

    if interaction.intent.to_lowercase().contains(query) {
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
    atoms_dir: JsValue,
    query: String,
    file_names: Vec<String>,
) -> Result<JsValue, JsValue> {
    let history: &FileSystemDirectoryHandle = history_dir.unchecked_ref();
    let atoms: &FileSystemDirectoryHandle = atoms_dir.unchecked_ref();

    let mut seen_urls = HashSet::new();
    let mut interactions: Vec<InteractionData> = Vec::new();

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
            if let Ok(item) = serde_json::from_str::<InteractionData>(line) {
                if seen_urls.insert(item.url.clone()) {
                    interactions.push(item);
                }
            }
        }
    }

    // 2. Load content for each slug
    let mut content_map: HashMap<String, String> = HashMap::new();
    let slugs: HashSet<&str> = interactions
        .iter()
        .filter_map(|i| i.slug.as_deref())
        .collect();

    for slug in slugs {
        if let Ok(slug_dir_val) = atoms.get_directory_handle(slug).await {
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
    for item in &interactions {
        let c = item
            .slug
            .as_deref()
            .and_then(|s| content_map.get(s))
            .cloned()
            .unwrap_or_default();
        engine.add_interaction(Interaction {
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

#[wasm_bindgen(start)]
pub fn main() {
    log("Portal Extension WASM module initialized");
}
