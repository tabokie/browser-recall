use browser_recall_replay::entities::Entity;
use browser_recall_replay::{effect_of, Context, EntityEffect, LogEntry};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::ready;
use std::io::{self, Read, Write};

#[derive(Debug, Deserialize)]
struct ReplayStep {
    entry: LogEntry,
    device_id: String,
}

#[derive(Debug, Deserialize)]
struct ReplayRequest {
    #[serde(default)]
    base_store: BTreeMap<String, Entity>,
    steps: Vec<ReplayStep>,
}

#[derive(Debug, Serialize)]
struct ReplayResponse {
    store: BTreeMap<String, Entity>,
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

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        let _ = writeln!(io::stderr(), "{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: ReplayRequest = serde_json::from_str(&input)?;

    let mut store = request.base_store;
    for step in request.steps {
        let snapshot = store.clone();
        let effects = effect_of(
            step.entry,
            move |key| ready(snapshot.get(key).cloned()),
            Context {
                device_id: step.device_id,
            },
        )
        .await?;
        apply_effects(&mut store, effects);
    }

    serde_json::to_writer(io::stdout(), &ReplayResponse { store })?;
    Ok(())
}
