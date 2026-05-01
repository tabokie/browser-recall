use std::collections::HashSet;
use std::future::Future;

use crate::{
    entities::Entity, get_orphaned, touch_timestamp_map, Context, EntityEffect, EntityMap,
    ReplayError, ORPHANED_KEY,
};

pub(crate) async fn handle_permanent_delete<L, Fut>(
    timestamp: i64,
    keys: &[String],
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut result = EntityMap::new();
    let delete_keys = keys
        .iter()
        .filter(|key| {
            key.starts_with("note:")
                || key.starts_with("list:")
                || key.starts_with("page:")
                || key.starts_with("snapshot:")
        })
        .cloned()
        .collect::<HashSet<_>>();

    for key in &delete_keys {
        result.insert(key.clone(), EntityEffect::Delete);
    }

    let mut orphaned = get_orphaned(&result, load, ORPHANED_KEY)
        .await
        .unwrap_or_else(crate::default_orphaned);
    orphaned
        .entries
        .retain(|entry| !delete_keys.contains(&entry.key));
    touch_timestamp_map(&mut orphaned.timestamps, &context.device_id, timestamp);
    result.insert(
        ORPHANED_KEY.to_string(),
        EntityEffect::Upsert(Entity::Orphaned(orphaned)),
    );

    Ok(result)
}
