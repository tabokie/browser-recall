use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PageEntity {
    pub slug: String,
    #[serde(default, rename = "parentIds")]
    pub parent_ids: Vec<String>,
    #[serde(default, rename = "childIds")]
    pub child_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub timestamps: HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(default, rename = "visitDates", skip_serializing_if = "Vec::is_empty")]
    pub visit_dates: Vec<i32>,
    #[serde(
        default,
        rename = "scrollDepth",
        skip_serializing_if = "Option::is_none"
    )]
    pub scroll_depth: Option<i64>,
    #[serde(
        default,
        rename = "timeOnPage",
        skip_serializing_if = "Option::is_none"
    )]
    pub time_on_page: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteEntity {
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, rename = "cssPath", skip_serializing_if = "Option::is_none")]
    pub css_path: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(default, rename = "deletedTs", skip_serializing_if = "Option::is_none")]
    pub deleted_ts: Option<i64>,
    #[serde(
        default,
        rename = "deletionReason",
        skip_serializing_if = "Option::is_none"
    )]
    pub deletion_reason: Option<String>,
    #[serde(
        default,
        rename = "replacedBy",
        skip_serializing_if = "Option::is_none"
    )]
    pub replaced_by: Option<String>,
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
pub struct PinEntity {
    pub id: String,
    #[serde(rename = "pinnedAt")]
    pub pinned_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleEntity {
    pub id: String,
    #[serde(rename = "type")]
    pub rule_type: String,
    #[serde(default)]
    pub config: BTreeMap<String, Value>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListEntity {
    pub slug: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default)]
    pub pins: Vec<PinEntity>,
    #[serde(default)]
    pub rules: Vec<RuleEntity>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub timestamps: HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(default, rename = "deletedTs", skip_serializing_if = "Option::is_none")]
    pub deleted_ts: Option<i64>,
}

impl ListEntity {
    pub fn new(slug: String) -> Self {
        Self {
            slug,
            name: String::new(),
            owner: None,
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
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
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
pub struct NameToIdManifest {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub timestamps: HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
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
pub struct TreeNode {
    pub id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListOrderManifest {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub timestamps: HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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
pub struct OrphanedEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrphanedManifest {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub timestamps: HashMap<String, i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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
            Self::Note(_)
            | Self::List(_)
            | Self::Settings(_)
            | Self::NameToId(_)
            | Self::ListOrder(_)
            | Self::Orphaned(_) => None,
        }
    }

    pub fn into_page(self) -> Option<PageEntity> {
        match self {
            Self::Page(page) => Some(page),
            Self::Note(_)
            | Self::List(_)
            | Self::Settings(_)
            | Self::NameToId(_)
            | Self::ListOrder(_)
            | Self::Orphaned(_) => None,
        }
    }

    pub fn as_note(&self) -> Option<&NoteEntity> {
        match self {
            Self::Note(note) => Some(note),
            Self::Page(_)
            | Self::List(_)
            | Self::Settings(_)
            | Self::NameToId(_)
            | Self::ListOrder(_)
            | Self::Orphaned(_) => None,
        }
    }

    pub fn into_note(self) -> Option<NoteEntity> {
        match self {
            Self::Note(note) => Some(note),
            Self::Page(_)
            | Self::List(_)
            | Self::Settings(_)
            | Self::NameToId(_)
            | Self::ListOrder(_)
            | Self::Orphaned(_) => None,
        }
    }

    pub fn as_list(&self) -> Option<&ListEntity> {
        match self {
            Self::List(list) => Some(list),
            Self::Page(_)
            | Self::Note(_)
            | Self::Settings(_)
            | Self::NameToId(_)
            | Self::ListOrder(_)
            | Self::Orphaned(_) => None,
        }
    }

    pub fn into_list(self) -> Option<ListEntity> {
        match self {
            Self::List(list) => Some(list),
            Self::Page(_)
            | Self::Note(_)
            | Self::Settings(_)
            | Self::NameToId(_)
            | Self::ListOrder(_)
            | Self::Orphaned(_) => None,
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

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_serialization_keeps_empty_collection_fields() {
        let list = ListEntity::new("reading".to_string());
        let value = serde_json::to_value(list).expect("serialize list");

        assert_eq!(value["pins"], serde_json::json!([]));
        assert_eq!(value["rules"], serde_json::json!([]));
    }

    #[test]
    fn entity_accessors_accept_only_the_matching_variant() {
        let entities = [
            Entity::Page(PageEntity::new("page".to_string())),
            Entity::Note(NoteEntity::new("note".to_string())),
            Entity::List(ListEntity::new("list".to_string())),
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
