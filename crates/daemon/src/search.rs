use browser_recall::{search_batch, search_notes, search_snapshots};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchHit {
    pub url: String,
    pub title: String,
    pub timestamp: i64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchHit {
    pub url: String,
    pub note_slug: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSearchHit {
    pub slug: String,
}

pub fn search_history_in_data_dir(
    data_dir: &Path,
    query: &str,
    limit: Option<usize>,
) -> io::Result<Vec<HistorySearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let logs_root = data_dir.join("data").join("logs");
    let pages_dir = data_dir.join("pages");
    if !logs_root.exists() {
        return Ok(Vec::new());
    }

    let mut merged_by_url: HashMap<String, HistorySearchHit> = HashMap::new();
    for device_dir in list_subdirs(&logs_root)? {
        let file_names = list_jsonl_files(&device_dir)?;
        if file_names.is_empty() {
            continue;
        }
        let results = search_batch(&device_dir, &pages_dir, query, &file_names)?;
        for result in results {
            let next = HistorySearchHit {
                url: result.url.clone(),
                title: result.title,
                timestamp: result.timestamp,
                score: result.score,
            };
            match merged_by_url.get_mut(&result.url) {
                Some(existing) => merge_history_hit(existing, next),
                None => {
                    merged_by_url.insert(result.url, next);
                }
            }
        }
    }

    let mut hits: Vec<_> = merged_by_url.into_values().collect();
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.timestamp.cmp(&left.timestamp))
            .then_with(|| left.url.cmp(&right.url))
    });
    apply_limit(hits, limit)
}

pub fn search_notes_in_data_dir(
    data_dir: &Path,
    query: &str,
    limit: Option<usize>,
) -> io::Result<Vec<NoteSearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let notes_dir = data_dir.join("data").join("notes");
    let hits = search_notes(&notes_dir, query)?
        .into_iter()
        .map(|hit| NoteSearchHit {
            url: hit.url,
            note_slug: hit.note_slug,
        })
        .collect();
    apply_limit(hits, limit)
}

pub fn search_snapshots_in_data_dir(
    data_dir: &Path,
    query: &str,
    limit: Option<usize>,
) -> io::Result<Vec<SnapshotSearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let snapshots_dir = data_dir.join("data").join("snapshots");
    if !snapshots_dir.exists() {
        return Ok(Vec::new());
    }

    let file_names = list_snapshot_files(&snapshots_dir)?;
    let hits = search_snapshots(&snapshots_dir, query, &file_names)?
        .into_iter()
        .map(|hit| SnapshotSearchHit { slug: hit.slug })
        .collect();
    apply_limit(hits, limit)
}

fn list_subdirs(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    for entry in fs::read_dir(root)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    Ok(dirs)
}

fn list_jsonl_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
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
        if name.ends_with(".jsonl") {
            files.push(name.to_string());
        }
    }
    files.sort();
    files.reverse();
    Ok(files)
}

fn list_snapshot_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut files_by_stem: HashMap<String, String> = HashMap::new();
    for entry in fs::read_dir(dir)? {
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
        if !(name.ends_with(".md") || name.ends_with(".html")) {
            continue;
        }
        let stem = name
            .strip_suffix(".md")
            .or_else(|| name.strip_suffix(".html"))
            .unwrap_or(name);
        match files_by_stem.get(stem) {
            Some(existing) if existing.ends_with(".md") => {}
            _ => {
                files_by_stem.insert(stem.to_string(), name.to_string());
            }
        }
    }
    let mut files: Vec<_> = files_by_stem.into_values().collect();
    files.sort();
    Ok(files)
}

fn merge_history_hit(existing: &mut HistorySearchHit, next: HistorySearchHit) {
    if next.score > existing.score
        || (next.score == existing.score && next.timestamp > existing.timestamp)
    {
        *existing = next;
        return;
    }

    if next.timestamp > existing.timestamp {
        existing.timestamp = next.timestamp;
        if existing.title.is_empty() && !next.title.is_empty() {
            existing.title = next.title;
        }
    }
}

fn apply_limit<T>(mut items: Vec<T>, limit: Option<usize>) -> io::Result<Vec<T>> {
    if let Some(limit) = limit {
        items.truncate(limit);
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn search_history_in_data_dir_merges_devices_and_applies_limit() {
        let temp_dir = tempdir().unwrap();
        let data_dir = temp_dir.path();
        let device_a = data_dir.join("data/logs/device-a");
        let device_b = data_dir.join("data/logs/device-b");
        let page_a = data_dir.join("pages/example-article");
        let page_b = data_dir.join("pages/second-article");
        fs::create_dir_all(&device_a).unwrap();
        fs::create_dir_all(&device_b).unwrap();
        fs::create_dir_all(&page_a).unwrap();
        fs::create_dir_all(&page_b).unwrap();

        fs::write(
            device_a.join("2026-04-18.jsonl"),
            json!({
                "timestamp": 100,
                "url": "https://example.com/article",
                "title": "Article A",
                "slug": "example-article"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            device_b.join("2026-04-18.jsonl"),
            [
                json!({
                    "timestamp": 200,
                    "url": "https://example.com/article",
                    "title": "Article A newer",
                    "slug": "example-article"
                })
                .to_string(),
                json!({
                    "timestamp": 150,
                    "url": "https://example.com/second",
                    "title": "Article B",
                    "slug": "second-article"
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(page_a.join("100.md"), "banana body match").unwrap();
        fs::write(page_b.join("100.md"), "banana second match").unwrap();

        let hits = search_history_in_data_dir(data_dir, "banana", Some(1)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/article");
        assert_eq!(hits[0].timestamp, 200);
    }

    #[test]
    fn search_notes_in_data_dir_reads_note_directory() {
        let temp_dir = tempdir().unwrap();
        let notes_dir = temp_dir.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        fs::write(
            notes_dir.join("note-a.json"),
            json!({
                "slug": "note-a",
                "url": "https://example.com/article",
                "excerpt": "banana excerpt"
            })
            .to_string(),
        )
        .unwrap();

        let hits = search_notes_in_data_dir(temp_dir.path(), "banana", None).unwrap();

        assert_eq!(
            hits,
            vec![NoteSearchHit {
                url: "https://example.com/article".into(),
                note_slug: "note-a".into(),
            }]
        );
    }

    #[test]
    fn search_snapshots_in_data_dir_reads_snapshot_directory() {
        let temp_dir = tempdir().unwrap();
        let snapshots_dir = temp_dir.path().join("data/snapshots");
        fs::create_dir_all(&snapshots_dir).unwrap();
        fs::write(
            snapshots_dir.join("my-page-1709251200000.md"),
            "banana snapshot",
        )
        .unwrap();

        let hits = search_snapshots_in_data_dir(temp_dir.path(), "banana", None).unwrap();

        assert_eq!(
            hits,
            vec![SnapshotSearchHit {
                slug: "my-page".into(),
            }]
        );
    }

    #[test]
    fn search_snapshots_in_data_dir_falls_back_to_html_files() {
        let temp_dir = tempdir().unwrap();
        let snapshots_dir = temp_dir.path().join("data/snapshots");
        fs::create_dir_all(&snapshots_dir).unwrap();
        fs::write(
            snapshots_dir.join("my-page-1709251200000.html"),
            "<html><body>banana snapshot</body></html>",
        )
        .unwrap();

        let hits = search_snapshots_in_data_dir(temp_dir.path(), "banana", None).unwrap();

        assert_eq!(
            hits,
            vec![SnapshotSearchHit {
                slug: "my-page".into(),
            }]
        );
    }
}
