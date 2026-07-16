#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

use browser_recall_replay::entities::{Entity, NoteEntity};
use browser_recall_replay::{effect_of, page_retains_checkpoint, Context, EntityEffect, LogEntry};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::error::Error;
use std::fs;
use std::future::ready;
use std::io;
use std::path::{Path, PathBuf};

const MAX_EXAMPLES: usize = 5;

#[derive(Debug)]
struct Args {
    data_dir: PathBuf,
    output_dir: PathBuf,
    verbose: bool,
}

#[derive(Debug)]
struct ReplayStep {
    entry: LogEntry,
    device_id: String,
    order: usize,
}

#[derive(Debug, Default)]
struct CompareCounts {
    matching: usize,
    replay_only: usize,
    existing_only: usize,
    schema_gap: usize,
    timing_drift: usize,
    data: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DiffCategory {
    SchemaGap,
    TimingDrift,
    Data,
}

#[derive(Debug)]
struct FieldDiff {
    field: String,
    replayed: Option<Value>,
    existing: Option<Value>,
    category: DiffCategory,
}

#[derive(Debug)]
struct EntityDiff {
    key: String,
    field_diffs: Vec<FieldDiff>,
}

#[derive(Debug, Default)]
struct CompareReport {
    counts: CompareCounts,
    schema_gap: Vec<EntityDiff>,
    timing_drift: Vec<EntityDiff>,
    data: Vec<EntityDiff>,
    replay_only: Vec<String>,
    existing_only: Vec<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;

    println!("Loading logs...");
    let steps = load_log_steps(&args.data_dir)?;
    println!("  {} entries", steps.len());

    println!("Loading base note store...");
    let base_store = load_base_note_store(&args.data_dir)?;
    println!("  {} notes", base_store.len());

    println!("Replaying...");
    let store = replay(steps, base_store).await?;
    println!("  {} keys in replayed store", store.len());

    println!("Writing replayed state to {}...", args.output_dir.display());
    write_projection(&args.output_dir, &store)?;

    println!("\nComparing replayed state vs existing checkpoints...");
    let report = compare_projection(&args.data_dir, &store)?;
    print_report(&report, args.verbose);
    Ok(())
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut data_dir = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not set")?
        .join("browser-data");
    let mut output_dir = PathBuf::from("/tmp/browser-replay");
    let mut verbose = false;
    let mut iter = env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--data-dir" => {
                let value = iter.next().ok_or("--data-dir requires a path")?;
                data_dir = PathBuf::from(value);
            }
            "--write" => {
                let value = iter.next().ok_or("--write requires a path")?;
                output_dir = PathBuf::from(value);
            }
            "--verbose" | "-v" => verbose = true,
            "--help" | "-h" => {
                println!(
                    "Usage: cargo run -q -p browser-recall-replay --bin replay-verify -- [--data-dir <dir>] [--write <dir>] [--verbose]"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument: {arg}").into()),
        }
    }
    Ok(Args {
        data_dir,
        output_dir,
        verbose,
    })
}

fn load_log_steps(data_dir: &Path) -> Result<Vec<ReplayStep>, Box<dyn Error>> {
    let logs_dir = data_dir.join("logs");
    let mut steps = Vec::new();
    let mut order = 0usize;
    if !logs_dir.exists() {
        return Ok(steps);
    }

    for device_path in sorted_entries(&logs_dir)? {
        if !device_path.is_dir() {
            continue;
        }
        let device_id = file_name(&device_path)?;
        for file_path in sorted_entries(&device_path)? {
            if file_path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let raw = fs::read_to_string(&file_path)?;
            for (index, line) in raw.lines().enumerate() {
                if line.trim().is_empty() {
                    return Err(format!(
                        "{}:{}: blank JSONL records are not allowed",
                        file_path.display(),
                        index + 1
                    )
                    .into());
                }
                let entry: LogEntry = serde_json::from_str(line)
                    .map_err(|error| format!("{}:{}: {error}", file_path.display(), index + 1))?;
                steps.push(ReplayStep {
                    entry,
                    device_id: device_id.clone(),
                    order,
                });
                order += 1;
            }
        }
    }

    steps.sort_by(|left, right| {
        left.entry
            .timestamp()
            .cmp(&right.entry.timestamp())
            .then(left.order.cmp(&right.order))
    });
    Ok(steps)
}

fn load_base_note_store(data_dir: &Path) -> Result<BTreeMap<String, Entity>, Box<dyn Error>> {
    let mut store = BTreeMap::new();
    let notes_dir = data_dir.join("objects").join("notes");
    if !notes_dir.exists() {
        return Ok(store);
    }
    for path in sorted_entries(&notes_dir)? {
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let slug = path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("invalid note filename: {}", path.display()))?;
        let raw = fs::read_to_string(&path)?;
        let note: NoteEntity =
            serde_json::from_str(&raw).map_err(|error| format!("{}: {error}", path.display()))?;
        store.insert(format!("note:{slug}"), Entity::Note(note));
    }
    Ok(store)
}

async fn replay(
    steps: Vec<ReplayStep>,
    mut store: BTreeMap<String, Entity>,
) -> Result<BTreeMap<String, Entity>, Box<dyn Error>> {
    for step in steps {
        let effects = effect_of(
            step.entry,
            |key| ready(store.get(key).cloned()),
            Context {
                device_id: step.device_id,
            },
        )
        .await?;
        apply_effects(&mut store, effects);
    }
    Ok(store)
}

fn apply_effects(store: &mut BTreeMap<String, Entity>, effects: BTreeMap<String, EntityEffect>) {
    for (key, effect) in effects {
        match effect {
            EntityEffect::Upsert(entity) => {
                store.insert(key, entity);
            }
            EntityEffect::Delete => {
                store.remove(&key);
            }
        }
    }
}

fn write_projection(output_dir: &Path, store: &BTreeMap<String, Entity>) -> io::Result<()> {
    if output_dir.exists() {
        fs::remove_dir_all(output_dir)?;
    }
    fs::create_dir_all(output_dir.join("views").join("pages"))?;
    fs::create_dir_all(output_dir.join("views").join("lists").join("system"))?;
    fs::create_dir_all(output_dir.join("views").join("manifest"))?;
    fs::create_dir_all(output_dir.join("objects").join("notes"))?;

    for (key, entity) in store {
        if entity_is_deleted(entity) {
            continue;
        }
        let Some(path) = checkpoint_path(output_dir, key, entity) else {
            continue;
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut payload = serde_json::to_vec_pretty(entity).map_err(invalid_data)?;
        payload.push(b'\n');
        fs::write(path, payload)?;
    }
    Ok(())
}

fn checkpoint_path(root: &Path, key: &str, entity: &Entity) -> Option<PathBuf> {
    match (key, entity) {
        ("manifest:settings", Entity::Settings(_)) => {
            Some(root.join("views").join("manifest").join("settings.json"))
        }
        ("manifest:orphaned", Entity::Orphaned(_)) => {
            Some(root.join("views").join("manifest").join("orphaned.json"))
        }
        ("manifest:name-to-id", Entity::NameToId(_)) => Some(
            root.join("views")
                .join("manifest")
                .join("list-name-to-id.json"),
        ),
        ("manifest:list-order", Entity::ListOrder(_)) => {
            Some(root.join("views").join("manifest").join("list-order.json"))
        }
        (_, Entity::Page(page)) => {
            if !key.starts_with("page:") || !page_retains_checkpoint(page) {
                return None;
            }
            let slug = key.trim_start_matches("page:");
            Some(
                root.join("views")
                    .join("pages")
                    .join(shard_for(slug))
                    .join(format!("{slug}.json")),
            )
        }
        (_, Entity::Note(note)) if key.starts_with("note:") => {
            let slug = key.strip_prefix("note:").unwrap_or(&note.slug);
            Some(
                root.join("objects")
                    .join("notes")
                    .join(format!("{slug}.json")),
            )
        }
        (_, Entity::List(list)) if key.starts_with("list:") => {
            let slug = key.strip_prefix("list:").unwrap_or(&list.slug);
            Some(
                root.join("views")
                    .join("lists")
                    .join(format!("{slug}.json")),
            )
        }
        _ => None,
    }
}

fn compare_projection(
    data_dir: &Path,
    store: &BTreeMap<String, Entity>,
) -> Result<CompareReport, Box<dyn Error>> {
    let entity_paths = existing_entity_paths(data_dir)?;
    let mut keys: BTreeSet<String> = store.keys().cloned().collect();
    keys.extend(entity_paths.keys().cloned());

    let mut report = CompareReport::default();
    for key in keys {
        let raw = store.get(&key);
        let replayed = replayed_checkpoint_value(&key, raw)?;
        let existing = entity_paths
            .get(&key)
            .map(|path| read_optional_json(data_dir.join(path)))
            .transpose()?
            .flatten();

        if replayed.is_none() && existing.is_none() {
            continue;
        }
        if raw.is_some_and(entity_is_deleted) && existing.is_some() {
            report.counts.matching += 1;
            continue;
        }
        match (replayed, existing) {
            (Some(left), Some(right)) if left == right => report.counts.matching += 1,
            (Some(_), None) => {
                report.counts.replay_only += 1;
                report.replay_only.push(key);
            }
            (None, Some(_)) => {
                report.counts.existing_only += 1;
                report.existing_only.push(key);
            }
            (Some(left), Some(right)) => {
                let diff = diff_entity(key, &left, &right);
                let worst = diff
                    .field_diffs
                    .iter()
                    .map(|field| field.category)
                    .max()
                    .unwrap_or(DiffCategory::Data);
                match worst {
                    DiffCategory::SchemaGap => {
                        report.counts.schema_gap += 1;
                        report.schema_gap.push(diff);
                    }
                    DiffCategory::TimingDrift => {
                        report.counts.timing_drift += 1;
                        report.timing_drift.push(diff);
                    }
                    DiffCategory::Data => {
                        report.counts.data += 1;
                        report.data.push(diff);
                    }
                }
            }
            (None, None) => {}
        }
    }
    Ok(report)
}

fn replayed_checkpoint_value(
    key: &str,
    entity: Option<&Entity>,
) -> Result<Option<Value>, io::Error> {
    let Some(entity) = entity else {
        return Ok(None);
    };
    if entity_is_deleted(entity) {
        return Ok(None);
    }
    if let Entity::Page(page) = entity {
        if !key.starts_with("page:") || !page_retains_checkpoint(page) {
            return Ok(None);
        }
    }
    let value = serde_json::to_value(entity).map_err(invalid_data)?;
    Ok(Some(value))
}

fn existing_entity_paths(data_dir: &Path) -> io::Result<BTreeMap<String, PathBuf>> {
    let mut paths = BTreeMap::new();
    for path in list_files_recursive(&data_dir.join("views").join("pages"))? {
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let slug = file_stem(&path)?;
        paths.insert(
            format!("page:{slug}"),
            path.strip_prefix(data_dir).unwrap_or(&path).to_path_buf(),
        );
    }
    for path in list_files_recursive(&data_dir.join("objects").join("notes"))? {
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let slug = file_stem(&path)?;
        paths.insert(
            format!("note:{slug}"),
            path.strip_prefix(data_dir).unwrap_or(&path).to_path_buf(),
        );
    }
    for path in list_files_recursive(&data_dir.join("views").join("lists"))? {
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let slug = file_stem(&path)?;
        let rel = path.strip_prefix(data_dir).unwrap_or(&path).to_path_buf();
        let key = if rel
            .components()
            .any(|component| component.as_os_str() == "system")
        {
            format!("list:system/{slug}")
        } else {
            format!("list:{slug}")
        };
        paths.insert(key, rel);
    }

    paths.insert(
        "manifest:settings".to_string(),
        PathBuf::from("views/manifest/settings.json"),
    );
    paths.insert(
        "manifest:orphaned".to_string(),
        PathBuf::from("views/manifest/orphaned.json"),
    );
    paths.insert(
        "manifest:name-to-id".to_string(),
        PathBuf::from("views/manifest/list-name-to-id.json"),
    );
    paths.insert(
        "manifest:list-order".to_string(),
        PathBuf::from("views/manifest/list-order.json"),
    );
    Ok(paths)
}

fn diff_entity(key: String, replayed: &Value, existing: &Value) -> EntityDiff {
    let mut fields = BTreeSet::new();
    if let Some(object) = replayed.as_object() {
        fields.extend(object.keys().cloned());
    }
    if let Some(object) = existing.as_object() {
        fields.extend(object.keys().cloned());
    }

    let mut field_diffs = Vec::new();
    for field in fields {
        let replayed_value = replayed.get(&field).cloned();
        let existing_value = existing.get(&field).cloned();
        if replayed_value == existing_value {
            continue;
        }
        let category =
            classify_field_diff(&field, replayed_value.as_ref(), existing_value.as_ref());
        field_diffs.push(FieldDiff {
            field,
            replayed: replayed_value,
            existing: existing_value,
            category,
        });
    }
    if field_diffs.is_empty() {
        field_diffs.push(FieldDiff {
            field: "<entity>".to_string(),
            replayed: Some(replayed.clone()),
            existing: Some(existing.clone()),
            category: DiffCategory::Data,
        });
    }
    EntityDiff { key, field_diffs }
}

fn classify_field_diff(
    field: &str,
    replayed: Option<&Value>,
    existing: Option<&Value>,
) -> DiffCategory {
    if matches!(field, "createdAt" | "visitDates") && existing.is_none() {
        return DiffCategory::SchemaGap;
    }
    if field == "timestamps" {
        if replayed.is_none() && existing == Some(&Value::Object(Default::default())) {
            return DiffCategory::SchemaGap;
        }
        if replayed.is_some() && existing.is_none() {
            return DiffCategory::SchemaGap;
        }
        if replayed.and_then(Value::as_object).is_some()
            && existing.and_then(Value::as_object).is_some()
        {
            return DiffCategory::TimingDrift;
        }
    }
    if field == "timestamp" && replayed.is_none() && existing.is_some() {
        return DiffCategory::SchemaGap;
    }
    if matches!(field, "scrollDepth" | "timeOnPage") {
        if replayed.is_none() && existing == Some(&Value::from(0)) {
            return DiffCategory::SchemaGap;
        }
        if replayed.is_some() && existing.is_some() {
            return DiffCategory::TimingDrift;
        }
        if replayed.is_none() && existing.and_then(Value::as_i64).is_some() {
            return DiffCategory::TimingDrift;
        }
    }
    if field == "visitDates" && replayed.and_then(Value::as_array).is_some() {
        return DiffCategory::TimingDrift;
    }
    if field == "visitDates" && replayed.is_none() && existing.is_some() {
        return DiffCategory::TimingDrift;
    }
    if matches!(field, "parentIds" | "childIds")
        && replayed.and_then(Value::as_array).is_some()
        && existing.and_then(Value::as_array).is_some()
        && relationship_diff_is_page_only(replayed, existing)
    {
        return DiffCategory::TimingDrift;
    }
    if field == "pins"
        && replayed.and_then(Value::as_array).is_some()
        && existing.and_then(Value::as_array).is_some()
        && same_pins_ignoring_order(replayed, existing)
    {
        return DiffCategory::TimingDrift;
    }
    if field == "title"
        && ((replayed.is_none() && existing == Some(&Value::String(String::new())))
            || (replayed == Some(&Value::String(String::new())) && existing.is_none()))
    {
        return DiffCategory::SchemaGap;
    }
    DiffCategory::Data
}

fn relationship_diff_is_page_only(replayed: Option<&Value>, existing: Option<&Value>) -> bool {
    let (Some(replayed), Some(existing)) = (
        replayed.and_then(Value::as_array),
        existing.and_then(Value::as_array),
    ) else {
        return false;
    };
    let Some(replayed_set): Option<BTreeSet<_>> = replayed.iter().map(Value::as_str).collect()
    else {
        return false;
    };
    let Some(existing_set): Option<BTreeSet<_>> = existing.iter().map(Value::as_str).collect()
    else {
        return false;
    };
    replayed_set
        .symmetric_difference(&existing_set)
        .all(|value| value.starts_with("page:"))
}

fn same_pins_ignoring_order(replayed: Option<&Value>, existing: Option<&Value>) -> bool {
    fn sorted(value: Option<&Value>) -> Option<Vec<Value>> {
        let mut pins = value?.as_array()?.clone();
        if pins
            .iter()
            .any(|pin| pin.get("id").and_then(Value::as_str).is_none())
        {
            return None;
        }
        pins.sort_by(|left, right| {
            left.get("id")
                .and_then(Value::as_str)
                .cmp(&right.get("id").and_then(Value::as_str))
        });
        Some(pins)
    }
    matches!((sorted(replayed), sorted(existing)), (Some(left), Some(right)) if left == right)
}

fn print_report(report: &CompareReport, verbose: bool) {
    let total_compared = report.counts.matching
        + report.counts.replay_only
        + report.counts.existing_only
        + report.counts.schema_gap
        + report.counts.timing_drift
        + report.counts.data;
    let total_mismatch = report.counts.schema_gap + report.counts.timing_drift + report.counts.data;

    println!("\n=== RESULTS ({total_compared} entities compared) ===");
    println!("  Matching:       {}", report.counts.matching);
    println!("  Mismatched:     {total_mismatch}");
    println!(
        "    schema-gap:     {}  (field added/removed by code evolution)",
        report.counts.schema_gap
    );
    println!(
        "    timing-drift:   {}  (checkpoint written at intermediate state)",
        report.counts.timing_drift
    );
    println!(
        "    data:           {}  (genuine difference - investigate)",
        report.counts.data
    );
    println!("  Replay-only:    {}", report.counts.replay_only);
    println!("  Existing-only:  {}", report.counts.existing_only);

    print_field_frequency(report);
    print_diff_examples("DATA", &report.data, verbose);
    print_diff_examples("TIMING-DRIFT", &report.timing_drift, verbose);
    print_diff_examples("SCHEMA-GAP", &report.schema_gap, verbose);
    print_presence_examples("REPLAY-ONLY", &report.replay_only, verbose);
    print_presence_examples("EXISTING-ONLY", &report.existing_only, verbose);

    if report.counts.data == 0 && report.counts.replay_only == 0 && report.counts.existing_only == 0
    {
        println!(
            "\nNo data-level discrepancies. All diffs are benign (schema gaps or timing drift)."
        );
    } else if report.counts.data == 0 {
        println!(
            "\nNo data-level mismatches. {} entity-presence diffs remain.",
            report.counts.replay_only + report.counts.existing_only
        );
    }
    println!("\nDone.");
}

fn print_field_frequency(report: &CompareReport) {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for diff in report
        .data
        .iter()
        .chain(report.timing_drift.iter())
        .chain(report.schema_gap.iter())
    {
        for field in &diff.field_diffs {
            *counts.entry(&field.field).or_default() += 1;
        }
    }
    if counts.is_empty() {
        return;
    }
    let mut sorted: Vec<_> = counts.into_iter().collect();
    sorted.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
    println!("\n=== FIELD MISMATCH FREQUENCY ===");
    for (field, count) in sorted {
        println!("  {field:<20} {count}");
    }
}

fn print_diff_examples(label: &str, items: &[EntityDiff], verbose: bool) {
    if items.is_empty() {
        return;
    }
    let shown = if verbose {
        items.len()
    } else {
        items.len().min(MAX_EXAMPLES)
    };
    println!("\n--- {label} ({} total, showing {shown}) ---", items.len());
    for diff in items.iter().take(shown) {
        println!("\n  {}:", diff.key);
        for field in &diff.field_diffs {
            println!(
                "    {}{}:",
                field.field,
                category_tag(field.category, label)
            );
            println!(
                "      replayed: {}",
                truncate(value_label(field.replayed.as_ref()), 120)
            );
            println!(
                "      existing: {}",
                truncate(value_label(field.existing.as_ref()), 120)
            );
        }
    }
    if !verbose && items.len() > MAX_EXAMPLES {
        println!(
            "\n  ... {} more (use --verbose to see all)",
            items.len() - MAX_EXAMPLES
        );
    }
}

fn category_tag(category: DiffCategory, section_label: &str) -> String {
    let label = match category {
        DiffCategory::SchemaGap => "SCHEMA-GAP",
        DiffCategory::TimingDrift => "TIMING-DRIFT",
        DiffCategory::Data => "DATA",
    };
    if label == section_label {
        String::new()
    } else {
        format!(" [{label}]")
    }
}

fn print_presence_examples(label: &str, keys: &[String], verbose: bool) {
    if keys.is_empty() {
        return;
    }
    let shown = if verbose {
        keys.len()
    } else {
        keys.len().min(MAX_EXAMPLES)
    };
    println!("\n--- {label} ({}) ---", keys.len());
    for key in keys.iter().take(shown) {
        println!("  {key}");
    }
    if !verbose && keys.len() > MAX_EXAMPLES {
        println!("  ... {} more", keys.len() - MAX_EXAMPLES);
    }
}

fn value_label(value: Option<&Value>) -> String {
    value
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "<invalid>".to_string()))
        .unwrap_or_else(|| "undefined".to_string())
}

fn truncate(value: String, max_len: usize) -> String {
    if value.len() <= max_len {
        value
    } else {
        format!("{}...", &value[..max_len.saturating_sub(3)])
    }
}

fn read_optional_json(path: PathBuf) -> io::Result<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw).map(Some).map_err(invalid_data)
}

fn list_files_recursive(root: &Path) -> io::Result<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    for path in sorted_entries(root)? {
        if path.is_dir() {
            output.extend(list_files_recursive(&path)?);
        } else {
            output.push(path);
        }
    }
    Ok(output)
}

fn sorted_entries(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut entries = fs::read_dir(root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    entries.sort();
    Ok(entries)
}

fn file_name(path: &Path) -> Result<String, Box<dyn Error>> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| format!("invalid path name: {}", path.display()).into())
}

fn file_stem(path: &Path) -> io::Result<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| invalid_data(format!("invalid filename: {}", path.display())))
}

fn shard_for(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{:02x}", digest[0])
}

fn entity_is_deleted(entity: &Entity) -> bool {
    match entity {
        Entity::Note(note) => note.deleted,
        Entity::List(list) => list.deleted,
        Entity::Page(_)
        | Entity::Settings(_)
        | Entity::NameToId(_)
        | Entity::ListOrder(_)
        | Entity::Orphaned(_) => false,
    }
}

fn invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
