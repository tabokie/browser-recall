use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

// Startup can block before the application logger exists. Keep the isolated
// native test's progress beside its profile because Windows GUI binaries may
// lack stderr. Do not pre-create the profile and change cold WebView2 startup.
pub fn record(stage: &str) {
    let Some(profile) = std::env::var_os("BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR") else {
        return;
    };
    let profile = PathBuf::from(profile);
    if !profile.is_absolute() {
        return; // Configuration bootstrap reports an invalid profile path.
    }
    static STARTED: OnceLock<Instant> = OnceLock::new();
    let elapsed = STARTED.get_or_init(Instant::now).elapsed().as_millis();
    let mut trace_path = profile.into_os_string();
    trace_path.push(".startup-stages.log");
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(PathBuf::from(trace_path))?;
        writeln!(file, "{elapsed}ms pid={} {stage}", std::process::id())
    })();
    if let Err(error) = result {
        eprintln!("Could not record native startup stage {stage}: {error}");
    }
}
