use browser_recall_replay::entities::{
    Entity, ListEntity, ListOrderManifest, NameToIdManifest, NoteEntity, OrphanedManifest,
    PageEntity, SettingsEntity,
};
use browser_recall_replay::EntityEffect;
use chrono::{Local, TimeZone};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone)]
pub struct Storage {
    inner: Arc<StorageInner>,
}

#[derive(Debug)]
struct StorageInner {
    root: PathBuf,
    cache: Mutex<EntityCache>,
}

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

    fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        self.order.retain(|entry| entry != key);
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|entry| entry != key);
        self.order.push_back(key.to_string());
    }
}

impl Storage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            inner: Arc::new(StorageInner {
                root: root.into(),
                cache: Mutex::new(EntityCache::new(5_000)),
            }),
        }
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub async fn ensure_layout(&self, device_id: &str) -> io::Result<()> {
        fs::create_dir_all(self.root().join("pages")).await?;
        fs::create_dir_all(self.root().join("lists")).await?;
        fs::create_dir_all(self.root().join("manifest")).await?;
        fs::create_dir_all(self.root().join("data").join("notes")).await?;
        fs::create_dir_all(self.root().join("data").join("logs").join(device_id)).await?;
        fs::create_dir_all(self.root().join("data").join("snapshots")).await?;
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

    pub async fn load_page(&self, slug: &str) -> io::Result<Option<PageEntity>> {
        if let Some(Some(Entity::Page(page))) = self.cache_get(&format!("page:{slug}")) {
            return Ok(Some(page));
        }
        let path = self.page_path(slug);
        if !path.exists() {
            self.cache_put(format!("page:{slug}"), None);
            return Ok(None);
        }
        let raw = fs::read_to_string(path).await?;
        let page: PageEntity = serde_json::from_str(&raw).map_err(invalid_data)?;
        self.cache_put(format!("page:{slug}"), Some(Entity::Page(page.clone())));
        Ok(Some(page))
    }

    pub async fn save_entity(&self, key: &str, entity: &Entity) -> io::Result<()> {
        match entity {
            Entity::Page(page) => {
                self.save_page(key.strip_prefix("page:").unwrap_or(&page.slug), page)
                    .await
            }
            Entity::Note(note) => {
                self.save_note(key.strip_prefix("note:").unwrap_or(&note.slug), note)
                    .await
            }
            Entity::List(list) => {
                self.save_list(key.strip_prefix("list:").unwrap_or(&list.slug), list)
                    .await
            }
            Entity::Settings(settings) => self.save_settings(settings).await,
            Entity::NameToId(manifest) => self.save_name_to_id(manifest).await,
            Entity::ListOrder(manifest) => self.save_list_order(manifest).await,
            Entity::Orphaned(manifest) => self.save_orphaned(manifest).await,
        }
    }

    pub async fn apply_effect(&self, key: &str, effect: &EntityEffect) -> io::Result<()> {
        match effect {
            EntityEffect::Upsert(entity) => self.save_entity(key, entity).await,
            EntityEffect::Delete => self.delete_entity(key).await,
        }
    }

    pub async fn save_page(&self, slug: &str, page: &PageEntity) -> io::Result<()> {
        fs::create_dir_all(self.root().join("pages")).await?;
        let payload = serde_json::to_vec_pretty(page).map_err(invalid_data)?;
        fs::write(self.page_path(slug), payload).await?;
        self.cache_put(format!("page:{slug}"), Some(Entity::Page(page.clone())));
        Ok(())
    }

    pub async fn load_note(&self, slug: &str) -> io::Result<Option<NoteEntity>> {
        if let Some(Some(Entity::Note(note))) = self.cache_get(&format!("note:{slug}")) {
            return Ok(Some(note));
        }
        let path = self.note_path(slug);
        if !path.exists() {
            self.cache_put(format!("note:{slug}"), None);
            return Ok(None);
        }
        let raw = fs::read_to_string(path).await?;
        let note: NoteEntity = serde_json::from_str(&raw).map_err(invalid_data)?;
        self.cache_put(format!("note:{slug}"), Some(Entity::Note(note.clone())));
        Ok(Some(note))
    }

    pub async fn save_note(&self, slug: &str, note: &NoteEntity) -> io::Result<()> {
        fs::create_dir_all(self.root().join("data").join("notes")).await?;
        let payload = serde_json::to_vec_pretty(note).map_err(invalid_data)?;
        fs::write(self.note_path(slug), payload).await?;
        self.cache_put(format!("note:{slug}"), Some(Entity::Note(note.clone())));
        Ok(())
    }

    pub async fn load_list(&self, slug: &str) -> io::Result<Option<ListEntity>> {
        if let Some(Some(Entity::List(list))) = self.cache_get(&format!("list:{slug}")) {
            return Ok(Some(list));
        }
        let path = self.list_path(slug);
        if !path.exists() {
            self.cache_put(format!("list:{slug}"), None);
            return Ok(None);
        }
        let raw = fs::read_to_string(path).await?;
        let list: ListEntity = serde_json::from_str(&raw).map_err(invalid_data)?;
        self.cache_put(format!("list:{slug}"), Some(Entity::List(list.clone())));
        Ok(Some(list))
    }

    pub async fn save_list(&self, slug: &str, list: &ListEntity) -> io::Result<()> {
        let path = self.list_path(slug);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let payload = serde_json::to_vec_pretty(list).map_err(invalid_data)?;
        fs::write(path, payload).await?;
        self.cache_put(format!("list:{slug}"), Some(Entity::List(list.clone())));
        Ok(())
    }

    pub async fn load_settings(&self) -> io::Result<Option<SettingsEntity>> {
        let key = "manifest:settings";
        if let Some(Some(Entity::Settings(settings))) = self.cache_get(key) {
            return Ok(Some(settings));
        }
        let value = load_json(self.manifest_path("settings.json")).await?;
        self.cache_put(key.to_string(), value.clone().map(Entity::Settings));
        Ok(value)
    }

    pub async fn save_settings(&self, settings: &SettingsEntity) -> io::Result<()> {
        save_json(self.manifest_path("settings.json"), settings).await?;
        self.cache_put(
            "manifest:settings".to_string(),
            Some(Entity::Settings(settings.clone())),
        );
        Ok(())
    }

    pub async fn load_name_to_id(&self) -> io::Result<Option<NameToIdManifest>> {
        let key = "manifest:name-to-id";
        if let Some(Some(Entity::NameToId(manifest))) = self.cache_get(key) {
            return Ok(Some(manifest));
        }
        let value = load_json(self.manifest_path("list-name-to-id.json")).await?;
        self.cache_put(key.to_string(), value.clone().map(Entity::NameToId));
        Ok(value)
    }

    pub async fn save_name_to_id(&self, manifest: &NameToIdManifest) -> io::Result<()> {
        save_json(self.manifest_path("list-name-to-id.json"), manifest).await?;
        self.cache_put(
            "manifest:name-to-id".to_string(),
            Some(Entity::NameToId(manifest.clone())),
        );
        Ok(())
    }

    pub async fn load_list_order(&self) -> io::Result<Option<ListOrderManifest>> {
        let key = "manifest:list-order";
        if let Some(Some(Entity::ListOrder(manifest))) = self.cache_get(key) {
            return Ok(Some(manifest));
        }
        let value = load_json(self.manifest_path("list-order.json")).await?;
        self.cache_put(key.to_string(), value.clone().map(Entity::ListOrder));
        Ok(value)
    }

    pub async fn save_list_order(&self, manifest: &ListOrderManifest) -> io::Result<()> {
        save_json(self.manifest_path("list-order.json"), manifest).await?;
        self.cache_put(
            "manifest:list-order".to_string(),
            Some(Entity::ListOrder(manifest.clone())),
        );
        Ok(())
    }

    pub async fn load_orphaned(&self) -> io::Result<Option<OrphanedManifest>> {
        let key = "manifest:orphaned";
        if let Some(Some(Entity::Orphaned(manifest))) = self.cache_get(key) {
            return Ok(Some(manifest));
        }
        let value = load_json(self.manifest_path("orphaned.json")).await?;
        self.cache_put(key.to_string(), value.clone().map(Entity::Orphaned));
        Ok(value)
    }

    pub async fn save_orphaned(&self, manifest: &OrphanedManifest) -> io::Result<()> {
        save_json(self.manifest_path("orphaned.json"), manifest).await?;
        self.cache_put(
            "manifest:orphaned".to_string(),
            Some(Entity::Orphaned(manifest.clone())),
        );
        Ok(())
    }

    pub async fn delete_entity(&self, key: &str) -> io::Result<()> {
        if let Some(slug) = key.strip_prefix("page:") {
            remove_if_exists(self.page_path(slug)).await?;
            self.cache_remove(key);
            return Ok(());
        }
        if let Some(slug) = key.strip_prefix("note:") {
            remove_if_exists(self.note_path(slug)).await?;
            self.cache_remove(key);
            return Ok(());
        }
        if let Some(slug) = key.strip_prefix("list:") {
            remove_if_exists(self.list_path(slug)).await?;
            self.cache_remove(key);
            return Ok(());
        }
        self.cache_remove(key);
        Ok(())
    }

    pub async fn append_log_entry(
        &self,
        device_id: &str,
        timestamp: i64,
        entry: &Value,
    ) -> io::Result<PathBuf> {
        let directory = self.root().join("data").join("logs").join(device_id);
        fs::create_dir_all(&directory).await?;
        let filename = format!("{}.jsonl", local_date(timestamp));
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
        Ok(path)
    }

    pub async fn save_snapshot_html(
        &self,
        slug: &str,
        timestamp: i64,
        html: &str,
    ) -> io::Result<PathBuf> {
        let directory = self.root().join("data").join("snapshots");
        fs::create_dir_all(&directory).await?;
        let path = directory.join(format!("{slug}-{timestamp}.html"));
        fs::write(&path, html.as_bytes()).await?;
        Ok(path)
    }

    pub async fn save_snapshot_markdown(
        &self,
        slug: &str,
        timestamp: i64,
        markdown: &str,
    ) -> io::Result<PathBuf> {
        let directory = self.root().join("data").join("snapshots");
        fs::create_dir_all(&directory).await?;
        let path = directory.join(format!("{slug}-{timestamp}.md"));
        fs::write(&path, markdown.as_bytes()).await?;
        Ok(path)
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

    pub async fn delete_snapshot(&self, slug: &str, timestamp: i64) -> io::Result<()> {
        remove_if_exists(self.snapshot_html_path(slug, timestamp)).await?;
        remove_if_exists(self.snapshot_markdown_path(slug, timestamp)).await?;
        Ok(())
    }

    pub async fn directory_size(&self) -> io::Result<u64> {
        let mut total = 0u64;
        let mut stack = vec![self.root().to_path_buf()];
        while let Some(dir) = stack.pop() {
            let mut entries = match fs::read_dir(&dir).await {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
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
        let mut entries = match fs::read_dir(self.root()).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.clear_cache();
                self.ensure_layout(device_id).await?;
                return Ok(0);
            }
            Err(error) => return Err(error),
        };

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
        let mut files = Vec::new();
        let cutoff = chrono::Local::now() - chrono::Duration::days(retention_days.max(0));
        let cutoff_str = format!(
            "{:04}-{:02}-{:02}",
            chrono::Datelike::year(&cutoff),
            chrono::Datelike::month(&cutoff),
            chrono::Datelike::day(&cutoff)
        );

        let logs_dir = self.root().join("data").join("logs").join(device_id);
        let mut log_entries = match fs::read_dir(&logs_dir).await {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if let Some(entries) = log_entries.as_mut() {
            while let Some(entry) = entries.next_entry().await? {
                if !entry.file_type().await?.is_file() {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let date_str = name.trim_end_matches(".jsonl");
                if date_str < cutoff_str.as_str() {
                    continue;
                }
                files.push((
                    format!("data/logs/{device_id}/{name}"),
                    fs::read_to_string(entry.path()).await?,
                ));
            }
        }

        let notes_dir = self.root().join("data").join("notes");
        let mut note_entries = match fs::read_dir(&notes_dir).await {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if let Some(entries) = note_entries.as_mut() {
            while let Some(entry) = entries.next_entry().await? {
                if !entry.file_type().await?.is_file() {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if !name.ends_with(".json") {
                    continue;
                }
                files.push((
                    format!("data/notes/{name}"),
                    fs::read_to_string(entry.path()).await?,
                ));
            }
        }

        Ok(files)
    }

    pub async fn write_sync_files(&self, files: &[(String, String)]) -> io::Result<()> {
        for (path, content) in files {
            let path = self.root().join(path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::write(path, content).await?;
        }
        Ok(())
    }

    pub async fn list_history_files(
        &self,
        include_sizes: bool,
    ) -> io::Result<(Vec<String>, Option<BTreeMap<String, u64>>)> {
        let logs_root = self.root().join("data").join("logs");
        let mut names = BTreeMap::new();
        let mut devices = match fs::read_dir(&logs_root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((Vec::new(), include_sizes.then(BTreeMap::new)));
            }
            Err(error) => return Err(error),
        };

        while let Some(device_entry) = devices.next_entry().await? {
            if !device_entry.file_type().await?.is_dir() {
                continue;
            }
            let mut files = fs::read_dir(device_entry.path()).await?;
            while let Some(file_entry) = files.next_entry().await? {
                if !file_entry.file_type().await?.is_file() {
                    continue;
                }
                let Some(name) = file_entry.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let size = file_entry.metadata().await?.len();
                *names.entry(name).or_insert(0) += size;
            }
        }

        let mut files: Vec<_> = names.keys().cloned().collect();
        files.reverse();
        let sizes = include_sizes.then_some(names);
        Ok((files, sizes))
    }

    pub async fn load_history_batch(&self, filenames: &[String]) -> io::Result<Vec<Value>> {
        let logs_root = self.root().join("data").join("logs");
        let wanted: std::collections::HashSet<&str> =
            filenames.iter().map(String::as_str).collect();
        let mut results = Vec::new();

        let mut devices = match fs::read_dir(&logs_root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(results),
            Err(error) => return Err(error),
        };

        while let Some(device_entry) = devices.next_entry().await? {
            if !device_entry.file_type().await?.is_dir() {
                continue;
            }
            let Some(device_id) = device_entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let mut files = fs::read_dir(device_entry.path()).await?;
            while let Some(file_entry) = files.next_entry().await? {
                if !file_entry.file_type().await?.is_file() {
                    continue;
                }
                let Some(name) = file_entry.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if !wanted.contains(name.as_str()) {
                    continue;
                }
                let raw = fs::read_to_string(file_entry.path()).await?;
                for line in raw.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let mut value: Value = match serde_json::from_str(line) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    if let Value::Object(object) = &mut value {
                        object.insert("deviceId".to_string(), Value::String(device_id.clone()));
                    }
                    results.push(value);
                }
            }
        }

        results.sort_by(|left, right| {
            let left_ts = left.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
            let right_ts = right.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
            left_ts.cmp(&right_ts)
        });

        Ok(results)
    }

    pub async fn load_all_pages(&self) -> io::Result<BTreeMap<String, PageEntity>> {
        let pages_dir = self.root().join("pages");
        let mut result = BTreeMap::new();
        let mut entries = match fs::read_dir(&pages_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(result),
            Err(error) => return Err(error),
        };

        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some(slug) = name.strip_suffix(".json").map(str::to_string) else {
                continue;
            };
            let raw = fs::read_to_string(entry.path()).await?;
            let page: PageEntity = serde_json::from_str(&raw).map_err(invalid_data)?;
            result.insert(slug, page);
        }

        Ok(result)
    }

    fn page_path(&self, slug: &str) -> PathBuf {
        self.root().join("pages").join(format!("{slug}.json"))
    }

    fn note_path(&self, slug: &str) -> PathBuf {
        self.root()
            .join("data")
            .join("notes")
            .join(format!("{slug}.json"))
    }

    fn list_path(&self, slug: &str) -> PathBuf {
        self.root().join("lists").join(format!("{slug}.json"))
    }

    fn manifest_path(&self, filename: &str) -> PathBuf {
        self.root().join("manifest").join(filename)
    }

    fn snapshot_html_path(&self, slug: &str, timestamp: i64) -> PathBuf {
        self.root()
            .join("data")
            .join("snapshots")
            .join(format!("{slug}-{timestamp}.html"))
    }

    fn snapshot_markdown_path(&self, slug: &str, timestamp: i64) -> PathBuf {
        self.root()
            .join("data")
            .join("snapshots")
            .join(format!("{slug}-{timestamp}.md"))
    }

    fn cache_get(&self, key: &str) -> Option<Option<Entity>> {
        self.inner
            .cache
            .lock()
            .expect("storage cache mutex poisoned")
            .get(key)
    }

    fn cache_put(&self, key: String, value: Option<Entity>) {
        self.inner
            .cache
            .lock()
            .expect("storage cache mutex poisoned")
            .put(key, value);
    }

    fn cache_remove(&self, key: &str) {
        self.inner
            .cache
            .lock()
            .expect("storage cache mutex poisoned")
            .remove(key);
    }

    fn clear_cache(&self) {
        let mut cache = self
            .inner
            .cache
            .lock()
            .expect("storage cache mutex poisoned");
        *cache = EntityCache::new(cache.capacity);
    }

    pub fn reset_cache(&self) {
        self.clear_cache();
    }
}

fn local_date(timestamp: i64) -> String {
    let datetime = Local
        .timestamp_millis_opt(timestamp)
        .single()
        .unwrap_or_else(|| {
            Local
                .with_ymd_and_hms(1970, 1, 1, 0, 0, 0)
                .earliest()
                .expect("epoch exists")
        });
    format!(
        "{:04}-{:02}-{:02}",
        chrono::Datelike::year(&datetime),
        chrono::Datelike::month(&datetime),
        chrono::Datelike::day(&datetime)
    )
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

    Ok(0)
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
    fs::write(path, payload).await
}
