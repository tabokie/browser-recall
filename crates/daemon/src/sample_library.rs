use crate::{runtime::ReplayTransaction, storage::Storage};
use browser_recall_replay::{entities::ListEntity, generate_slug_from_url, LogEntry};
use serde_json::json;

pub(crate) const LIST_ID: &str = "browser-recall-sample-library";
const OWNER: &str = "browser-recall-sample";
const LIST_NAME: &str = "Sample Library";
const PAGE_URL: &str = "https://example.org/?browser-recall-sample=reading";
const PAGE_TITLE: &str = "A quieter way to read";
const EXCERPT: &str = "Save a passage worth coming back to.";
const NOTE_ID: &str = "browser-recall-sample-highlight";
const NOTE_PATH: &str = "objects/notes/browser-recall-sample-highlight.json";
const SNAPSHOT_MARKER: &str = "<!-- Browser Recall sample library -->";

async fn sample_list(storage: &Storage) -> Result<Option<ListEntity>, String> {
    let list = storage
        .load_list(LIST_ID)
        .await
        .map_err(|error| error.to_string())?;
    if list.as_ref().is_some_and(|list| list.owner != OWNER) {
        return Err("The sample library identifier is already in use".into());
    }
    Ok(list)
}

async fn sample_snapshots(
    storage: &Storage,
    slug: &str,
    in_recycle_bin: bool,
) -> Result<Vec<i64>, String> {
    let candidates = if in_recycle_bin {
        storage
            .load_orphaned()
            .await
            .map_err(|error| error.to_string())?
            .map(|manifest| {
                manifest
                    .entries
                    .into_iter()
                    .map(|entry| entry.key)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        storage
            .load_page(slug)
            .await
            .map_err(|error| error.to_string())?
            .map(|page| page.child_ids)
            .unwrap_or_default()
    };
    let prefix = format!("snapshot:{slug}-");
    let mut timestamps = Vec::new();
    for key in candidates {
        let Some(timestamp) = key
            .strip_prefix(&prefix)
            .and_then(|value| value.parse().ok())
        else {
            continue;
        };
        let html = storage
            .load_snapshot_html(slug, timestamp)
            .await
            .map_err(|error| error.to_string())?;
        if html.is_some_and(|html| html.contains(SNAPSHOT_MARKER)) {
            timestamps.push(timestamp);
        }
    }
    Ok(timestamps)
}

pub(crate) async fn load(storage: &Storage, device_id: &str) -> Result<String, String> {
    let mut transaction = ReplayTransaction::begin(storage, device_id).await?;
    let list = sample_list(storage).await?;
    if let Some(list) = list.as_ref().filter(|list| !list.deleted) {
        return Ok(list.name.clone());
    }

    let slug = generate_slug_from_url(PAGE_URL).map_err(|error| error.to_string())?;
    let active_snapshots = sample_snapshots(storage, &slug, false).await?;
    if active_snapshots.is_empty() {
        if let Some(timestamp) = sample_snapshots(storage, &slug, true)
            .await?
            .into_iter()
            .max()
        {
            transaction
                .apply(LogEntry::RestoreSnapshot {
                    timestamp: storage.next_command_timestamp_millis(),
                    url: PAGE_URL.into(),
                    path: storage.snapshot_sidecar_relative_path(&slug, timestamp),
                })
                .await?;
        } else {
            create_snapshot(storage, &mut transaction, &slug).await?;
        }
    }

    match storage
        .load_note(NOTE_ID)
        .await
        .map_err(|error| error.to_string())?
    {
        Some(note) if note.deleted && note.url.as_deref() == Some(PAGE_URL) => {
            // A user edit replaces the sample note without sending it to the Recycle Bin.
            let note_key = format!("note:{NOTE_ID}");
            let recycle_bin = storage
                .load_orphaned()
                .await
                .map_err(|error| error.to_string())?;
            if recycle_bin
                .is_some_and(|manifest| manifest.entries.iter().any(|entry| entry.key == note_key))
            {
                transaction
                    .apply(LogEntry::RestoreNote {
                        timestamp: storage.next_command_timestamp_millis(),
                        url: Some(PAGE_URL.into()),
                        path: NOTE_PATH.into(),
                    })
                    .await?;
            }
        }
        None => {
            transaction
                .apply(LogEntry::CreateNote {
                    timestamp: storage.next_command_timestamp_millis(),
                    url: PAGE_URL.into(),
                    path: NOTE_PATH.into(),
                    title: Some(PAGE_TITLE.into()),
                    excerpt: Some(json!([EXCERPT])),
                    note: Some("Try opening the saved page from the snapshot menu.".into()),
                    css_path: Some(json!(["main > p:first-of-type"])),
                })
                .await?;
        }
        Some(_) => {}
    }

    let timestamp = storage.next_command_timestamp_millis();
    let name = if let Some(list) = list {
        transaction
            .apply(LogEntry::RestoreList {
                timestamp,
                name: list.name.clone(),
                list_owner: OWNER.into(),
            })
            .await?;
        list.name
    } else {
        transaction
            .apply(LogEntry::CreateList {
                timestamp,
                list_owner: OWNER.into(),
                list_id: Some(LIST_ID.into()),
                name: LIST_NAME.into(),
                parent_list_id: None,
            })
            .await?;
        LIST_NAME.into()
    };
    transaction
        .apply(LogEntry::PinToList {
            timestamp: storage.next_command_timestamp_millis(),
            name: name.clone(),
            list_owner: OWNER.into(),
            urls: vec![PAGE_URL.into()],
            titles: Some(vec![Some(PAGE_TITLE.into())]),
            source: None,
        })
        .await?;
    transaction.commit().await?;
    Ok(name)
}

async fn create_snapshot(
    storage: &Storage,
    transaction: &mut ReplayTransaction<'_>,
    slug: &str,
) -> Result<(), String> {
    let timestamp = storage.next_command_timestamp_millis();
    let html = format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"x-browser-recall-slug\" content=\"{slug}\">\
             <meta name=\"x-browser-recall-url\" content=\"{PAGE_URL}\">\
             <title>{PAGE_TITLE}</title></head><body>{SNAPSHOT_MARKER}\
             <main><h1>{PAGE_TITLE}</h1><p>{EXCERPT}</p>\
             <p>This example stays available offline. Open Book to read the sample highlight, or search for this page by title.</p>\
             </main></body></html>"
        );
    let markdown =
        format!("# {PAGE_TITLE}\n\n{EXCERPT}\n\nThis example stays available offline.\n");
    storage
        .save_snapshot_html(slug, timestamp, &html)
        .await
        .map_err(|error| error.to_string())?;
    storage
        .save_snapshot_markdown(slug, timestamp, &markdown)
        .await
        .map_err(|error| error.to_string())?;
    transaction
        .apply(LogEntry::CreateSnapshot {
            timestamp,
            url: PAGE_URL.into(),
            path: storage.snapshot_sidecar_relative_path(slug, timestamp),
            title: Some(PAGE_TITLE.into()),
        })
        .await?;
    Ok(())
}

pub(crate) async fn remove(storage: &Storage, device_id: &str) -> Result<(), String> {
    let mut transaction = ReplayTransaction::begin(storage, device_id).await?;
    let Some(list) = sample_list(storage).await? else {
        return Ok(());
    };
    let slug = generate_slug_from_url(PAGE_URL).map_err(|error| error.to_string())?;
    for snapshot in sample_snapshots(storage, &slug, false).await? {
        transaction
            .apply(LogEntry::DeleteSnapshot {
                timestamp: storage.next_command_timestamp_millis(),
                url: PAGE_URL.into(),
                path: storage.snapshot_sidecar_relative_path(&slug, snapshot),
            })
            .await?;
    }
    if storage
        .load_note(NOTE_ID)
        .await
        .map_err(|error| error.to_string())?
        .is_some_and(|note| !note.deleted && note.url.as_deref() == Some(PAGE_URL))
    {
        transaction
            .apply(LogEntry::DeleteNote {
                timestamp: storage.next_command_timestamp_millis(),
                url: Some(PAGE_URL.into()),
                path: NOTE_PATH.into(),
            })
            .await?;
    }
    if !list.deleted {
        transaction
            .apply(LogEntry::DeleteList {
                timestamp: storage.next_command_timestamp_millis(),
                name: list.name,
                list_owner: OWNER.into(),
            })
            .await?;
    }
    transaction.commit().await?;
    Ok(())
}
