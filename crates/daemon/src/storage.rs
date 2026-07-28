use browser_recall_replay::entities::{
    Entity, ListEntity, ListOrderManifest, NameToIdManifest, NoteEntity, OrphanedManifest,
    PageEntity, SettingsEntity,
};
use browser_recall_replay::{page_retains_checkpoint, EntityEffect, LogEntry};
use chrono::{Local, TimeZone};
use parking_lot::Mutex as StdMutex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::warn;

const REPLAY_PROGRESS_FILE: &str = "replay-progress.json";
const REPLAY_PROGRESS_MIN_STEP_MS: i64 = 15 * 60 * 1000;
static ATOMIC_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct Storage {
    inner: Arc<StorageInner>,
}

#[derive(Debug)]
struct StorageInner {
    root: PathBuf,
    cache: StdMutex<EntityCache>,
    highlight_chronology_cache: StdMutex<Option<HighlightChronologyCache>>,
    highlight_chronology_generation: AtomicU64,
    write_gate: Mutex<()>,
    last_command_timestamp_ms: StdMutex<i64>,
    checkpoint_tx: mpsc::Sender<CheckpointWork>,
    checkpoint_error: StdMutex<Option<String>>,
}

pub type CheckpointBatch = BTreeMap<String, EntityEffect>;
pub type ReplayProgress = BTreeMap<String, i64>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryFileListing {
    pub files: Vec<String>,
    pub sizes: Option<BTreeMap<String, u64>>,
    pub devices: Vec<String>,
}

#[derive(Debug)]
struct LogFile {
    device_id: String,
    date: String,
    name: String,
    path: PathBuf,
    size: u64,
}

#[derive(Debug)]
struct LogCatalog {
    devices: Vec<String>,
    files: Vec<LogFile>,
}

#[derive(Debug, Clone)]
struct HighlightChronologyCache {
    generation: u64,
    entries: Vec<LogEntry>,
}

#[derive(Debug)]
pub struct CheckpointBatchWork {
    pub effects: CheckpointBatch,
    pub replay_progress: ReplayProgress,
}

#[derive(Debug)]
enum CheckpointWork {
    Batch(CheckpointBatchWork),
    Flush(oneshot::Sender<()>),
}

#[derive(Debug)]
pub struct CheckpointPermit(mpsc::OwnedPermit<CheckpointWork>);

#[derive(Debug)]
struct EntityCache {
    entries: HashMap<String, Option<Entity>>,
    order: VecDeque<String>,
    capacity: usize,
}

impl EntityCache {
    fn new(capacity: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            capacity,
        }
    }

    fn get(&mut self, key: &str) -> Option<Option<Entity>> {
        let value = self.entries.get(key).cloned()?;
        self.touch(key);
        Some(value)
    }

    fn put(&mut self, key: String, value: Option<Entity>) {
        self.entries.insert(key.clone(), value);
        self.touch(&key);
        while self.entries.len() > self.capacity {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if self.entries.remove(&oldest).is_some() {
                break;
            }
        }
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|entry| entry != key);
        self.order.push_back(key.to_string());
    }
}

impl Storage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let (checkpoint_tx, checkpoint_rx) = mpsc::channel(64);
        let storage = Self {
            inner: Arc::new(StorageInner {
                root: root.into(),
                cache: StdMutex::new(EntityCache::new(5_000)),
                highlight_chronology_cache: StdMutex::new(None),
                highlight_chronology_generation: AtomicU64::new(0),
                write_gate: Mutex::new(()),
                last_command_timestamp_ms: StdMutex::new(0),
                checkpoint_tx,
                checkpoint_error: StdMutex::new(None),
            }),
        };
        tokio::spawn(checkpoint_worker(storage.clone(), checkpoint_rx));
        storage
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub async fn write_guard(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.inner.write_gate.lock().await
    }

    pub fn next_command_timestamp_millis(&self) -> i64 {
        let now = Local::now().timestamp_millis();
        let mut last = self.inner.last_command_timestamp_ms.lock();
        let next = now.max(*last + 1);
        *last = next;
        next
    }

    pub async fn ensure_layout(&self, device_id: &str) -> io::Result<()> {
        fs::create_dir_all(self.root().join("views").join("pages")).await?;
        fs::create_dir_all(self.root().join("views").join("lists")).await?;
        fs::create_dir_all(self.root().join("views").join("manifest")).await?;
        fs::create_dir_all(self.root().join("objects").join("notes")).await?;
        fs::create_dir_all(self.root().join("objects").join("snapshots")).await?;
        fs::create_dir_all(self.root().join("logs").join(device_id)).await?;
        Ok(())
    }

    pub async fn load_entity(&self, key: &str) -> io::Result<Option<Entity>> {
        if let Some(entity) = self.cache_get(key) {
            return Ok(entity);
        }
        if let Some(slug) = key.strip_prefix("page:") {
            return self
                .load_page(slug)
                .await
                .map(|page| page.map(Entity::Page));
        }
        if let Some(slug) = key.strip_prefix("note:") {
            return self
                .load_note(slug)
                .await
                .map(|note| note.map(Entity::Note));
        }
        if let Some(slug) = key.strip_prefix("list:") {
            return self
                .load_list(slug)
                .await
                .map(|list| list.map(Entity::List));
        }
        match key {
            "manifest:settings" => self
                .load_settings()
                .await
                .map(|settings| settings.map(Entity::Settings)),
            "manifest:name-to-id" => self
                .load_name_to_id()
                .await
                .map(|manifest| manifest.map(Entity::NameToId)),
            "manifest:list-order" => self
                .load_list_order()
                .await
                .map(|manifest| manifest.map(Entity::ListOrder)),
            "manifest:orphaned" => self
                .load_orphaned()
                .await
                .map(|manifest| manifest.map(Entity::Orphaned)),
            _ => Ok(None),
        }
    }

    pub async fn load_entity_coordinated(&self, key: &str) -> io::Result<Option<Entity>> {
        if let Some(entity) = self.cache_get(key) {
            return Ok(entity);
        }
        let _guard = self.write_guard().await;
        self.load_entity(key).await
    }

    pub async fn load_page(&self, slug: &str) -> io::Result<Option<PageEntity>> {
        self.load_cached_json(
            &format!("page:{slug}"),
            self.page_path(slug),
            Entity::Page,
            |entity| match entity {
                Entity::Page(page) => Some(page),
                _ => None,
            },
        )
        .await
    }

    pub async fn load_page_coordinated(&self, slug: &str) -> io::Result<Option<PageEntity>> {
        Ok(
            match self
                .load_entity_coordinated(&format!("page:{slug}"))
                .await?
            {
                Some(Entity::Page(page)) => Some(page),
                _ => None,
            },
        )
    }

    async fn write_entity_checkpoint(&self, key: &str, entity: &Entity) -> io::Result<()> {
        match entity {
            Entity::Page(page) => self.persist_page_checkpoint_effect(key, page).await,
            Entity::Note(note) => {
                let slug = key
                    .strip_prefix("note:")
                    .ok_or_else(|| invalid_data(format!("invalid note effect key: {key}")))?;
                if slug != note.slug {
                    return Err(invalid_data(format!(
                        "note effect key {key} does not match entity slug {}",
                        note.slug
                    )));
                }
                self.write_note_checkpoint(slug, note).await
            }
            Entity::List(list) => {
                let slug = key
                    .strip_prefix("list:")
                    .ok_or_else(|| invalid_data(format!("invalid list effect key: {key}")))?;
                if slug != list.slug {
                    return Err(invalid_data(format!(
                        "list effect key {key} does not match entity slug {}",
                        list.slug
                    )));
                }
                self.write_list_checkpoint(slug, list).await
            }
            Entity::Settings(settings) => self.write_settings_checkpoint(settings).await,
            Entity::NameToId(manifest) => self.write_name_to_id_checkpoint(manifest).await,
            Entity::ListOrder(manifest) => self.write_list_order_checkpoint(manifest).await,
            Entity::Orphaned(manifest) => self.write_orphaned_checkpoint(manifest).await,
        }
    }

    pub fn apply_effect_to_cache(&self, key: &str, effect: &EntityEffect) {
        match effect {
            EntityEffect::Upsert(entity) => self.cache_put(key.to_string(), Some(entity.clone())),
            EntityEffect::Delete => self.cache_put(key.to_string(), None),
        }
    }

    pub async fn persist_checkpoint_effect(
        &self,
        key: &str,
        effect: &EntityEffect,
    ) -> io::Result<()> {
        match effect {
            EntityEffect::Upsert(entity) => self.write_entity_checkpoint(key, entity).await,
            EntityEffect::Delete => self.delete_checkpoint_entity(key).await,
        }
    }

    pub async fn reserve_checkpoint_slot(&self) -> io::Result<CheckpointPermit> {
        self.check_checkpoint_health()?;
        self.inner
            .checkpoint_tx
            .clone()
            .reserve_owned()
            .await
            .map(CheckpointPermit)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "checkpoint worker stopped"))
    }

    pub fn send_reserved_checkpoint_work(
        permit: CheckpointPermit,
        effects: CheckpointBatch,
        replay_progress: ReplayProgress,
    ) {
        permit.0.send(CheckpointWork::Batch(CheckpointBatchWork {
            effects,
            replay_progress,
        }));
    }

    pub async fn flush_checkpoints(&self) -> io::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .checkpoint_tx
            .send(CheckpointWork::Flush(tx))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "checkpoint worker stopped"))?;
        rx.await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "checkpoint worker stopped"))?;
        self.check_checkpoint_health()
    }

    pub async fn load_replay_progress(&self) -> io::Result<ReplayProgress> {
        match load_json(self.manifest_path(REPLAY_PROGRESS_FILE)).await? {
            Some(progress) => Ok(progress),
            None => Ok(ReplayProgress::new()),
        }
    }

    async fn save_replay_progress(&self, replay_progress: &ReplayProgress) -> io::Result<()> {
        save_json(self.manifest_path(REPLAY_PROGRESS_FILE), replay_progress).await
    }

    pub async fn load_log_entries_after_replay_progress(
        &self,
    ) -> io::Result<Vec<(String, LogEntry)>> {
        let replay_progress = self.load_replay_progress().await?;
        self.load_log_entries_where(|device_id, entry| {
            entry.timestamp() > replay_progress.get(device_id).copied().unwrap_or(i64::MIN)
        })
        .await
    }

    pub async fn load_highlight_chronology_entries(&self) -> io::Result<Vec<LogEntry>> {
        loop {
            let generation = self
                .inner
                .highlight_chronology_generation
                .load(Ordering::Acquire);
            if let Some(cached) = self
                .inner
                .highlight_chronology_cache
                .lock()
                .as_ref()
                .filter(|cached| cached.generation == generation)
                .cloned()
            {
                return Ok(cached.entries);
            }

            let entries = self
                .load_log_entries_where(|_, entry| {
                    matches!(
                        entry,
                        LogEntry::CreateNote { .. } | LogEntry::ReplaceNote { .. }
                    )
                })
                .await?
                .into_iter()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>();
            // A note mutation can invalidate the cache while this asynchronous
            // scan is running. Publish only if the generation is unchanged;
            // otherwise rebuild so stale scan results cannot win afterward.
            if self
                .inner
                .highlight_chronology_generation
                .load(Ordering::Acquire)
                == generation
            {
                *self.inner.highlight_chronology_cache.lock() = Some(HighlightChronologyCache {
                    generation,
                    entries: entries.clone(),
                });
                return Ok(entries);
            }
        }
    }

    async fn load_log_entries_where(
        &self,
        mut include: impl FnMut(&str, &LogEntry) -> bool,
    ) -> io::Result<Vec<(String, LogEntry)>> {
        let mut result = Vec::new();
        for file in self.scan_log_catalog().await?.files {
            let raw = fs::read_to_string(&file.path).await?;
            for (index, line) in raw.lines().enumerate() {
                if line.trim().is_empty() {
                    return Err(invalid_data(format!(
                        "{}:{}: blank JSONL records are not allowed",
                        file.path.display(),
                        index + 1
                    )));
                }
                let entry: LogEntry = serde_json::from_str(line).map_err(|error| {
                    invalid_data(format!("{}:{}: {error}", file.path.display(), index + 1))
                })?;
                if include(&file.device_id, &entry) {
                    result.push((file.device_id.clone(), entry));
                }
            }
        }

        result.sort_by_key(|entry| entry.1.timestamp());
        Ok(result)
    }

    pub async fn save_page(&self, slug: &str, page: &PageEntity) -> io::Result<()> {
        self.write_page_checkpoint(slug, page).await?;
        self.cache_put(format!("page:{slug}"), Some(Entity::Page(page.clone())));
        Ok(())
    }

    pub async fn load_note(&self, slug: &str) -> io::Result<Option<NoteEntity>> {
        self.load_cached_json(
            &format!("note:{slug}"),
            self.note_path(slug),
            Entity::Note,
            |entity| match entity {
                Entity::Note(note) => Some(note),
                _ => None,
            },
        )
        .await
    }

    pub async fn load_note_coordinated(&self, slug: &str) -> io::Result<Option<NoteEntity>> {
        Ok(
            match self
                .load_entity_coordinated(&format!("note:{slug}"))
                .await?
            {
                Some(Entity::Note(note)) => Some(note),
                _ => None,
            },
        )
    }

    pub async fn save_note(&self, slug: &str, note: &NoteEntity) -> io::Result<()> {
        self.write_note_checkpoint(slug, note).await?;
        self.cache_put(format!("note:{slug}"), Some(Entity::Note(note.clone())));
        Ok(())
    }

    pub async fn load_list(&self, slug: &str) -> io::Result<Option<ListEntity>> {
        self.load_cached_json(
            &format!("list:{slug}"),
            self.list_path(slug),
            Entity::List,
            |entity| match entity {
                Entity::List(list) => Some(list),
                _ => None,
            },
        )
        .await
    }

    pub async fn load_list_coordinated(&self, slug: &str) -> io::Result<Option<ListEntity>> {
        Ok(
            match self
                .load_entity_coordinated(&format!("list:{slug}"))
                .await?
            {
                Some(Entity::List(list)) => Some(list),
                _ => None,
            },
        )
    }

    pub async fn save_list(&self, slug: &str, list: &ListEntity) -> io::Result<()> {
        self.write_list_checkpoint(slug, list).await?;
        self.cache_put(format!("list:{slug}"), Some(Entity::List(list.clone())));
        Ok(())
    }

    pub async fn load_settings(&self) -> io::Result<Option<SettingsEntity>> {
        self.load_cached_json(
            "manifest:settings",
            self.manifest_path("settings.json"),
            Entity::Settings,
            |entity| match entity {
                Entity::Settings(settings) => Some(settings),
                _ => None,
            },
        )
        .await
    }

    pub async fn save_settings(&self, settings: &SettingsEntity) -> io::Result<()> {
        self.write_settings_checkpoint(settings).await?;
        self.cache_put(
            "manifest:settings".to_string(),
            Some(Entity::Settings(settings.clone())),
        );
        Ok(())
    }

    pub async fn load_name_to_id(&self) -> io::Result<Option<NameToIdManifest>> {
        self.load_cached_json(
            "manifest:name-to-id",
            self.manifest_path("list-name-to-id.json"),
            Entity::NameToId,
            |entity| match entity {
                Entity::NameToId(manifest) => Some(manifest),
                _ => None,
            },
        )
        .await
    }

    pub async fn save_name_to_id(&self, manifest: &NameToIdManifest) -> io::Result<()> {
        self.write_name_to_id_checkpoint(manifest).await?;
        self.cache_put(
            "manifest:name-to-id".to_string(),
            Some(Entity::NameToId(manifest.clone())),
        );
        Ok(())
    }

    pub async fn load_list_order(&self) -> io::Result<Option<ListOrderManifest>> {
        self.load_cached_json(
            "manifest:list-order",
            self.manifest_path("list-order.json"),
            Entity::ListOrder,
            |entity| match entity {
                Entity::ListOrder(manifest) => Some(manifest),
                _ => None,
            },
        )
        .await
    }

    pub async fn load_list_order_coordinated(&self) -> io::Result<Option<ListOrderManifest>> {
        Ok(
            match self.load_entity_coordinated("manifest:list-order").await? {
                Some(Entity::ListOrder(manifest)) => Some(manifest),
                _ => None,
            },
        )
    }

    pub async fn save_list_order(&self, manifest: &ListOrderManifest) -> io::Result<()> {
        self.write_list_order_checkpoint(manifest).await?;
        self.cache_put(
            "manifest:list-order".to_string(),
            Some(Entity::ListOrder(manifest.clone())),
        );
        Ok(())
    }

    pub async fn load_orphaned(&self) -> io::Result<Option<OrphanedManifest>> {
        self.load_cached_json(
            "manifest:orphaned",
            self.manifest_path("orphaned.json"),
            Entity::Orphaned,
            |entity| match entity {
                Entity::Orphaned(manifest) => Some(manifest),
                _ => None,
            },
        )
        .await
    }

    pub async fn save_orphaned(&self, manifest: &OrphanedManifest) -> io::Result<()> {
        self.write_orphaned_checkpoint(manifest).await?;
        self.cache_put(
            "manifest:orphaned".to_string(),
            Some(Entity::Orphaned(manifest.clone())),
        );
        Ok(())
    }

    async fn delete_checkpoint_entity(&self, key: &str) -> io::Result<()> {
        if let Some(slug) = key.strip_prefix("page:") {
            return remove_if_exists(self.page_path(slug)).await;
        }
        if let Some(slug) = key.strip_prefix("note:") {
            return remove_if_exists(self.note_path(slug)).await;
        }
        if let Some(slug) = key.strip_prefix("list:") {
            return remove_if_exists(self.list_path(slug)).await;
        }
        if let Some(snapshot_stem) = key.strip_prefix("snapshot:") {
            let (slug, timestamp) = split_snapshot_stem(snapshot_stem)?;
            remove_if_exists(self.snapshot_html_path(&slug, timestamp)).await?;
            remove_if_exists(self.snapshot_markdown_path(&slug, timestamp)).await?;
            return Ok(());
        }
        Err(invalid_data(format!(
            "unsupported checkpoint deletion key: {key}"
        )))
    }

    pub async fn append_log_entry(
        &self,
        device_id: &str,
        timestamp: i64,
        entry: &Value,
    ) -> io::Result<PathBuf> {
        let directory = self.root().join("logs").join(device_id);
        fs::create_dir_all(&directory).await?;
        let filename = format!("{}.jsonl", local_date(timestamp)?);
        let path = directory.join(filename);
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        let mut line = serde_json::to_vec(entry).map_err(invalid_data)?;
        line.push(b'\n');
        file.write_all(&line).await?;
        file.flush().await?;
        if matches!(
            entry.get("action").and_then(Value::as_str),
            Some("create_note" | "replace_note")
        ) {
            self.invalidate_highlight_chronology();
        }
        Ok(path)
    }

    pub async fn save_snapshot_html(
        &self,
        slug: &str,
        timestamp: i64,
        html: &str,
    ) -> io::Result<PathBuf> {
        self.save_snapshot_sidecar(slug, timestamp, "html", html)
            .await
    }

    pub async fn save_snapshot_markdown(
        &self,
        slug: &str,
        timestamp: i64,
        markdown: &str,
    ) -> io::Result<PathBuf> {
        self.save_snapshot_sidecar(slug, timestamp, "md", markdown)
            .await
    }

    pub async fn load_snapshot_html(
        &self,
        slug: &str,
        timestamp: i64,
    ) -> io::Result<Option<String>> {
        let path = self.snapshot_html_path(slug, timestamp);
        if !path.exists() {
            return Ok(None);
        }
        fs::read_to_string(path).await.map(Some)
    }

    pub fn snapshot_html_file_path(&self, slug: &str, timestamp: i64) -> PathBuf {
        self.snapshot_html_path(slug, timestamp)
    }

    pub fn snapshot_sidecar_relative_path(&self, slug: &str, timestamp: i64) -> String {
        let stem = snapshot_stem(slug, timestamp);
        format!("objects/snapshots/{}/{}", shard_for(&stem), stem)
    }

    pub async fn delete_snapshot(&self, slug: &str, timestamp: i64) -> io::Result<()> {
        remove_if_exists(self.snapshot_html_path(slug, timestamp)).await?;
        remove_if_exists(self.snapshot_markdown_path(slug, timestamp)).await?;
        let snapshot_key = format!("snapshot:{slug}-{timestamp}");
        self.remove_page_child_references(&snapshot_key).await?;
        Ok(())
    }

    pub async fn directory_size(&self) -> io::Result<u64> {
        let mut total = 0u64;
        let mut stack = vec![self.root().to_path_buf()];
        while let Some(dir) = stack.pop() {
            let mut entries = fs::read_dir(&dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let file_type = entry.file_type().await?;
                if file_type.is_dir() {
                    stack.push(entry.path());
                } else if file_type.is_file() {
                    total += entry.metadata().await?.len();
                }
            }
        }
        Ok(total)
    }

    pub async fn clear_all_data(&self, device_id: &str) -> io::Result<usize> {
        let mut deleted_count = 0usize;
        let mut entries = fs::read_dir(self.root()).await?;

        while let Some(entry) = entries.next_entry().await? {
            deleted_count += remove_path(entry.path()).await?;
        }

        self.clear_cache();
        self.ensure_layout(device_id).await?;
        Ok(deleted_count)
    }

    pub async fn load_sync_manifest(&self, key: &str) -> io::Result<Option<Value>> {
        load_json(self.manifest_path(&format!("{key}.json"))).await
    }

    pub async fn save_sync_manifest(&self, key: &str, data: &Value) -> io::Result<()> {
        save_json(self.manifest_path(&format!("{key}.json")), data).await
    }

    pub async fn collect_sync_files(
        &self,
        device_id: &str,
        retention_days: i64,
    ) -> io::Result<Vec<(String, String)>> {
        if retention_days < 1 {
            return Err(invalid_data(
                "sync retention days must be greater than or equal to 1",
            ));
        }
        let mut files = Vec::new();
        let cutoff = chrono::Local::now() - chrono::Duration::days(retention_days);
        let cutoff_str = format!(
            "{:04}-{:02}-{:02}",
            chrono::Datelike::year(&cutoff),
            chrono::Datelike::month(&cutoff),
            chrono::Datelike::day(&cutoff)
        );

        let logs_dir = self.root().join("logs").join(device_id);
        for log_file in scan_device_log_files(device_id, &logs_dir).await? {
            if log_file.date.as_str() < cutoff_str.as_str() {
                continue;
            }
            files.push((
                format!("logs/{device_id}/{}", log_file.name),
                fs::read_to_string(log_file.path).await?,
            ));
        }

        let notes_dir = self.root().join("objects").join("notes");
        let mut note_entries = fs::read_dir(&notes_dir).await?;
        {
            let entries = &mut note_entries;
            while let Some(entry) = entries.next_entry().await? {
                if !entry.file_type().await?.is_file() {
                    continue;
                }
                if entry.path().extension() != Some(std::ffi::OsStr::new("json")) {
                    continue;
                }
                let name = entry
                    .file_name()
                    .to_str()
                    .map(str::to_string)
                    .ok_or_else(|| invalid_data("note filename is not UTF-8"))?;
                files.push((
                    format!("objects/notes/{name}"),
                    fs::read_to_string(entry.path()).await?,
                ));
            }
        }

        Ok(files)
    }

    pub async fn write_sync_files(&self, files: &[(String, String)]) -> io::Result<()> {
        for (path, _) in files {
            let relative = Path::new(path);
            if relative.as_os_str().is_empty()
                || relative.is_absolute()
                || relative
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
            {
                return Err(invalid_data(format!(
                    "sync file path must be a non-empty relative path: {path}"
                )));
            }
            let Some(root) = relative
                .components()
                .next()
                .and_then(|component| match component {
                    std::path::Component::Normal(value) => value.to_str(),
                    _ => None,
                })
            else {
                return Err(invalid_data(format!("sync file path is not UTF-8: {path}")));
            };
            if !matches!(root, "logs" | "objects" | "views" | "manifest") {
                return Err(invalid_data(format!(
                    "sync file path has unsupported root: {path}"
                )));
            }
        }
        for (path, content) in files {
            let path = self.root().join(path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::write(path, content).await?;
        }
        self.clear_cache();
        Ok(())
    }

    pub async fn list_history_files(&self, include_sizes: bool) -> io::Result<HistoryFileListing> {
        let mut names = BTreeMap::new();
        let catalog = self.scan_log_catalog().await?;
        for file in catalog.files {
            *names.entry(file.name).or_insert(0) += file.size;
        }

        let mut files: Vec<_> = names.keys().cloned().collect();
        files.reverse();
        let sizes = include_sizes.then_some(names);
        Ok(HistoryFileListing {
            files,
            sizes,
            devices: catalog.devices,
        })
    }

    pub async fn load_history_batch(&self, filenames: &[String]) -> io::Result<Vec<Value>> {
        let wanted: std::collections::HashSet<&str> =
            filenames.iter().map(String::as_str).collect();
        let mut results = Vec::new();
        for file in self.scan_log_catalog().await?.files {
            if !wanted.contains(file.name.as_str()) {
                continue;
            }
            let raw = fs::read_to_string(&file.path).await?;
            for (line_index, line) in raw.lines().enumerate() {
                if line.trim().is_empty() {
                    return Err(invalid_data(format!(
                        "blank JSONL record in {} at line {}",
                        file.name,
                        line_index + 1
                    )));
                }
                let value: Value = serde_json::from_str(line).map_err(|error| {
                    invalid_data(format!(
                        "invalid JSONL in {} at line {}: {error}",
                        file.name,
                        line_index + 1
                    ))
                })?;
                let Value::Object(mut object) = value else {
                    return Err(invalid_data(format!(
                        "log entry in {} at line {} must be an object",
                        file.name,
                        line_index + 1
                    )));
                };
                let timestamp =
                    object
                        .get("timestamp")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| {
                            invalid_data(format!(
                                "log entry in {} at line {} is missing an integer timestamp",
                                file.name,
                                line_index + 1
                            ))
                        })?;
                serde_json::from_value::<LogEntry>(Value::Object(object.clone())).map_err(
                    |error| {
                        invalid_data(format!(
                            "invalid log schema in {} at line {}: {error}",
                            file.name,
                            line_index + 1
                        ))
                    },
                )?;
                object.insert(
                    "deviceId".to_string(),
                    Value::String(file.device_id.clone()),
                );
                results.push((timestamp, Value::Object(object)));
            }
        }

        results.sort_by_key(|(timestamp, _)| *timestamp);

        Ok(results.into_iter().map(|(_, entry)| entry).collect())
    }

    async fn scan_log_catalog(&self) -> io::Result<LogCatalog> {
        let logs_root = self.root().join("logs");
        let mut devices = fs::read_dir(&logs_root).await?;
        let mut device_ids = Vec::new();
        let mut files = Vec::new();
        while let Some(device_entry) = devices.next_entry().await? {
            if !device_entry.file_type().await?.is_dir() {
                continue;
            }
            let Some(device_id) = device_entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            device_ids.push(device_id.clone());
            files.extend(scan_device_log_files(&device_id, &device_entry.path()).await?);
        }
        device_ids.sort();
        files.sort_by(|left, right| {
            (&left.device_id, &left.name).cmp(&(&right.device_id, &right.name))
        });
        Ok(LogCatalog {
            devices: device_ids,
            files,
        })
    }

    pub async fn load_all_pages(&self) -> io::Result<BTreeMap<String, PageEntity>> {
        let pages_dir = self.root().join("views").join("pages");
        let mut result = BTreeMap::new();
        match fs::read_dir(&pages_dir).await {
            Ok(mut entries) => {
                while let Some(entry) = entries.next_entry().await? {
                    if !entry.file_type().await?.is_dir() {
                        continue;
                    }
                    let Some(shard) = entry.file_name().to_str().map(str::to_string) else {
                        continue;
                    };
                    if shard.len() != 2 || !shard.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                        continue;
                    }
                    let mut files = fs::read_dir(entry.path()).await?;
                    while let Some(file) = files.next_entry().await? {
                        if !file.file_type().await?.is_file() {
                            continue;
                        }
                        if file.path().extension() != Some(std::ffi::OsStr::new("json")) {
                            continue;
                        }
                        let name = file
                            .file_name()
                            .to_str()
                            .map(str::to_string)
                            .ok_or_else(|| invalid_data("page checkpoint filename is not UTF-8"))?;
                        let Some(slug) = name.strip_suffix(".json") else {
                            continue;
                        };
                        if slug.is_empty() || shard_for(slug) != shard {
                            return Err(invalid_data(format!(
                                "page checkpoint {name} is stored in the wrong shard {shard}"
                            )));
                        }
                        let raw = fs::read_to_string(file.path()).await?;
                        let page: PageEntity = serde_json::from_str(&raw).map_err(invalid_data)?;
                        if result.insert(slug.to_string(), page).is_some() {
                            return Err(invalid_data(format!(
                                "duplicate page checkpoint slug: {slug}"
                            )));
                        }
                    }
                }
            }
            Err(error) => return Err(error),
        }

        for (slug, cached) in self.cached_page_overlay() {
            match cached {
                Some(page) => {
                    result.insert(slug, page);
                }
                None => {
                    result.remove(&slug);
                }
            }
        }

        Ok(result)
    }

    fn cached_page_overlay(&self) -> BTreeMap<String, Option<PageEntity>> {
        let cache = self.inner.cache.lock();
        cache
            .entries
            .iter()
            .filter_map(|(key, value)| {
                let slug = key.strip_prefix("page:")?;
                let page = match value {
                    Some(Entity::Page(page)) => Some(page.clone()),
                    _ => None,
                };
                Some((slug.to_string(), page))
            })
            .collect()
    }

    pub async fn load_all_notes(&self) -> io::Result<BTreeMap<String, NoteEntity>> {
        let notes_dir = self.root().join("objects").join("notes");
        let mut result = BTreeMap::new();
        let mut entries = fs::read_dir(&notes_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !entry.file_type().await?.is_file() {
                continue;
            }
            if path.extension() != Some(std::ffi::OsStr::new("json")) {
                continue;
            }
            let name = entry
                .file_name()
                .to_str()
                .map(str::to_string)
                .ok_or_else(|| invalid_data("note checkpoint filename is not UTF-8"))?;
            let Some(slug) = name.strip_suffix(".json") else {
                continue;
            };
            if slug.is_empty() {
                return Err(invalid_data("note checkpoint slug must not be empty"));
            }
            let raw = fs::read_to_string(&path).await?;
            let note: NoteEntity = serde_json::from_str(&raw).map_err(|error| {
                invalid_data(format!(
                    "invalid note checkpoint {}: {error}",
                    path.display()
                ))
            })?;
            if note.slug != slug {
                return Err(invalid_data(format!(
                    "note checkpoint filename {slug} does not match entity slug {}",
                    note.slug
                )));
            }
            if result.insert(slug.to_string(), note).is_some() {
                return Err(invalid_data(format!(
                    "duplicate note checkpoint slug: {slug}"
                )));
            }
        }

        for (slug, cached) in self.cached_note_overlay() {
            match cached {
                Some(note) => {
                    result.insert(slug, note);
                }
                None => {
                    result.remove(&slug);
                }
            }
        }

        Ok(result)
    }

    fn cached_note_overlay(&self) -> BTreeMap<String, Option<NoteEntity>> {
        let cache = self.inner.cache.lock();
        cache
            .entries
            .iter()
            .filter_map(|(key, value)| {
                let slug = key.strip_prefix("note:")?;
                let note = match value {
                    Some(Entity::Note(note)) => Some(note.clone()),
                    _ => None,
                };
                Some((slug.to_string(), note))
            })
            .collect()
    }

    pub async fn load_all_lists(&self) -> io::Result<BTreeMap<String, ListEntity>> {
        let lists_dir = self.root().join("views").join("lists");
        let mut result = BTreeMap::new();
        match fs::read_dir(&lists_dir).await {
            Ok(mut entries) => {
                while let Some(entry) = entries.next_entry().await? {
                    if !entry.file_type().await?.is_file() {
                        continue;
                    }
                    if entry.path().extension() != Some(std::ffi::OsStr::new("json")) {
                        continue;
                    }
                    let name = entry
                        .file_name()
                        .to_str()
                        .map(str::to_string)
                        .ok_or_else(|| invalid_data("list checkpoint filename is not UTF-8"))?;
                    let Some(slug) = name.strip_suffix(".json") else {
                        continue;
                    };
                    if slug.is_empty() {
                        return Err(invalid_data("list checkpoint slug must not be empty"));
                    }
                    let raw = fs::read_to_string(entry.path()).await?;
                    let list: ListEntity = serde_json::from_str(&raw).map_err(invalid_data)?;
                    if result.insert(slug.to_string(), list).is_some() {
                        return Err(invalid_data(format!(
                            "duplicate list checkpoint slug: {slug}"
                        )));
                    }
                }
            }
            Err(error) => return Err(error),
        }

        for (slug, cached) in self.cached_list_overlay() {
            match cached {
                Some(list) => {
                    result.insert(slug, list);
                }
                None => {
                    result.remove(&slug);
                }
            }
        }

        Ok(result)
    }

    fn cached_list_overlay(&self) -> BTreeMap<String, Option<ListEntity>> {
        let cache = self.inner.cache.lock();
        cache
            .entries
            .iter()
            .filter_map(|(key, value)| {
                let slug = key.strip_prefix("list:")?;
                let list = match value {
                    Some(Entity::List(list)) => Some(list.clone()),
                    _ => None,
                };
                Some((slug.to_string(), list))
            })
            .collect()
    }

    async fn remove_page_child_references(&self, child_key: &str) -> io::Result<()> {
        for (page_slug, mut page) in self.load_all_pages().await? {
            let original_len = page.child_ids.len();
            page.child_ids.retain(|child| child != child_key);
            if page.child_ids.len() != original_len {
                self.save_or_delete_page(&page_slug, page).await?;
            }
        }
        Ok(())
    }

    async fn save_or_delete_page(&self, slug: &str, page: PageEntity) -> io::Result<()> {
        if page_retains_checkpoint(&page) {
            self.save_page(slug, &page).await
        } else {
            remove_if_exists(self.page_path(slug)).await?;
            self.cache_put(format!("page:{slug}"), None);
            Ok(())
        }
    }

    fn page_path(&self, slug: &str) -> PathBuf {
        self.root()
            .join("views")
            .join("pages")
            .join(shard_for(slug))
            .join(format!("{slug}.json"))
    }

    async fn write_page_checkpoint(&self, slug: &str, page: &PageEntity) -> io::Result<()> {
        save_json(self.page_path(slug), page).await
    }

    async fn persist_page_checkpoint_effect(&self, key: &str, page: &PageEntity) -> io::Result<()> {
        let slug = key
            .strip_prefix("page:")
            .ok_or_else(|| invalid_data(format!("invalid page effect key: {key}")))?;
        if slug != page.slug {
            return Err(invalid_data(format!(
                "page effect key {key} does not match entity slug {}",
                page.slug
            )));
        }
        if page_retains_checkpoint(page) {
            self.write_page_checkpoint(slug, page).await
        } else {
            remove_if_exists(self.page_path(slug)).await
        }
    }

    fn note_path(&self, slug: &str) -> PathBuf {
        self.root()
            .join("objects")
            .join("notes")
            .join(format!("{slug}.json"))
    }

    async fn write_note_checkpoint(&self, slug: &str, note: &NoteEntity) -> io::Result<()> {
        save_json(self.note_path(slug), note).await
    }

    fn list_path(&self, slug: &str) -> PathBuf {
        self.root()
            .join("views")
            .join("lists")
            .join(format!("{slug}.json"))
    }

    async fn write_list_checkpoint(&self, slug: &str, list: &ListEntity) -> io::Result<()> {
        save_json(self.list_path(slug), list).await
    }

    fn manifest_path(&self, filename: &str) -> PathBuf {
        self.root().join("views").join("manifest").join(filename)
    }

    async fn write_settings_checkpoint(&self, settings: &SettingsEntity) -> io::Result<()> {
        save_json(self.manifest_path("settings.json"), settings).await
    }

    async fn write_name_to_id_checkpoint(&self, manifest: &NameToIdManifest) -> io::Result<()> {
        save_json(self.manifest_path("list-name-to-id.json"), manifest).await
    }

    async fn write_list_order_checkpoint(&self, manifest: &ListOrderManifest) -> io::Result<()> {
        save_json(self.manifest_path("list-order.json"), manifest).await
    }

    async fn write_orphaned_checkpoint(&self, manifest: &OrphanedManifest) -> io::Result<()> {
        save_json(self.manifest_path("orphaned.json"), manifest).await
    }

    fn snapshot_html_path(&self, slug: &str, timestamp: i64) -> PathBuf {
        self.snapshot_path(slug, timestamp, "html")
    }

    fn snapshot_markdown_path(&self, slug: &str, timestamp: i64) -> PathBuf {
        self.snapshot_path(slug, timestamp, "md")
    }

    fn snapshot_path(&self, slug: &str, timestamp: i64, extension: &str) -> PathBuf {
        let stem = snapshot_stem(slug, timestamp);
        self.root()
            .join("objects")
            .join("snapshots")
            .join(shard_for(&stem))
            .join(format!("{stem}.{extension}"))
    }

    async fn save_snapshot_sidecar(
        &self,
        slug: &str,
        timestamp: i64,
        extension: &str,
        content: &str,
    ) -> io::Result<PathBuf> {
        let path = self.snapshot_path(slug, timestamp, extension);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&path, content.as_bytes()).await?;
        Ok(path)
    }

    fn cache_get(&self, key: &str) -> Option<Option<Entity>> {
        self.inner.cache.lock().get(key)
    }

    async fn load_cached_json<T>(
        &self,
        key: &str,
        path: PathBuf,
        into_entity: fn(T) -> Entity,
        from_entity: fn(Entity) -> Option<T>,
    ) -> io::Result<Option<T>>
    where
        T: serde::de::DeserializeOwned + Clone,
    {
        if let Some(cached) = self.cache_get(key) {
            return Ok(cached.and_then(from_entity));
        }
        let value = load_json(path).await?;
        self.cache_put(key.to_string(), value.clone().map(into_entity));
        Ok(value)
    }

    fn cache_put(&self, key: String, value: Option<Entity>) {
        self.inner.cache.lock().put(key, value);
    }

    fn clear_cache(&self) {
        let mut cache = self.inner.cache.lock();
        *cache = EntityCache::new(cache.capacity);
        drop(cache);
        self.invalidate_highlight_chronology();
    }

    fn invalidate_highlight_chronology(&self) {
        self.inner
            .highlight_chronology_generation
            .fetch_add(1, Ordering::AcqRel);
        *self.inner.highlight_chronology_cache.lock() = None;
    }

    pub fn reset_cache(&self) {
        self.clear_cache();
    }

    fn set_checkpoint_error(&self, error: String) {
        *self.inner.checkpoint_error.lock() = Some(error);
    }

    fn check_checkpoint_health(&self) -> io::Result<()> {
        if let Some(error) = self.inner.checkpoint_error.lock().clone() {
            return Err(io::Error::other(format!(
                "checkpoint persistence failed: {error}"
            )));
        }
        Ok(())
    }
}

fn shard_for(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{:02x}", digest[0])
}

fn snapshot_stem(slug: &str, timestamp: i64) -> String {
    format!("{slug}-{timestamp}")
}

fn local_date(timestamp: i64) -> io::Result<String> {
    let datetime = Local
        .timestamp_millis_opt(timestamp)
        .single()
        .ok_or_else(|| invalid_data("timestamp is out of range"))?;
    Ok(format!(
        "{:04}-{:02}-{:02}",
        chrono::Datelike::year(&datetime),
        chrono::Datelike::month(&datetime),
        chrono::Datelike::day(&datetime)
    ))
}

async fn scan_device_log_files(device_id: &str, directory: &Path) -> io::Result<Vec<LogFile>> {
    let mut entries = fs::read_dir(directory).await?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_file() {
            continue;
        }
        if entry.path().extension() != Some(std::ffi::OsStr::new("jsonl")) {
            continue;
        }
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| invalid_data("log filename is not UTF-8"))?;
        let date = name
            .strip_suffix(".jsonl")
            .ok_or_else(|| invalid_data(format!("invalid JSONL log filename: {name}")))?;
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| invalid_data(format!("log filename must be YYYY-MM-DD.jsonl: {name}")))?;
        files.push(LogFile {
            device_id: device_id.to_string(),
            date: date.to_string(),
            name,
            path: entry.path(),
            size: entry.metadata().await?.len(),
        });
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(files)
}

fn invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

async fn remove_if_exists(path: PathBuf) -> io::Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn checkpoint_worker(storage: Storage, mut rx: mpsc::Receiver<CheckpointWork>) {
    let mut durable_progress = match storage.load_replay_progress().await {
        Ok(progress) => progress,
        Err(error) => {
            warn!(error = %error, "checkpoint worker could not load replay progress");
            storage.set_checkpoint_error(error.to_string());
            return;
        }
    };
    while let Some(work) = rx.recv().await {
        match work {
            CheckpointWork::Batch(batch) => {
                let mut failed = false;
                for (key, effect) in batch.effects {
                    if let Err(error) = storage.persist_checkpoint_effect(&key, &effect).await {
                        warn!(key = %key, error = %error, "checkpoint persistence failed");
                        storage.set_checkpoint_error(error.to_string());
                        failed = true;
                    }
                }
                if !failed {
                    merge_replay_progress(&mut durable_progress, &batch.replay_progress);
                    if let Err(error) =
                        persist_due_replay_progress(&storage, &durable_progress, false).await
                    {
                        warn!(error = %error, "replay progress persistence failed");
                        storage.set_checkpoint_error(error.to_string());
                    }
                }
            }
            CheckpointWork::Flush(done) => {
                if let Err(error) =
                    persist_due_replay_progress(&storage, &durable_progress, true).await
                {
                    warn!(error = %error, "replay progress persistence failed");
                    storage.set_checkpoint_error(error.to_string());
                }
                let _ = done.send(());
            }
        }
    }
}

fn merge_replay_progress(target: &mut ReplayProgress, source: &ReplayProgress) {
    for (device, timestamp) in source {
        let current = target.entry(device.clone()).or_insert(i64::MIN);
        *current = (*current).max(*timestamp);
    }
}

async fn persist_due_replay_progress(
    storage: &Storage,
    durable_progress: &ReplayProgress,
    force: bool,
) -> io::Result<()> {
    if durable_progress.is_empty() {
        return Ok(());
    }
    let mut persisted = storage.load_replay_progress().await?;
    let mut changed = false;
    for (device, durable_timestamp) in durable_progress {
        let persisted_timestamp = persisted.get(device).copied().unwrap_or(i64::MIN);
        if *durable_timestamp <= persisted_timestamp {
            continue;
        }
        if !force
            && persisted_timestamp != i64::MIN
            && *durable_timestamp - persisted_timestamp < REPLAY_PROGRESS_MIN_STEP_MS
        {
            continue;
        }
        persisted.insert(device.clone(), *durable_timestamp);
        changed = true;
    }
    if changed {
        storage.save_replay_progress(&persisted).await?;
    }
    Ok(())
}

async fn remove_path(path: PathBuf) -> io::Result<usize> {
    let metadata = match fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };

    if metadata.is_file() {
        fs::remove_file(path).await?;
        return Ok(1);
    }

    if metadata.is_dir() {
        let mut removed = 1usize;
        let mut entries = fs::read_dir(&path).await?;
        while let Some(entry) = entries.next_entry().await? {
            removed += Box::pin(remove_path(entry.path())).await?;
        }
        fs::remove_dir(&path).await?;
        return Ok(removed);
    }

    Err(invalid_data(format!(
        "unsupported filesystem entry cannot be removed: {}",
        path.display()
    )))
}

fn split_snapshot_stem(snapshot_stem: &str) -> io::Result<(String, i64)> {
    let (slug, timestamp) = snapshot_stem
        .rsplit_once('-')
        .ok_or_else(|| invalid_data(format!("invalid snapshot checkpoint key: {snapshot_stem}")))?;
    if slug.is_empty() {
        return Err(invalid_data(format!(
            "invalid snapshot checkpoint key: {snapshot_stem}"
        )));
    }
    let timestamp = timestamp.parse::<i64>().map_err(|error| {
        invalid_data(format!(
            "invalid snapshot checkpoint timestamp in {snapshot_stem}: {error}"
        ))
    })?;
    Ok((slug.to_string(), timestamp))
}

async fn load_json<T>(path: PathBuf) -> io::Result<Option<T>>
where
    T: serde::de::DeserializeOwned,
{
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).await?;
    let value = serde_json::from_str(&raw).map_err(invalid_data)?;
    Ok(Some(value))
}

async fn save_json<T>(path: PathBuf, value: &T) -> io::Result<()>
where
    T: serde::Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let payload = serde_json::to_vec_pretty(value).map_err(invalid_data)?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            invalid_data(format!(
                "checkpoint path has no UTF-8 filename: {}",
                path.display()
            ))
        })?;
    let counter = ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_file_name(format!(
        ".{filename}.{}.{}.tmp",
        std::process::id(),
        counter
    ));
    fs::write(&tmp_path, payload).await?;
    match fs::rename(&tmp_path, &path).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&tmp_path).await;
            Err(error)
        }
    }
}
