use browser_recall_daemon::storage::Storage;
use browser_recall_replay::entities::{
    Entity, ListEntity, ListOrderManifest, NameToIdManifest, NoteEntity, OrphanedEntry,
    OrphanedManifest, PageEntity, PinEntity, SettingsEntity, TreeNode,
};
use browser_recall_replay::EntityEffect;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use tempfile::tempdir;

fn shard_for(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{:02x}", digest[0])
}

fn page_path(root: &Path, slug: &str) -> PathBuf {
    root.join("views")
        .join("pages")
        .join(shard_for(slug))
        .join(format!("{slug}.json"))
}

#[tokio::test]
async fn round_trips_all_entity_types_and_snapshot_artifacts() {
    let temp_dir = tempdir().expect("tempdir");
    let storage = Storage::new(temp_dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");

    let mut page = PageEntity::new("page-a".into());
    page.url = Some("https://example.com/page".into());
    page.title = Some("Example Page".into());
    page.child_ids = vec!["note:note-a".into(), "snapshot:page-a-1710000000000".into()];
    page.timestamps.insert("title".into(), 10);
    storage
        .save_page("page-a", &page)
        .await
        .expect("page saved");

    let note = NoteEntity {
        slug: "note-a".into(),
        excerpt: Some(serde_json::json!(["highlight"])),
        note: Some("annotation".into()),
        css_path: Some(serde_json::json!(["body > p"])),
        url: Some("https://example.com/page".into()),
        deleted: false,
        deleted_ts: None,
        deletion_reason: None,
        replaced_by: None,
    };
    storage
        .save_note("note-a", &note)
        .await
        .expect("note saved");

    let list = ListEntity {
        slug: "reading".into(),
        name: "Reading".into(),
        owner: "device-a".into(),
        pins: vec![PinEntity {
            id: "page:page-a".into(),
            pinned_at: 20,
            source: Some("manual".into()),
        }],
        rules: Vec::new(),
        timestamps: HashMap::from([(String::from("pins"), 20)]),
        deleted: false,
        deleted_ts: None,
    };
    storage
        .save_list("reading", &list)
        .await
        .expect("list saved");

    let settings = SettingsEntity {
        timestamps: HashMap::from([(String::from("theme"), 30)]),
        values: BTreeMap::from([(String::from("theme"), json!("sepia"))]),
    };
    storage
        .save_settings(&settings)
        .await
        .expect("settings saved");

    let name_to_id = NameToIdManifest {
        timestamps: HashMap::from([(String::from("device-a/Reading"), 40)]),
        paths: BTreeMap::from([(String::from("device-a/Reading"), String::from("reading"))]),
    };
    storage
        .save_name_to_id(&name_to_id)
        .await
        .expect("name-to-id saved");

    let list_order = ListOrderManifest {
        timestamps: HashMap::from([(String::from("tree"), 50)]),
        tree: vec![TreeNode {
            id: "list:reading".into(),
            children: Vec::new(),
        }],
    };
    storage
        .save_list_order(&list_order)
        .await
        .expect("list-order saved");

    let orphaned = OrphanedManifest {
        timestamps: HashMap::from([(String::from("entries"), 60)]),
        entries: vec![OrphanedEntry {
            key: "note:orphaned".into(),
            url: Some("https://example.com/orphaned".into()),
        }],
    };
    storage
        .save_orphaned(&orphaned)
        .await
        .expect("orphaned saved");

    let log_path = storage
        .append_log_entry(
            "device-a",
            1_710_000_000_000,
            &json!({
                "timestamp": 1_710_000_000_000i64,
                "action": "visit_page",
                "url": "https://example.com/page",
                "title": null,
                "referrerUrl": null
            }),
        )
        .await
        .expect("log appended");
    storage
        .save_snapshot_markdown("page-a", 1_710_000_000_000, "# snapshot")
        .await
        .expect("snapshot markdown saved");
    storage
        .save_snapshot_html(
            "page-a",
            1_710_000_000_000,
            "<html><body>snapshot</body></html>",
        )
        .await
        .expect("snapshot html saved");

    let page_shard = page_path(temp_dir.path(), "page-a")
        .parent()
        .expect("page shard")
        .to_path_buf();
    for path in [
        temp_dir.path().join("logs/.DS_Store"),
        temp_dir.path().join("logs/device-a/.DS_Store"),
        temp_dir.path().join("views/pages/.DS_Store"),
        page_shard.join("README.txt"),
        temp_dir.path().join("views/lists/.DS_Store"),
        temp_dir.path().join("objects/notes/.DS_Store"),
    ] {
        tokio::fs::write(path, "outside the owned namespace")
            .await
            .expect("unrelated file written");
    }
    tokio::fs::create_dir_all(temp_dir.path().join("views/pages/not-a-shard"))
        .await
        .expect("unrelated page directory written");
    tokio::fs::create_dir_all(temp_dir.path().join("objects/notes/unowned"))
        .await
        .expect("unrelated note directory written");

    assert_eq!(
        storage
            .load_entity("page:page-a")
            .await
            .expect("page loaded"),
        Some(Entity::Page(page))
    );
    assert_eq!(
        storage
            .load_entity("note:note-a")
            .await
            .expect("note loaded"),
        Some(Entity::Note(note))
    );
    assert_eq!(
        storage
            .load_entity("list:reading")
            .await
            .expect("list loaded"),
        Some(Entity::List(list))
    );
    assert_eq!(
        storage
            .load_entity("manifest:settings")
            .await
            .expect("settings loaded"),
        Some(Entity::Settings(settings))
    );
    assert_eq!(
        storage
            .load_entity("manifest:name-to-id")
            .await
            .expect("name-to-id loaded"),
        Some(Entity::NameToId(name_to_id))
    );
    assert_eq!(
        storage
            .load_entity("manifest:list-order")
            .await
            .expect("list-order loaded"),
        Some(Entity::ListOrder(list_order))
    );
    assert_eq!(
        storage
            .load_entity("manifest:orphaned")
            .await
            .expect("orphaned loaded"),
        Some(Entity::Orphaned(orphaned))
    );

    let log_raw = tokio::fs::read_to_string(log_path)
        .await
        .expect("log file exists");
    assert!(log_raw.contains("\"action\":\"visit_page\""));

    let snapshot_path = temp_dir
        .path()
        .join(storage.snapshot_sidecar_relative_path("page-a", 1_710_000_000_000));
    let snapshot_md = tokio::fs::read_to_string(snapshot_path.with_extension("md"))
        .await
        .expect("snapshot markdown exists");
    assert!(snapshot_md.contains("# snapshot"));

    let snapshot_html = tokio::fs::read_to_string(snapshot_path.with_extension("html"))
        .await
        .expect("snapshot html exists");
    assert!(snapshot_html.contains("snapshot"));

    assert_eq!(
        storage
            .load_log_entries_after_replay_progress()
            .await
            .expect("log scan ignores unrelated entries")
            .len(),
        1
    );
    assert_eq!(
        storage
            .load_all_pages()
            .await
            .expect("page scan ignores unrelated entries")
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec!["page-a".to_string()]
    );
    assert_eq!(
        storage
            .load_all_lists()
            .await
            .expect("list scan ignores unrelated entries")
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec!["reading".to_string()]
    );
}

#[tokio::test]
async fn load_all_pages_reflects_committed_cache_before_checkpoint_flush() {
    let temp_dir = tempdir().expect("tempdir");
    let storage = Storage::new(temp_dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");

    let mut cached_only = PageEntity::new("cached-only".into());
    cached_only.url = Some("https://example.com/cached-only".into());
    cached_only.title = Some("Cached Only".into());
    storage.apply_effect_to_cache(
        "page:cached-only",
        &EntityEffect::Upsert(Entity::Page(cached_only.clone())),
    );
    assert!(!page_path(temp_dir.path(), "cached-only").exists());

    let pages = storage.load_all_pages().await.expect("load all pages");
    assert_eq!(pages.get("cached-only"), Some(&cached_only));

    let mut stale_disk = PageEntity::new("stale-disk".into());
    stale_disk.url = Some("https://example.com/stale-disk".into());
    stale_disk.title = Some("Stale Disk".into());
    storage
        .save_page("stale-disk", &stale_disk)
        .await
        .expect("save stale disk page");
    storage.apply_effect_to_cache("page:stale-disk", &EntityEffect::Delete);

    let pages = storage.load_all_pages().await.expect("load all pages");
    assert!(!pages.contains_key("stale-disk"));
}

#[tokio::test]
async fn sync_file_roundtrip_collects_expected_files_and_refreshes_reads() {
    let temp_dir = tempdir().expect("tempdir");
    let storage = Storage::new(temp_dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");

    storage
        .save_sync_manifest("sync-cursors", &json!({"device-b": 123}))
        .await
        .expect("save sync manifest");
    assert_eq!(
        storage
            .load_sync_manifest("sync-cursors")
            .await
            .expect("load sync manifest"),
        Some(json!({"device-b": 123}))
    );

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    storage
        .write_sync_files(&[
            (
                format!("logs/device-a/{today}.jsonl"),
                [
                    serde_json::to_string(&json!({
                        "timestamp": 1_710_100_000_001i64,
                        "action": "visit_page",
                        "url": "https://example.com/sync-a",
                        "title": "Sync A",
                        "referrerUrl": null
                    }))
                    .expect("log json"),
                    String::new(),
                    "not json".to_string(),
                ]
                .join("\n"),
            ),
            (
                "logs/device-a/1999-01-01.jsonl".to_string(),
                serde_json::to_string(&json!({
                    "timestamp": 1i64,
                    "action": "visit_page",
                    "url": "https://example.com/old",
                    "title": "Old",
                    "referrerUrl": null
                }))
                .expect("old log json"),
            ),
            (
                format!("logs/device-b/{today}.jsonl"),
                serde_json::to_string(&json!({
                    "timestamp": 1_710_100_000_000i64,
                    "action": "visit_page",
                    "url": "https://example.com/sync-b",
                    "title": "Sync B",
                    "referrerUrl": null
                }))
                .expect("device-b log json"),
            ),
            (
                "objects/notes/sync-note.json".to_string(),
                serde_json::to_string(&NoteEntity {
                    slug: "sync-note".to_string(),
                    excerpt: Some(serde_json::json!(["remote excerpt"])),
                    note: Some("remote note".to_string()),
                    css_path: Some(serde_json::json!(["body > p"])),
                    url: Some("https://example.com/sync-a".to_string()),
                    deleted: false,
                    deleted_ts: None,
                    deletion_reason: None,
                    replaced_by: None,
                })
                .expect("note json"),
            ),
            (
                "objects/notes/ignored.tmp".to_string(),
                "ignored".to_string(),
            ),
            (
                "views/lists/remote.json".to_string(),
                serde_json::to_string(&ListEntity {
                    slug: "remote".to_string(),
                    name: "Remote".to_string(),
                    owner: "device-b".to_string(),
                    pins: Vec::new(),
                    rules: Vec::new(),
                    timestamps: HashMap::new(),
                    deleted: false,
                    deleted_ts: None,
                })
                .expect("list json"),
            ),
        ])
        .await
        .expect("write sync files");

    let loaded_note = storage
        .load_note("sync-note")
        .await
        .expect("load synced note")
        .expect("synced note exists");
    assert_eq!(loaded_note.note.as_deref(), Some("remote note"));

    let lists = storage.load_all_lists().await.expect("load all lists");
    assert_eq!(
        lists.get("remote").map(|list| list.name.as_str()),
        Some("Remote")
    );
    let missing_lists_error = Storage::new(temp_dir.path().join("missing"))
        .load_all_lists()
        .await
        .expect_err("missing list storage must be reported");
    assert_eq!(missing_lists_error.kind(), std::io::ErrorKind::NotFound);

    let listing = storage
        .list_history_files(true)
        .await
        .expect("list history files");
    assert_eq!(
        listing.files,
        vec![format!("{today}.jsonl"), "1999-01-01.jsonl".to_string()]
    );
    assert_eq!(
        listing.devices,
        vec!["device-a".to_string(), "device-b".to_string()]
    );
    let sizes = listing.sizes.expect("history sizes");
    assert!(
        sizes
            .get(&format!("{today}.jsonl"))
            .copied()
            .unwrap_or_default()
            > 0
    );

    let error = storage
        .load_history_batch(&[format!("{today}.jsonl")])
        .await
        .expect_err("blank JSONL records must fail the whole history read");
    assert!(error.to_string().contains("blank JSONL record"));

    storage
        .write_sync_files(&[(
            format!("logs/device-a/{today}.jsonl"),
            [
                serde_json::to_string(&json!({
                    "timestamp": 1_710_100_000_001i64,
                    "action": "visit_page",
                    "url": "https://example.com/sync-a",
                    "title": "Sync A",
                    "referrerUrl": null
                }))
                .expect("log json"),
                "not json".to_string(),
            ]
            .join("\n"),
        )])
        .await
        .expect("replace blank log");
    let error = storage
        .load_history_batch(&[format!("{today}.jsonl")])
        .await
        .expect_err("malformed JSONL must fail the whole history read");
    assert!(error.to_string().contains("invalid JSONL"));

    storage
        .write_sync_files(&[(
            format!("logs/device-a/{today}.jsonl"),
            serde_json::to_string(&json!({
                "timestamp": 1_710_100_000_001i64,
                "action": "visit_page",
                "url": "https://example.com/sync-a",
                "title": "Sync A",
                "referrerUrl": null
            }))
            .expect("replacement log json"),
        )])
        .await
        .expect("replace malformed log");
    let batch = storage
        .load_history_batch(&[format!("{today}.jsonl")])
        .await
        .expect("load repaired history batch");
    assert_eq!(batch.len(), 2);
    assert_eq!(
        batch
            .iter()
            .map(|value| value.get("deviceId").and_then(|id| id.as_str()).unwrap())
            .collect::<Vec<_>>(),
        vec!["device-b", "device-a"]
    );

    let collected = storage
        .collect_sync_files("device-a", 1)
        .await
        .expect("collect owned sync files while ignoring unrelated entries");
    let collected_paths = collected
        .iter()
        .map(|(path, _)| path.as_str())
        .collect::<Vec<_>>();
    assert!(collected_paths.contains(&format!("logs/device-a/{today}.jsonl").as_str()));
    assert!(!collected_paths.contains(&"logs/device-a/1999-01-01.jsonl"));
    assert!(collected_paths.contains(&"objects/notes/sync-note.json"));
    assert!(!collected_paths.contains(&"objects/notes/ignored.tmp"));

    let missing_storage = Storage::new(temp_dir.path().join("missing-storage"));
    let missing_sync_error = missing_storage
        .collect_sync_files("device-a", 1)
        .await
        .expect_err("missing sync storage must be reported");
    assert_eq!(missing_sync_error.kind(), std::io::ErrorKind::NotFound);

    let size = storage.directory_size().await.expect("directory size");
    assert!(size > 0);
    let cleared = storage
        .clear_all_data("device-a")
        .await
        .expect("clear all data");
    assert!(cleared > 0);
    assert_eq!(
        storage
            .directory_size()
            .await
            .expect("directory size after clear"),
        0
    );
    let clear_missing_error = missing_storage
        .clear_all_data("device-a")
        .await
        .expect_err("missing data root must be reported before destructive operations");
    assert_eq!(clear_missing_error.kind(), std::io::ErrorKind::NotFound);
}

#[tokio::test]
async fn snapshot_child_cleanup_and_checkpoint_errors_are_visible() {
    let temp_dir = tempdir().expect("tempdir");
    let storage = Storage::new(temp_dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");

    let retained_slug = "retained-snapshot-page";
    let deleted_slug = "deleted-snapshot-page";
    let timestamp = 1_710_200_000_000;
    let mut retained = PageEntity::new(retained_slug.to_string());
    retained.url = Some("https://example.com/retained-snapshot".to_string());
    retained.user_title = Some("Keep Me".to_string());
    retained.child_ids = vec![format!("snapshot:{retained_slug}-{timestamp}")];
    storage
        .save_page(retained_slug, &retained)
        .await
        .expect("save retained page");
    let mut deleted = PageEntity::new(deleted_slug.to_string());
    deleted.url = Some("https://example.com/deleted-snapshot".to_string());
    deleted.child_ids = vec![format!("snapshot:{deleted_slug}-{timestamp}")];
    storage
        .save_page(deleted_slug, &deleted)
        .await
        .expect("save deleted page");
    storage
        .save_snapshot_html(retained_slug, timestamp, "<html>retained</html>")
        .await
        .expect("save retained html");
    storage
        .save_snapshot_markdown(retained_slug, timestamp, "retained md")
        .await
        .expect("save retained md");
    storage
        .save_snapshot_html(deleted_slug, timestamp, "<html>deleted</html>")
        .await
        .expect("save deleted html");

    storage
        .delete_snapshot(retained_slug, timestamp)
        .await
        .expect("delete retained snapshot");
    storage
        .delete_snapshot(deleted_slug, timestamp)
        .await
        .expect("delete deleted snapshot");

    assert_eq!(
        storage
            .load_snapshot_html(retained_slug, timestamp)
            .await
            .expect("load deleted retained html"),
        None
    );
    let retained_after = storage
        .load_page(retained_slug)
        .await
        .expect("load retained page")
        .expect("retained page remains because user title is durable");
    assert!(retained_after.child_ids.is_empty());
    assert!(
        storage
            .load_page(deleted_slug)
            .await
            .expect("load unretained page")
            .is_none(),
        "removing the only snapshot child should delete an unretained page checkpoint"
    );

    let checkpoint_storage = Storage::new(temp_dir.path().join("checkpoint-error"));
    checkpoint_storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");
    let blocking_path = checkpoint_storage
        .root()
        .join("views")
        .join("manifest")
        .join("settings.json");
    tokio::fs::create_dir_all(&blocking_path)
        .await
        .expect("create directory where settings file should be");
    let mut settings = SettingsEntity::new();
    settings
        .values
        .insert("theme".to_string(), serde_json::json!(["dark"]));
    checkpoint_storage
        .persist_checkpoint_effect(
            "manifest:settings",
            &EntityEffect::Upsert(Entity::Settings(settings)),
        )
        .await
        .expect_err("directory collision should fail checkpoint write");

    let permit = checkpoint_storage
        .reserve_checkpoint_slot()
        .await
        .expect("reserve checkpoint slot");
    let mut batch = BTreeMap::new();
    batch.insert(
        "manifest:settings".to_string(),
        EntityEffect::Upsert(Entity::Settings(SettingsEntity::new())),
    );
    Storage::send_reserved_checkpoint_work(permit, batch, BTreeMap::new());
    let error = checkpoint_storage
        .flush_checkpoints()
        .await
        .expect_err("worker checkpoint error is surfaced");
    assert!(error.to_string().contains("checkpoint persistence failed"));
    assert!(checkpoint_storage.reserve_checkpoint_slot().await.is_err());
}

#[tokio::test]
async fn checkpoint_worker_persists_only_user_retained_pages() {
    let temp_dir = tempdir().expect("tempdir");
    let storage = Storage::new(temp_dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");

    let mut visit_only = PageEntity::new("visit-only".into());
    visit_only.url = Some("https://example.com/visit-only".into());
    visit_only.title = Some("Visit Only".into());
    storage
        .persist_checkpoint_effect(
            "page:visit-only",
            &EntityEffect::Upsert(Entity::Page(visit_only)),
        )
        .await
        .expect("visit-only checkpoint effect persisted");
    assert!(!page_path(temp_dir.path(), "visit-only").exists());

    let mut retained = PageEntity::new("retained".into());
    retained.url = Some("https://example.com/retained".into());
    retained.title = Some("Retained".into());
    retained.parent_ids = vec!["list:reading".into()];
    storage
        .persist_checkpoint_effect(
            "page:retained",
            &EntityEffect::Upsert(Entity::Page(retained.clone())),
        )
        .await
        .expect("retained checkpoint effect persisted");
    assert!(page_path(temp_dir.path(), "retained").exists());

    retained.parent_ids.clear();
    storage
        .persist_checkpoint_effect(
            "page:retained",
            &EntityEffect::Upsert(Entity::Page(retained)),
        )
        .await
        .expect("unretained checkpoint effect persisted");
    assert!(!page_path(temp_dir.path(), "retained").exists());
}

#[tokio::test]
async fn concurrent_writes_to_different_entities_do_not_corrupt_files() {
    let temp_dir = tempdir().expect("tempdir");
    let storage = Storage::new(temp_dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");

    let mut page = PageEntity::new("page-a".into());
    page.url = Some("https://example.com/page".into());
    page.title = Some("Concurrent Page".into());

    let note = NoteEntity {
        slug: "note-a".into(),
        excerpt: Some(serde_json::json!(["concurrent"])),
        note: Some("annotation".into()),
        css_path: None,
        url: Some("https://example.com/page".into()),
        deleted: false,
        deleted_ts: None,
        deletion_reason: None,
        replaced_by: None,
    };

    let mut settings = SettingsEntity::new();
    settings.values.insert("theme".into(), json!("sepia"));
    let rename_entry = json!({
        "timestamp": 1_710_000_000_100i64,
        "action": "rename_page",
        "url": "https://example.com/page",
        "user_title": "Concurrent Page"
    });

    tokio::try_join!(
        storage.save_page("page-a", &page),
        storage.save_note("note-a", &note),
        storage.save_settings(&settings),
        storage.append_log_entry("device-a", 1_710_000_000_100, &rename_entry),
        storage.save_snapshot_markdown("page-a", 1_710_000_000_100, "concurrent snapshot"),
    )
    .expect("concurrent writes succeed");

    assert_eq!(
        storage.load_page("page-a").await.expect("page loaded"),
        Some(page)
    );
    assert_eq!(
        storage.load_note("note-a").await.expect("note loaded"),
        Some(note)
    );
    assert_eq!(
        storage
            .load_settings()
            .await
            .expect("settings loaded")
            .expect("settings present")
            .values
            .get("theme"),
        Some(&json!("sepia"))
    );
}

#[tokio::test]
async fn entity_cache_serves_repeat_reads_and_invalidates_on_write_delete() {
    let temp_dir = tempdir().expect("tempdir");
    let storage = Storage::new(temp_dir.path());
    storage
        .ensure_layout("device-a")
        .await
        .expect("layout created");

    let mut page = PageEntity::new("page-a".into());
    page.url = Some("https://example.com/page".into());
    page.title = Some("Cached Title".into());
    storage
        .save_page("page-a", &page)
        .await
        .expect("page saved");

    let cached = storage
        .load_page("page-a")
        .await
        .expect("page loads")
        .expect("page present");
    assert_eq!(cached.title.as_deref(), Some("Cached Title"));

    let path = page_path(temp_dir.path(), "page-a");
    let mut mutated = page.clone();
    mutated.title = Some("Disk Mutation".into());
    tokio::fs::write(
        &path,
        serde_json::to_vec_pretty(&mutated).expect("page json"),
    )
    .await
    .expect("page mutated on disk");

    let still_cached = storage
        .load_page("page-a")
        .await
        .expect("cached page loads")
        .expect("page present");
    assert_eq!(still_cached.title.as_deref(), Some("Cached Title"));

    storage
        .save_page("page-a", &mutated)
        .await
        .expect("page resaved");
    let refreshed = storage
        .load_page("page-a")
        .await
        .expect("page reloads")
        .expect("page present");
    assert_eq!(refreshed.title.as_deref(), Some("Disk Mutation"));
}
