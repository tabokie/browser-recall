use browser_recall_daemon::pairing::{static_approver, PairingDecision};
use browser_recall_daemon::ws_server::{start_server, ServerStartOptions};
use browser_recall_daemon::{ConfigStore, DaemonConfig};
use std::env;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let args = match parse_cli_args(env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let config_store = ConfigStore::new(
        args.config_dir
            .unwrap_or_else(|| env::temp_dir().join("browser-recall-daemon")),
    );
    if let Err(message) = configure_data_directory(&config_store, args.data_dir) {
        eprintln!("{message}");
        std::process::exit(2);
    }
    let mut options =
        ServerStartOptions::phase1_defaults(config_store, static_approver(args.approve_mode));
    if let Some(port_candidates) = port_candidates_from_env() {
        options.port_candidates = port_candidates;
    }
    options.test_control_enabled = args.test_control_enabled;
    let handle = start_server(options)
        .await
        .expect("failed to start browser recall daemon");
    println!("listening on {}", handle.port());
    tokio::signal::ctrl_c()
        .await
        .expect("failed to listen for ctrl_c");
    handle.shutdown().await;
}

#[derive(Debug)]
struct CliArgs {
    config_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    approve_mode: PairingDecision,
    test_control_enabled: bool,
}

fn parse_cli_args(args: impl IntoIterator<Item = String>) -> Result<CliArgs, String> {
    let mut args = args.into_iter();
    let mut config_dir = None::<PathBuf>;
    let mut data_dir = None::<PathBuf>;
    let mut approve_mode = PairingDecision::Approve;
    let mut test_control_enabled = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config-dir" => {
                config_dir = Some(PathBuf::from(required_option_value(
                    &mut args,
                    "--config-dir",
                )?));
            }
            "--data-dir" => {
                data_dir = Some(PathBuf::from(required_option_value(
                    &mut args,
                    "--data-dir",
                )?));
            }
            "--approve-mode" => {
                approve_mode = match required_option_value(&mut args, "--approve-mode")?.as_str() {
                    "allow" => PairingDecision::Approve,
                    "deny" => PairingDecision::Deny,
                    value => {
                        return Err(format!(
                            "--approve-mode must be `allow` or `deny`, got `{value}`"
                        ));
                    }
                };
            }
            "--test-control" => {
                test_control_enabled = true;
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }

    Ok(CliArgs {
        config_dir,
        data_dir,
        approve_mode,
        test_control_enabled,
    })
}

fn required_option_value(
    args: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<String, String> {
    match args.next() {
        Some(value) if !value.trim().is_empty() && !value.starts_with("--") => Ok(value),
        _ => Err(format!("{option} requires a value")),
    }
}

fn configure_data_directory(
    config_store: &ConfigStore,
    data_dir: Option<PathBuf>,
) -> Result<(), String> {
    match (config_store.exists(), data_dir) {
        (false, None) => {
            return Err("--data-dir is required when creating daemon configuration".to_string());
        }
        (false, Some(data_dir)) => {
            let config = DaemonConfig::new_configured(data_dir).map_err(str::to_string)?;
            config_store
                .save(&config)
                .map_err(|error| format!("failed to create daemon configuration: {error}"))?;
        }
        (true, Some(data_dir)) => {
            let mut config = config_store
                .load_or_create()
                .map_err(|error| format!("failed to load daemon configuration: {error}"))?;
            if !config.data_dir.as_os_str().is_empty() && config.data_dir != data_dir {
                return Err(format!(
                    "daemon is already configured to use {}",
                    config.data_dir.display()
                ));
            }
            if config.is_configured() {
                return Ok(());
            }
            config
                .select_data_directory(data_dir)
                .map_err(str::to_string)?;
            config.complete_setup().map_err(str::to_string)?;
            config_store
                .save(&config)
                .map_err(|error| format!("failed to update daemon configuration: {error}"))?;
        }
        (true, None) => {
            let config = config_store
                .load_or_create()
                .map_err(|error| format!("failed to load daemon configuration: {error}"))?;
            if !config.is_configured() {
                return Err(
                    "--data-dir is required when daemon configuration is incomplete".to_string(),
                );
            }
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::{configure_data_directory, parse_cli_args};
    use browser_recall_daemon::{ConfigStore, DaemonConfig};
    use tempfile::tempdir;

    #[test]
    fn explicit_data_directory_cannot_repoint_existing_configuration() {
        let root = tempdir().expect("config root");
        let store = ConfigStore::new(root.path());
        let original_data_dir = root.path().join("original-data");
        let replacement_data_dir = root.path().join("replacement-data");
        let config = DaemonConfig::new_configured(original_data_dir.clone())
            .expect("configure original data directory");
        store.save(&config).expect("save configured daemon");

        let error = configure_data_directory(&store, Some(replacement_data_dir))
            .expect_err("existing configuration must not be repointed");

        assert!(error.contains("already configured"));
        assert_eq!(
            store
                .load()
                .expect("load config")
                .expect("existing config")
                .data_dir,
            original_data_dir
        );
    }

    #[test]
    fn incomplete_existing_configuration_still_requires_a_data_directory() {
        let root = tempdir().expect("config root");
        let store = ConfigStore::new(root.path());
        store
            .save(&DaemonConfig::new_unconfigured())
            .expect("save incomplete config");

        let error = configure_data_directory(&store, None)
            .expect_err("incomplete configuration must not start");

        assert!(error.contains("configuration is incomplete"));
    }

    #[test]
    fn data_directory_rejects_a_following_flag_as_its_value() {
        let error = parse_cli_args(
            ["--data-dir", "--test-control"]
                .into_iter()
                .map(str::to_string),
        )
        .expect_err("a flag is not a data directory value");

        assert_eq!(error, "--data-dir requires a value");
    }

    #[test]
    fn cli_rejects_unknown_arguments_and_invalid_approval_modes() {
        let unknown = parse_cli_args(["--mystery"].into_iter().map(str::to_string))
            .expect_err("unknown arguments must not be ignored");
        assert_eq!(unknown, "unknown argument: --mystery");

        let invalid_mode =
            parse_cli_args(["--approve-mode", "maybe"].into_iter().map(str::to_string))
                .expect_err("invalid approval modes must not silently approve");
        assert_eq!(
            invalid_mode,
            "--approve-mode must be `allow` or `deny`, got `maybe`"
        );
    }
}
