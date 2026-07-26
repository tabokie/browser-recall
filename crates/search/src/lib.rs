#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

use browser_recall_replay::entities::{NoteEntity, PageEntity};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Represents a history entry (webpage visit, document read, etc.)
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HistoryEntry {
    pub timestamp: i64,
    pub url: String,
    pub title: Option<String>,
    pub user_title: Option<String>,
    pub content: String,
}

impl HistoryEntry {
    pub fn new(url: String, title: String) -> io::Result<Self> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| {
                io::Error::other(format!("system clock is before UNIX epoch: {error}"))
            })?
            .as_millis();
        let timestamp = i64::try_from(timestamp)
            .map_err(|_| io::Error::other("system timestamp exceeds i64 milliseconds"))?;
        Ok(Self {
            timestamp,
            url,
            title: Some(title),
            user_title: None,
            content: String::new(),
        })
    }

    pub fn set_content(&mut self, content: String) {
        self.content = content;
    }
}

/// A single search result with its relevance score.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchResult {
    pub url: String,
    pub title: Option<String>,
    pub timestamp: i64,
    pub score: f64,
}

/// Deduplicated history record prepared by a storage/query adapter.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchRecord {
    pub timestamp: i64,
    pub url: String,
    pub title: Option<String>,
    pub user_title: Option<String>,
    pub slug: Option<String>,
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
            .filter_map(|entry| {
                let score = identity_score_opt(entry, &words)?;
                Some(SearchResult {
                    url: entry.url.clone(),
                    title: entry.title.clone(),
                    timestamp: entry.timestamp,
                    score,
                })
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
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteMatch {
    pub url: String,
    #[serde(rename = "noteSlug")]
    pub note_slug: String,
    pub score: f64,
}

/// Search a batch of snapshot files for query matches.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SnapshotMatch {
    pub slug: String,
    pub timestamp: i64,
    pub score: f64,
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

#[cfg(test)]
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

fn match_quality_score(quality: MatchQuality) -> f64 {
    match quality {
        MatchQuality::Exact => 1.0,
        MatchQuality::Fuzzy(distance) => (1.0 - distance as f64 * 0.3).max(0.1),
    }
}

fn weighted_fields_score(words: &[QueryWord], fields: &[(&str, f64)]) -> Option<f64> {
    if words.is_empty() {
        return None;
    }

    let mut total = 0.0;
    for word in words {
        let mut best: Option<f64> = None;
        for (field, weight) in fields {
            if *weight <= 0.0 {
                continue;
            }
            if let Some(quality) = word_match_quality(word, field) {
                let score = *weight * match_quality_score(quality);
                best = Some(best.map_or(score, |current| current.max(score)));
            }
        }
        total += best?;
    }

    Some(total / words.len() as f64)
}

fn identity_score_opt(entry: &HistoryEntry, words: &[QueryWord]) -> Option<f64> {
    weighted_fields_score(
        words,
        &[
            (entry.title.as_deref().unwrap_or_default(), 2.0),
            (entry.user_title.as_deref().unwrap_or_default(), 2.0),
            (&entry.url, 0.5),
        ],
    )
}

#[cfg(test)]
fn identity_score(entry: &HistoryEntry, words: &[QueryWord]) -> f64 {
    identity_score_opt(entry, words).unwrap_or(0.0)
}

fn extract_note_fields(note: &NoteEntity) -> io::Result<Vec<String>> {
    let mut fields = Vec::new();
    match &note.excerpt {
        Some(Value::Array(items)) => {
            for value in items {
                let text = value.as_str().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("note {} excerpt must contain strings only", note.slug),
                    )
                })?;
                fields.push(text.to_string());
            }
        }
        None => {}
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("note {} excerpt must be a string array", note.slug),
            ))
        }
    }
    if let Some(note_text) = &note.note {
        fields.push(note_text.clone());
    }
    Ok(fields)
}

fn shard_for(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{:02x}", digest[0])
}

fn read_page_user_title(pages_dir: &Path, slug: &str) -> io::Result<Option<String>> {
    let path = pages_dir.join(shard_for(slug)).join(format!("{slug}.json"));
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let page: PageEntity = serde_json::from_str(&text).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid page checkpoint: {error}"),
        )
    })?;
    Ok(page.user_title.filter(|title| !title.trim().is_empty()))
}

fn extract_snapshot_parts_from_name(name: &str) -> io::Result<(String, i64)> {
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("snapshot path must be relative and traversal-free: {name}"),
        ));
    }
    let components: Vec<_> = path.components().collect();
    if components.len() != 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("snapshot path must be <shard>/<file>: {name}"),
        ));
    }
    if let [std::path::Component::Normal(shard), _] = components.as_slice() {
        let shard = shard.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "snapshot shard is not UTF-8")
        })?;
        if shard.len() != 2 || !shard.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("snapshot shard must be two hexadecimal characters: {shard}"),
            ));
        }
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "snapshot filename is not UTF-8")
        })?;
    let name = file_name.strip_suffix(".md").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("snapshot search filename must end in .md: {name}"),
        )
    })?;
    let last_dash = name.rfind('-').ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("snapshot filename is missing timestamp: {name}"),
        )
    })?;
    if last_dash == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("snapshot filename is missing slug: {name}"),
        ));
    }
    let timestamp = &name[last_dash + 1..];
    if timestamp.len() == 13 && timestamp.chars().all(|char| char.is_ascii_digit()) {
        Ok((
            name[..last_dash].to_string(),
            timestamp.parse().map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid snapshot timestamp in {name}: {error}"),
                )
            })?,
        ))
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("snapshot filename must end with a 13-digit timestamp: {name}"),
        ))
    }
}

/// Search prepared history records by title, user title, and URL.
pub fn search_records<P>(
    pages_dir: P,
    query: &str,
    records: Vec<SearchRecord>,
) -> io::Result<Vec<SearchResult>>
where
    P: AsRef<Path>,
{
    let pages_dir = pages_dir.as_ref();
    let mut engine = SearchEngine::new();
    for entry in records {
        let user_title = match entry.user_title {
            Some(user_title) if !user_title.trim().is_empty() => Some(user_title),
            _ => entry
                .slug
                .as_deref()
                .map(|slug| read_page_user_title(pages_dir, slug))
                .transpose()?
                .flatten(),
        };
        let history_entry = HistoryEntry {
            timestamp: entry.timestamp,
            url: entry.url,
            title: entry.title,
            user_title,
            content: String::new(),
        };
        engine.add_entry(history_entry);
    }

    Ok(engine.search(query, RankingAlgorithm::Content))
}

/// Search all note JSON files in a directory for query matches.
pub fn search_notes<P: AsRef<Path>>(notes_dir: P, query: &str) -> io::Result<Vec<NoteMatch>> {
    let entries = fs::read_dir(notes_dir.as_ref())?;
    let mut notes = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension() != Some(std::ffi::OsStr::new("json")) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "note filename is not UTF-8")
            })?;
        let text = fs::read_to_string(&path)?;
        let note = serde_json::from_str::<NoteEntity>(&text).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid note checkpoint {}: {error}", path.display()),
            )
        })?;
        let filename_slug = name.trim_end_matches(".json");
        if note.slug != filename_slug {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "note checkpoint filename {filename_slug} does not match entity slug {}",
                    note.slug
                ),
            ));
        }
        notes.push(note);
    }

    search_note_entities(notes, query)
}

/// Search note entities for query matches.
pub fn search_note_entities(
    notes: impl IntoIterator<Item = NoteEntity>,
    query: &str,
) -> io::Result<Vec<NoteMatch>> {
    let words = parse_query_words(query);
    if words.is_empty() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();
    for note in notes {
        if note.deleted {
            continue;
        }
        let url = note
            .url
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("active note {} is missing its URL", note.slug),
                )
            })?;

        let fields = extract_note_fields(&note)?;
        let field_refs: Vec<(&str, f64)> =
            fields.iter().map(|field| (field.as_str(), 1.0)).collect();
        let Some(score) = weighted_fields_score(&words, &field_refs) else {
            continue;
        };

        matches.push(NoteMatch {
            url,
            note_slug: note.slug,
            score,
        });
    }

    Ok(matches)
}

/// Search a batch of snapshot files for query matches.
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
        let (slug, timestamp) = extract_snapshot_parts_from_name(file_name)?;
        let path = snapshots_dir.as_ref().join(file_name);
        let content = fs::read_to_string(path)?;
        if let Some(score) = weighted_fields_score(&words, &[(&content, 1.0)]) {
            matches.push(SnapshotMatch {
                slug,
                timestamp,
                score,
            });
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
    fn identity_score_exact_title() {
        let entry = HistoryEntry {
            timestamp: 1,
            url: "https://example.com".into(),
            title: Some("React Hooks".into()),
            user_title: None,
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
        assert!((identity_score(&entry, &words) - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn identity_score_fuzzy_title() {
        let entry = HistoryEntry {
            timestamp: 1,
            url: "https://example.com".into(),
            title: Some("React Hooks".into()),
            user_title: None,
            content: String::new(),
        };
        let words = vec![QueryWord {
            text: "raect".into(),
            exact: false,
        }];
        let score = identity_score(&entry, &words);
        assert!(score > 0.0);
        assert!(score < 2.0);
    }

    #[test]
    fn identity_score_distributes_words_across_identity_fields() {
        let entry = HistoryEntry {
            timestamp: 1,
            url: "https://example.com/research".into(),
            title: Some("React Hooks".into()),
            user_title: Some("Custom name".into()),
            content: String::new(),
        };
        let words = vec![
            QueryWord {
                text: "react".into(),
                exact: false,
            },
            QueryWord {
                text: "research".into(),
                exact: false,
            },
        ];

        assert!((identity_score(&entry, &words) - 1.25).abs() < f64::EPSILON);
    }

    #[test]
    fn search_records_matches_user_title_and_url() {
        let temp_dir = tempdir().unwrap();
        let results = search_records(
            temp_dir.path(),
            "custom",
            vec![SearchRecord {
                timestamp: 200,
                url: "https://example.com/plain".into(),
                title: Some("Original title".into()),
                user_title: Some("Custom title".into()),
                slug: None,
            }],
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://example.com/plain");

        let results = search_records(
            temp_dir.path(),
            "url-needle",
            vec![SearchRecord {
                timestamp: 200,
                url: "https://example.com/url-needle".into(),
                title: Some("Original title".into()),
                user_title: None,
                slug: None,
            }],
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://example.com/url-needle");
    }

    #[test]
    fn search_records_matches_page_checkpoint_user_title() {
        let temp_dir = tempdir().unwrap();
        let pages_dir = temp_dir.path().join("pages");
        let slug = "renamed-page";
        let page_dir = pages_dir.join(shard_for(slug));
        fs::create_dir_all(&page_dir).unwrap();
        let mut page = PageEntity::new(slug.to_string());
        page.url = Some("https://example.com/renamed".to_string());
        page.title = Some("Original title".to_string());
        page.user_title = Some("Custom banana title".to_string());
        fs::write(
            page_dir.join(format!("{slug}.json")),
            serde_json::to_string(&page).unwrap(),
        )
        .unwrap();

        let results = search_records(
            &pages_dir,
            "banana",
            vec![SearchRecord {
                timestamp: 200,
                url: "https://example.com/renamed".into(),
                title: Some("Original title".into()),
                user_title: None,
                slug: Some(slug.into()),
            }],
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://example.com/renamed");
    }

    #[test]
    fn search_notes_matches_excerpt_arrays_and_note_text() {
        let temp_dir = tempdir().unwrap();
        let notes_dir = temp_dir.path().join("notes");
        fs::create_dir_all(&notes_dir).unwrap();

        let mut react_note = NoteEntity::new("react-note".to_string());
        react_note.url = Some("https://example.com/react".to_string());
        react_note.excerpt = Some(json!(["first match", "second excerpt"]));
        react_note.css_path = Some(json!(["body > p", "body > p"]));
        react_note.note = Some("Remember the batching caveat".to_string());
        fs::write(
            notes_dir.join("react-note.json"),
            serde_json::to_string(&react_note).unwrap(),
        )
        .unwrap();
        let mut other_note = NoteEntity::new("other".to_string());
        other_note.url = Some("https://example.com/other".to_string());
        other_note.excerpt = Some(json!(["nothing relevant here"]));
        other_note.css_path = Some(json!(["body > p"]));
        fs::write(
            notes_dir.join("other.json"),
            serde_json::to_string(&other_note).unwrap(),
        )
        .unwrap();

        let results = search_notes(&notes_dir, "first batching").unwrap();

        assert_eq!(
            results,
            vec![NoteMatch {
                url: "https://example.com/react".into(),
                note_slug: "react-note".into(),
                score: 1.0,
            }]
        );
    }

    #[test]
    fn search_snapshots_returns_matching_slugs() {
        let temp_dir = tempdir().unwrap();
        let snapshots_dir = temp_dir.path().join("snapshots");
        fs::create_dir_all(snapshots_dir.join("aa")).unwrap();

        fs::write(
            snapshots_dir.join("aa/my-page-1709251200000.md"),
            "captured banana document",
        )
        .unwrap();
        fs::write(
            snapshots_dir.join("aa/other-page-1709251200001.md"),
            "no match here",
        )
        .unwrap();

        let results = search_snapshots(
            &snapshots_dir,
            "banana",
            &[
                "aa/my-page-1709251200000.md",
                "aa/other-page-1709251200001.md",
            ],
        )
        .unwrap();

        assert_eq!(
            results,
            vec![SnapshotMatch {
                slug: "my-page".into(),
                timestamp: 1_709_251_200_000,
                score: 1.0,
            }]
        );
    }
}
