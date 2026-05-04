use crate::storage::Storage;
use browser_recall_replay::{
    effect_of, Context as ReplayContext, EntityEffect, LogEntry, ReplayError,
};
use std::collections::BTreeMap;

pub type EntityMapView = BTreeMap<String, EntityEffect>;

pub async fn effect_with_overlay(
    entry: LogEntry,
    storage: &Storage,
    overlay: &EntityMapView,
    context: &ReplayContext,
) -> Result<EntityMapView, ReplayError> {
    effect_of(
        entry,
        |key| {
            let key = key.to_string();
            let overlay_effect = overlay.get(&key).cloned();
            let storage = storage.clone();
            async move {
                if let Some(effect) = overlay_effect {
                    return match effect {
                        EntityEffect::Upsert(entity) => Some(entity),
                        EntityEffect::Delete => None,
                    };
                }
                storage.load_entity(&key).await.ok().flatten()
            }
        },
        context.clone(),
    )
    .await
}
