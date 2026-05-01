use crate::config::ApprovedConnector;
use chrono::{DateTime, Local, LocalResult, TimeZone};
use std::collections::HashSet;

pub type ConnectorKey = (String, String);

pub fn connector_key(browser_id: &str, extension_id: &str) -> ConnectorKey {
    (browser_id.to_string(), extension_id.to_string())
}

pub fn current_local_day_start_unix() -> u64 {
    local_day_start_unix(Local::now())
}

pub fn local_day_start_unix(now: DateTime<Local>) -> u64 {
    let Some(midnight) = now.date_naive().and_hms_opt(0, 0, 0) else {
        return 0;
    };
    let timestamp = match Local.from_local_datetime(&midnight) {
        LocalResult::Single(value) => value.timestamp(),
        LocalResult::Ambiguous(earliest, _) => earliest.timestamp(),
        LocalResult::None => 0,
    };
    timestamp.max(0) as u64
}

pub fn prune_inactive_connectors(
    connectors: &mut Vec<ApprovedConnector>,
    active_keys: &HashSet<ConnectorKey>,
    cutoff: u64,
) -> usize {
    let before = connectors.len();
    connectors.retain(|connector| {
        active_keys.contains(&connector_key(
            &connector.browser_id,
            &connector.extension_id,
        )) || connector
            .last_seen_at
            .is_some_and(|last_seen| last_seen >= cutoff)
    });
    before - connectors.len()
}

#[cfg(test)]
mod tests {
    use super::{connector_key, local_day_start_unix, prune_inactive_connectors};
    use crate::config::{ApprovedConnector, Token};
    use chrono::{Local, TimeZone};
    use std::collections::HashSet;

    #[test]
    fn prune_inactive_connectors_keeps_connected_and_seen_today() {
        let now = Local.with_ymd_and_hms(2026, 4, 29, 12, 0, 0).unwrap();
        let cutoff = local_day_start_unix(now);
        let mut connectors = vec![
            ApprovedConnector {
                browser_id: "connected-old".into(),
                browser_name: "Chrome".into(),
                extension_id: "ext".into(),
                browser_profile: None,
                token: Token("a".into()),
                approved_at: cutoff - 10,
                last_seen_at: Some(cutoff - 10),
            },
            ApprovedConnector {
                browser_id: "seen-today".into(),
                browser_name: "Chrome".into(),
                extension_id: "ext".into(),
                browser_profile: None,
                token: Token("b".into()),
                approved_at: cutoff,
                last_seen_at: Some(cutoff),
            },
            ApprovedConnector {
                browser_id: "old".into(),
                browser_name: "Chrome".into(),
                extension_id: "ext".into(),
                browser_profile: None,
                token: Token("c".into()),
                approved_at: cutoff - 10,
                last_seen_at: Some(cutoff - 10),
            },
        ];
        let active = HashSet::from([connector_key("connected-old", "ext")]);

        assert_eq!(
            prune_inactive_connectors(&mut connectors, &active, cutoff),
            1
        );
        assert_eq!(connectors.len(), 2);
        assert!(connectors
            .iter()
            .any(|connector| connector.browser_id == "connected-old"));
        assert!(connectors
            .iter()
            .any(|connector| connector.browser_id == "seen-today"));
    }
}
