use browser_recall_daemon::pairing::{static_approver, PairingDecision};
use browser_recall_daemon::ws_server::{start_server, ServerStartOptions};
use browser_recall_daemon::ConfigStore;
use std::env;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let mut args = env::args().skip(1);
    let mut config_dir = None::<PathBuf>;
    let mut approve_mode = PairingDecision::Approve;
    let mut test_control_enabled = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config-dir" => {
                if let Some(value) = args.next() {
                    config_dir = Some(PathBuf::from(value));
                }
            }
            "--approve-mode" => {
                if let Some(value) = args.next() {
                    approve_mode = if value == "deny" {
                        PairingDecision::Deny
                    } else {
                        PairingDecision::Approve
                    };
                }
            }
            "--test-control" => {
                test_control_enabled = true;
            }
            _ => {}
        }
    }

    let config_store = ConfigStore::new(
        config_dir.unwrap_or_else(|| env::temp_dir().join("browser-recall-daemon")),
    );
    let mut options =
        ServerStartOptions::phase1_defaults(config_store, static_approver(approve_mode));
    if let Some(port_candidates) = port_candidates_from_env() {
        options.port_candidates = port_candidates;
    }
    options.test_control_enabled = test_control_enabled;
    let handle = start_server(options)
        .await
        .expect("failed to start browser recall daemon");
    println!("listening on {}", handle.port());
    tokio::signal::ctrl_c()
        .await
        .expect("failed to listen for ctrl_c");
    handle.shutdown().await;
}

fn port_candidates_from_env() -> Option<Vec<u16>> {
    let raw = env::var("BROWSER_RECALL_PORTS").ok()?;
    let ports = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.parse::<u16>().ok())
        .collect::<Option<Vec<_>>>()?;
    if ports.is_empty() {
        return None;
    }
    Some(ports)
}
