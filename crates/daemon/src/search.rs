use browser_recall::{
    search_batch, search_notes, search_records, search_snapshots, SearchRecord, SearchResult,
};
use serde::Deserialize;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchHit {
    pub url: String,
    pub title: String,
    pub timestamp: i64,
    pub score: f64,
}

impl From<SearchResult> for HistorySearchHit {
    fn from(result: SearchResult) -> Self {
        Self {
            url: result.url,
            title: result.title,
            timestamp: result.timestamp,
            score: result.score,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchHit {
    pub url: String,
    pub note_slug: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSearchHit {
    pub slug: String,
    pub timestamp: i64,
    pub score: f64,
}

pub const HISTORY_SEARCH_PARALLELISM: usize = 4;
const HISTORY_SEARCH_RECORDS_PER_TASK: usize = 4;

#[derive(Debug, Clone)]
pub struct HistorySearchChunk {
    pub worker_id: usize,
    pub results: Vec<HistorySearchHit>,
}

pub fn search_history_in_data_dir(
    data_dir: &Path,
    query: &str,
    limit: Option<usize>,
) -> io::Result<Vec<HistorySearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let logs_root = data_dir.join("logs");
    let pages_dir = data_dir.join("views").join("pages");
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
        merge_history_hits(&mut merged_by_url, results.into_iter().map(Into::into));
    }

    Ok(sorted_history_hits(merged_by_url, limit))
}

pub fn search_history_parallel_in_data_dir<F>(
    data_dir: &Path,
    query: &str,
    limit: Option<usize>,
    cancel: Arc<AtomicBool>,
    mut on_chunk: F,
) -> io::Result<Vec<HistorySearchHit>>
where
    F: FnMut(HistorySearchChunk) -> io::Result<()>,
{
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let logs_root = data_dir.join("logs");
    let pages_dir = data_dir.join("views").join("pages");
    if !logs_root.exists() {
        return Ok(Vec::new());
    }

    let mut tasks = Vec::new();
    for device_dir in list_subdirs(&logs_root)? {
        let records = latest_history_records_for_device(&device_dir)?;
        for chunk in records.chunks(HISTORY_SEARCH_RECORDS_PER_TASK) {
            tasks.push(chunk.to_vec());
        }
    }

    if tasks.is_empty() {
        return Ok(Vec::new());
    }

    let worker_count = HISTORY_SEARCH_PARALLELISM.min(tasks.len());
    let mut worker_tasks = vec![Vec::new(); worker_count];
    for (index, task) in tasks.into_iter().enumerate() {
        worker_tasks[index % worker_count].push(task);
    }

    let (tx, rx) = mpsc::channel();
    thread::scope(|scope| {
        for (worker_id, tasks) in worker_tasks.into_iter().enumerate() {
            let tx = tx.clone();
            let pages_dir = pages_dir.clone();
            let query = query.to_string();
            let cancel = Arc::clone(&cancel);
            scope.spawn(move || {
                for task in tasks {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let result = search_records(&pages_dir, &query, task).map(|results| {
                        HistorySearchChunk {
                            worker_id,
                            results: results.into_iter().map(Into::into).collect(),
                        }
                    });
                    if tx.send(result).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);

        let mut merged_by_url: HashMap<String, HistorySearchHit> = HashMap::new();
        for result in rx {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let chunk = result?;
            if chunk.results.is_empty() {
                continue;
            }
            merge_history_hits(&mut merged_by_url, chunk.results.iter().cloned());
            if limit.is_none() {
                on_chunk(chunk)?;
            }
        }

        let hits = sorted_history_hits(merged_by_url, limit);
        if limit.is_some() && !cancel.load(Ordering::Relaxed) && !hits.is_empty() {
            on_chunk(HistorySearchChunk {
                worker_id: 0,
                results: hits.clone(),
            })?;
        }
        Ok(hits)
    })
}

pub fn search_notes_in_data_dir(
    data_dir: &Path,
    query: &str,
    limit: Option<usize>,
) -> io::Result<Vec<NoteSearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let notes_dir = data_dir.join("objects").join("notes");
    let hits = search_notes(&notes_dir, query)?
        .into_iter()
        .map(|hit| NoteSearchHit {
            url: hit.url,
            note_slug: hit.note_slug,
            score: hit.score,
        })
        .collect();
    Ok(truncate_to_limit(hits, limit))
}

pub fn search_snapshots_in_data_dir(
    data_dir: &Path,
    query: &str,
    limit: Option<usize>,
) -> io::Result<Vec<SnapshotSearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let snapshots_dir = data_dir.join("objects").join("snapshots");
    if !snapshots_dir.exists() {
        return Ok(Vec::new());
    }

    let file_names = list_snapshot_files(&snapshots_dir)?;
    let hits = search_snapshots(&snapshots_dir, query, &file_names)?
        .into_iter()
        .map(|hit| SnapshotSearchHit {
            slug: hit.slug,
            timestamp: hit.timestamp,
            score: hit.score,
        })
        .collect();
    Ok(truncate_to_limit(hits, limit))
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

#[derive(Debug, Deserialize)]
struct RawHistoryRecord {
    timestamp: i64,
    url: String,
    title: String,
    #[serde(default)]
    slug: Option<String>,
}

fn latest_history_records_for_device(device_dir: &Path) -> io::Result<Vec<SearchRecord>> {
    let file_names = list_jsonl_files(device_dir)?;
    let mut seen_urls = HashSet::new();
    let mut records = Vec::new();

    for file_name in file_names {
        let path = device_dir.join(file_name);
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(item) = serde_json::from_str::<RawHistoryRecord>(line) else {
                continue;
            };
            if seen_urls.insert(item.url.clone()) {
                records.push(SearchRecord {
                    timestamp: item.timestamp,
                    url: item.url,
                    title: item.title,
                    user_title: None,
                    slug: item.slug,
                });
            }
        }
    }

    Ok(records)
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
    collect_snapshot_files(dir, dir, &mut files_by_stem)?;
    let mut files: Vec<_> = files_by_stem.into_values().collect();
    files.sort();
    Ok(files)
}

fn collect_snapshot_files(
    root: &Path,
    dir: &Path,
    files_by_stem: &mut HashMap<String, String>,
) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.is_dir() {
            collect_snapshot_files(root, &path, files_by_stem)?;
            continue;
        }
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
        let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
        match files_by_stem.get(stem) {
            Some(existing) if existing.ends_with(".md") => {}
            _ => {
                files_by_stem.insert(stem.to_string(), relative.to_string());
            }
        }
    }
    Ok(())
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

fn merge_history_hits(
    merged_by_url: &mut HashMap<String, HistorySearchHit>,
    hits: impl IntoIterator<Item = HistorySearchHit>,
) {
    for hit in hits {
        match merged_by_url.get_mut(&hit.url) {
            Some(existing) => merge_history_hit(existing, hit),
            None => {
                merged_by_url.insert(hit.url.clone(), hit);
            }
        }
    }
}

fn sorted_history_hits(
    merged_by_url: HashMap<String, HistorySearchHit>,
    limit: Option<usize>,
) -> Vec<HistorySearchHit> {
    let mut hits: Vec<_> = merged_by_url.into_values().collect();
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.timestamp.cmp(&left.timestamp))
            .then_with(|| left.url.cmp(&right.url))
    });
    truncate_to_limit(hits, limit)
}

fn truncate_to_limit<T>(mut items: Vec<T>, limit: Option<usize>) -> Vec<T> {
    if let Some(limit) = limit {
        items.truncate(limit);
    }
    items
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
        let device_a = data_dir.join("logs/device-a");
        let device_b = data_dir.join("logs/device-b");
        let page_a = data_dir.join("views/pages/example-article");
        let page_b = data_dir.join("views/pages/second-article");
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

        let hits = search_history_in_data_dir(data_dir, "Article", Some(1)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/article");
        assert_eq!(hits[0].timestamp, 200);
    }

    #[test]
    fn search_history_parallel_matches_sequential_results() {
        let temp_dir = tempdir().unwrap();
        let data_dir = temp_dir.path();
        let device_a = data_dir.join("logs/device-a");
        let device_b = data_dir.join("logs/device-b");
        fs::create_dir_all(&device_a).unwrap();
        fs::create_dir_all(&device_b).unwrap();
        fs::create_dir_all(data_dir.join("views/pages")).unwrap();

        for index in 0..6 {
            let url = format!("https://example.com/parallel-{index}");
            let slug = format!("parallel-{index}");
            let target = if index % 2 == 0 { &device_a } else { &device_b };
            fs::write(
                target.join(format!("2026-04-{:02}.jsonl", index + 1)),
                json!({
                    "timestamp": 1000 + index,
                    "url": url,
                    "title": format!("Parallel banana {index}"),
                    "slug": slug,
                })
                .to_string(),
            )
            .unwrap();
        }

        let sequential = search_history_in_data_dir(data_dir, "banana", None).unwrap();
        let mut chunks = Vec::new();
        let parallel = search_history_parallel_in_data_dir(
            data_dir,
            "banana",
            None,
            Arc::new(AtomicBool::new(false)),
            |chunk| {
                chunks.push(chunk);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(parallel, sequential);
        assert!(!chunks.is_empty());
    }

    #[test]
    fn search_history_parallel_suppresses_older_duplicate_urls_before_search() {
        let temp_dir = tempdir().unwrap();
        let data_dir = temp_dir.path();
        let device = data_dir.join("logs/device-a");
        fs::create_dir_all(&device).unwrap();
        fs::create_dir_all(data_dir.join("views/pages")).unwrap();

        fs::write(
            device.join("2026-04-19.jsonl"),
            json!({
                "timestamp": 200,
                "url": "https://example.com/duplicate",
                "title": "Newest title without match",
                "slug": "duplicate",
            })
            .to_string(),
        )
        .unwrap();
        for index in 0..3 {
            fs::write(
                device.join(format!("2026-04-1{index}.jsonl")),
                json!({
                    "timestamp": 150 - index,
                    "url": format!("https://example.com/filler-{index}"),
                    "title": format!("Filler {index}"),
                    "slug": format!("filler-{index}"),
                })
                .to_string(),
            )
            .unwrap();
        }
        fs::write(
            device.join("2026-04-09.jsonl"),
            json!({
                "timestamp": 100,
                "url": "https://example.com/duplicate",
                "title": "Older needle title",
                "slug": "duplicate",
            })
            .to_string(),
        )
        .unwrap();

        let sequential = search_history_in_data_dir(data_dir, "needle", None).unwrap();
        let parallel = search_history_parallel_in_data_dir(
            data_dir,
            "needle",
            None,
            Arc::new(AtomicBool::new(false)),
            |_| Ok(()),
        )
        .unwrap();

        assert!(sequential.is_empty());
        assert!(parallel.is_empty());
    }

    #[test]
    fn search_history_parallel_emits_only_limited_final_chunk_when_limited() {
        let temp_dir = tempdir().unwrap();
        let data_dir = temp_dir.path();
        let device = data_dir.join("logs/device-a");
        fs::create_dir_all(&device).unwrap();
        fs::create_dir_all(data_dir.join("views/pages")).unwrap();

        for index in 0..6 {
            fs::write(
                device.join(format!("2026-04-{:02}.jsonl", index + 1)),
                json!({
                    "timestamp": 1000 + index,
                    "url": format!("https://example.com/limited-{index}"),
                    "title": format!("Limited needle {index}"),
                    "slug": format!("limited-{index}"),
                })
                .to_string(),
            )
            .unwrap();
        }

        let mut chunks = Vec::new();
        let hits = search_history_parallel_in_data_dir(
            data_dir,
            "needle",
            Some(2),
            Arc::new(AtomicBool::new(false)),
            |chunk| {
                chunks.push(chunk);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].results, hits);
    }

    #[test]
    fn search_history_parallel_honors_pre_cancelled_token() {
        let temp_dir = tempdir().unwrap();
        let data_dir = temp_dir.path();
        let device = data_dir.join("logs/device-a");
        fs::create_dir_all(&device).unwrap();
        fs::write(
            device.join("2026-04-18.jsonl"),
            json!({
                "timestamp": 100,
                "url": "https://example.com/cancelled",
                "title": "Cancelled banana",
                "slug": "cancelled",
            })
            .to_string(),
        )
        .unwrap();

        let cancel = Arc::new(AtomicBool::new(true));
        let mut chunks = Vec::new();
        let hits = search_history_parallel_in_data_dir(data_dir, "banana", None, cancel, |chunk| {
            chunks.push(chunk);
            Ok(())
        })
        .unwrap();

        assert!(hits.is_empty());
        assert!(chunks.is_empty());
    }

    #[test]
    fn search_notes_in_data_dir_reads_note_directory() {
        let temp_dir = tempdir().unwrap();
        let notes_dir = temp_dir.path().join("objects/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        fs::write(
            notes_dir.join("note-a.json"),
            json!({
                "slug": "note-a",
                "url": "https://example.com/article",
                "excerpt": ["banana excerpt"]
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
                score: 1.0,
            }]
        );
    }

    #[test]
    fn search_snapshots_in_data_dir_reads_snapshot_directory() {
        let temp_dir = tempdir().unwrap();
        let snapshots_dir = temp_dir.path().join("objects/snapshots/aa");
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
                timestamp: 1_709_251_200_000,
                score: 1.0,
            }]
        );
    }

    #[test]
    fn search_snapshots_in_data_dir_falls_back_to_html_files() {
        let temp_dir = tempdir().unwrap();
        let snapshots_dir = temp_dir.path().join("objects/snapshots/aa");
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
                timestamp: 1_709_251_200_000,
                score: 1.0,
            }]
        );
    }
}
