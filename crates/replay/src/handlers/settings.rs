use std::future::Future;

use serde_json::Value;

use crate::{
    entities::{Entity, SettingsEntity},
    load_settings, touch_timestamp_map, Context, EntityEffect, EntityMap, ReplayError,
    SETTINGS_KEY,
};

pub(crate) async fn handle_update_setting<L, Fut>(
    timestamp: i64,
    key: &str,
    value: Value,
    load: &L,
    context: &Context,
) -> Result<EntityMap, ReplayError>
where
    L: Fn(&str) -> Fut,
    Fut: Future<Output = Option<Entity>>,
{
    let mut settings = load_settings(load, SETTINGS_KEY)
        .await
        .unwrap_or_else(SettingsEntity::new);
    touch_timestamp_map(&mut settings.timestamps, &context.device_id, timestamp);
    settings.values.insert(key.to_string(), value);

    let mut result = EntityMap::new();
    result.insert(
        SETTINGS_KEY.to_string(),
        EntityEffect::Upsert(Entity::Settings(settings)),
    );
    Ok(result)
}
