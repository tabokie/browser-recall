use crate::storage::Storage;
use browser_recall::{
    search_note_entities, search_notes, search_records, search_snapshots, SearchRecord,
    SearchResult,
};
use browser_recall_replay::LogEntry;
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
    pub title: Option<String>,
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
    require_directory(&logs_root, "history log")?;

    let mut merged_by_url: HashMap<String, HistorySearchHit> = HashMap::new();
    for device_dir in list_subdirs(&logs_root)? {
        let records = latest_history_records_for_device(&device_dir)?;
        if records.is_empty() {
            continue;
        }
        let results = search_records(&pages_dir, query, records)?;
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
    require_directory(&logs_root, "history log")?;

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
    require_directory(&notes_dir, "note object")?;
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

pub async fn search_notes_in_storage(
    storage: &Storage,
    query: &str,
    limit: Option<usize>,
) -> io::Result<Vec<NoteSearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let hits = search_note_entities(storage.load_all_notes().await?.into_values(), query)?
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
    require_directory(&snapshots_dir, "snapshot object")?;

    let file_names = list_snapshot_markdown_files(&snapshots_dir)?;
    let mut hits_by_snapshot = HashMap::new();
    for hit in search_snapshots(&snapshots_dir, query, &file_names)? {
        let key = (hit.slug.clone(), hit.timestamp);
        hits_by_snapshot
            .entry(key)
            .and_modify(|score: &mut f64| *score = score.max(hit.score))
            .or_insert(hit.score);
    }
    let mut hits = hits_by_snapshot
        .into_iter()
        .map(|((slug, timestamp), score)| SnapshotSearchHit {
            slug,
            timestamp,
            score,
        })
        .collect::<Vec<_>>();
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.timestamp.cmp(&left.timestamp))
            .then_with(|| left.slug.cmp(&right.slug))
    });
    Ok(truncate_to_limit(hits, limit))
}

fn list_subdirs(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    Ok(dirs)
}

fn latest_history_records_for_device(device_dir: &Path) -> io::Result<Vec<SearchRecord>> {
    let file_names = list_jsonl_files(device_dir)?;
    let mut seen_urls = HashSet::new();
    let mut records = Vec::new();

    for file_name in file_names {
        let path = device_dir.join(file_name);
        let text = fs::read_to_string(&path)?;
        for (line_index, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} line {} is blank; JSONL records must be canonical entries",
                        path.display(),
                        line_index + 1
                    ),
                ));
            }
            let item = serde_json::from_str::<LogEntry>(line).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} line {} is not a canonical log entry: {error}",
                        path.display(),
                        line_index + 1
                    ),
                )
            })?;
            let (timestamp, url, title) = match item {
                LogEntry::VisitPage {
                    timestamp,
                    url,
                    title,
                    ..
                }
                | LogEntry::LeavePage {
                    timestamp,
                    url,
                    title,
                    ..
                } => (timestamp, url, title),
                _ => continue,
            };
            if seen_urls.insert(url.clone()) {
                records.push(SearchRecord {
                    timestamp,
                    url,
                    title,
                    user_title: None,
                    slug: None,
                });
            }
        }
    }

    Ok(records)
}

fn list_jsonl_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        if path.extension() != Some(std::ffi::OsStr::new("jsonl")) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "log filename is not UTF-8")
            })?;
        validate_log_filename(name)?;
        files.push(name.to_string());
    }
    files.sort();
    files.reverse();
    Ok(files)
}

fn list_snapshot_markdown_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let shard = entry.file_name();
        let Some(shard) = shard.to_str() else {
            continue;
        };
        if shard.len() != 2 || !shard.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        for sidecar in fs::read_dir(entry.path())? {
            let sidecar = sidecar?;
            if !sidecar.file_type()?.is_file()
                || sidecar.path().extension() != Some(std::ffi::OsStr::new("md"))
            {
                continue;
            }
            let name = sidecar.file_name();
            let name = name.to_str().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "snapshot Markdown filename is not UTF-8",
                )
            })?;
            files.push(format!("{shard}/{name}"));
        }
    }
    files.sort();
    Ok(files)
}

fn require_directory(path: &Path, kind: &str) -> io::Result<()> {
    let metadata = fs::metadata(path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "{kind} directory {} is unavailable: {error}",
                path.display()
            ),
        )
    })?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{kind} path is not a directory: {}", path.display()),
        ));
    }
    Ok(())
}

fn validate_log_filename(name: &str) -> io::Result<()> {
    let date = name.strip_suffix(".jsonl").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected non-JSONL history file: {name}"),
        )
    })?;
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("history filename must be YYYY-MM-DD.jsonl: {name}: {error}"),
        )
    })?;
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
        if existing.title.as_deref().is_none_or(str::is_empty)
            && next.title.as_deref().is_some_and(|title| !title.is_empty())
        {
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
                "action": "visit_page",
                "timestamp": 100,
                "url": "https://example.com/article",
                "title": "Article A",
                "referrerUrl": null
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            device_b.join("2026-04-18.jsonl"),
            [
                json!({
                    "action": "visit_page",
                    "timestamp": 200,
                    "url": "https://example.com/article",
                    "title": "Article A newer",
                    "referrerUrl": null
                })
                .to_string(),
                json!({
                    "action": "visit_page",
                    "timestamp": 150,
                    "url": "https://example.com/second",
                    "title": "Article B",
                    "referrerUrl": null
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
    fn search_history_ignores_unowned_files_and_preserves_a_missing_title() {
        let temp_dir = tempdir().unwrap();
        let data_dir = temp_dir.path();
        let device = data_dir.join("logs/device-a");
        fs::create_dir_all(&device).unwrap();
        fs::create_dir_all(data_dir.join("views/pages")).unwrap();
        fs::write(data_dir.join("logs/.DS_Store"), "metadata").unwrap();
        fs::write(device.join(".DS_Store"), "metadata").unwrap();
        fs::write(
            device.join("2026-07-15.jsonl"),
            json!({
                "action": "visit_page",
                "timestamp": 100,
                "url": "https://nullable-title.example/needle",
                "title": null,
                "referrerUrl": null,
            })
            .to_string(),
        )
        .unwrap();

        let hits = search_history_in_data_dir(data_dir, "needle", None).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://nullable-title.example/needle");
        assert_eq!(hits[0].title, None);
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
            let target = if index % 2 == 0 { &device_a } else { &device_b };
            fs::write(
                target.join(format!("2026-04-{:02}.jsonl", index + 1)),
                json!({
                    "action": "visit_page",
                    "timestamp": 1000 + index,
                    "url": url,
                    "title": format!("Parallel banana {index}"),
                    "referrerUrl": null,
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
                "action": "visit_page",
                "timestamp": 200,
                "url": "https://example.com/duplicate",
                "title": "Newest title without match",
                "referrerUrl": null,
            })
            .to_string(),
        )
        .unwrap();
        for index in 0..3 {
            fs::write(
                device.join(format!("2026-04-1{index}.jsonl")),
                json!({
                    "action": "visit_page",
                    "timestamp": 150 - index,
                    "url": format!("https://example.com/filler-{index}"),
                    "title": format!("Filler {index}"),
                    "referrerUrl": null,
                })
                .to_string(),
            )
            .unwrap();
        }
        fs::write(
            device.join("2026-04-09.jsonl"),
            json!({
                "action": "visit_page",
                "timestamp": 100,
                "url": "https://example.com/duplicate",
                "title": "Older needle title",
                "referrerUrl": null,
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
                    "action": "visit_page",
                    "timestamp": 1000 + index,
                    "url": format!("https://example.com/limited-{index}"),
                    "title": format!("Limited needle {index}"),
                    "referrerUrl": null,
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
                "action": "visit_page",
                "timestamp": 100,
                "url": "https://example.com/cancelled",
                "title": "Cancelled banana",
                "referrerUrl": null,
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
        let mut note = browser_recall_replay::entities::NoteEntity::new("note-a".to_string());
        note.url = Some("https://example.com/article".to_string());
        note.excerpt = Some(json!(["banana excerpt"]));
        note.css_path = Some(json!(["body"]));
        fs::write(
            notes_dir.join("note-a.json"),
            serde_json::to_string(&note).unwrap(),
        )
        .unwrap();
        fs::write(notes_dir.join(".DS_Store"), "metadata").unwrap();
        fs::create_dir(notes_dir.join("unowned")).unwrap();

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
        fs::write(
            temp_dir.path().join("objects/snapshots/.DS_Store"),
            "metadata",
        )
        .unwrap();
        fs::write(snapshots_dir.join("README.txt"), "unowned").unwrap();

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
    fn search_snapshots_in_data_dir_ignores_html_when_markdown_does_not_match() {
        let temp_dir = tempdir().unwrap();
        let snapshots_dir = temp_dir.path().join("objects/snapshots/aa");
        fs::create_dir_all(&snapshots_dir).unwrap();
        fs::write(
            snapshots_dir.join("my-page-1709251200000.md"),
            "markdown without the query",
        )
        .unwrap();
        fs::write(
            snapshots_dir.join("my-page-1709251200000.html"),
            "<html><body>banana snapshot</body></html>",
        )
        .unwrap();

        let hits = search_snapshots_in_data_dir(temp_dir.path(), "banana", None).unwrap();

        assert!(hits.is_empty());
    }
}
