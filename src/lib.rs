use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Represents a portal interaction (webpage visit, document read, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[wasm_bindgen(getter_with_clone)]
pub struct Interaction {
    pub id: String,
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
            id: format!("{}-{}", timestamp, url),
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
    id: String,
    timestamp: i64,
    intent: String,
    attention: String,
    score: f64,
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
                id: i.id.clone(),
                timestamp: i.timestamp,
                intent: i.intent.clone(),
                attention: i.attention.clone(),
                score: self.content_score(i, &query_lower),
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
                // Sort by timestamp for now (temporal context)
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
            RankingAlgorithm::Lineage => {
                // TODO: Implement lineage-based ranking
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
            RankingAlgorithm::Attention => {
                // TODO: Implement attention-based ranking
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
            RankingAlgorithm::Hybrid => {
                // TODO: Implement hybrid ranking
                results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            }
        }

        results
    }

    fn content_score(&self, interaction: &Interaction, query: &str) -> f64 {
        let mut score = 0.0;

        // Title match (higher weight)
        if interaction.title.to_lowercase().contains(query) {
            score += 2.0;
        }

        // Content match
        if interaction.content.to_lowercase().contains(query) {
            score += 1.0;
        }

        // Intent match
        if interaction.intent.to_lowercase().contains(query) {
            score += 1.5;
        }

        score
    }
}

#[wasm_bindgen(start)]
pub fn main() {
    log("Portal Extension WASM module initialized");
}
