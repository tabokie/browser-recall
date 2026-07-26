use browser_recall_daemon::read_projections::ReadProjections;
use browser_recall_daemon::storage::Storage;
use browser_recall_replay::entities::{
    ListEntity, ListOrderManifest, NoteEntity, OrphanedEntry, OrphanedManifest, PageEntity,
    PinEntity, TreeNode,
};
use tempfile::tempdir;

#[tokio::test]
async fn list_display_resolves_page_and_note_pins_from_coordinated_disk_reads() {
    let dir = tempdir().expect("tempdir");
    let writer = Storage::new(dir.path());
    writer.ensure_layout("device-a").await.expect("layout");

    let mut page = PageEntity::new("page-a".to_string());
    page.url = Some("https://example.com/a".to_string());
    page.title = Some("Page A".to_string());
    page.user_title = Some("Renamed A".to_string());
    page.child_ids = vec!["note:note-a".to_string()];
    writer.save_page("page-a", &page).await.expect("page");

    let mut note = NoteEntity::new("note-a".to_string());
    note.excerpt = Some(serde_json::json!(["Highlighted text"]));
    note.css_path = Some(serde_json::json!(["body"]));
    writer.save_note("note-a", &note).await.expect("note");

    let mut list = ListEntity::new(
        "reading".to_string(),
        "Reading".to_string(),
        "device-a".to_string(),
    );
    list.pins = vec![
        PinEntity {
            id: "page:page-a".to_string(),
            pinned_at: 20,
            source: None,
        },
        PinEntity {
            id: "note:note-a".to_string(),
            pinned_at: 10,
            source: Some("manual".to_string()),
        },
    ];
    writer.save_list("reading", &list).await.expect("list");

    // A fresh Storage has an empty projection cache, so every successful read
    // below proves the coordinated cache-miss-to-disk path is used.
    let reader = Storage::new(dir.path());
    let projection = ReadProjections::new(reader)
        .list_display("reading")
        .await
        .expect("projection")
        .expect("visible list");

    assert_eq!(projection.slug, "reading");
    assert_eq!(projection.pins.len(), 2);
    assert_eq!(projection.pins[0].kind, "page");
    assert_eq!(
        projection.pins[0].url.as_deref(),
        Some("https://example.com/a")
    );
    assert_eq!(projection.pins[0].user_title.as_deref(), Some("Renamed A"));
    assert_eq!(projection.pins[1].kind, "note");
    assert_eq!(
        projection.pins[1].title.as_deref(),
        Some("Highlighted text")
    );
    let pin_json = serde_json::to_value(&projection.pins[0]).expect("serialized pin");
    assert!(pin_json.get("id").is_none());
    assert_eq!(pin_json["slug"], "page-a");
}

#[tokio::test]
async fn list_display_hides_deleted_lists_and_rejects_invalid_pin_targets() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage.ensure_layout("device-a").await.expect("layout");

    let mut list = ListEntity::new(
        "missing-target".to_string(),
        "Missing target".to_string(),
        "device-a".to_string(),
    );
    list.pins.push(PinEntity {
        id: "page:not-checkpointed".to_string(),
        pinned_at: 1,
        source: None,
    });
    storage
        .save_list("missing-target", &list)
        .await
        .expect("list");
    let projections = ReadProjections::new(storage.clone());
    let missing_error = projections
        .list_display("missing-target")
        .await
        .expect_err("missing pin targets must fail");
    assert!(missing_error.contains("references missing page not-checkpointed"));

    list.pins[0].id = "malformed-pin".to_string();
    storage
        .save_list("missing-target", &list)
        .await
        .expect("malformed pin list");
    assert!(projections
        .list_display("missing-target")
        .await
        .expect_err("malformed pin IDs must fail")
        .contains("missing its entity kind"));

    list.deleted = true;
    storage
        .save_list("missing-target", &list)
        .await
        .expect("deleted list");
    assert!(projections
        .list_display("missing-target")
        .await
        .expect("deleted projection")
        .is_none());
}

#[tokio::test]
async fn page_context_batches_pages_notes_and_visible_list_memberships() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage.ensure_layout("device-a").await.expect("layout");

    let mut page = PageEntity::new("page-a".to_string());
    page.url = Some("https://example.com/a".to_string());
    page.child_ids = vec!["note:note-a".to_string()];
    page.parent_ids = vec!["list:reading".to_string(), "list:deleted".to_string()];
    storage.save_page("page-a", &page).await.expect("page");
    let mut note = NoteEntity::new("note-a".to_string());
    note.note = Some("Context note".to_string());
    storage.save_note("note-a", &note).await.expect("note");
    let reading = ListEntity::new(
        "reading".to_string(),
        "Reading".to_string(),
        "device-a".to_string(),
    );
    storage
        .save_list("reading", &reading)
        .await
        .expect("reading");
    let mut deleted = ListEntity::new(
        "deleted".to_string(),
        "Deleted".to_string(),
        "device-a".to_string(),
    );
    deleted.deleted = true;
    storage
        .save_list("deleted", &deleted)
        .await
        .expect("deleted");

    let pages = ReadProjections::new(storage)
        .page_context(&["page-a".to_string(), "missing".to_string()])
        .await
        .expect("page context");
    let context = pages.get("page-a").expect("page-a context");
    assert_eq!(context.notes[0].note.as_deref(), Some("Context note"));
    assert_eq!(context.lists[0].name, "Reading");
    assert!(!pages.contains_key("missing"));
    let page_json = serde_json::to_value(&context.page).expect("serialized page");
    assert!(page_json.get("childIds").is_none());
    assert!(page_json.get("parentIds").is_none());
}

#[tokio::test]
async fn list_tree_and_recycle_bin_hide_storage_topology_and_restore_policy() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage.ensure_layout("device-a").await.expect("layout");
    let list = ListEntity::new(
        "reading".to_string(),
        "Reading".to_string(),
        "device-a".to_string(),
    );
    storage.save_list("reading", &list).await.expect("list");
    storage
        .save_list_order(&ListOrderManifest {
            timestamps: Default::default(),
            tree: vec![TreeNode {
                id: "list:reading".to_string(),
                children: vec![],
            }],
        })
        .await
        .expect("order");

    let mut deleted_note = NoteEntity::new("deleted-note".to_string());
    deleted_note.deleted = true;
    deleted_note.excerpt = Some(serde_json::json!(["Deleted excerpt"]));
    storage
        .save_note("deleted-note", &deleted_note)
        .await
        .expect("note");
    let mut replaced_note = NoteEntity::new("replaced-note".to_string());
    replaced_note.deleted = true;
    replaced_note.replaced_by = Some("note:new-note".to_string());
    storage
        .save_note("replaced-note", &replaced_note)
        .await
        .expect("replaced");
    storage
        .save_orphaned(&OrphanedManifest {
            timestamps: Default::default(),
            entries: vec![
                OrphanedEntry {
                    key: "note:deleted-note".to_string(),
                    url: None,
                },
                OrphanedEntry {
                    key: "note:replaced-note".to_string(),
                    url: None,
                },
            ],
        })
        .await
        .expect("orphaned");

    let projections = ReadProjections::new(storage);
    let tree = projections.list_tree().await.expect("tree");
    assert_eq!(tree.tree[0].slug, "reading");
    assert_eq!(tree.tree[0].name, "Reading");
    assert_eq!(tree.order[0].slug, "reading");
    let order_json = serde_json::to_value(&tree.order[0]).expect("serialized order");
    assert!(order_json.get("id").is_none());
    let recycle = projections.recycle_bin().await.expect("recycle");
    assert_eq!(recycle.len(), 1);
    assert_eq!(recycle[0].key, "note:deleted-note");
    assert_eq!(recycle[0].title.as_deref(), Some("Deleted excerpt"));
}

#[tokio::test]
async fn list_tree_rejects_malformed_nodes_instead_of_dropping_them() {
    let dir = tempdir().expect("tempdir");
    let storage = Storage::new(dir.path());
    storage.ensure_layout("device-a").await.expect("layout");
    storage
        .save_list_order(&ListOrderManifest {
            timestamps: Default::default(),
            tree: vec![TreeNode {
                id: "page:not-a-list".to_string(),
                children: vec![],
            }],
        })
        .await
        .expect("order");

    let error = ReadProjections::new(storage)
        .list_tree()
        .await
        .expect_err("malformed list-order nodes must fail projection");
    assert!(error.contains("invalid entity reference page:not-a-list"));
}
