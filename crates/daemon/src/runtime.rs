use crate::storage::{ReplayProgress, Storage};
use browser_recall_replay::{
    effect_of, Context as ReplayContext, EntityEffect, LogEntry, ReplayError,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::MutexGuard;

pub type EntityMapView = BTreeMap<String, EntityEffect>;

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayTransactionResult {
    pub entry_count: usize,
    pub effects: EntityMapView,
}

pub struct ReplayTransaction<'a> {
    storage: &'a Storage,
    _write_guard: MutexGuard<'a, ()>,
    device_id: String,
    entries: Vec<LogEntry>,
    effects: EntityMapView,
}

impl<'a> ReplayTransaction<'a> {
    pub async fn begin(storage: &'a Storage, device_id: &str) -> Result<Self, String> {
        let write_guard = storage.write_guard().await;
        Ok(Self {
            storage,
            _write_guard: write_guard,
            device_id: device_id.to_string(),
            entries: Vec::new(),
            effects: EntityMapView::new(),
        })
    }

    pub async fn apply(&mut self, entry: LogEntry) -> Result<EntityMapView, String> {
        if matches!(entry, LogEntry::PermanentDelete { .. }) {
            self.storage
                .flush_checkpoints()
                .await
                .map_err(|error| error.to_string())?;
        }
        let replay_context = ReplayContext {
            device_id: self.device_id.clone(),
        };
        let next_effects =
            effect_with_overlay(entry.clone(), self.storage, &self.effects, &replay_context)
                .await
                .map_err(|error| error.to_string())?;
        self.effects.extend(next_effects.clone());
        self.entries.push(entry);
        Ok(next_effects)
    }

    pub fn effects(&self) -> &EntityMapView {
        &self.effects
    }

    pub async fn commit(self) -> Result<ReplayTransactionResult, String> {
        let entry_count = self.entries.len();
        if entry_count == 0 {
            return Ok(ReplayTransactionResult {
                entry_count,
                effects: self.effects,
            });
        }

        let persisted_progress = self
            .storage
            .load_replay_progress()
            .await
            .map_err(|error| error.to_string())?;
        let must_flush_before_ack =
            persisted_progress
                .get(&self.device_id)
                .is_some_and(|progress| {
                    self.entries
                        .iter()
                        .any(|entry| entry.timestamp() <= *progress)
                });
        let replay_progress = replay_progress_for_entries(
            &self.device_id,
            self.entries.iter().map(LogEntry::timestamp),
        );
        let checkpoint_slot = if self.effects.is_empty() && replay_progress.is_empty() {
            None
        } else {
            Some(
                self.storage
                    .reserve_checkpoint_slot()
                    .await
                    .map_err(|error| error.to_string())?,
            )
        };

        for entry in &self.entries {
            let raw = serde_json::to_value(entry).map_err(|error| error.to_string())?;
            self.storage
                .append_log_entry(&self.device_id, entry.timestamp(), &raw)
                .await
                .map_err(|error| error.to_string())?;
        }

        apply_projection(
            self.storage,
            checkpoint_slot,
            &self.effects,
            replay_progress,
        );
        if must_flush_before_ack {
            self.storage
                .flush_checkpoints()
                .await
                .map_err(|error| error.to_string())?;
        }

        Ok(ReplayTransactionResult {
            entry_count,
            effects: self.effects,
        })
    }
}

pub async fn commit_local_entries(
    storage: &Storage,
    device_id: &str,
    entries: impl IntoIterator<Item = LogEntry>,
) -> Result<ReplayTransactionResult, String> {
    let mut transaction = ReplayTransaction::begin(storage, device_id).await?;
    for entry in entries {
        transaction.apply(entry).await?;
    }
    transaction.commit().await
}

pub async fn install_remote_files(
    storage: &Storage,
    device_id: &str,
    files: &[(String, String)],
    entries: Vec<LogEntry>,
) -> Result<ReplayTransactionResult, String> {
    let entry_count = entries.len();
    let _write_guard = storage.write_guard().await;
    storage
        .flush_checkpoints()
        .await
        .map_err(|error| error.to_string())?;

    let replay_context = ReplayContext {
        device_id: device_id.to_string(),
    };
    let mut effects = EntityMapView::new();
    for entry in &entries {
        let next_effects = effect_with_overlay(entry.clone(), storage, &effects, &replay_context)
            .await
            .map_err(|error| error.to_string())?;
        effects.extend(next_effects);
    }
    let replay_progress =
        replay_progress_for_entries(device_id, entries.iter().map(LogEntry::timestamp));
    let checkpoint_slot = if entries.is_empty() {
        None
    } else {
        Some(
            storage
                .reserve_checkpoint_slot()
                .await
                .map_err(|error| error.to_string())?,
        )
    };
    if !files.is_empty() {
        storage
            .write_sync_files(files)
            .await
            .map_err(|error| error.to_string())?;
    }
    apply_projection(storage, checkpoint_slot, &effects, replay_progress);

    Ok(ReplayTransactionResult {
        entry_count,
        effects,
    })
}

pub async fn clear_all_data(storage: &Storage, device_id: &str) -> Result<usize, String> {
    let _write_guard = storage.write_guard().await;
    storage
        .flush_checkpoints()
        .await
        .map_err(|error| error.to_string())?;
    storage
        .clear_all_data(device_id)
        .await
        .map_err(|error| error.to_string())
}

pub async fn recover_checkpoint_tail(storage: &Storage) -> Result<usize, String> {
    let _write_guard = storage.write_guard().await;
    let entries = storage
        .load_log_entries_after_replay_progress()
        .await
        .map_err(|error| error.to_string())?;
    if entries.is_empty() {
        return Ok(0);
    }

    let mut effects = EntityMapView::new();
    let mut replay_progress = ReplayProgress::new();
    for (device_id, entry) in &entries {
        let replay_context = ReplayContext {
            device_id: device_id.clone(),
        };
        let next_effects = effect_with_overlay(entry.clone(), storage, &effects, &replay_context)
            .await
            .map_err(|error| error.to_string())?;
        effects.extend(next_effects);
        let current = replay_progress.entry(device_id.clone()).or_insert(i64::MIN);
        *current = (*current).max(entry.timestamp());
    }

    let checkpoint_slot = storage
        .reserve_checkpoint_slot()
        .await
        .map_err(|error| error.to_string())?;
    apply_projection(storage, Some(checkpoint_slot), &effects, replay_progress);
    Ok(entries.len())
}

async fn effect_with_overlay(
    entry: LogEntry,
    storage: &Storage,
    overlay: &EntityMapView,
    context: &ReplayContext,
) -> Result<EntityMapView, ReplayError> {
    let load_error = Arc::new(StdMutex::new(None::<String>));
    let replay_result = effect_of(
        entry,
        |key| {
            let key = key.to_string();
            let overlay_effect = overlay.get(&key).cloned();
            let storage = storage.clone();
            let load_error = Arc::clone(&load_error);
            async move {
                if let Some(effect) = overlay_effect {
                    return match effect {
                        EntityEffect::Upsert(entity) => Some(entity),
                        EntityEffect::Delete => None,
                    };
                }
                match storage.load_entity(&key).await {
                    Ok(entity) => entity,
                    Err(error) => {
                        let mut first_error =
                            load_error.lock().expect("replay load error mutex poisoned");
                        if first_error.is_none() {
                            *first_error = Some(format!("{key}: {error}"));
                        }
                        None
                    }
                }
            }
        },
        context.clone(),
    )
    .await;
    let load_error = load_error
        .lock()
        .expect("replay load error mutex poisoned")
        .take();
    match load_error {
        Some(error) => Err(ReplayError::Load(error)),
        None => replay_result,
    }
}

fn apply_projection(
    storage: &Storage,
    checkpoint_slot: Option<crate::storage::CheckpointPermit>,
    effects: &EntityMapView,
    replay_progress: ReplayProgress,
) {
    for (key, effect) in effects {
        storage.apply_effect_to_cache(key, effect);
    }
    if let Some(checkpoint_slot) =
        checkpoint_slot.filter(|_| !effects.is_empty() || !replay_progress.is_empty())
    {
        Storage::send_reserved_checkpoint_work(checkpoint_slot, effects.clone(), replay_progress);
    }
}

fn replay_progress_for_entries(
    device_id: &str,
    timestamps: impl Iterator<Item = i64>,
) -> ReplayProgress {
    timestamps
        .max()
        .map(|timestamp| BTreeMap::from([(device_id.to_string(), timestamp)]))
        .unwrap_or_default()
}
