use std::error::Error;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};
use tracing::level_filters::LevelFilter;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder as RollingBuilder, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt;

type BoxError = Box<dyn Error>;

pub struct LoggingHandle {
    _guard: WorkerGuard,
    filter_handle: reload::Handle<LevelFilter, tracing_subscriber::Registry>,
}

pub fn init(log_dir: &Path, level: &str) -> Result<LoggingHandle, BoxError> {
    fs::create_dir_all(log_dir)?;
    prune_old_logs(log_dir, Duration::from_secs(7 * 24 * 60 * 60))?;

    let appender = RollingBuilder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("browser-recall")
        .filename_suffix("log")
        .build(log_dir)?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let (filter, filter_handle) = reload::Layer::new(parse_level(level));

    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer)
                .with_target(true),
        )
        .init();

    Ok(LoggingHandle {
        _guard: guard,
        filter_handle,
    })
}

impl LoggingHandle {
    pub fn set_level(&self, level: &str) -> Result<(), BoxError> {
        self.filter_handle
            .modify(|filter| *filter = parse_level(level))
            .map_err(|error| Box::new(std::io::Error::other(error.to_string())) as BoxError)
    }
}

fn parse_level(level: &str) -> LevelFilter {
    match level {
        "trace" => LevelFilter::TRACE,
        "debug" => LevelFilter::DEBUG,
        "warn" => LevelFilter::WARN,
        "error" => LevelFilter::ERROR,
        _ => LevelFilter::INFO,
    }
}

fn prune_old_logs(log_dir: &Path, retention: Duration) -> Result<(), BoxError> {
    let now = SystemTime::now();
    for entry in fs::read_dir(log_dir)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.starts_with("browser-recall") {
            continue;
        }

        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }

        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age > retention {
            let _ = fs::remove_file(entry.path());
        }
    }

    Ok(())
}
