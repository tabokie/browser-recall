#![cfg(target_os = "windows")]

use browser_recall_daemon::{
    config::{current_hostname, device_id_from_os_parts},
    ConfigStore,
};
use std::{
    fs,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

fn run_bounded(command: &mut Command) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start identity probe");
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut timed_out = false;
    while child.try_wait().expect("inspect identity probe").is_none() {
        if Instant::now() >= deadline {
            timed_out = true;
            child.kill().expect("stop stalled identity probe");
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().expect("collect identity probe");
    assert!(
        !timed_out && output.status.success(),
        "identity probe failed (timed_out={timed_out}): {output:?}"
    );
    output
}

#[test]
fn fresh_and_upgraded_configuration_do_not_require_registry_subprocesses() {
    const PROFILE: &str = "BROWSER_RECALL_IDENTITY_PROBE_PROFILE";
    const EXPECTED: &str = "BROWSER_RECALL_IDENTITY_PROBE_EXPECTED";
    if let Some(profile) = std::env::var_os(PROFILE) {
        let expected = std::env::var(EXPECTED).expect("expected legacy identity");
        let store = ConfigStore::new(profile);
        let fresh = store.load_or_create().expect("create fresh configuration");
        assert_eq!(fresh.device_id, expected);
        assert_eq!(store.load().unwrap().unwrap(), fresh);
        fs::write(store.config_path(), b"{}").unwrap();
        let upgraded = store
            .load()
            .expect("upgrade missing device identity")
            .unwrap();
        assert_eq!(upgraded.device_id, expected);
        assert_eq!(store.load().unwrap().unwrap(), upgraded);
        return;
    }

    // Compare with the shipped registry command before making reg.exe unusable.
    let registry_command =
        std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/reg.exe");
    let output = run_bounded(Command::new(registry_command).args([
        "query",
        r"HKLM\SOFTWARE\Microsoft\Cryptography",
        "/v",
        "MachineGuid",
    ]));
    let output = String::from_utf8(output.stdout).unwrap();
    let machine_guid = output
        .lines()
        .find(|line| line.contains("MachineGuid"))
        .and_then(|line| line.split_whitespace().last())
        .expect("legacy MachineGuid");
    let expected =
        device_id_from_os_parts(current_hostname().as_deref(), Some(machine_guid)).unwrap();

    let work = tempfile::tempdir().unwrap();
    let probe = work.path().join("identity-probe.exe");
    fs::copy(std::env::current_exe().unwrap(), &probe).unwrap();
    // Windows searches the executable directory first. This copy rejects reg's
    // arguments, so a subprocess-based implementation fails deterministically.
    fs::copy(&probe, work.path().join("reg.exe")).unwrap();
    run_bounded(
        Command::new(probe)
            .args([
                "--exact",
                "fresh_and_upgraded_configuration_do_not_require_registry_subprocesses",
                "--nocapture",
            ])
            .env(PROFILE, work.path().join("profile"))
            .env(EXPECTED, expected),
    );
}
