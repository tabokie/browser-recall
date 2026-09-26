use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PageEntity {
    pub slug: String,
    #[serde(rename = "parentIds")]
    pub parent_ids: Vec<String>,
    #[serde(rename = "childIds")]
    pub child_ids: Vec<String>,
    pub timestamps: HashMap<String, i64>,
    pub url: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<i64>,
    #[serde(rename = "visitDates")]
    pub visit_dates: Vec<i32>,
    #[serde(rename = "scrollDepth")]
    pub scroll_depth: Option<i64>,
    #[serde(rename = "timeOnPage")]
    pub time_on_page: Option<i64>,
    pub user_title: Option<String>,
    pub likes: Option<i64>,
}

impl PageEntity {
    pub fn new(slug: String) -> Self {
        Self {
            slug,
            parent_ids: Vec::new(),
            child_ids: Vec::new(),
            timestamps: HashMap::new(),
            url: None,
            title: None,
            created_at: None,
            visit_dates: Vec::new(),
            scroll_depth: None,
            time_on_page: None,
            user_title: None,
            likes: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NoteEntity {
    pub slug: String,
    pub excerpt: Option<Value>,
    pub note: Option<String>,
    #[serde(rename = "cssPath")]
    pub css_path: Option<Value>,
    pub url: Option<String>,
    pub deleted: bool,
    #[serde(rename = "deletedTs")]
    pub deleted_ts: Option<i64>,
    #[serde(rename = "deletionReason")]
    pub deletion_reason: Option<String>,
    #[serde(rename = "replacedBy")]
    pub replaced_by: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedNoteEntity {
    slug: String,
    excerpt: Value,
    note: Option<String>,
    #[serde(rename = "cssPath")]
    css_path: Value,
    url: Option<String>,
    deleted: bool,
    #[serde(rename = "deletedTs")]
    deleted_ts: Option<i64>,
    #[serde(rename = "deletionReason")]
    deletion_reason: Option<String>,
    #[serde(rename = "replacedBy")]
    replaced_by: Option<String>,
}

impl<'de> Deserialize<'de> for NoteEntity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let persisted = PersistedNoteEntity::deserialize(deserializer)?;
        let (excerpt, css_path) = match (persisted.excerpt, persisted.css_path) {
            (Value::Null, Value::Null) if persisted.deleted && persisted.deleted_ts.is_some() => {
                (None, None)
            }
            (Value::Array(excerpts), Value::Array(paths))
                if !excerpts.is_empty()
                    && excerpts.len() == paths.len()
                    && excerpts.iter().all(|value| {
                        value
                            .as_str()
                            .is_some_and(|text| !text.is_empty() && text == text.trim())
                    })
                    && paths.iter().all(Value::is_string) =>
            {
                (Some(Value::Array(excerpts)), Some(Value::Array(paths)))
            }
            _ => {
                return Err(serde::de::Error::custom(
                    "live note anchors must be aligned non-empty string arrays; only deleted tombstones may omit both anchors",
                ));
            }
        };

        Ok(Self {
            slug: persisted.slug,
            excerpt,
            note: persisted.note,
            css_path,
            url: persisted.url,
            deleted: persisted.deleted,
            deleted_ts: persisted.deleted_ts,
            deletion_reason: persisted.deletion_reason,
            replaced_by: persisted.replaced_by,
        })
    }
}

impl NoteEntity {
    pub fn new(slug: String) -> Self {
        Self {
            slug,
            excerpt: None,
            note: None,
            css_path: None,
            url: None,
            deleted: false,
            deleted_ts: None,
            deletion_reason: None,
            replaced_by: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PinEntity {
    pub id: String,
    #[serde(rename = "pinnedAt")]
    pub pinned_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuleEntity {
    pub id: String,
    #[serde(rename = "type")]
    pub rule_type: String,
    pub config: BTreeMap<String, Value>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ListEntity {
    #[serde(deserialize_with = "deserialize_non_empty_string")]
    pub slug: String,
    #[serde(deserialize_with = "deserialize_non_empty_string")]
    pub name: String,
    #[serde(deserialize_with = "deserialize_non_empty_string")]
    pub owner: String,
    pub pins: Vec<PinEntity>,
    pub rules: Vec<RuleEntity>,
    pub timestamps: HashMap<String, i64>,
    pub deleted: bool,
    #[serde(rename = "deletedTs")]
    pub deleted_ts: Option<i64>,
}

impl ListEntity {
    pub fn new(slug: String, name: String, owner: String) -> Self {
        Self {
            slug,
            name,
            owner,
            pins: Vec::new(),
            rules: Vec::new(),
            timestamps: HashMap::new(),
            deleted: false,
            deleted_ts: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SettingsEntity {
    pub timestamps: HashMap<String, i64>,
    #[serde(flatten)]
    pub values: BTreeMap<String, Value>,
}

impl SettingsEntity {
    pub fn new() -> Self {
        Self {
            timestamps: HashMap::new(),
            values: BTreeMap::new(),
        }
    }
}

impl Default for SettingsEntity {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NameToIdManifest {
    pub timestamps: HashMap<String, i64>,
    pub paths: BTreeMap<String, String>,
}

impl NameToIdManifest {
    pub fn new() -> Self {
        Self {
            timestamps: HashMap::new(),
            paths: BTreeMap::new(),
        }
    }
}

impl Default for NameToIdManifest {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TreeNode {
    pub id: String,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ListOrderManifest {
    pub timestamps: HashMap<String, i64>,
    pub tree: Vec<TreeNode>,
}

impl ListOrderManifest {
    pub fn new() -> Self {
        Self {
            timestamps: HashMap::new(),
            tree: Vec::new(),
        }
    }
}

impl Default for ListOrderManifest {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OrphanedEntry {
    pub key: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OrphanedManifest {
    pub timestamps: HashMap<String, i64>,
    pub entries: Vec<OrphanedEntry>,
}

impl OrphanedManifest {
    pub fn new() -> Self {
        Self {
            timestamps: HashMap::new(),
            entries: Vec::new(),
        }
    }
}

impl Default for OrphanedManifest {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Entity {
    Page(PageEntity),
    Note(NoteEntity),
    List(ListEntity),
    Settings(SettingsEntity),
    NameToId(NameToIdManifest),
    ListOrder(ListOrderManifest),
    Orphaned(OrphanedManifest),
}

impl Entity {
    pub fn as_page(&self) -> Option<&PageEntity> {
        match self {
            Self::Page(page) => Some(page),
            _ => None,
        }
    }

    pub fn into_page(self) -> Option<PageEntity> {
        match self {
            Self::Page(page) => Some(page),
            _ => None,
        }
    }

    pub fn as_note(&self) -> Option<&NoteEntity> {
        match self {
            Self::Note(note) => Some(note),
            _ => None,
        }
    }

    pub fn into_note(self) -> Option<NoteEntity> {
        match self {
            Self::Note(note) => Some(note),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&ListEntity> {
        match self {
            Self::List(list) => Some(list),
            _ => None,
        }
    }

    pub fn into_list(self) -> Option<ListEntity> {
        match self {
            Self::List(list) => Some(list),
            _ => None,
        }
    }

    pub fn as_settings(&self) -> Option<&SettingsEntity> {
        match self {
            Self::Settings(settings) => Some(settings),
            _ => None,
        }
    }

    pub fn into_settings(self) -> Option<SettingsEntity> {
        match self {
            Self::Settings(settings) => Some(settings),
            _ => None,
        }
    }

    pub fn as_name_to_id(&self) -> Option<&NameToIdManifest> {
        match self {
            Self::NameToId(manifest) => Some(manifest),
            _ => None,
        }
    }

    pub fn into_name_to_id(self) -> Option<NameToIdManifest> {
        match self {
            Self::NameToId(manifest) => Some(manifest),
            _ => None,
        }
    }

    pub fn as_list_order(&self) -> Option<&ListOrderManifest> {
        match self {
            Self::ListOrder(manifest) => Some(manifest),
            _ => None,
        }
    }

    pub fn into_list_order(self) -> Option<ListOrderManifest> {
        match self {
            Self::ListOrder(manifest) => Some(manifest),
            _ => None,
        }
    }

    pub fn as_orphaned(&self) -> Option<&OrphanedManifest> {
        match self {
            Self::Orphaned(manifest) => Some(manifest),
            _ => None,
        }
    }

    pub fn into_orphaned(self) -> Option<OrphanedManifest> {
        match self {
            Self::Orphaned(manifest) => Some(manifest),
            _ => None,
        }
    }
}

fn deserialize_non_empty_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.trim().is_empty() {
        return Err(serde::de::Error::custom("value must be a non-empty string"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_serialization_keeps_empty_collection_fields() {
        let list = ListEntity::new(
            "reading".to_string(),
            "Reading".to_string(),
            "test-device".to_string(),
        );
        let value = serde_json::to_value(list).expect("serialize list");

        assert_eq!(value["pins"], serde_json::json!([]));
        assert_eq!(value["rules"], serde_json::json!([]));
    }

    #[test]
    fn entity_accessors_accept_only_the_matching_variant() {
        let entities = [
            Entity::Page(PageEntity::new("page".to_string())),
            Entity::Note(NoteEntity::new("note".to_string())),
            Entity::List(ListEntity::new(
                "list".to_string(),
                "List".to_string(),
                "test-device".to_string(),
            )),
            Entity::Settings(SettingsEntity::new()),
            Entity::NameToId(NameToIdManifest::new()),
            Entity::ListOrder(ListOrderManifest::new()),
            Entity::Orphaned(OrphanedManifest::new()),
        ];

        for (index, entity) in entities.iter().enumerate() {
            assert_eq!(entity.as_page().is_some(), index == 0);
            assert_eq!(entity.as_note().is_some(), index == 1);
            assert_eq!(entity.as_list().is_some(), index == 2);
            assert_eq!(entity.as_settings().is_some(), index == 3);
            assert_eq!(entity.as_name_to_id().is_some(), index == 4);
            assert_eq!(entity.as_list_order().is_some(), index == 5);
            assert_eq!(entity.as_orphaned().is_some(), index == 6);

            assert_eq!(entity.clone().into_page().is_some(), index == 0);
            assert_eq!(entity.clone().into_note().is_some(), index == 1);
            assert_eq!(entity.clone().into_list().is_some(), index == 2);
            assert_eq!(entity.clone().into_settings().is_some(), index == 3);
            assert_eq!(entity.clone().into_name_to_id().is_some(), index == 4);
            assert_eq!(entity.clone().into_list_order().is_some(), index == 5);
            assert_eq!(entity.clone().into_orphaned().is_some(), index == 6);
        }
    }
}
