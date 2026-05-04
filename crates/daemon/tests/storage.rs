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
        excerpt: Some("highlight".into()),
        note: Some("annotation".into()),
        css_path: Some("body > p".into()),
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
        owner: Some("device-a".into()),
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
                "url": "https://example.com/page"
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
        excerpt: Some("concurrent".into()),
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
