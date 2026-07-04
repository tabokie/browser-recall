use crate::storage::Storage;
use browser_recall_replay::entities::{Entity, NoteEntity, PageEntity, PinEntity, TreeNode};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct ReadProjections {
    storage: Storage,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListDisplayProjection {
    pub slug: String,
    pub name: String,
    pub rules: Vec<RuleProjection>,
    pub pins: Vec<ListPinProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListPinProjection {
    pub pinned_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub kind: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_title: Option<String>,
    pub is_note: bool,
    pub has_snapshots: bool,
    pub has_highlight_notes: bool,
    pub list_slugs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_on_page: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    pub visit_dates: Vec<i32>,
    pub timestamps: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageContextProjection {
    pub page: PageProjection,
    pub notes: Vec<NoteProjection>,
    pub lists: Vec<ListMembershipProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PageInfoProjection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<PageProjection>,
    pub notes: Vec<NoteProjection>,
    pub snapshots: Vec<SnapshotProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotProjection {
    pub timestamp: i64,
    pub has_md: bool,
    pub has_html: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PageProjection {
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_title: Option<String>,
    #[serde(rename = "createdAt")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(rename = "visitDates")]
    pub visit_dates: Vec<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "scrollDepth")]
    pub scroll_depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "timeOnPage")]
    pub time_on_page: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likes: Option<i64>,
    pub timestamps: BTreeMap<String, i64>,
    #[serde(rename = "hasSnapshots")]
    pub has_snapshots: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NoteProjection {
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "cssPath")]
    pub css_path: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RuleProjection {
    pub id: String,
    #[serde(rename = "type")]
    pub rule_type: String,
    pub config: BTreeMap<String, Value>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListSummaryProjection {
    pub slug: String,
    pub name: String,
    pub pins: Vec<PinSummaryProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinSummaryProjection {
    pub kind: String,
    pub slug: String,
    pub pinned_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListMembershipProjection {
    pub slug: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListTreeProjection {
    pub tree: Vec<ListTreeNodeProjection>,
    pub order: Vec<ListOrderNodeProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListTreeNodeProjection {
    pub slug: String,
    pub name: String,
    pub children: Vec<ListTreeNodeProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListOrderNodeProjection {
    pub slug: String,
    pub children: Vec<ListOrderNodeProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecycleBinEntryProjection {
    pub key: String,
    pub kind: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl ReadProjections {
    pub fn new(storage: Storage) -> Self {
        Self { storage }
    }

    pub async fn list_display(
        &self,
        list_id: &str,
    ) -> Result<Option<ListDisplayProjection>, String> {
        let Some(list) = self
            .storage
            .load_list_coordinated(list_id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        if list.deleted {
            return Ok(None);
        }

        let mut pins = Vec::with_capacity(list.pins.len());
        for pin in list.pins {
            pins.push(self.resolve_pin(pin).await?);
        }
        Ok(Some(ListDisplayProjection {
            slug: list.slug,
            name: list.name,
            rules: list
                .rules
                .into_iter()
                .map(|rule| RuleProjection {
                    id: rule.id,
                    rule_type: rule.rule_type,
                    config: rule.config,
                    created_at: rule.created_at,
                })
                .collect(),
            pins,
        }))
    }

    pub async fn page_context(
        &self,
        slugs: &[String],
    ) -> Result<BTreeMap<String, PageContextProjection>, String> {
        let mut result = BTreeMap::new();
        for slug in slugs {
            let Some(page) = self
                .storage
                .load_page_coordinated(slug)
                .await
                .map_err(|error| error.to_string())?
            else {
                continue;
            };
            let mut notes = Vec::new();
            for child_id in &page.child_ids {
                let Some(note_slug) = child_id.strip_prefix("note:") else {
                    continue;
                };
                if let Some(note) = self
                    .storage
                    .load_note_coordinated(note_slug)
                    .await
                    .map_err(|error| error.to_string())?
                    .filter(|note| !note.deleted)
                {
                    notes.push(note);
                }
            }
            let mut lists = Vec::new();
            for parent_id in &page.parent_ids {
                let Some(list_slug) = parent_id.strip_prefix("list:") else {
                    continue;
                };
                if let Some(list) = self
                    .storage
                    .load_list_coordinated(list_slug)
                    .await
                    .map_err(|error| error.to_string())?
                    .filter(|list| !list.deleted)
                {
                    lists.push(ListMembershipProjection {
                        slug: list.slug,
                        name: list.name,
                    });
                }
            }
            result.insert(
                slug.clone(),
                PageContextProjection {
                    page: project_page(page),
                    notes: notes.into_iter().map(project_note).collect(),
                    lists,
                },
            );
        }
        Ok(result)
    }

    pub async fn all_page_context(
        &self,
    ) -> Result<BTreeMap<String, PageContextProjection>, String> {
        let pages = self
            .storage
            .load_all_pages()
            .await
            .map_err(|error| error.to_string())?;
        self.page_context(&pages.into_keys().collect::<Vec<_>>())
            .await
    }

    pub async fn page_info(&self, slug: &str) -> Result<PageInfoProjection, String> {
        let page = self
            .storage
            .load_page_coordinated(slug)
            .await
            .map_err(|error| error.to_string())?;
        let mut notes = Vec::new();
        let mut snapshots = Vec::new();
        if let Some(page) = &page {
            for child_id in &page.child_ids {
                if let Some(note_slug) = child_id.strip_prefix("note:") {
                    if let Some(note) = self
                        .storage
                        .load_note_coordinated(note_slug)
                        .await
                        .map_err(|error| error.to_string())?
                        .filter(|note| !note.deleted)
                    {
                        notes.push(note);
                    }
                    continue;
                }
                let Some(stem) = child_id.strip_prefix("snapshot:") else {
                    continue;
                };
                let (Some(page_slug), Some(timestamp)) = split_snapshot_stem(stem) else {
                    continue;
                };
                let html_path = self.storage.snapshot_html_file_path(page_slug, timestamp);
                snapshots.push(SnapshotProjection {
                    timestamp,
                    has_md: html_path.with_extension("md").exists(),
                    has_html: html_path.exists(),
                });
            }
        }
        snapshots.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
        Ok(PageInfoProjection {
            page: page.map(project_page),
            notes: notes.into_iter().map(project_note).collect(),
            snapshots,
        })
    }

    pub async fn list_summaries(&self) -> Result<Vec<ListSummaryProjection>, String> {
        let tree = self.list_tree().await?;
        let mut ids = Vec::new();
        collect_projected_list_ids(&tree.order, &mut ids);
        let mut lists = Vec::new();
        for list_id in ids {
            if let Some(list) = self
                .storage
                .load_list_coordinated(&list_id)
                .await
                .map_err(|error| error.to_string())?
                .filter(|list| !list.deleted)
            {
                lists.push(ListSummaryProjection {
                    slug: list.slug,
                    name: list.name,
                    pins: list
                        .pins
                        .into_iter()
                        .map(|pin| {
                            let (kind, slug) = parse_pin_target(&pin.id)?;
                            Ok(PinSummaryProjection {
                                kind: kind.to_string(),
                                slug: slug.to_string(),
                                pinned_at: pin.pinned_at,
                                source: pin.source,
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()?,
                });
            }
        }
        Ok(lists)
    }

    pub async fn list_tree(&self) -> Result<ListTreeProjection, String> {
        let order = match self
            .storage
            .load_entity_coordinated("manifest:list-order")
            .await
            .map_err(|error| error.to_string())?
        {
            Some(Entity::ListOrder(order)) => order,
            Some(_) => return Err("list order has unexpected entity type".to_string()),
            None => {
                return Ok(ListTreeProjection {
                    tree: Vec::new(),
                    order: Vec::new(),
                })
            }
        };
        let mut list_ids = Vec::new();
        collect_list_ids(&order.tree, &mut list_ids);
        let mut visible = BTreeMap::new();
        for list_id in list_ids {
            if let Some(list) = self
                .storage
                .load_list_coordinated(&list_id)
                .await
                .map_err(|error| error.to_string())?
                .filter(|list| !list.deleted)
            {
                visible.insert(list_id, list.name);
            }
        }
        Ok(ListTreeProjection {
            tree: project_list_tree(&order.tree, &visible),
            order: project_list_order(&order.tree, &visible),
        })
    }

    pub async fn recycle_bin(&self) -> Result<Vec<RecycleBinEntryProjection>, String> {
        let orphaned = match self
            .storage
            .load_entity_coordinated("manifest:orphaned")
            .await
            .map_err(|error| error.to_string())?
        {
            Some(Entity::Orphaned(orphaned)) => orphaned,
            Some(_) => return Err("orphaned manifest has unexpected entity type".to_string()),
            None => return Ok(Vec::new()),
        };
        let mut result = Vec::new();
        for entry in orphaned.entries {
            if let Some(slug) = entry.key.strip_prefix("note:") {
                let slug = slug.to_string();
                let Some(note) = self
                    .storage
                    .load_note_coordinated(&slug)
                    .await
                    .map_err(|error| error.to_string())?
                else {
                    continue;
                };
                if !note.deleted
                    || note.deletion_reason.as_deref() == Some("replaced")
                    || note.replaced_by.is_some()
                {
                    continue;
                }
                result.push(RecycleBinEntryProjection {
                    key: entry.key,
                    kind: "note".to_string(),
                    slug,
                    timestamp: note.deleted_ts,
                    url: note.url,
                    title: excerpt_title(note.excerpt.as_ref()).or(note.note),
                });
                continue;
            }
            if let Some(slug) = entry.key.strip_prefix("list:") {
                let slug = slug.to_string();
                let Some(list) = self
                    .storage
                    .load_list_coordinated(&slug)
                    .await
                    .map_err(|error| error.to_string())?
                else {
                    continue;
                };
                if !list.deleted {
                    continue;
                }
                result.push(RecycleBinEntryProjection {
                    key: entry.key,
                    kind: "list".to_string(),
                    slug,
                    timestamp: list.deleted_ts,
                    url: entry.url,
                    title: Some(list.name),
                });
                continue;
            }
            if let Some(stem) = entry.key.strip_prefix("snapshot:") {
                let stem = stem.to_string();
                let (page_slug, timestamp) = split_snapshot_stem(&stem);
                let title = if let Some(page_slug) = page_slug {
                    self.storage
                        .load_page_coordinated(page_slug)
                        .await
                        .map_err(|error| error.to_string())?
                        .and_then(|page| page.user_title.or(page.title))
                } else {
                    None
                };
                result.push(RecycleBinEntryProjection {
                    key: entry.key,
                    kind: "snapshot".to_string(),
                    slug: page_slug.unwrap_or(&stem).to_string(),
                    timestamp,
                    url: entry.url,
                    title,
                });
                continue;
            }
            result.push(RecycleBinEntryProjection {
                slug: entry.key.clone(),
                key: entry.key,
                kind: "unknown".to_string(),
                timestamp: None,
                url: entry.url,
                title: None,
            });
        }
        Ok(result)
    }

    pub async fn settings(&self) -> Result<Option<BTreeMap<String, Value>>, String> {
        match self
            .storage
            .load_entity_coordinated("manifest:settings")
            .await
            .map_err(|error| error.to_string())?
        {
            Some(Entity::Settings(settings)) => Ok(Some(settings.values)),
            Some(_) => Err("settings manifest has unexpected entity type".to_string()),
            None => Ok(None),
        }
    }

    async fn resolve_pin(&self, pin: PinEntity) -> Result<ListPinProjection, String> {
        let (pin_kind, pin_slug) = parse_pin_target(&pin.id)?;
        let pin_kind = pin_kind.to_string();
        let pin_slug = pin_slug.to_string();
        if pin_kind == "page" {
            if let Some(page) = self
                .storage
                .load_page_coordinated(&pin_slug)
                .await
                .map_err(|error| error.to_string())?
            {
                let has_snapshots = page.child_ids.iter().any(|id| id.starts_with("snapshot:"));
                let has_highlight_notes = page_has_highlight_notes(&self.storage, &page).await?;
                let list_slugs = page
                    .parent_ids
                    .iter()
                    .filter_map(|id| id.strip_prefix("list:").map(str::to_string))
                    .collect();
                return Ok(ListPinProjection {
                    pinned_at: pin.pinned_at,
                    source: pin.source,
                    kind: "page".to_string(),
                    slug: page.slug,
                    url: page.url,
                    title: page.title,
                    user_title: page.user_title,
                    is_note: false,
                    has_snapshots,
                    has_highlight_notes,
                    list_slugs,
                    excerpt: None,
                    note: None,
                    scroll_depth: page.scroll_depth,
                    time_on_page: page.time_on_page,
                    likes: page.likes,
                    created_at: page.created_at,
                    visit_dates: page.visit_dates,
                    timestamps: page.timestamps.into_iter().collect(),
                });
            }
        } else if pin_kind == "note" {
            if let Some(note) = self
                .storage
                .load_note_coordinated(&pin_slug)
                .await
                .map_err(|error| error.to_string())?
                .filter(|note| !note.deleted)
            {
                return Ok(ListPinProjection {
                    pinned_at: pin.pinned_at,
                    source: pin.source,
                    kind: "note".to_string(),
                    slug: note.slug,
                    url: note.url,
                    title: excerpt_title(note.excerpt.as_ref()),
                    user_title: None,
                    is_note: true,
                    has_snapshots: false,
                    has_highlight_notes: false,
                    list_slugs: Vec::new(),
                    excerpt: note.excerpt,
                    note: note.note,
                    scroll_depth: None,
                    time_on_page: None,
                    likes: None,
                    created_at: None,
                    visit_dates: Vec::new(),
                    timestamps: BTreeMap::new(),
                });
            }
        }

        Ok(ListPinProjection {
            slug: pin_slug,
            pinned_at: pin.pinned_at,
            source: pin.source,
            kind: "missing".to_string(),
            url: None,
            title: None,
            user_title: None,
            is_note: false,
            has_snapshots: false,
            has_highlight_notes: false,
            list_slugs: Vec::new(),
            excerpt: None,
            note: None,
            scroll_depth: None,
            time_on_page: None,
            likes: None,
            created_at: None,
            visit_dates: Vec::new(),
            timestamps: BTreeMap::new(),
        })
    }
}

fn parse_pin_target(id: &str) -> Result<(&str, &str), String> {
    let Some((kind, slug)) = id.split_once(':') else {
        return Err(format!("pin id '{id}' is missing its entity kind"));
    };
    if slug.is_empty() {
        return Err(format!("pin id '{id}' is missing its entity slug"));
    }
    if !matches!(kind, "page" | "note") {
        return Err(format!(
            "pin id '{id}' has unsupported entity kind '{kind}'"
        ));
    }
    Ok((kind, slug))
}

fn collect_list_ids(nodes: &[TreeNode], out: &mut Vec<String>) {
    for node in nodes {
        if let Some(slug) = node.id.strip_prefix("list:") {
            out.push(slug.to_string());
        }
        collect_list_ids(&node.children, out);
    }
}

fn collect_projected_list_ids(nodes: &[ListOrderNodeProjection], out: &mut Vec<String>) {
    for node in nodes {
        out.push(node.slug.clone());
        collect_projected_list_ids(&node.children, out);
    }
}

fn project_list_tree(
    nodes: &[TreeNode],
    visible: &BTreeMap<String, String>,
) -> Vec<ListTreeNodeProjection> {
    nodes
        .iter()
        .filter_map(|node| {
            let slug = node.id.strip_prefix("list:")?;
            let name = visible.get(slug)?;
            Some(ListTreeNodeProjection {
                slug: slug.to_string(),
                name: name.clone(),
                children: project_list_tree(&node.children, visible),
            })
        })
        .collect()
}

fn project_list_order(
    nodes: &[TreeNode],
    visible: &BTreeMap<String, String>,
) -> Vec<ListOrderNodeProjection> {
    nodes
        .iter()
        .filter_map(|node| {
            let slug = node.id.strip_prefix("list:")?;
            visible.get(slug)?;
            Some(ListOrderNodeProjection {
                slug: slug.to_string(),
                children: project_list_order(&node.children, visible),
            })
        })
        .collect()
}

fn split_snapshot_stem(stem: &str) -> (Option<&str>, Option<i64>) {
    let Some(index) = stem.rfind('-') else {
        return (None, None);
    };
    let Ok(timestamp) = stem[index + 1..].parse::<i64>() else {
        return (None, None);
    };
    (Some(&stem[..index]), Some(timestamp))
}

fn excerpt_title(excerpt: Option<&Value>) -> Option<String> {
    let parts = excerpt?.as_array()?;
    let title = parts
        .iter()
        .filter_map(Value::as_str)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!title.is_empty()).then_some(title)
}

fn project_page(page: PageEntity) -> PageProjection {
    let has_snapshots = page.child_ids.iter().any(|id| id.starts_with("snapshot:"));
    PageProjection {
        slug: page.slug,
        url: page.url,
        title: page.title,
        user_title: page.user_title,
        created_at: page.created_at,
        visit_dates: page.visit_dates,
        scroll_depth: page.scroll_depth,
        time_on_page: page.time_on_page,
        likes: page.likes,
        timestamps: page.timestamps.into_iter().collect(),
        has_snapshots,
    }
}

fn project_note(note: NoteEntity) -> NoteProjection {
    NoteProjection {
        slug: note.slug,
        excerpt: note.excerpt,
        note: note.note,
        css_path: note.css_path,
        url: note.url,
    }
}

async fn page_has_highlight_notes(storage: &Storage, page: &PageEntity) -> Result<bool, String> {
    for child_id in &page.child_ids {
        let Some(note_slug) = child_id.strip_prefix("note:") else {
            continue;
        };
        if storage
            .load_note_coordinated(note_slug)
            .await
            .map_err(|error| error.to_string())?
            .is_some_and(|note| !note.deleted && note.excerpt.is_some())
        {
            return Ok(true);
        }
    }
    Ok(false)
}
