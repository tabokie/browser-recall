use browser_recall_daemon::{config::ReviewRequestHistory, ConfigStore};
use parking_lot::Mutex;
use std::{future::Future, sync::Arc};

#[derive(Default)]
struct Context {
    session: u64,
    generation: u64,
    active: bool,
}

/// A request remains valid only in the frontend context that completed the task.
#[derive(Clone)]
pub struct Permit {
    context: Arc<Mutex<Context>>,
    session: u64,
    generation: u64,
}
impl Permit {
    pub fn is_current(&self) -> bool {
        let current = self.context.lock();
        current.active && current.session == self.session && current.generation == self.generation
    }
}

#[derive(Clone)]
pub struct ReviewCoordinator {
    store: ConfigStore,
    enabled: bool,
    opened_at: i64,
    context: Arc<Mutex<Context>>,
    requesting: Arc<tokio::sync::Mutex<()>>,
}

fn next_request_at(history: &ReviewRequestHistory) -> Option<i64> {
    const DAY: i64 = 86_400_000;
    match history.requested_at.as_slice() {
        [] => history.first_opened_at.checked_add(7 * DAY),
        [first] => first.checked_add(30 * DAY),
        _ => None,
    }
}

fn validate_schedule(history: &ReviewRequestHistory) -> Result<(), std::io::Error> {
    let mut previous = ReviewRequestHistory {
        first_opened_at: history.first_opened_at,
        requested_at: vec![],
    };
    for timestamp in &history.requested_at {
        if next_request_at(&previous).is_none_or(|earliest| *timestamp < earliest) {
            return Err(std::io::Error::other(
                "review request timestamps violate the request schedule",
            ));
        }
        previous.requested_at.push(*timestamp);
    }
    if previous.requested_at.len() < 2 && next_request_at(&previous).is_none() {
        return Err(std::io::Error::other(
            "review request timestamps are out of range",
        ));
    }
    Ok(())
}

impl ReviewCoordinator {
    pub fn new(store: ConfigStore, enabled: bool, opened_at: i64) -> Self {
        Self {
            store,
            enabled,
            opened_at,
            context: Arc::default(),
            requesting: Arc::default(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn begin_session(&self) -> u64 {
        let mut context = self.context.lock();
        context.session += 1;
        context.generation = 0;
        context.active = false;
        context.session
    }

    // Cancellation never waits for configuration I/O or another bridge operation.
    pub fn cancel(&self, session: u64, generation: u64) {
        let mut context = self.context.lock();
        if context.session == session && generation >= context.generation {
            context.generation = generation;
            context.active = false;
        }
    }

    pub async fn initialize(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            this.store
                .update(|config| {
                    let history = config
                        .review_requests
                        .get_or_insert_with(|| this.initial_history());
                    validate_schedule(history)
                })
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    fn initial_history(&self) -> ReviewRequestHistory {
        ReviewRequestHistory {
            first_opened_at: self.opened_at,
            requested_at: vec![],
        }
    }

    /// Reserve durably on a worker, then revalidate the UI and native activity
    /// immediately before StoreKit. An unused reservation is rolled back.
    pub async fn request<P, F>(
        &self,
        session: u64,
        generation: u64,
        now: i64,
        prepare: impl FnOnce() -> P,
        present: impl FnOnce(u64, Permit) -> F,
    ) -> Result<bool, String>
    where
        P: Future<Output = Result<Option<u64>, String>>,
        F: Future<Output = Result<bool, String>>,
    {
        if !self.enabled {
            return Ok(false);
        }
        let permit = {
            let mut context = self.context.lock();
            if session != context.session || generation <= context.generation {
                return Ok(false);
            }
            context.generation = generation;
            context.active = true;
            Permit {
                context: self.context.clone(),
                session,
                generation,
            }
        };
        let Ok(_requesting) = self.requesting.try_lock() else {
            return Ok(false);
        };
        let result = self
            .request_with_permit(now, permit.clone(), prepare, present)
            .await;
        self.cancel(session, generation);
        result
    }

    async fn request_with_permit<P, F>(
        &self,
        now: i64,
        permit: Permit,
        prepare: impl FnOnce() -> P,
        present: impl FnOnce(u64, Permit) -> F,
    ) -> Result<bool, String>
    where
        P: Future<Output = Result<Option<u64>, String>>,
        F: Future<Output = Result<bool, String>>,
    {
        if !permit.is_current() {
            return Ok(false);
        }
        let Some(epoch) = prepare().await? else {
            return Ok(false);
        };
        let this = self.clone();
        let worker_permit = permit.clone();
        let reservation = tokio::task::spawn_blocking(move || {
            this.store
                .update(|config| {
                    if !worker_permit.is_current() {
                        return Ok(None);
                    }
                    let history = config
                        .review_requests
                        .get_or_insert_with(|| this.initial_history());
                    validate_schedule(history)?;
                    if next_request_at(history).is_none_or(|earliest| now < earliest) {
                        return Ok(None);
                    }
                    history.requested_at.push(now);
                    Ok(Some(history.clone()))
                })
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??;
        let Some(reservation) = reservation else {
            return Ok(false);
        };
        let result = if permit.is_current() {
            present(epoch, permit).await
        } else {
            Ok(false)
        };
        if !matches!(result, Ok(true)) {
            let store = self.store.clone();
            tokio::task::spawn_blocking(move || {
                store
                    .update(|config| {
                        if let Some(history) = config
                            .review_requests
                            .as_mut()
                            .filter(|history| **history == reservation)
                        {
                            history.requested_at.pop();
                        }
                        Ok(())
                    })
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| error.to_string())??;
        }
        result
    }
}
