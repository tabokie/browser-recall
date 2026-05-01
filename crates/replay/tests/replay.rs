use browser_recall_replay::entities::{
    Entity, ListEntity, ListOrderManifest, NameToIdManifest, NoteEntity, OrphanedEntry,
    OrphanedManifest, PageEntity, PinEntity, RuleEntity, TreeNode,
};
use browser_recall_replay::RuleInput;
use browser_recall_replay::{effect_of, generate_slug_from_url, Context, EntityEffect, LogEntry};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::future::ready;

fn context() -> Context {
    Context {
        device_id: "test-device".to_string(),
    }
}

fn context_with_device(device_id: &str) -> Context {
    Context {
        device_id: device_id.to_string(),
    }
}

fn page(slug: &str) -> PageEntity {
    PageEntity::new(slug.to_string())
}

fn note(slug: &str, url: &str) -> NoteEntity {
    let mut note = NoteEntity::new(slug.to_string());
    note.url = Some(url.to_string());
    note
}

fn list(slug: &str, name: &str) -> ListEntity {
    let mut list = ListEntity::new(slug.to_string());
    list.name = name.to_string();
    list.owner = Some("test-device".to_string());
    list
}

fn load_from(
    store: BTreeMap<String, Entity>,
) -> impl Fn(&str) -> std::future::Ready<Option<Entity>> {
    move |key| ready(store.get(key).cloned())
}

fn apply_effects(store: &mut BTreeMap<String, Entity>, effects: BTreeMap<String, EntityEffect>) {
    for (key, effect) in effects {
        match effect {
            EntityEffect::Upsert(entity) => {
                store.insert(key, entity);
            }
            EntityEffect::Delete => {
                store.remove(&key);
            }
        }
    }
}

async fn replay_sequence(
    mut store: BTreeMap<String, Entity>,
    steps: Vec<(LogEntry, Context)>,
) -> BTreeMap<String, Entity> {
    for (entry, replay_context) in steps {
        let effects = effect_of(entry, load_from(store.clone()), replay_context)
            .await
            .expect("sequence replay succeeds");
        apply_effects(&mut store, effects);
    }
    store
}

fn permutations<T: Clone>(items: &[T]) -> Vec<Vec<T>> {
    if items.is_empty() {
        return vec![Vec::new()];
    }

    let mut result = Vec::new();
    for index in 0..items.len() {
        let mut rest = items.to_vec();
        let head = rest.remove(index);
        for mut tail in permutations(&rest) {
            let mut permutation = Vec::with_capacity(items.len());
            permutation.push(head.clone());
            permutation.append(&mut tail);
            result.push(permutation);
        }
    }
    result
}

fn collect_tree_ids(nodes: &[TreeNode]) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for node in nodes {
        ids.insert(node.id.clone());
        ids.extend(collect_tree_ids(&node.children));
    }
    ids
}

#[tokio::test]
async fn visit_page_enriches_existing_page() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(page(&slug)));

    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            title: Some("A".to_string()),
            referrer_url: None,
            checkpoint: false,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("visit replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page written");
    assert_eq!(page.url.as_deref(), Some("https://a.com"));
    assert_eq!(page.title.as_deref(), Some("A"));
    assert_eq!(page.timestamps.get("test-device"), Some(&100));
}

#[tokio::test]
async fn visit_page_adds_visit_date() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(page(&slug)));

    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 1_710_000_000_000,
            url: "https://a.com".to_string(),
            title: None,
            referrer_url: None,
            checkpoint: false,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("visit replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page written");
    assert_eq!(page.visit_dates.len(), 1);
}

#[tokio::test]
async fn visit_page_without_checkpoint_does_not_create_page() {
    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            title: Some("A".to_string()),
            referrer_url: None,
            checkpoint: false,
        },
        |_| ready(None),
        context(),
    )
    .await
    .expect("visit replay succeeds");

    assert!(result.is_empty());
}

#[tokio::test]
async fn visit_page_checkpoint_creates_page() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            title: Some("A".to_string()),
            referrer_url: None,
            checkpoint: true,
        },
        |_| ready(None),
        context(),
    )
    .await
    .expect("checkpoint replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    assert_eq!(page.created_at, Some(100));
    assert_eq!(page.url.as_deref(), Some("https://a.com"));
}

#[tokio::test]
async fn visit_page_updates_referrer_relationships() {
    let child_slug = generate_slug_from_url("https://child.com").expect("slug");
    let parent_slug = generate_slug_from_url("https://parent.com").expect("slug");
    let child_key = format!("page:{child_slug}");
    let parent_key = format!("page:{parent_slug}");
    let mut store = BTreeMap::new();
    store.insert(child_key.clone(), Entity::Page(page(&child_slug)));
    store.insert(parent_key.clone(), Entity::Page(page(&parent_slug)));

    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: "https://child.com".to_string(),
            title: Some("Child".to_string()),
            referrer_url: Some("https://parent.com".to_string()),
            checkpoint: false,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("referrer replay succeeds");

    let child = result
        .get(&child_key)
        .and_then(EntityEffect::as_page)
        .expect("child updated");
    let parent = result
        .get(&parent_key)
        .and_then(EntityEffect::as_page)
        .expect("parent updated");
    assert!(child.parent_ids.contains(&parent_key));
    assert!(parent.child_ids.contains(&child_key));
}

#[tokio::test]
async fn checkpoint_enriches_existing_page_without_overwriting_created_at() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut existing = page(&slug);
    existing.created_at = Some(50);
    existing.url = Some("https://a.com".to_string());
    let store = BTreeMap::from([(key.clone(), Entity::Page(existing))]);

    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            title: Some("Checkpointed".to_string()),
            referrer_url: None,
            checkpoint: true,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("checkpoint replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page written");
    assert_eq!(page.created_at, Some(50));
    assert_eq!(page.title.as_deref(), Some("Checkpointed"));
}

#[tokio::test]
async fn leave_page_accumulates_attention_once_per_device_timestamp() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.timestamps.insert("test-device".to_string(), 100);
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(seeded));

    let result = effect_of(
        LogEntry::LeavePage {
            timestamp: 200,
            url: "https://a.com".to_string(),
            title: None,
            scroll_depth: Some(80),
            time_on_page: Some(5000),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("leave replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.scroll_depth, Some(80));
    assert_eq!(page.time_on_page, Some(5000));
    assert_eq!(page.timestamps.get("test-device"), Some(&200));
}

#[tokio::test]
async fn leave_page_preserves_additive_fields_when_timestamp_already_applied() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.scroll_depth = Some(30);
    seeded.time_on_page = Some(2000);
    seeded.timestamps.insert("test-device".to_string(), 100);
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(seeded));

    let result = effect_of(
        LogEntry::LeavePage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            title: None,
            scroll_depth: Some(50),
            time_on_page: Some(1000),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("leave replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.scroll_depth, Some(30));
    assert_eq!(page.time_on_page, Some(2000));
    assert_eq!(page.timestamps.get("test-device"), Some(&100));
}

#[tokio::test]
async fn leave_page_preserves_higher_existing_timestamp() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.timestamps.insert("test-device".to_string(), 500);
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(seeded));

    let result = effect_of(
        LogEntry::LeavePage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            title: Some("B".to_string()),
            scroll_depth: None,
            time_on_page: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("leave replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.timestamps.get("test-device"), Some(&500));
}

#[tokio::test]
async fn leave_page_updates_title_and_accumulates_time() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.url = Some("https://a.com".to_string());
    seeded.time_on_page = Some(1000);
    seeded.timestamps.insert("test-device".to_string(), 50);
    let base = BTreeMap::from([(key.clone(), Entity::Page(seeded))]);

    let replayed = replay_sequence(
        base,
        vec![
            (
                LogEntry::LeavePage {
                    timestamp: 100,
                    url: "https://a.com".to_string(),
                    title: Some("Page B".to_string()),
                    scroll_depth: Some(20),
                    time_on_page: Some(500),
                },
                context(),
            ),
            (
                LogEntry::LeavePage {
                    timestamp: 200,
                    url: "https://a.com".to_string(),
                    title: Some("Page C".to_string()),
                    scroll_depth: Some(50),
                    time_on_page: Some(800),
                },
                context(),
            ),
        ],
    )
    .await;

    let page = match replayed.get(&key) {
        Some(Entity::Page(page)) => page,
        _ => panic!("page missing"),
    };
    assert_eq!(page.title.as_deref(), Some("Page C"));
    assert_eq!(page.scroll_depth, Some(50));
    assert_eq!(page.time_on_page, Some(2300));
}

#[tokio::test]
async fn create_snapshot_creates_page_and_links_child() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let result = effect_of(
        LogEntry::CreateSnapshot {
            timestamp: 1000,
            url: "https://a.com".to_string(),
            path: format!("snapshots/{slug}-1000"),
            title: Some("Snap Title".to_string()),
        },
        |_| ready(None),
        context(),
    )
    .await
    .expect("snapshot replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    assert!(page.child_ids.contains(&format!("snapshot:{slug}-1000")));
    assert_eq!(page.title.as_deref(), Some("Snap Title"));
}

#[tokio::test]
async fn create_snapshot_appends_to_existing_child_ids() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut existing = page(&slug);
    existing.url = Some("https://a.com".to_string());
    existing.child_ids = vec!["note:n1".to_string()];
    let store = BTreeMap::from([(page_key.clone(), Entity::Page(existing))]);

    let result = effect_of(
        LogEntry::CreateSnapshot {
            timestamp: 1000,
            url: "https://a.com".to_string(),
            path: format!("snapshots/{slug}-1000"),
            title: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("snapshot replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert!(page.child_ids.contains(&"note:n1".to_string()));
    assert!(page.child_ids.contains(&format!("snapshot:{slug}-1000")));
}

#[tokio::test]
async fn create_snapshot_preserves_existing_created_at() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut existing = page(&slug);
    existing.created_at = Some(50);
    existing.url = Some("https://a.com".to_string());
    let store = BTreeMap::from([(page_key.clone(), Entity::Page(existing))]);

    let result = effect_of(
        LogEntry::CreateSnapshot {
            timestamp: 1000,
            url: "https://a.com".to_string(),
            path: format!("snapshots/{slug}-1000"),
            title: Some("Ignored".to_string()),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("snapshot replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.created_at, Some(50));
}

#[tokio::test]
async fn rename_page_creates_page_and_sets_user_title() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let result = effect_of(
        LogEntry::RenamePage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            user_title: "Custom".to_string(),
        },
        |_| ready(None),
        context(),
    )
    .await
    .expect("rename replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    assert_eq!(page.user_title.as_deref(), Some("Custom"));
    assert_eq!(page.created_at, Some(100));
}

#[tokio::test]
async fn rename_page_preserves_higher_existing_timestamp() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.url = Some("https://a.com".to_string());
    seeded.timestamps.insert("test-device".to_string(), 500);
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(seeded));

    let result = effect_of(
        LogEntry::RenamePage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            user_title: "Renamed".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("rename replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.timestamps.get("test-device"), Some(&500));
}

#[tokio::test]
async fn rate_page_accumulates_likes_for_newer_event() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.likes = Some(3);
    seeded.title = Some("Existing Title".to_string());
    seeded.timestamps.insert("test-device".to_string(), 100);
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(seeded));

    let result = effect_of(
        LogEntry::RatePage {
            timestamp: 200,
            url: "https://a.com".to_string(),
            likes: -1,
            title: Some("Page A".to_string()),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("rate replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.likes, Some(2));
    assert_eq!(page.title.as_deref(), Some("Existing Title"));
}

#[tokio::test]
async fn rate_page_applies_title_when_creating_new_entity() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");

    let result = effect_of(
        LogEntry::RatePage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            likes: 1,
            title: Some("Page A".to_string()),
        },
        |_| ready(None),
        context(),
    )
    .await
    .expect("rate replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    assert_eq!(page.likes, Some(1));
    assert_eq!(page.title.as_deref(), Some("Page A"));
}

#[tokio::test]
async fn rate_page_skips_duplicate_device_timestamp() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.likes = Some(3);
    seeded.timestamps.insert("test-device".to_string(), 100);
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(seeded));

    let result = effect_of(
        LogEntry::RatePage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            likes: 1,
            title: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("rate replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.likes, Some(3));
}

#[tokio::test]
async fn rate_page_preserves_higher_existing_timestamp() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.url = Some("https://a.com".to_string());
    seeded.timestamps.insert("test-device".to_string(), 500);
    let mut store = BTreeMap::new();
    store.insert(key.clone(), Entity::Page(seeded));

    let result = effect_of(
        LogEntry::RatePage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            likes: 1,
            title: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("rate replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.timestamps.get("test-device"), Some(&500));
}

#[tokio::test]
async fn create_note_creates_page_and_links_note_entity() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let result = effect_of(
        LogEntry::CreateNote {
            timestamp: 100,
            url: "https://a.com".to_string(),
            path: "notes/n1.json".to_string(),
            title: Some("Note Page".to_string()),
            excerpt: Some("hello".to_string()),
            note: Some("world".to_string()),
            css_path: Some("body > p".to_string()),
        },
        |_| ready(None),
        context(),
    )
    .await
    .expect("note replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    let note = result
        .get("note:n1")
        .and_then(EntityEffect::as_note)
        .expect("note created");
    assert!(page.child_ids.contains(&"note:n1".to_string()));
    assert_eq!(page.title.as_deref(), Some("Note Page"));
    assert_eq!(note.url.as_deref(), Some("https://a.com"));
    assert_eq!(note.excerpt.as_deref(), Some("hello"));
    assert_eq!(note.note.as_deref(), Some("world"));
    assert_eq!(note.css_path.as_deref(), Some("body > p"));
}

#[tokio::test]
async fn create_note_links_note_on_existing_page() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut existing = page(&slug);
    existing.url = Some("https://a.com".to_string());
    existing.child_ids = vec!["snapshot:other".to_string()];
    let store = BTreeMap::from([(page_key.clone(), Entity::Page(existing))]);

    let result = effect_of(
        LogEntry::CreateNote {
            timestamp: 100,
            url: "https://a.com".to_string(),
            path: "notes/n1.json".to_string(),
            title: None,
            excerpt: None,
            note: None,
            css_path: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("note replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert!(page.child_ids.contains(&"snapshot:other".to_string()));
    assert!(page.child_ids.contains(&"note:n1".to_string()));
}

#[tokio::test]
async fn create_note_preserves_existing_created_at() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut existing = page(&slug);
    existing.created_at = Some(50);
    existing.url = Some("https://a.com".to_string());
    let store = BTreeMap::from([(page_key.clone(), Entity::Page(existing))]);

    let result = effect_of(
        LogEntry::CreateNote {
            timestamp: 100,
            url: "https://a.com".to_string(),
            path: "notes/n1.json".to_string(),
            title: Some("Ignored".to_string()),
            excerpt: None,
            note: None,
            css_path: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("note replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.created_at, Some(50));
}

#[tokio::test]
async fn delete_note_unlinks_note_and_tombstones_ineligible_page() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut seeded_page = page(&slug);
    seeded_page.child_ids = vec!["note:n1".to_string()];
    let mut store = BTreeMap::new();
    store.insert(page_key.clone(), Entity::Page(seeded_page));
    store.insert(
        "note:n1".to_string(),
        Entity::Note(NoteEntity {
            slug: "n1".to_string(),
            excerpt: Some("hello".to_string()),
            note: Some("world".to_string()),
            css_path: None,
            url: Some("https://a.com".to_string()),
            deleted: false,
            deleted_ts: None,
            deletion_reason: None,
            replaced_by: None,
        }),
    );

    let result = effect_of(
        LogEntry::DeleteNote {
            timestamp: 200,
            url: Some("https://a.com".to_string()),
            path: "notes/n1.json".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("delete note replay succeeds");

    let note = result
        .get("note:n1")
        .and_then(EntityEffect::as_note)
        .expect("note tombstone written");
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert!(note.deleted);
    assert_eq!(note.deleted_ts, Some(200));
    assert!(result.get(&page_key).expect("page effect").is_delete());
    assert!(orphaned
        .entries
        .iter()
        .any(|entry| { entry.key == "note:n1" && entry.url.as_deref() == Some("https://a.com") }));
}

#[tokio::test]
async fn delete_note_removes_note_pins_from_lists() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut seeded_page = page(&slug);
    seeded_page.url = Some("https://a.com".to_string());
    seeded_page.child_ids = vec!["note:n1".to_string()];
    seeded_page.user_title = Some("Kept".to_string());

    let mut pinned_list = list("test-id", "Test");
    pinned_list.pins = vec![PinEntity {
        id: "note:n1".to_string(),
        pinned_at: 50,
        source: None,
    }];

    let store = BTreeMap::from([
        (page_key.clone(), Entity::Page(seeded_page)),
        (
            "note:n1".to_string(),
            Entity::Note(note("n1", "https://a.com")),
        ),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        ("list:test-id".to_string(), Entity::List(pinned_list)),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);

    let result = effect_of(
        LogEntry::DeleteNote {
            timestamp: 100,
            url: Some("https://a.com".to_string()),
            path: "notes/n1.json".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("delete note replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page retained");
    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    assert!(!page.child_ids.contains(&"note:n1".to_string()));
    assert!(list.pins.is_empty());
}

#[tokio::test]
async fn delete_note_noops_when_deleted_timestamp_is_newer() {
    let mut deleted = note("n1", "https://a.com");
    deleted.deleted = true;
    deleted.deleted_ts = Some(200);

    let store = BTreeMap::from([
        ("note:n1".to_string(), Entity::Note(deleted)),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![OrphanedEntry {
                    key: "note:n1".to_string(),
                    url: Some("https://a.com".to_string()),
                }],
            }),
        ),
    ]);

    let result = effect_of(
        LogEntry::DeleteNote {
            timestamp: 200,
            url: Some("https://a.com".to_string()),
            path: "notes/n1.json".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("delete note replay succeeds");

    assert!(result.is_empty());
}

#[tokio::test]
async fn restore_note_relinks_and_clears_deleted_flag() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut store = BTreeMap::new();
    store.insert(page_key.clone(), Entity::Page(page(&slug)));
    store.insert(
        "note:n1".to_string(),
        Entity::Note(NoteEntity {
            slug: "n1".to_string(),
            excerpt: Some("hello".to_string()),
            note: Some("world".to_string()),
            css_path: None,
            url: Some("https://a.com".to_string()),
            deleted: true,
            deleted_ts: Some(100),
            deletion_reason: None,
            replaced_by: None,
        }),
    );
    store.insert(
        "manifest:orphaned".to_string(),
        Entity::Orphaned(OrphanedManifest {
            timestamps: Default::default(),
            entries: vec![OrphanedEntry {
                key: "note:n1".to_string(),
                url: Some("https://a.com".to_string()),
            }],
        }),
    );

    let result = effect_of(
        LogEntry::RestoreNote {
            timestamp: 200,
            url: Some("https://a.com".to_string()),
            path: "notes/n1.json".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("restore note replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page relinked");
    let note = result
        .get("note:n1")
        .and_then(EntityEffect::as_note)
        .expect("note restored");
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert!(page.child_ids.contains(&"note:n1".to_string()));
    assert!(!note.deleted);
    assert_eq!(note.deleted_ts, Some(200));
    assert!(!orphaned.entries.iter().any(|entry| entry.key == "note:n1"));
}

#[tokio::test]
async fn replace_note_links_new_note_and_deletes_old_note() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut seeded_page = page(&slug);
    seeded_page.child_ids = vec!["note:n1".to_string()];
    let mut store = BTreeMap::new();
    store.insert(page_key.clone(), Entity::Page(seeded_page));
    store.insert(
        "note:n1".to_string(),
        Entity::Note(NoteEntity {
            slug: "n1".to_string(),
            excerpt: Some("old excerpt".to_string()),
            note: Some("old body".to_string()),
            css_path: Some("body > p".to_string()),
            url: Some("https://a.com".to_string()),
            deleted: false,
            deleted_ts: None,
            deletion_reason: None,
            replaced_by: None,
        }),
    );
    let result = effect_of(
        LogEntry::ReplaceNote {
            timestamp: 200,
            url: Some("https://a.com".to_string()),
            path: "notes/n2.json".to_string(),
            old_path: "notes/n1.json".to_string(),
            excerpt: Some("old excerpt".to_string()),
            note: Some("new body".to_string()),
            css_path: Some("body > p".to_string()),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("replace note replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    let new_note = result
        .get("note:n2")
        .and_then(EntityEffect::as_note)
        .expect("new note written");
    assert!(!page.child_ids.contains(&"note:n1".to_string()));
    assert!(page.child_ids.contains(&"note:n2".to_string()));
    assert!(result.get("note:n1").expect("old note deleted").is_delete());
    assert_eq!(new_note.url.as_deref(), Some("https://a.com"));
    assert_eq!(new_note.excerpt.as_deref(), Some("old excerpt"));
    assert_eq!(new_note.note.as_deref(), Some("new body"));
    assert_eq!(new_note.css_path.as_deref(), Some("body > p"));
}

#[tokio::test]
async fn replace_note_transfers_pins_and_removes_old_note_from_recycle_bin() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.child_ids = vec!["note:n1".to_string()];

    let mut pinned_list = list("test-id", "Test");
    pinned_list.pins = vec![PinEntity {
        id: "note:n1".to_string(),
        pinned_at: 50,
        source: None,
    }];

    let store = BTreeMap::from([
        (page_key, Entity::Page(page)),
        (
            "note:n1".to_string(),
            Entity::Note(note("n1", "https://a.com")),
        ),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        ("list:test-id".to_string(), Entity::List(pinned_list)),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);

    let result = effect_of(
        LogEntry::ReplaceNote {
            timestamp: 100,
            url: Some("https://a.com".to_string()),
            path: "notes/n2.json".to_string(),
            old_path: "notes/n1.json".to_string(),
            excerpt: Some("new excerpt".to_string()),
            note: Some("new body".to_string()),
            css_path: Some("body > p".to_string()),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("replace note replay succeeds");

    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert!(list.pins.iter().any(|pin| pin.id == "note:n2"));
    assert!(!list.pins.iter().any(|pin| pin.id == "note:n1"));
    assert!(!orphaned.entries.iter().any(|entry| entry.key == "note:n1"));
    assert!(result.get("note:n1").expect("old note deleted").is_delete());
}

#[tokio::test]
async fn replace_note_proceeds_when_old_note_was_already_deleted() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());

    let mut old_note = note("n1", "https://a.com");
    old_note.deleted = true;
    old_note.deleted_ts = Some(50);

    let store = BTreeMap::from([
        (page_key.clone(), Entity::Page(page)),
        ("note:n1".to_string(), Entity::Note(old_note)),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![OrphanedEntry {
                    key: "note:n1".to_string(),
                    url: Some("https://a.com".to_string()),
                }],
            }),
        ),
    ]);

    let result = effect_of(
        LogEntry::ReplaceNote {
            timestamp: 100,
            url: Some("https://a.com".to_string()),
            path: "notes/n2.json".to_string(),
            old_path: "notes/n1.json".to_string(),
            excerpt: Some("new excerpt".to_string()),
            note: Some("new body".to_string()),
            css_path: Some("body > p".to_string()),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("replace note replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    let new_note = result
        .get("note:n2")
        .and_then(EntityEffect::as_note)
        .expect("new note created");
    assert!(page.child_ids.contains(&"note:n2".to_string()));
    assert!(result.get("note:n1").expect("old note deleted").is_delete());
    assert_eq!(new_note.url.as_deref(), Some("https://a.com"));
}

#[tokio::test]
async fn replace_note_replay_is_idempotent() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.child_ids = vec!["note:n1".to_string()];
    let base = BTreeMap::from([
        (page_key.clone(), Entity::Page(page)),
        (
            "note:n1".to_string(),
            Entity::Note(note("n1", "https://a.com")),
        ),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let entry = LogEntry::ReplaceNote {
        timestamp: 100,
        url: Some("https://a.com".to_string()),
        path: "notes/n2.json".to_string(),
        old_path: "notes/n1.json".to_string(),
        excerpt: Some("new excerpt".to_string()),
        note: Some("new body".to_string()),
        css_path: Some("body > p".to_string()),
    };

    let replayed =
        replay_sequence(base, vec![(entry.clone(), context()), (entry, context())]).await;

    let page = match replayed.get(&page_key) {
        Some(Entity::Page(page)) => page,
        _ => panic!("page missing"),
    };
    let orphaned = match replayed.get("manifest:orphaned") {
        Some(Entity::Orphaned(manifest)) => manifest,
        _ => panic!("orphaned manifest missing"),
    };
    assert_eq!(
        page.child_ids
            .iter()
            .filter(|child| child.as_str() == "note:n2")
            .count(),
        1
    );
    assert!(!page.child_ids.contains(&"note:n1".to_string()));
    assert!(!replayed.contains_key("note:n1"));
    assert!(!orphaned.entries.iter().any(|entry| entry.key == "note:n1"));
}

#[tokio::test]
async fn delete_snapshot_tombstones_page_when_last_retention_signal_is_removed() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut seeded_page = page(&slug);
    seeded_page.child_ids = vec![format!("snapshot:{slug}-1000")];
    let mut store = BTreeMap::new();
    store.insert(page_key.clone(), Entity::Page(seeded_page));

    let result = effect_of(
        LogEntry::DeleteSnapshot {
            timestamp: 200,
            url: "https://a.com".to_string(),
            path: format!("snapshots/{slug}-1000"),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("delete snapshot replay succeeds");

    assert!(result.get(&page_key).expect("page effect").is_delete());
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert!(orphaned.entries.iter().any(|entry| {
        entry.key == format!("snapshot:{slug}-1000")
            && entry.url.as_deref() == Some("https://a.com")
    }));
}

#[tokio::test]
async fn restore_snapshot_relinks_child_on_page() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut store = BTreeMap::new();
    store.insert(page_key.clone(), Entity::Page(page(&slug)));
    store.insert(
        "manifest:orphaned".to_string(),
        Entity::Orphaned(OrphanedManifest {
            timestamps: Default::default(),
            entries: vec![OrphanedEntry {
                key: format!("snapshot:{slug}-1000"),
                url: Some("https://a.com".to_string()),
            }],
        }),
    );

    let result = effect_of(
        LogEntry::RestoreSnapshot {
            timestamp: 200,
            url: "https://a.com".to_string(),
            path: format!("snapshots/{slug}-1000"),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("restore snapshot replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert!(page.child_ids.contains(&format!("snapshot:{slug}-1000")));
    assert!(!orphaned
        .entries
        .iter()
        .any(|entry| entry.key == format!("snapshot:{slug}-1000")));
}

#[tokio::test]
async fn permanent_delete_removes_entities_and_orphan_entries() {
    let mut orphaned = OrphanedManifest::new();
    orphaned.entries = vec![
        OrphanedEntry {
            key: "note:n1".to_string(),
            url: Some("https://a.com".to_string()),
        },
        OrphanedEntry {
            key: "snapshot:page-a-1000".to_string(),
            url: Some("https://a.com".to_string()),
        },
        OrphanedEntry {
            key: "note:keep".to_string(),
            url: Some("https://b.com".to_string()),
        },
    ];

    let mut store = BTreeMap::new();
    store.insert(
        "note:n1".to_string(),
        Entity::Note(note("n1", "https://a.com")),
    );
    store.insert("manifest:orphaned".to_string(), Entity::Orphaned(orphaned));

    let result = effect_of(
        LogEntry::PermanentDelete {
            timestamp: 200,
            keys: vec!["note:n1".to_string(), "snapshot:page-a-1000".to_string()],
        },
        load_from(store),
        context(),
    )
    .await
    .expect("permanent delete replay succeeds");

    assert!(result.get("note:n1").expect("note delete").is_delete());
    assert!(result
        .get("snapshot:page-a-1000")
        .expect("snapshot delete")
        .is_delete());
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert_eq!(
        orphaned.entries,
        vec![OrphanedEntry {
            key: "note:keep".to_string(),
            url: Some("https://b.com".to_string()),
        }]
    );
    assert_eq!(orphaned.timestamps.get("test-device"), Some(&200));
}

#[tokio::test]
async fn update_setting_persists_dynamic_value_with_timestamp() {
    let result = effect_of(
        LogEntry::UpdateSetting {
            timestamp: 100,
            key: "theme".to_string(),
            value: json!("dark"),
        },
        |_| ready(None),
        context(),
    )
    .await
    .expect("settings replay succeeds");

    let settings = result
        .get("manifest:settings")
        .and_then(EntityEffect::as_settings)
        .expect("settings updated");
    assert_eq!(settings.values.get("theme"), Some(&json!("dark")));
    assert_eq!(settings.timestamps.get("test-device"), Some(&100));
}

#[tokio::test]
async fn update_setting_preserves_higher_existing_timestamp() {
    let store = BTreeMap::from([(
        "manifest:settings".to_string(),
        Entity::Settings(browser_recall_replay::entities::SettingsEntity {
            timestamps: [("test-device".to_string(), 500)].into_iter().collect(),
            values: BTreeMap::new(),
        }),
    )]);

    let result = effect_of(
        LogEntry::UpdateSetting {
            timestamp: 100,
            key: "theme".to_string(),
            value: json!("dark"),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("settings replay succeeds");

    let settings = result
        .get("manifest:settings")
        .and_then(EntityEffect::as_settings)
        .expect("settings updated");
    assert_eq!(settings.timestamps.get("test-device"), Some(&500));
}

#[tokio::test]
async fn update_setting_preserves_unrelated_keys_and_replay_is_idempotent() {
    let base = BTreeMap::from([(
        "manifest:settings".to_string(),
        Entity::Settings(browser_recall_replay::entities::SettingsEntity {
            timestamps: Default::default(),
            values: BTreeMap::from([("fontSize".to_string(), json!(14))]),
        }),
    )]);
    let entry = LogEntry::UpdateSetting {
        timestamp: 100,
        key: "theme".to_string(),
        value: json!("dark"),
    };

    let replayed =
        replay_sequence(base, vec![(entry.clone(), context()), (entry, context())]).await;

    let settings = match replayed.get("manifest:settings") {
        Some(Entity::Settings(settings)) => settings,
        _ => panic!("settings missing"),
    };
    assert_eq!(settings.values.get("theme"), Some(&json!("dark")));
    assert_eq!(settings.values.get("fontSize"), Some(&json!(14)));
}

#[tokio::test]
async fn create_and_update_list_refresh_manifests() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest::new()),
    );
    store.insert(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest::new()),
    );

    let created = effect_of(
        LogEntry::CreateList {
            timestamp: 100,
            name: "Reading".to_string(),
            list_owner: "test-device".to_string(),
            list_id: Some("reading-list".to_string()),
            parent_list_id: None,
        },
        load_from(store.clone()),
        context(),
    )
    .await
    .expect("create list replay succeeds");

    let list = created
        .get("list:reading-list")
        .and_then(EntityEffect::as_list)
        .expect("list created");
    let name_map = created
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map updated");
    let tree = created
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("list order updated");
    assert_eq!(list.name, "Reading");
    assert_eq!(
        name_map.paths.get("test-device/Reading"),
        Some(&"reading-list".to_string())
    );
    assert!(tree.tree.iter().any(|node| node.id == "list:reading-list"));

    store.insert("list:reading-list".to_string(), Entity::List(list.clone()));
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(name_map.clone()),
    );

    let updated = effect_of(
        LogEntry::UpdateList {
            timestamp: 200,
            name: "Reading".to_string(),
            list_owner: "test-device".to_string(),
            new_name: Some("Reading Later".to_string()),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("update list replay succeeds");

    let renamed = updated
        .get("list:reading-list")
        .and_then(EntityEffect::as_list)
        .expect("list renamed");
    let renamed_map = updated
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map renamed");
    assert_eq!(renamed.name, "Reading Later");
    assert_eq!(
        renamed_map.paths.get("test-device/Reading Later"),
        Some(&"reading-list".to_string())
    );
    assert!(!renamed_map.paths.contains_key("test-device/Reading"));
}

#[tokio::test]
async fn pin_and_unpin_list_updates_list_and_page_parent_ids() {
    let slug = generate_slug_from_url("https://example.com/list-page").expect("slug");
    let page_key = format!("page:{slug}");
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );

    let pinned = effect_of(
        LogEntry::PinToList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://example.com/list-page".to_string()],
            titles: Some(BTreeMap::from([(
                "https://example.com/list-page".to_string(),
                "Pinned Page".to_string(),
            )])),
            source: None,
        },
        load_from(store.clone()),
        context(),
    )
    .await
    .expect("pin replay succeeds");

    let list = pinned
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    let page = pinned
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    assert_eq!(list.pins.len(), 1);
    assert_eq!(list.pins[0].id, page_key);
    assert!(page.parent_ids.contains(&"list:test-id".to_string()));
    assert_eq!(page.title.as_deref(), Some("Pinned Page"));

    store.insert("list:test-id".to_string(), Entity::List(list.clone()));
    store.insert(page_key.clone(), Entity::Page(page.clone()));

    let unpinned = effect_of(
        LogEntry::UnpinFromList {
            timestamp: 200,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://example.com/list-page".to_string()],
        },
        load_from(store),
        context(),
    )
    .await
    .expect("unpin replay succeeds");

    let list = unpinned
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    assert!(list.pins.is_empty());
    assert!(unpinned.get(&page_key).expect("page effect").is_delete());
}

#[tokio::test]
async fn pin_to_list_uses_entry_titles_for_new_pages_without_overwriting_existing_title() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );

    let created = effect_of(
        LogEntry::PinToList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
            titles: Some(BTreeMap::from([(
                "https://a.com".to_string(),
                "Page A Title".to_string(),
            )])),
            source: None,
        },
        load_from(store.clone()),
        context(),
    )
    .await
    .expect("pin replay succeeds");
    let created_page = created
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    assert_eq!(created_page.title.as_deref(), Some("Page A Title"));

    let mut existing_page = page(&slug);
    existing_page.url = Some("https://a.com".to_string());
    existing_page.title = Some("Existing".to_string());
    store.insert(page_key.clone(), Entity::Page(existing_page));
    let updated = effect_of(
        LogEntry::PinToList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
            titles: Some(BTreeMap::from([(
                "https://a.com".to_string(),
                "Ignored".to_string(),
            )])),
            source: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("pin replay succeeds");
    let updated_page = updated
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(updated_page.title.as_deref(), Some("Existing"));
}

#[tokio::test]
async fn pin_to_list_skips_empty_items_and_deduplicates_pins() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );

    let result = effect_of(
        LogEntry::PinToList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec![
                "".to_string(),
                "https://a.com".to_string(),
                "https://a.com".to_string(),
            ],
            titles: None,
            source: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("pin replay succeeds");

    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    assert_eq!(list.pins.len(), 1);
}

#[tokio::test]
async fn pin_to_list_preserves_higher_existing_list_timestamp() {
    let mut existing = list("test-id", "Test");
    existing.timestamps.insert("test-device".to_string(), 500);
    let store = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        ("list:test-id".to_string(), Entity::List(existing)),
    ]);

    let result = effect_of(
        LogEntry::PinToList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
            titles: None,
            source: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("pin replay succeeds");

    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    assert_eq!(list.timestamps.get("test-device"), Some(&500));
}

#[tokio::test]
async fn unpin_keeps_page_when_note_child_remains() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.parent_ids = vec!["list:test-id".to_string()];
    page.child_ids = vec!["note:n1".to_string()];

    let mut pinned_list = list("test-id", "Test");
    pinned_list.pins = vec![PinEntity {
        id: page_key.clone(),
        pinned_at: 50,
        source: None,
    }];

    let store = BTreeMap::from([
        (page_key.clone(), Entity::Page(page)),
        ("list:test-id".to_string(), Entity::List(pinned_list)),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
    ]);

    let result = effect_of(
        LogEntry::UnpinFromList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
        },
        load_from(store),
        context(),
    )
    .await
    .expect("unpin replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page retained");
    assert!(!page.parent_ids.contains(&"list:test-id".to_string()));
    assert_eq!(page.child_ids, vec!["note:n1".to_string()]);
}

#[tokio::test]
async fn unpin_keeps_page_when_user_title_remains() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.parent_ids = vec!["list:test-id".to_string()];
    page.user_title = Some("Custom".to_string());

    let mut pinned_list = list("test-id", "Test");
    pinned_list.pins = vec![PinEntity {
        id: page_key.clone(),
        pinned_at: 50,
        source: None,
    }];

    let store = BTreeMap::from([
        (page_key.clone(), Entity::Page(page)),
        ("list:test-id".to_string(), Entity::List(pinned_list)),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
    ]);

    let result = effect_of(
        LogEntry::UnpinFromList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
        },
        load_from(store),
        context(),
    )
    .await
    .expect("unpin replay succeeds");

    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page retained");
    assert_eq!(page.user_title.as_deref(), Some("Custom"));
    assert!(!page.parent_ids.contains(&"list:test-id".to_string()));
}

#[tokio::test]
async fn add_update_remove_rule_mutates_list_rules() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );

    let added = effect_of(
        LogEntry::AddRule {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule: RuleInput {
                id: Some("rule-k-1".to_string()),
                rule_type: "keyword".to_string(),
                config: BTreeMap::from([("pattern".to_string(), json!("rust"))]),
            },
        },
        load_from(store.clone()),
        context(),
    )
    .await
    .expect("add rule replay succeeds");
    let list = added
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("rule added");
    assert_eq!(list.rules.len(), 1);
    assert_eq!(list.rules[0].config.get("pattern"), Some(&json!("rust")));

    store.insert("list:test-id".to_string(), Entity::List(list.clone()));
    let updated = effect_of(
        LogEntry::UpdateRule {
            timestamp: 200,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule_id: "rule-k-1".to_string(),
            config: BTreeMap::from([("pattern".to_string(), json!("rustacean"))]),
        },
        load_from(store.clone()),
        context(),
    )
    .await
    .expect("update rule replay succeeds");
    let list = updated
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("rule updated");
    assert_eq!(
        list.rules[0].config.get("pattern"),
        Some(&json!("rustacean"))
    );

    store.insert("list:test-id".to_string(), Entity::List(list.clone()));
    let removed = effect_of(
        LogEntry::RemoveRule {
            timestamp: 300,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule_id: "rule-k-1".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("remove rule replay succeeds");
    let list = removed
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("rule removed");
    assert!(list.rules.is_empty());
}

#[tokio::test]
async fn add_rule_is_idempotent_and_noops_for_unknown_list() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );

    let entry = LogEntry::AddRule {
        timestamp: 100,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
        rule: RuleInput {
            id: Some("rule-k-1".to_string()),
            rule_type: "keyword".to_string(),
            config: BTreeMap::from([("pattern".to_string(), json!("rust"))]),
        },
    };
    let replayed = replay_sequence(
        store.clone(),
        vec![(entry.clone(), context()), (entry, context())],
    )
    .await;
    let list = match replayed.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("list missing"),
    };
    assert_eq!(list.rules.len(), 1);

    let missing = effect_of(
        LogEntry::AddRule {
            timestamp: 100,
            name: "Missing".to_string(),
            list_owner: "test-device".to_string(),
            rule: RuleInput {
                id: Some("rule-k-1".to_string()),
                rule_type: "keyword".to_string(),
                config: BTreeMap::from([("pattern".to_string(), json!("rust"))]),
            },
        },
        load_from(store),
        context(),
    )
    .await
    .expect("missing list add rule replay succeeds");
    assert!(missing.is_empty());
}

#[tokio::test]
async fn remove_rule_is_idempotent_and_supported_on_deleted_orphaned_list() {
    let mut deleted_list = list("test-id", "Test");
    deleted_list.deleted = true;
    deleted_list.deleted_ts = Some(50);
    deleted_list.rules = vec![RuleEntity {
        id: "rule-k-1".to_string(),
        rule_type: "keyword".to_string(),
        config: BTreeMap::from([("pattern".to_string(), json!("rust"))]),
        created_at: 10,
    }];
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![OrphanedEntry {
                    key: "list:test-id".to_string(),
                    url: None,
                }],
            }),
        ),
        ("list:test-id".to_string(), Entity::List(deleted_list)),
    ]);

    let removed = effect_of(
        LogEntry::RemoveRule {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule_id: "rule-k-1".to_string(),
        },
        load_from(base.clone()),
        context(),
    )
    .await
    .expect("remove rule replay succeeds");
    let removed_list = removed
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    assert!(removed_list.rules.is_empty());

    let mut next_store = base;
    next_store.insert(
        "list:test-id".to_string(),
        Entity::List(removed_list.clone()),
    );
    let removed_again = effect_of(
        LogEntry::RemoveRule {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule_id: "rule-k-1".to_string(),
        },
        load_from(next_store),
        context(),
    )
    .await
    .expect("remove rule replay succeeds");
    let list = removed_again
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    assert!(list.rules.is_empty());
}

#[tokio::test]
async fn update_rule_noops_for_missing_rule_and_deleted_orphaned_list() {
    let mut deleted_list = list("test-id", "Test");
    deleted_list.deleted = true;
    deleted_list.deleted_ts = Some(50);
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![OrphanedEntry {
                    key: "list:test-id".to_string(),
                    url: None,
                }],
            }),
        ),
        ("list:test-id".to_string(), Entity::List(deleted_list)),
    ]);

    let result = effect_of(
        LogEntry::UpdateRule {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule_id: "rule-k-missing".to_string(),
            config: BTreeMap::from([("pattern".to_string(), json!("test"))]),
        },
        load_from(base),
        context(),
    )
    .await
    .expect("update rule replay succeeds");
    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    assert!(list.rules.is_empty());
}

#[tokio::test]
async fn pin_to_deleted_orphaned_list_is_preserved() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut deleted_list = list("test-id", "Test");
    deleted_list.deleted = true;
    deleted_list.deleted_ts = Some(50);

    let store = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![OrphanedEntry {
                    key: "list:test-id".to_string(),
                    url: None,
                }],
            }),
        ),
        ("list:test-id".to_string(), Entity::List(deleted_list)),
    ]);

    let result = effect_of(
        LogEntry::PinToList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
            titles: None,
            source: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("pin replay succeeds");

    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    let page = result
        .get(&page_key)
        .and_then(EntityEffect::as_page)
        .expect("page created");
    assert!(list.deleted);
    assert_eq!(list.pins.len(), 1);
    assert_eq!(list.pins[0].id, page_key);
    assert!(page.parent_ids.contains(&"list:test-id".to_string()));
}

#[tokio::test]
async fn add_update_remove_rule_on_deleted_orphaned_list_is_supported() {
    let mut deleted_list = list("test-id", "Test");
    deleted_list.deleted = true;
    deleted_list.deleted_ts = Some(50);
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![OrphanedEntry {
                    key: "list:test-id".to_string(),
                    url: None,
                }],
            }),
        ),
        ("list:test-id".to_string(), Entity::List(deleted_list)),
    ]);

    let added = effect_of(
        LogEntry::AddRule {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule: RuleInput {
                id: Some("rule-k-1".to_string()),
                rule_type: "keyword".to_string(),
                config: BTreeMap::from([("pattern".to_string(), json!("rust"))]),
            },
        },
        load_from(base.clone()),
        context(),
    )
    .await
    .expect("add rule replay succeeds");
    let added_list = added
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("rule added");
    assert!(added_list.deleted);
    assert_eq!(added_list.rules.len(), 1);

    let mut updated_store = base.clone();
    updated_store.insert("list:test-id".to_string(), Entity::List(added_list.clone()));
    let updated = effect_of(
        LogEntry::UpdateRule {
            timestamp: 200,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule_id: "rule-k-1".to_string(),
            config: BTreeMap::from([("pattern".to_string(), json!("rustacean"))]),
        },
        load_from(updated_store.clone()),
        context(),
    )
    .await
    .expect("update rule replay succeeds");
    let updated_list = updated
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("rule updated");
    assert_eq!(
        updated_list.rules[0].config.get("pattern"),
        Some(&json!("rustacean"))
    );

    updated_store.insert(
        "list:test-id".to_string(),
        Entity::List(updated_list.clone()),
    );
    let removed = effect_of(
        LogEntry::RemoveRule {
            timestamp: 300,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule_id: "rule-k-1".to_string(),
        },
        load_from(updated_store),
        context(),
    )
    .await
    .expect("remove rule replay succeeds");
    let removed_list = removed
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("rule removed");
    assert!(removed_list.deleted);
    assert!(removed_list.rules.is_empty());
}

#[tokio::test]
async fn create_list_nests_under_parent_in_tree_manifest() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest {
            timestamps: Default::default(),
            tree: vec![TreeNode {
                id: "list:test-id".to_string(),
                children: Vec::new(),
            }],
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );

    let result = effect_of(
        LogEntry::CreateList {
            timestamp: 100,
            name: "Child".to_string(),
            list_owner: "test-device".to_string(),
            list_id: None,
            parent_list_id: Some("test-id".to_string()),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("nested create list replay succeeds");

    let child_key = result
        .keys()
        .find(|key| key.starts_with("list:") && key.as_str() != "list:test-id")
        .cloned()
        .expect("child list created");
    let name_map = result
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map updated");
    let list_order = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    let parent = list_order
        .tree
        .iter()
        .find(|node| node.id == "list:test-id")
        .expect("parent node present");
    assert!(parent.children.iter().any(|node| node.id == child_key));
    assert_eq!(
        name_map.paths.get("test-device/Child"),
        Some(&child_key.trim_start_matches("list:").to_string())
    );
}

#[tokio::test]
async fn create_list_uses_provided_list_id() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest::new()),
    );
    store.insert(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest::new()),
    );

    let result = effect_of(
        LogEntry::CreateList {
            timestamp: 100,
            name: "Cinema".to_string(),
            list_owner: "test-device".to_string(),
            list_id: Some("cinema-gfl1h7".to_string()),
            parent_list_id: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("create list replay succeeds");

    let list = result
        .get("list:cinema-gfl1h7")
        .and_then(EntityEffect::as_list)
        .expect("list created");
    let tree = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    let name_map = result
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map updated");
    assert_eq!(list.name, "Cinema");
    assert!(tree.tree.iter().any(|node| node.id == "list:cinema-gfl1h7"));
    assert_eq!(
        name_map.paths.get("test-device/Cinema"),
        Some(&"cinema-gfl1h7".to_string())
    );
}

#[tokio::test]
async fn delete_list_soft_deletes_and_orphans_list() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest {
            timestamps: Default::default(),
            tree: vec![TreeNode {
                id: "list:test-id".to_string(),
                children: Vec::new(),
            }],
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );

    let result = effect_of(
        LogEntry::DeleteList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("delete list replay succeeds");

    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list updated");
    let tree = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    let name_map = result
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map updated");
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert!(list.deleted);
    assert_eq!(list.deleted_ts, Some(100));
    assert!(!tree.tree.iter().any(|node| node.id == "list:test-id"));
    assert!(!name_map.paths.contains_key("test-device/Test"));
    assert!(orphaned
        .entries
        .iter()
        .any(|entry| entry.key == "list:test-id"));
}

#[tokio::test]
async fn delete_list_noops_when_deleted_timestamp_is_newer() {
    let mut deleted = list("test-id", "Test");
    deleted.deleted = true;
    deleted.deleted_ts = Some(200);
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
        }),
    );
    store.insert("list:test-id".to_string(), Entity::List(deleted));

    let result = effect_of(
        LogEntry::DeleteList {
            timestamp: 200,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("delete list replay succeeds");

    assert!(result.is_empty());
}

#[tokio::test]
async fn delete_list_promotes_children_without_cascading_delete() {
    let mut store = BTreeMap::new();
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest {
            timestamps: Default::default(),
            paths: BTreeMap::from([
                ("test-device/Test".to_string(), "test-id".to_string()),
                ("test-device/Child".to_string(), "child-id".to_string()),
            ]),
        }),
    );
    store.insert(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest {
            timestamps: Default::default(),
            tree: vec![TreeNode {
                id: "list:test-id".to_string(),
                children: vec![TreeNode {
                    id: "list:child-id".to_string(),
                    children: Vec::new(),
                }],
            }],
        }),
    );
    store.insert(
        "list:test-id".to_string(),
        Entity::List(list("test-id", "Test")),
    );
    store.insert(
        "list:child-id".to_string(),
        Entity::List(list("child-id", "Child")),
    );

    let result = effect_of(
        LogEntry::DeleteList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("delete list replay succeeds");

    let tree = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    let name_map = result
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map updated");
    assert!(!result.contains_key("list:child-id"));
    assert!(tree.tree.iter().any(|node| node.id == "list:child-id"));
    assert!(!tree.tree.iter().any(|node| node.id == "list:test-id"));
    assert_eq!(
        name_map.paths.get("test-device/Child"),
        Some(&"child-id".to_string())
    );
    assert!(!name_map.paths.contains_key("test-device/Test"));
}

#[tokio::test]
async fn restore_list_readds_tree_name_map_and_unorphans() {
    let mut restored = list("test-id", "Test");
    restored.deleted = true;
    restored.deleted_ts = Some(50);
    restored.timestamps.insert("test-device".to_string(), 50);
    let mut store = BTreeMap::new();
    store.insert("list:test-id".to_string(), Entity::List(restored));
    store.insert(
        "manifest:name-to-id".to_string(),
        Entity::NameToId(NameToIdManifest::new()),
    );
    store.insert(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest::new()),
    );
    store.insert(
        "manifest:orphaned".to_string(),
        Entity::Orphaned(OrphanedManifest {
            timestamps: Default::default(),
            entries: vec![browser_recall_replay::entities::OrphanedEntry {
                key: "list:test-id".to_string(),
                url: None,
            }],
        }),
    );

    let result = effect_of(
        LogEntry::RestoreList {
            timestamp: 100,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("restore list replay succeeds");

    let list = result
        .get("list:test-id")
        .and_then(EntityEffect::as_list)
        .expect("list restored");
    let tree = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    let name_map = result
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map updated");
    let orphaned = result
        .get("manifest:orphaned")
        .and_then(EntityEffect::as_orphaned)
        .expect("orphaned updated");
    assert!(!list.deleted);
    assert_eq!(list.deleted_ts, Some(100));
    assert!(tree.tree.iter().any(|node| node.id == "list:test-id"));
    assert_eq!(
        name_map.paths.get("test-device/Test"),
        Some(&"test-id".to_string())
    );
    assert!(!orphaned
        .entries
        .iter()
        .any(|entry| entry.key == "list:test-id"));
}

#[tokio::test]
async fn update_list_tree_writes_new_structure_and_timestamp() {
    let store = BTreeMap::from([(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest {
            timestamps: Default::default(),
            tree: vec![
                TreeNode {
                    id: "list:a-id".to_string(),
                    children: Vec::new(),
                },
                TreeNode {
                    id: "list:b-id".to_string(),
                    children: Vec::new(),
                },
            ],
        }),
    )]);
    let new_tree = vec![TreeNode {
        id: "list:a-id".to_string(),
        children: vec![TreeNode {
            id: "list:b-id".to_string(),
            children: Vec::new(),
        }],
    }];

    let result = effect_of(
        LogEntry::UpdateListTree {
            timestamp: 100,
            tree: new_tree.clone(),
        },
        load_from(store),
        context(),
    )
    .await
    .expect("update list tree replay succeeds");

    let list_order = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    assert_eq!(list_order.tree, new_tree);
    assert_eq!(list_order.timestamps.get("test-device"), Some(&100));
}

#[tokio::test]
async fn update_list_tree_does_not_modify_name_to_id() {
    let store = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/A".to_string(), "a-id".to_string())]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest::new()),
        ),
    ]);

    let result = effect_of(
        LogEntry::UpdateListTree {
            timestamp: 100,
            tree: vec![TreeNode {
                id: "list:a-id".to_string(),
                children: Vec::new(),
            }],
        },
        load_from(store),
        context(),
    )
    .await
    .expect("tree replay succeeds");

    assert!(!result.contains_key("manifest:name-to-id"));
}

#[tokio::test]
async fn update_list_tree_skips_stale_same_device_event() {
    let store = BTreeMap::from([(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest {
            timestamps: [("test-device".to_string(), 200)].into_iter().collect(),
            tree: vec![TreeNode {
                id: "list:a-id".to_string(),
                children: Vec::new(),
            }],
        }),
    )]);

    let result = effect_of(
        LogEntry::UpdateListTree {
            timestamp: 100,
            tree: vec![TreeNode {
                id: "list:b-id".to_string(),
                children: Vec::new(),
            }],
        },
        load_from(store),
        context(),
    )
    .await
    .expect("update list tree replay succeeds");

    assert!(result.is_empty());
}

#[tokio::test]
async fn update_list_tree_filters_deleted_lists_and_appends_missing_live_lists() {
    let mut deleted = list("deleted-id", "Deleted");
    deleted.deleted = true;
    let store = BTreeMap::from([
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![TreeNode {
                    id: "list:present-id".to_string(),
                    children: Vec::new(),
                }],
            }),
        ),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([
                    ("test-device/Present".to_string(), "present-id".to_string()),
                    ("test-device/Missing".to_string(), "missing-id".to_string()),
                    ("test-device/Deleted".to_string(), "deleted-id".to_string()),
                ]),
            }),
        ),
        (
            "list:present-id".to_string(),
            Entity::List(list("present-id", "Present")),
        ),
        (
            "list:missing-id".to_string(),
            Entity::List(list("missing-id", "Missing")),
        ),
        ("list:deleted-id".to_string(), Entity::List(deleted)),
    ]);

    let result = effect_of(
        LogEntry::UpdateListTree {
            timestamp: 100,
            tree: vec![
                TreeNode {
                    id: "list:present-id".to_string(),
                    children: vec![TreeNode {
                        id: "list:deleted-id".to_string(),
                        children: Vec::new(),
                    }],
                },
                TreeNode {
                    id: "list:unknown-id".to_string(),
                    children: Vec::new(),
                },
            ],
        },
        load_from(store),
        context(),
    )
    .await
    .expect("update list tree replay succeeds");

    let list_order = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    let top_level_ids = list_order
        .tree
        .iter()
        .map(|node| node.id.as_str())
        .collect::<Vec<_>>();
    assert!(top_level_ids.contains(&"list:present-id"));
    assert!(top_level_ids.contains(&"list:missing-id"));
    assert!(top_level_ids.contains(&"list:unknown-id"));
    assert!(!list_order
        .tree
        .iter()
        .any(|node| node.id == "list:deleted-id"));
}

#[tokio::test]
async fn tree_update_and_create_list_include_all_lists_in_both_orders() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([
                    ("test-device/A".to_string(), "a-id".to_string()),
                    ("test-device/B".to_string(), "b-id".to_string()),
                ]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![
                    TreeNode {
                        id: "list:a-id".to_string(),
                        children: Vec::new(),
                    },
                    TreeNode {
                        id: "list:b-id".to_string(),
                        children: Vec::new(),
                    },
                ],
            }),
        ),
        ("list:a-id".to_string(), Entity::List(list("a-id", "A"))),
        ("list:b-id".to_string(), Entity::List(list("b-id", "B"))),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let tree_update = LogEntry::UpdateListTree {
        timestamp: 10,
        tree: vec![
            TreeNode {
                id: "list:a-id".to_string(),
                children: Vec::new(),
            },
            TreeNode {
                id: "list:b-id".to_string(),
                children: Vec::new(),
            },
        ],
    };
    let create = LogEntry::CreateList {
        timestamp: 20,
        name: "C".to_string(),
        list_owner: "test-device".to_string(),
        list_id: None,
        parent_list_id: None,
    };

    let forward = replay_sequence(
        base.clone(),
        vec![
            (tree_update.clone(), context()),
            (create.clone(), context()),
        ],
    )
    .await;
    let reverse = replay_sequence(base, vec![(create, context()), (tree_update, context())]).await;

    for state in [forward, reverse] {
        let tree = match state.get("manifest:list-order") {
            Some(Entity::ListOrder(manifest)) => &manifest.tree,
            _ => panic!("tree missing"),
        };
        let ids = collect_tree_ids(tree);
        let c_key = state
            .iter()
            .find_map(|(key, entity)| match entity {
                Entity::List(list) if list.name == "C" => Some(key.clone()),
                _ => None,
            })
            .expect("created list present");
        assert!(ids.contains("list:a-id"));
        assert!(ids.contains("list:b-id"));
        assert!(ids.contains(&c_key));
    }
}

#[tokio::test]
async fn tree_update_and_delete_list_remove_deleted_list_in_both_orders() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([
                    ("test-device/A".to_string(), "a-id".to_string()),
                    ("test-device/B".to_string(), "b-id".to_string()),
                    ("test-device/C".to_string(), "c-id".to_string()),
                ]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![
                    TreeNode {
                        id: "list:a-id".to_string(),
                        children: vec![TreeNode {
                            id: "list:b-id".to_string(),
                            children: Vec::new(),
                        }],
                    },
                    TreeNode {
                        id: "list:c-id".to_string(),
                        children: Vec::new(),
                    },
                ],
            }),
        ),
        ("list:a-id".to_string(), Entity::List(list("a-id", "A"))),
        ("list:b-id".to_string(), Entity::List(list("b-id", "B"))),
        ("list:c-id".to_string(), Entity::List(list("c-id", "C"))),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let tree_update = LogEntry::UpdateListTree {
        timestamp: 10,
        tree: vec![
            TreeNode {
                id: "list:a-id".to_string(),
                children: vec![TreeNode {
                    id: "list:b-id".to_string(),
                    children: Vec::new(),
                }],
            },
            TreeNode {
                id: "list:c-id".to_string(),
                children: Vec::new(),
            },
        ],
    };
    let delete = LogEntry::DeleteList {
        timestamp: 20,
        name: "B".to_string(),
        list_owner: "test-device".to_string(),
    };

    let forward = replay_sequence(
        base.clone(),
        vec![
            (tree_update.clone(), context()),
            (delete.clone(), context()),
        ],
    )
    .await;
    let reverse = replay_sequence(base, vec![(delete, context()), (tree_update, context())]).await;

    for state in [forward, reverse] {
        let tree = match state.get("manifest:list-order") {
            Some(Entity::ListOrder(manifest)) => &manifest.tree,
            _ => panic!("tree missing"),
        };
        let ids = collect_tree_ids(tree);
        assert!(ids.contains("list:a-id"));
        assert!(ids.contains("list:c-id"));
        assert!(!ids.contains("list:b-id"));
    }
}

#[tokio::test]
async fn create_tree_update_delete_reconcile_all_orderings() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([
                    ("test-device/A".to_string(), "a-id".to_string()),
                    ("test-device/B".to_string(), "b-id".to_string()),
                ]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![
                    TreeNode {
                        id: "list:a-id".to_string(),
                        children: Vec::new(),
                    },
                    TreeNode {
                        id: "list:b-id".to_string(),
                        children: Vec::new(),
                    },
                ],
            }),
        ),
        ("list:a-id".to_string(), Entity::List(list("a-id", "A"))),
        ("list:b-id".to_string(), Entity::List(list("b-id", "B"))),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let events = vec![
        LogEntry::CreateList {
            timestamp: 10,
            name: "C".to_string(),
            list_owner: "test-device".to_string(),
            list_id: None,
            parent_list_id: None,
        },
        LogEntry::UpdateListTree {
            timestamp: 20,
            tree: vec![TreeNode {
                id: "list:a-id".to_string(),
                children: vec![TreeNode {
                    id: "list:b-id".to_string(),
                    children: Vec::new(),
                }],
            }],
        },
        LogEntry::DeleteList {
            timestamp: 30,
            name: "A".to_string(),
            list_owner: "test-device".to_string(),
        },
    ];

    for permutation in permutations(&events) {
        let state = replay_sequence(
            base.clone(),
            permutation
                .into_iter()
                .map(|entry| (entry, context()))
                .collect(),
        )
        .await;
        let tree = match state.get("manifest:list-order") {
            Some(Entity::ListOrder(manifest)) => &manifest.tree,
            _ => panic!("tree missing"),
        };
        let ids = collect_tree_ids(tree);
        let c_key = state
            .iter()
            .find_map(|(key, entity)| match entity {
                Entity::List(list) if list.name == "C" => Some(key.clone()),
                _ => None,
            })
            .expect("created list present");
        assert!(!ids.contains("list:a-id"));
        assert!(ids.contains("list:b-id"));
        assert!(ids.contains(&c_key));
    }
}

#[tokio::test]
async fn visit_page_caps_parent_ids_at_referrer_limit() {
    let child_slug = generate_slug_from_url("https://example.com/child").expect("slug");
    let child_key = format!("page:{child_slug}");
    let existing_parent_ids = (0..50)
        .map(|index| {
            format!(
                "page:{}",
                generate_slug_from_url(&format!("https://example.com/old-parent-{index}"))
                    .expect("slug")
            )
        })
        .collect::<Vec<_>>();
    let new_parent_url = "https://example.com/new-parent-51";
    let new_parent_slug = generate_slug_from_url(new_parent_url).expect("slug");
    let new_parent_key = format!("page:{new_parent_slug}");

    let mut child = page(&child_slug);
    child.url = Some("https://example.com/child".to_string());
    child.title = Some("Child".to_string());
    child.timestamps.insert("test-device".to_string(), 50);
    child.parent_ids = existing_parent_ids.clone();

    let mut parent = page(&new_parent_slug);
    parent.url = Some(new_parent_url.to_string());
    parent.title = Some("New Parent".to_string());
    parent.timestamps.insert("test-device".to_string(), 50);

    let store = BTreeMap::from([
        (child_key.clone(), Entity::Page(child)),
        (new_parent_key.clone(), Entity::Page(parent)),
    ]);

    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: "https://example.com/child".to_string(),
            title: Some("Child".to_string()),
            referrer_url: Some(new_parent_url.to_string()),
            checkpoint: false,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("visit replay succeeds");

    let child = result
        .get(&child_key)
        .and_then(EntityEffect::as_page)
        .expect("child updated");
    assert_eq!(child.parent_ids.len(), 50);
    assert!(!child.parent_ids.contains(&existing_parent_ids[0]));
    assert!(child.parent_ids.contains(&new_parent_key));
}

#[tokio::test]
async fn visit_page_caps_referrer_child_ids_at_referrer_limit() {
    let parent_slug = generate_slug_from_url("https://example.com/parent").expect("slug");
    let parent_key = format!("page:{parent_slug}");
    let existing_child_ids = (0..50)
        .map(|index| {
            format!(
                "page:{}",
                generate_slug_from_url(&format!("https://example.com/old-child-{index}"))
                    .expect("slug")
            )
        })
        .collect::<Vec<_>>();
    let new_child_url = "https://example.com/new-child-51";
    let new_child_slug = generate_slug_from_url(new_child_url).expect("slug");
    let new_child_key = format!("page:{new_child_slug}");

    let mut parent = page(&parent_slug);
    parent.url = Some("https://example.com/parent".to_string());
    parent.title = Some("Parent".to_string());
    parent.timestamps.insert("test-device".to_string(), 50);
    parent.child_ids = existing_child_ids.clone();

    let mut child = page(&new_child_slug);
    child.url = Some(new_child_url.to_string());
    child.title = Some("New Child".to_string());
    child.timestamps.insert("test-device".to_string(), 50);

    let store = BTreeMap::from([
        (parent_key.clone(), Entity::Page(parent)),
        (new_child_key.clone(), Entity::Page(child)),
    ]);

    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: new_child_url.to_string(),
            title: Some("New Child".to_string()),
            referrer_url: Some("https://example.com/parent".to_string()),
            checkpoint: false,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("visit replay succeeds");

    let parent = result
        .get(&parent_key)
        .and_then(EntityEffect::as_page)
        .expect("parent updated");
    assert_eq!(parent.child_ids.len(), 50);
    assert!(!parent.child_ids.contains(&existing_child_ids[0]));
    assert!(parent.child_ids.contains(&new_child_key));
}

#[tokio::test]
async fn visit_page_preserves_higher_existing_timestamp() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut seeded = page(&slug);
    seeded.url = Some("https://a.com".to_string());
    seeded.timestamps.insert("test-device".to_string(), 500);
    let store = BTreeMap::from([(key.clone(), Entity::Page(seeded))]);

    let result = effect_of(
        LogEntry::VisitPage {
            timestamp: 100,
            url: "https://a.com".to_string(),
            title: Some("A".to_string()),
            referrer_url: None,
            checkpoint: false,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("visit replay succeeds");

    let page = result
        .get(&key)
        .and_then(EntityEffect::as_page)
        .expect("page updated");
    assert_eq!(page.timestamps.get("test-device"), Some(&500));
}

#[tokio::test]
async fn create_list_preserves_higher_existing_manifest_timestamps() {
    let store = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: [("test-device".to_string(), 500)].into_iter().collect(),
                paths: BTreeMap::new(),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: [("test-device".to_string(), 500)].into_iter().collect(),
                tree: Vec::new(),
            }),
        ),
    ]);

    let result = effect_of(
        LogEntry::CreateList {
            timestamp: 100,
            name: "Reading".to_string(),
            list_owner: "test-device".to_string(),
            list_id: None,
            parent_list_id: None,
        },
        load_from(store),
        context(),
    )
    .await
    .expect("create list replay succeeds");

    let name_map = result
        .get("manifest:name-to-id")
        .and_then(EntityEffect::as_name_to_id)
        .expect("name map updated");
    let list_order = result
        .get("manifest:list-order")
        .and_then(EntityEffect::as_list_order)
        .expect("tree updated");
    assert_eq!(name_map.timestamps.get("test-device"), Some(&500));
    assert_eq!(list_order.timestamps.get("test-device"), Some(&500));
}

#[tokio::test]
async fn note_delete_then_restore_converges_to_restored_state() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.child_ids = vec!["note:n1".to_string()];
    let base = BTreeMap::from([
        (page_key.clone(), Entity::Page(page)),
        (
            "note:n1".to_string(),
            Entity::Note(NoteEntity {
                slug: "n1".to_string(),
                excerpt: Some("hello".to_string()),
                note: Some("world".to_string()),
                css_path: None,
                url: Some("https://a.com".to_string()),
                deleted: false,
                deleted_ts: None,
                deletion_reason: None,
                replaced_by: None,
            }),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let delete = LogEntry::DeleteNote {
        timestamp: 10,
        url: Some("https://a.com".to_string()),
        path: "notes/n1.json".to_string(),
    };
    let restore = LogEntry::RestoreNote {
        timestamp: 20,
        url: Some("https://a.com".to_string()),
        path: "notes/n1.json".to_string(),
    };

    let forward = replay_sequence(
        base.clone(),
        vec![(delete.clone(), context()), (restore.clone(), context())],
    )
    .await;
    let reverse = replay_sequence(base, vec![(restore, context()), (delete, context())]).await;

    let forward_note = match forward.get("note:n1") {
        Some(Entity::Note(note)) => note,
        _ => panic!("restored note missing"),
    };
    let reverse_note = match reverse.get("note:n1") {
        Some(Entity::Note(note)) => note,
        _ => panic!("restored note missing"),
    };
    assert!(!forward_note.deleted);
    assert_eq!(forward_note.deleted_ts, Some(20));
    assert_eq!(forward_note, reverse_note);
}

#[tokio::test]
async fn two_devices_replacing_same_note_preserves_both_new_notes() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.child_ids = vec!["note:n1".to_string()];
    let base = BTreeMap::from([
        (page_key.clone(), Entity::Page(page)),
        (
            "note:n1".to_string(),
            Entity::Note(note("n1", "https://a.com")),
        ),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);

    let first = LogEntry::ReplaceNote {
        timestamp: 10,
        url: Some("https://a.com".to_string()),
        path: "notes/newY.json".to_string(),
        old_path: "notes/n1.json".to_string(),
        excerpt: None,
        note: None,
        css_path: None,
    };
    let second = LogEntry::ReplaceNote {
        timestamp: 20,
        url: Some("https://a.com".to_string()),
        path: "notes/newZ.json".to_string(),
        old_path: "notes/n1.json".to_string(),
        excerpt: None,
        note: None,
        css_path: None,
    };

    let state_a = replay_sequence(
        base.clone(),
        vec![(first.clone(), context()), (second.clone(), context())],
    )
    .await;
    let state_b = replay_sequence(base, vec![(second, context()), (first, context())]).await;

    for state in [&state_a, &state_b] {
        let page = match state.get(&page_key) {
            Some(Entity::Page(page)) => page,
            _ => panic!("page missing"),
        };
        assert!(page.child_ids.contains(&"note:newY".to_string()));
        assert!(page.child_ids.contains(&"note:newZ".to_string()));
        assert!(!state.contains_key("note:n1"));
    }
}

#[tokio::test]
async fn replace_and_delete_note_converge_with_new_note_preserved() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.child_ids = vec!["note:n1".to_string()];
    let base = BTreeMap::from([
        (page_key.clone(), Entity::Page(page)),
        (
            "note:n1".to_string(),
            Entity::Note(note("n1", "https://a.com")),
        ),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let replace = LogEntry::ReplaceNote {
        timestamp: 10,
        url: Some("https://a.com".to_string()),
        path: "notes/newY.json".to_string(),
        old_path: "notes/n1.json".to_string(),
        excerpt: None,
        note: None,
        css_path: None,
    };
    let delete = LogEntry::DeleteNote {
        timestamp: 20,
        url: Some("https://a.com".to_string()),
        path: "notes/n1.json".to_string(),
    };

    let state_a = replay_sequence(
        base.clone(),
        vec![(replace.clone(), context()), (delete.clone(), context())],
    )
    .await;
    let state_b = replay_sequence(base, vec![(delete, context()), (replace, context())]).await;

    for state in [&state_a, &state_b] {
        let page = match state.get(&page_key) {
            Some(Entity::Page(page)) => page,
            _ => panic!("page missing"),
        };
        assert!(state.contains_key("note:newY"));
        assert!(page.child_ids.contains(&"note:newY".to_string()));
        assert!(matches!(state.get("note:n1"), Some(Entity::Note(note)) if note.deleted));
    }
}

#[tokio::test]
async fn note_restore_then_delete_converges_to_deleted_state() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    let base = BTreeMap::from([
        (page_key, Entity::Page(page)),
        (
            "note:n1".to_string(),
            Entity::Note(NoteEntity {
                slug: "n1".to_string(),
                excerpt: Some("hello".to_string()),
                note: Some("world".to_string()),
                css_path: None,
                url: Some("https://a.com".to_string()),
                deleted: true,
                deleted_ts: Some(5),
                deletion_reason: None,
                replaced_by: None,
            }),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![browser_recall_replay::entities::OrphanedEntry {
                    key: "note:n1".to_string(),
                    url: Some("https://a.com".to_string()),
                }],
            }),
        ),
    ]);
    let restore = LogEntry::RestoreNote {
        timestamp: 10,
        url: Some("https://a.com".to_string()),
        path: "notes/n1.json".to_string(),
    };
    let delete = LogEntry::DeleteNote {
        timestamp: 20,
        url: Some("https://a.com".to_string()),
        path: "notes/n1.json".to_string(),
    };

    let forward = replay_sequence(
        base.clone(),
        vec![(restore.clone(), context()), (delete.clone(), context())],
    )
    .await;
    let reverse = replay_sequence(base, vec![(delete, context()), (restore, context())]).await;

    let forward_note = match forward.get("note:n1") {
        Some(Entity::Note(note)) => note,
        _ => panic!("deleted note missing"),
    };
    let reverse_note = match reverse.get("note:n1") {
        Some(Entity::Note(note)) => note,
        _ => panic!("deleted note missing"),
    };
    assert!(forward_note.deleted);
    assert_eq!(forward_note.deleted_ts, Some(20));
    assert_eq!(forward_note, reverse_note);
}

#[tokio::test]
async fn list_delete_then_restore_converges_to_restored_state() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![TreeNode {
                    id: "list:test-id".to_string(),
                    children: Vec::new(),
                }],
            }),
        ),
        (
            "list:test-id".to_string(),
            Entity::List(list("test-id", "Test")),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let delete = LogEntry::DeleteList {
        timestamp: 10,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
    };
    let restore = LogEntry::RestoreList {
        timestamp: 20,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
    };

    let forward = replay_sequence(
        base.clone(),
        vec![(delete.clone(), context()), (restore.clone(), context())],
    )
    .await;
    let reverse = replay_sequence(base, vec![(restore, context()), (delete, context())]).await;

    let forward_list = match forward.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("restored list missing"),
    };
    let reverse_list = match reverse.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("restored list missing"),
    };
    assert!(!forward_list.deleted);
    assert_eq!(forward_list.deleted_ts, Some(20));
    assert_eq!(forward_list, reverse_list);
}

#[tokio::test]
async fn list_restore_then_delete_converges_to_deleted_state() {
    let mut deleted = list("test-id", "Test");
    deleted.deleted = true;
    deleted.deleted_ts = Some(5);
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest::new()),
        ),
        ("list:test-id".to_string(), Entity::List(deleted)),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest {
                timestamps: Default::default(),
                entries: vec![browser_recall_replay::entities::OrphanedEntry {
                    key: "list:test-id".to_string(),
                    url: None,
                }],
            }),
        ),
    ]);
    let restore = LogEntry::RestoreList {
        timestamp: 10,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
    };
    let delete = LogEntry::DeleteList {
        timestamp: 20,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
    };

    let forward = replay_sequence(
        base.clone(),
        vec![(restore.clone(), context()), (delete.clone(), context())],
    )
    .await;
    let reverse = replay_sequence(base, vec![(delete, context()), (restore, context())]).await;

    let forward_list = match forward.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("deleted list missing"),
    };
    let reverse_list = match reverse.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("deleted list missing"),
    };
    assert!(forward_list.deleted);
    assert_eq!(forward_list.deleted_ts, Some(20));
    assert_eq!(forward_list, reverse_list);
}

#[tokio::test]
async fn tree_updates_converge_with_newest_timestamp_winning() {
    let base = BTreeMap::from([(
        "manifest:list-order".to_string(),
        Entity::ListOrder(ListOrderManifest::new()),
    )]);
    let older = LogEntry::UpdateListTree {
        timestamp: 10,
        tree: vec![
            TreeNode {
                id: "list:a".to_string(),
                children: Vec::new(),
            },
            TreeNode {
                id: "list:b".to_string(),
                children: Vec::new(),
            },
        ],
    };
    let newer_tree = vec![
        TreeNode {
            id: "list:c".to_string(),
            children: vec![TreeNode {
                id: "list:a".to_string(),
                children: Vec::new(),
            }],
        },
        TreeNode {
            id: "list:b".to_string(),
            children: Vec::new(),
        },
    ];
    let newer = LogEntry::UpdateListTree {
        timestamp: 20,
        tree: newer_tree.clone(),
    };

    let forward = replay_sequence(
        base.clone(),
        vec![(older.clone(), context()), (newer.clone(), context())],
    )
    .await;
    let reverse = replay_sequence(base, vec![(newer, context()), (older, context())]).await;

    let forward_tree = match forward.get("manifest:list-order") {
        Some(Entity::ListOrder(manifest)) => &manifest.tree,
        _ => panic!("tree manifest missing"),
    };
    let reverse_tree = match reverse.get("manifest:list-order") {
        Some(Entity::ListOrder(manifest)) => &manifest.tree,
        _ => panic!("tree manifest missing"),
    };
    assert_eq!(forward_tree, &newer_tree);
    assert_eq!(forward_tree, reverse_tree);
}

#[tokio::test]
async fn two_devices_rating_same_page_accumulates_in_any_order() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.likes = Some(0);
    let base = BTreeMap::from([(key.clone(), Entity::Page(page))]);
    let first = LogEntry::RatePage {
        timestamp: 10,
        url: "https://a.com".to_string(),
        likes: 1,
        title: None,
    };
    let second = LogEntry::RatePage {
        timestamp: 20,
        url: "https://a.com".to_string(),
        likes: 1,
        title: None,
    };

    let forward = replay_sequence(
        base.clone(),
        vec![
            (first.clone(), context_with_device("deviceA")),
            (second.clone(), context_with_device("deviceB")),
        ],
    )
    .await;
    let reverse = replay_sequence(
        base,
        vec![
            (second, context_with_device("deviceB")),
            (first, context_with_device("deviceA")),
        ],
    )
    .await;

    let forward_page = match forward.get(&key) {
        Some(Entity::Page(page)) => page,
        _ => panic!("page missing"),
    };
    let reverse_page = match reverse.get(&key) {
        Some(Entity::Page(page)) => page,
        _ => panic!("page missing"),
    };
    assert_eq!(forward_page.likes, Some(2));
    assert_eq!(reverse_page.likes, Some(2));
}

#[tokio::test]
async fn same_device_replaying_rate_event_does_not_double_count() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.likes = Some(0);
    let base = BTreeMap::from([(key.clone(), Entity::Page(page))]);
    let entry = LogEntry::RatePage {
        timestamp: 10,
        url: "https://a.com".to_string(),
        likes: 1,
        title: None,
    };

    let replayed = replay_sequence(
        base,
        vec![
            (entry.clone(), context_with_device("deviceA")),
            (entry, context_with_device("deviceA")),
        ],
    )
    .await;

    let page = match replayed.get(&key) {
        Some(Entity::Page(page)) => page,
        _ => panic!("page missing"),
    };
    assert_eq!(page.likes, Some(1));
}

#[tokio::test]
async fn leave_page_accumulates_per_device_time_on_page_in_any_order() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.time_on_page = Some(0);
    let base = BTreeMap::from([(key.clone(), Entity::Page(page))]);
    let first = LogEntry::LeavePage {
        timestamp: 10,
        url: "https://a.com".to_string(),
        title: None,
        scroll_depth: None,
        time_on_page: Some(5000),
    };
    let second = LogEntry::LeavePage {
        timestamp: 20,
        url: "https://a.com".to_string(),
        title: None,
        scroll_depth: None,
        time_on_page: Some(3000),
    };

    let forward = replay_sequence(
        base.clone(),
        vec![
            (first.clone(), context_with_device("deviceA")),
            (second.clone(), context_with_device("deviceB")),
        ],
    )
    .await;
    let reverse = replay_sequence(
        base,
        vec![
            (second, context_with_device("deviceB")),
            (first, context_with_device("deviceA")),
        ],
    )
    .await;

    let forward_page = match forward.get(&key) {
        Some(Entity::Page(page)) => page,
        _ => panic!("page missing"),
    };
    let reverse_page = match reverse.get(&key) {
        Some(Entity::Page(page)) => page,
        _ => panic!("page missing"),
    };
    assert_eq!(forward_page.time_on_page, Some(8000));
    assert_eq!(reverse_page.time_on_page, Some(8000));
}

#[tokio::test]
async fn delete_then_pin_to_deleted_list_converges_for_list_state() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![TreeNode {
                    id: "list:test-id".to_string(),
                    children: Vec::new(),
                }],
            }),
        ),
        (
            "list:test-id".to_string(),
            Entity::List(list("test-id", "Test")),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let delete = LogEntry::DeleteList {
        timestamp: 10,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
    };
    let pin = LogEntry::PinToList {
        timestamp: 20,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
        items: vec!["https://a.com".to_string()],
        titles: None,
        source: None,
    };

    let forward = replay_sequence(
        base.clone(),
        vec![(delete.clone(), context()), (pin.clone(), context())],
    )
    .await;
    let reverse = replay_sequence(base, vec![(pin, context()), (delete, context())]).await;

    let forward_list = match forward.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("list missing"),
    };
    let reverse_list = match reverse.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("list missing"),
    };
    assert!(forward_list.deleted);
    assert_eq!(forward_list.pins.len(), 1);
    assert_eq!(forward_list.deleted, reverse_list.deleted);
    assert_eq!(forward_list.pins.len(), reverse_list.pins.len());
}

#[tokio::test]
async fn pin_delete_restore_list_converges_across_all_orderings() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![TreeNode {
                    id: "list:test-id".to_string(),
                    children: Vec::new(),
                }],
            }),
        ),
        (
            "list:test-id".to_string(),
            Entity::List(list("test-id", "Test")),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let events = vec![
        LogEntry::PinToList {
            timestamp: 10,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
            titles: None,
            source: None,
        },
        LogEntry::DeleteList {
            timestamp: 20,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
        LogEntry::RestoreList {
            timestamp: 30,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
    ];

    let mut states = Vec::new();
    for permutation in permutations(&events) {
        let steps = permutation
            .into_iter()
            .map(|entry| (entry, context()))
            .collect::<Vec<_>>();
        states.push(replay_sequence(base.clone(), steps).await);
    }

    for state in &states {
        let list = match state.get("list:test-id") {
            Some(Entity::List(list)) => list,
            _ => panic!("list missing"),
        };
        assert!(!list.deleted);
        assert_eq!(list.pins.len(), 1);
    }
}

#[tokio::test]
async fn delete_then_unpin_from_deleted_list_converges_for_list_state() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut listed_page = page(&slug);
    listed_page.url = Some("https://a.com".to_string());
    listed_page.parent_ids = vec!["list:test-id".to_string()];
    let mut seeded_list = list("test-id", "Test");
    seeded_list.pins = vec![PinEntity {
        id: page_key,
        pinned_at: 5,
        source: None,
    }];

    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![TreeNode {
                    id: "list:test-id".to_string(),
                    children: Vec::new(),
                }],
            }),
        ),
        ("list:test-id".to_string(), Entity::List(seeded_list)),
        (format!("page:{slug}"), Entity::Page(listed_page)),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let delete = LogEntry::DeleteList {
        timestamp: 10,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
    };
    let unpin = LogEntry::UnpinFromList {
        timestamp: 20,
        name: "Test".to_string(),
        list_owner: "test-device".to_string(),
        items: vec!["https://a.com".to_string()],
    };

    let forward = replay_sequence(
        base.clone(),
        vec![(delete.clone(), context()), (unpin.clone(), context())],
    )
    .await;
    let reverse = replay_sequence(base, vec![(unpin, context()), (delete, context())]).await;

    let forward_list = match forward.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("list missing"),
    };
    let reverse_list = match reverse.get("list:test-id") {
        Some(Entity::List(list)) => list,
        _ => panic!("list missing"),
    };
    assert!(forward_list.pins.is_empty());
    assert_eq!(forward_list.pins.len(), reverse_list.pins.len());
}

#[tokio::test]
async fn replace_delete_restore_note_converges_across_all_orderings() {
    let slug = generate_slug_from_url("https://a.com").expect("slug");
    let page_key = format!("page:{slug}");
    let mut page = page(&slug);
    page.url = Some("https://a.com".to_string());
    page.child_ids = vec!["note:n1".to_string()];
    let base = BTreeMap::from([
        (page_key, Entity::Page(page)),
        (
            "note:n1".to_string(),
            Entity::Note(note("n1", "https://a.com")),
        ),
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest::new()),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let events = vec![
        LogEntry::ReplaceNote {
            timestamp: 10,
            url: Some("https://a.com".to_string()),
            path: "notes/newY.json".to_string(),
            old_path: "notes/n1.json".to_string(),
            excerpt: None,
            note: None,
            css_path: None,
        },
        LogEntry::DeleteNote {
            timestamp: 20,
            url: Some("https://a.com".to_string()),
            path: "notes/n1.json".to_string(),
        },
        LogEntry::RestoreNote {
            timestamp: 30,
            url: Some("https://a.com".to_string()),
            path: "notes/n1.json".to_string(),
        },
    ];

    for permutation in permutations(&events) {
        let state = replay_sequence(
            base.clone(),
            permutation
                .into_iter()
                .map(|entry| (entry, context()))
                .collect(),
        )
        .await;

        let note = match state.get("note:n1") {
            Some(Entity::Note(note)) => note,
            _ => panic!("note missing"),
        };
        assert!(!note.deleted);
        assert_eq!(note.deleted_ts, Some(30));
        assert!(state.contains_key("note:newY"));
    }
}

#[tokio::test]
async fn delete_pin_restore_list_converges_across_all_orderings() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![TreeNode {
                    id: "list:test-id".to_string(),
                    children: Vec::new(),
                }],
            }),
        ),
        (
            "list:test-id".to_string(),
            Entity::List(list("test-id", "Test")),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let events = vec![
        LogEntry::DeleteList {
            timestamp: 10,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
        LogEntry::PinToList {
            timestamp: 20,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            items: vec!["https://a.com".to_string()],
            titles: None,
            source: None,
        },
        LogEntry::RestoreList {
            timestamp: 30,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
    ];

    for permutation in permutations(&events) {
        let state = replay_sequence(
            base.clone(),
            permutation
                .into_iter()
                .map(|entry| (entry, context()))
                .collect(),
        )
        .await;

        let list = match state.get("list:test-id") {
            Some(Entity::List(list)) => list,
            _ => panic!("list missing"),
        };
        assert!(!list.deleted);
        assert_eq!(list.pins.len(), 1);
    }
}

#[tokio::test]
async fn delete_add_rule_restore_list_converges_across_all_orderings() {
    let base = BTreeMap::from([
        (
            "manifest:name-to-id".to_string(),
            Entity::NameToId(NameToIdManifest {
                timestamps: Default::default(),
                paths: BTreeMap::from([("test-device/Test".to_string(), "test-id".to_string())]),
            }),
        ),
        (
            "manifest:list-order".to_string(),
            Entity::ListOrder(ListOrderManifest {
                timestamps: Default::default(),
                tree: vec![TreeNode {
                    id: "list:test-id".to_string(),
                    children: Vec::new(),
                }],
            }),
        ),
        (
            "list:test-id".to_string(),
            Entity::List(list("test-id", "Test")),
        ),
        (
            "manifest:orphaned".to_string(),
            Entity::Orphaned(OrphanedManifest::new()),
        ),
    ]);
    let events = vec![
        LogEntry::DeleteList {
            timestamp: 10,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
        LogEntry::AddRule {
            timestamp: 20,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
            rule: RuleInput {
                id: Some("rule-k-1".to_string()),
                rule_type: "keyword".to_string(),
                config: BTreeMap::from([("pattern".to_string(), json!("test"))]),
            },
        },
        LogEntry::RestoreList {
            timestamp: 30,
            name: "Test".to_string(),
            list_owner: "test-device".to_string(),
        },
    ];

    for permutation in permutations(&events) {
        let state = replay_sequence(
            base.clone(),
            permutation
                .into_iter()
                .map(|entry| (entry, context()))
                .collect(),
        )
        .await;

        let list = match state.get("list:test-id") {
            Some(Entity::List(list)) => list,
            _ => panic!("list missing"),
        };
        assert!(!list.deleted);
        assert_eq!(list.rules.len(), 1);
        assert_eq!(list.rules[0].config.get("pattern"), Some(&json!("test")));
    }
}
