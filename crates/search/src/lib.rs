use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Represents a history entry (webpage visit, document read, etc.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryEntry {
    pub timestamp: i64,
    pub url: String,
    pub title: String,
    pub content: String,
}

impl HistoryEntry {
    pub fn new(url: String, title: String) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        Self {
            timestamp,
            url,
            title,
            content: String::new(),
        }
    }

    pub fn set_content(&mut self, content: String) {
        self.content = content;
    }
}

/// A single search result with its relevance score.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchResult {
    pub url: String,
    pub title: String,
    pub timestamp: i64,
    pub score: f64,
}

/// Raw history data from JSONL files.
#[derive(Debug, Deserialize)]
struct HistoryData {
    timestamp: i64,
    url: String,
    title: String,
    #[serde(default)]
    slug: Option<String>,
}

/// Search result ranking algorithms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankingAlgorithm {
    Content,
}

/// Text search engine. Currently only handles flat query strings.
#[derive(Debug, Clone)]
pub struct SearchEngine {
    entries: Vec<HistoryEntry>,
}

impl Default for SearchEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SearchEngine {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn add_entry(&mut self, entry: HistoryEntry) {
        self.entries.push(entry);
    }

    pub fn search(&self, query: &str, algorithm: RankingAlgorithm) -> Vec<SearchResult> {
        let words = parse_query_words(query);
        if words.is_empty() {
            return Vec::new();
        }

        let mut results: Vec<SearchResult> = self
            .entries
            .iter()
            .filter(|entry| words_match_fields(&words, &[&entry.title, &entry.content]))
            .map(|entry| SearchResult {
                url: entry.url.clone(),
                title: entry.title.clone(),
                timestamp: entry.timestamp,
                score: content_score(entry, &words),
            })
            .collect();

        match algorithm {
            RankingAlgorithm::Content => {
                results.sort_by(|left, right| {
                    right
                        .score
                        .total_cmp(&left.score)
                        .then_with(|| right.timestamp.cmp(&left.timestamp))
                });
            }
        }

        results
    }
}

/// A parsed query word: either an exact (quoted) phrase or a substring match.
#[derive(Debug, Clone)]
struct QueryWord {
    text: String,
    exact: bool,
}

/// Search all note JSON files in a directory for query matches.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NoteMatch {
    pub url: String,
    #[serde(rename = "noteSlug")]
    pub note_slug: String,
}

/// Search a batch of snapshot markdown files for query matches.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SnapshotMatch {
    pub slug: String,
}

#[derive(Debug, Deserialize)]
struct NoteData {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    excerpt: Value,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// Parse a query string into words, matching JS `parseSearchWords` semantics.
/// Quoted phrases stay together. Unquoted tokens are substring/fuzzy matches.
fn parse_query_words(query: &str) -> Vec<QueryWord> {
    let mut words = Vec::new();
    let mut chars = query.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch == '"' {
            chars.next();
            let mut phrase = String::new();
            while let Some(&c) = chars.peek() {
                if c == '"' {
                    chars.next();
                    break;
                }
                phrase.push(c);
                chars.next();
            }
            if !phrase.is_empty() {
                words.push(QueryWord {
                    text: phrase.to_lowercase(),
                    exact: true,
                });
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
                words.push(QueryWord {
                    text: token.to_lowercase(),
                    exact: false,
                });
            }
        }
    }

    words
}

/// Optimal string alignment distance (restricted Damerau-Levenshtein).
fn damerau_levenshtein(a: &str, b: &str) -> usize {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let a_len = a_bytes.len();
    let b_len = b_bytes.len();

    if a_len == 0 {
        return b_len;
    }
    if b_len == 0 {
        return a_len;
    }

    let mut prev2 = vec![0usize; b_len + 1];
    let mut prev = (0..=b_len).collect::<Vec<_>>();
    let mut curr = vec![0usize; b_len + 1];

    for i in 1..=a_len {
        curr[0] = i;
        for j in 1..=b_len {
            let cost = if a_bytes[i - 1] == b_bytes[j - 1] {
                0
            } else {
                1
            };
            curr[j] = (prev[j - 1] + cost).min(curr[j - 1] + 1).min(prev[j] + 1);
            if i > 1
                && j > 1
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
    for (index, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_alphanumeric() {
            if start.is_none() {
                start = Some(index);
            }
        } else if let Some(token_start) = start {
            tokens.push(&text[token_start..index]);
            start = None;
        }
    }
    if let Some(token_start) = start {
        tokens.push(&text[token_start..]);
    }
    tokens
}

#[derive(Debug, Clone, Copy)]
enum MatchQuality {
    Exact,
    Fuzzy(usize),
}

fn max_fuzzy_distance(word_len: usize) -> Option<usize> {
    match word_len {
        0..=2 => None,
        3..=4 => Some(1),
        _ => Some(2),
    }
}

fn word_match_quality(word: &QueryWord, text: &str) -> Option<MatchQuality> {
    let lower = text.to_lowercase();
    if word.exact {
        let needle = &word.text;
        let mut start = 0;
        while let Some(pos) = lower[start..].find(needle) {
            let abs_pos = start + pos;
            let end_pos = abs_pos + needle.len();
            let at_word_start =
                abs_pos == 0 || !lower.as_bytes()[abs_pos - 1].is_ascii_alphanumeric();
            let at_word_end =
                end_pos == lower.len() || !lower.as_bytes()[end_pos].is_ascii_alphanumeric();
            if at_word_start && at_word_end {
                return Some(MatchQuality::Exact);
            }
            start = abs_pos + 1;
            if start >= lower.len() {
                break;
            }
        }
        return None;
    }

    if lower.contains(&word.text) {
        return Some(MatchQuality::Exact);
    }

    let max_dist = max_fuzzy_distance(word.text.len())?;
    let mut best_dist = usize::MAX;
    for token in tokenize(&lower) {
        let distance = damerau_levenshtein(&word.text, token);
        best_dist = best_dist.min(distance);
        if token.len() > word.text.len() {
            for prefix_len in [
                word.text.len().saturating_sub(1),
                word.text.len(),
                word.text.len() + 1,
            ] {
                if prefix_len > 0 && prefix_len <= token.len() {
                    let distance = damerau_levenshtein(&word.text, &token[..prefix_len]);
                    best_dist = best_dist.min(distance);
                }
            }
        }
        if best_dist == 0 {
            break;
        }
    }

    if best_dist <= max_dist {
        Some(MatchQuality::Fuzzy(best_dist))
    } else {
        None
    }
}

fn word_matches_text(word: &QueryWord, text: &str) -> bool {
    word_match_quality(word, text).is_some()
}

fn words_match_fields(words: &[QueryWord], fields: &[&str]) -> bool {
    words
        .iter()
        .all(|word| fields.iter().any(|field| word_matches_text(word, field)))
}

fn field_match_quality(words: &[QueryWord], text: &str) -> Option<f64> {
    let mut total = 0.0;
    for word in words {
        match word_match_quality(word, text) {
            None => return None,
            Some(MatchQuality::Exact) => total += 1.0,
            Some(MatchQuality::Fuzzy(distance)) => total += (1.0 - distance as f64 * 0.3).max(0.1),
        }
    }
    Some(total / words.len().max(1) as f64)
}

fn content_score(entry: &HistoryEntry, words: &[QueryWord]) -> f64 {
    let mut score = 0.0;

    if let Some(quality) = field_match_quality(words, &entry.title) {
        score += 2.0 * quality;
    }

    if !entry.content.is_empty() {
        if let Some(quality) = field_match_quality(words, &entry.content) {
            score += 1.0 * quality;
        }
    }

    score
}

fn read_dir_if_exists(path: &Path) -> io::Result<Option<fs::ReadDir>> {
    match fs::read_dir(path) {
        Ok(entries) => Ok(Some(entries)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_latest_markdown(slug_dir: &Path) -> io::Result<Option<String>> {
    let Some(entries) = read_dir_if_exists(slug_dir)? else {
        return Ok(None);
    };

    let mut latest_timestamp = i64::MIN;
    let mut latest_path = None;

    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".md") {
            continue;
        }
        let Ok(timestamp) = name.trim_end_matches(".md").parse::<i64>() else {
            continue;
        };
        if timestamp > latest_timestamp {
            latest_timestamp = timestamp;
            latest_path = Some(path);
        }
    }

    let Some(path) = latest_path else {
        return Ok(None);
    };

    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn extract_note_fields(note: &NoteData) -> Vec<String> {
    let mut fields = Vec::new();
    match &note.excerpt {
        Value::String(text) => fields.push(text.clone()),
        Value::Array(items) => {
            for value in items {
                if let Some(text) = value.as_str() {
                    fields.push(text.to_string());
                }
            }
        }
        _ => {}
    }
    if let Some(note_text) = &note.note {
        fields.push(note_text.clone());
    }
    fields
}

fn extract_slug_from_snapshot_name(name: &str) -> Option<String> {
    let name = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".html"))?;
    let last_dash = name.rfind('-')?;
    let timestamp = &name[last_dash + 1..];
    if timestamp.len() == 13 && timestamp.chars().all(|char| char.is_ascii_digit()) {
        Some(name[..last_dash].to_string())
    } else {
        None
    }
}

/// Search a batch of JSONL files + their page markdown content.
pub fn search_batch<P1, P2, S>(
    history_dir: P1,
    pages_dir: P2,
    query: &str,
    file_names: &[S],
) -> io::Result<Vec<SearchResult>>
where
    P1: AsRef<Path>,
    P2: AsRef<Path>,
    S: AsRef<str>,
{
    let history_dir = history_dir.as_ref();
    let pages_dir = pages_dir.as_ref();

    let mut seen_urls = HashSet::new();
    let mut entries = Vec::new();

    for file_name in file_names {
        let path = history_dir.join(file_name.as_ref());
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(item) = serde_json::from_str::<HistoryData>(line) else {
                continue;
            };
            if seen_urls.insert(item.url.clone()) {
                entries.push(item);
            }
        }
    }

    let mut content_by_slug = HashMap::new();
    let slugs: HashSet<&str> = entries
        .iter()
        .filter_map(|entry| entry.slug.as_deref())
        .collect();
    for slug in slugs {
        if let Some(markdown) = read_latest_markdown(&pages_dir.join(slug))? {
            if !markdown.is_empty() {
                content_by_slug.insert(slug.to_string(), markdown);
            }
        }
    }

    let mut engine = SearchEngine::new();
    for entry in entries {
        let content = entry
            .slug
            .as_deref()
            .and_then(|slug| content_by_slug.get(slug))
            .cloned()
            .unwrap_or_default();
        let mut history_entry = HistoryEntry {
            timestamp: entry.timestamp,
            url: entry.url,
            title: entry.title,
            content: String::new(),
        };
        history_entry.set_content(content);
        engine.add_entry(history_entry);
    }

    Ok(engine.search(query, RankingAlgorithm::Content))
}

/// Search all note JSON files in a directory for query matches.
pub fn search_notes<P: AsRef<Path>>(notes_dir: P, query: &str) -> io::Result<Vec<NoteMatch>> {
    let Some(entries) = read_dir_if_exists(notes_dir.as_ref())? else {
        return Ok(Vec::new());
    };

    let words = parse_query_words(query);
    if words.is_empty() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(note) = serde_json::from_str::<NoteData>(&text) else {
            continue;
        };

        let fields = extract_note_fields(&note);
        let field_refs: Vec<&str> = fields.iter().map(String::as_str).collect();
        if fields.is_empty() || !words_match_fields(&words, &field_refs) {
            continue;
        }

        let Some(url) = note.url else {
            continue;
        };
        let note_slug = note
            .slug
            .unwrap_or_else(|| name.trim_end_matches(".json").to_string());
        matches.push(NoteMatch { url, note_slug });
    }

    Ok(matches)
}

/// Search a batch of snapshot markdown files for query matches.
pub fn search_snapshots<P: AsRef<Path>, S: AsRef<str>>(
    snapshots_dir: P,
    query: &str,
    file_names: &[S],
) -> io::Result<Vec<SnapshotMatch>> {
    let words = parse_query_words(query);
    if words.is_empty() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();
    for file_name in file_names {
        let file_name = file_name.as_ref();
        let Some(slug) = extract_slug_from_snapshot_name(file_name) else {
            continue;
        };
        let path = snapshots_dir.as_ref().join(file_name);
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        if words_match_fields(&words, &[&content]) {
            matches.push(SnapshotMatch { slug });
        }
    }

    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

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

    #[test]
    fn fuzzy_distance_thresholds() {
        assert_eq!(max_fuzzy_distance(1), None);
        assert_eq!(max_fuzzy_distance(2), None);
        assert_eq!(max_fuzzy_distance(3), Some(1));
        assert_eq!(max_fuzzy_distance(4), Some(1));
        assert_eq!(max_fuzzy_distance(5), Some(2));
        assert_eq!(max_fuzzy_distance(10), Some(2));
    }

    #[test]
    fn exact_quoted_match() {
        let word = QueryWord {
            text: "react".into(),
            exact: true,
        };
        assert!(matches!(
            word_match_quality(&word, "Learn React Today"),
            Some(MatchQuality::Exact)
        ));
        assert!(word_match_quality(&word, "reactivity is key").is_none());
    }

    #[test]
    fn substring_match() {
        let word = QueryWord {
            text: "reac".into(),
            exact: false,
        };
        assert!(matches!(
            word_match_quality(&word, "react hooks"),
            Some(MatchQuality::Exact)
        ));
    }

    #[test]
    fn fuzzy_match_typo() {
        let word = QueryWord {
            text: "raect".into(),
            exact: false,
        };
        match word_match_quality(&word, "react hooks tutorial") {
            Some(MatchQuality::Fuzzy(distance)) => assert!(distance <= 2),
            other => panic!("expected Fuzzy match, got {:?}", other),
        }
    }

    #[test]
    fn fuzzy_match_prefix_typo() {
        let word = QueryWord {
            text: "raect".into(),
            exact: false,
        };
        match word_match_quality(&word, "reactivity overview") {
            Some(MatchQuality::Fuzzy(distance)) => assert!(distance <= 2),
            other => panic!("expected Fuzzy match, got {:?}", other),
        }
    }

    #[test]
    fn no_fuzzy_for_short_words() {
        let word = QueryWord {
            text: "ab".into(),
            exact: false,
        };
        assert!(word_match_quality(&word, "xy zz").is_none());
    }

    #[test]
    fn fuzzy_too_distant() {
        let word = QueryWord {
            text: "react".into(),
            exact: false,
        };
        assert!(word_match_quality(&word, "python tutorial").is_none());
    }

    #[test]
    fn field_quality_all_exact() {
        let words = vec![
            QueryWord {
                text: "react".into(),
                exact: false,
            },
            QueryWord {
                text: "hooks".into(),
                exact: false,
            },
        ];
        let quality = field_match_quality(&words, "react hooks tutorial").unwrap();
        assert!((quality - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn field_quality_mixed() {
        let words = vec![
            QueryWord {
                text: "react".into(),
                exact: false,
            },
            QueryWord {
                text: "raect".into(),
                exact: false,
            },
        ];
        let quality = field_match_quality(&words, "react hooks tutorial").unwrap();
        assert!(quality < 1.0);
        assert!(quality > 0.0);
    }

    #[test]
    fn field_quality_none_when_word_misses() {
        let words = vec![
            QueryWord {
                text: "react".into(),
                exact: false,
            },
            QueryWord {
                text: "python".into(),
                exact: false,
            },
        ];
        assert!(field_match_quality(&words, "react hooks tutorial").is_none());
    }

    #[test]
    fn content_score_exact_title() {
        let entry = HistoryEntry {
            timestamp: 1,
            url: "https://example.com".into(),
            title: "React Hooks".into(),
            content: String::new(),
        };
        let words = vec![
            QueryWord {
                text: "react".into(),
                exact: false,
            },
            QueryWord {
                text: "hooks".into(),
                exact: false,
            },
        ];
        assert!((content_score(&entry, &words) - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn content_score_fuzzy_title() {
        let entry = HistoryEntry {
            timestamp: 1,
            url: "https://example.com".into(),
            title: "React Hooks".into(),
            content: String::new(),
        };
        let words = vec![QueryWord {
            text: "raect".into(),
            exact: false,
        }];
        let score = content_score(&entry, &words);
        assert!(score > 0.0);
        assert!(score < 2.0);
    }

    #[test]
    fn search_batch_dedupes_urls_and_reads_latest_markdown() {
        let temp_dir = tempdir().unwrap();
        let history_dir = temp_dir.path().join("logs");
        let pages_dir = temp_dir.path().join("pages");
        let page_slug_dir = pages_dir.join("example-article");
        fs::create_dir_all(&history_dir).unwrap();
        fs::create_dir_all(&page_slug_dir).unwrap();

        fs::write(
            history_dir.join("2026-04-18.jsonl"),
            [
                json!({
                    "timestamp": 200,
                    "url": "https://example.com/article",
                    "title": "Unread title",
                    "slug": "example-article"
                })
                .to_string(),
                json!({
                    "timestamp": 180,
                    "url": "https://example.com/other",
                    "title": "Other page"
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            history_dir.join("2026-04-17.jsonl"),
            json!({
                "timestamp": 100,
                "url": "https://example.com/article",
                "title": "Older duplicate",
                "slug": "example-article"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(page_slug_dir.join("100.md"), "stale content").unwrap();
        fs::write(
            page_slug_dir.join("200.md"),
            "banana match from markdown body",
        )
        .unwrap();

        let results = search_batch(
            &history_dir,
            &pages_dir,
            "banana",
            &["2026-04-18.jsonl", "2026-04-17.jsonl"],
        )
        .unwrap();

        assert_eq!(
            results,
            vec![SearchResult {
                url: "https://example.com/article".into(),
                title: "Unread title".into(),
                timestamp: 200,
                score: 1.0,
            }]
        );
    }

    #[test]
    fn search_notes_matches_excerpt_arrays_and_note_text() {
        let temp_dir = tempdir().unwrap();
        let notes_dir = temp_dir.path().join("notes");
        fs::create_dir_all(&notes_dir).unwrap();

        fs::write(
            notes_dir.join("react-note.json"),
            json!({
                "slug": "react-note",
                "url": "https://example.com/react",
                "excerpt": ["first match", "second excerpt"],
                "note": "Remember the batching caveat"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            notes_dir.join("other.json"),
            json!({
                "url": "https://example.com/other",
                "excerpt": "nothing relevant here"
            })
            .to_string(),
        )
        .unwrap();

        let results = search_notes(&notes_dir, "batching").unwrap();

        assert_eq!(
            results,
            vec![NoteMatch {
                url: "https://example.com/react".into(),
                note_slug: "react-note".into(),
            }]
        );
    }

    #[test]
    fn search_snapshots_returns_matching_slugs() {
        let temp_dir = tempdir().unwrap();
        let snapshots_dir = temp_dir.path().join("snapshots");
        fs::create_dir_all(&snapshots_dir).unwrap();

        fs::write(
            snapshots_dir.join("my-page-1709251200000.md"),
            "captured banana document",
        )
        .unwrap();
        fs::write(
            snapshots_dir.join("other-page-1709251200001.md"),
            "no match here",
        )
        .unwrap();

        let results = search_snapshots(
            &snapshots_dir,
            "banana",
            &["my-page-1709251200000.md", "other-page-1709251200001.md"],
        )
        .unwrap();

        assert_eq!(
            results,
            vec![SnapshotMatch {
                slug: "my-page".into()
            }]
        );
    }
}
