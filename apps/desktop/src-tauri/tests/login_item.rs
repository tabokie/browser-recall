#[path = "../src/login_item.rs"]
#[allow(dead_code)]
mod login_item;

use login_item::{
    persist_preference, reconcile, reconcile_for_startup, windows_run_command,
    windows_startup_approved_enabled, LoginItemBackend,
};
use std::cell::{Cell, RefCell};
use std::io;
use std::path::Path;

struct TestBackend {
    enabled: Cell<bool>,
    registered: Cell<bool>,
    changes: RefCell<Vec<bool>>,
    fail_on_change: Cell<Option<bool>>,
    fail_after_change: Cell<Option<bool>>,
    fail_restore: Cell<bool>,
    restores: RefCell<Vec<TestSnapshot>>,
}

impl TestBackend {
    fn new(enabled: bool) -> Self {
        Self::with_state(enabled, enabled)
    }

    fn with_state(enabled: bool, registered: bool) -> Self {
        Self {
            enabled: Cell::new(enabled),
            registered: Cell::new(registered),
            changes: RefCell::new(Vec::new()),
            fail_on_change: Cell::new(None),
            fail_after_change: Cell::new(None),
            fail_restore: Cell::new(false),
            restores: RefCell::new(Vec::new()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TestSnapshot {
    enabled: bool,
    registered: bool,
}

impl LoginItemBackend for TestBackend {
    type Snapshot = TestSnapshot;

    fn is_supported(&self) -> bool {
        true
    }

    fn is_enabled(&self) -> io::Result<bool> {
        Ok(self.enabled.get())
    }

    fn is_registered(&self) -> io::Result<bool> {
        Ok(self.registered.get())
    }

    fn set_enabled(&self, enabled: bool) -> io::Result<()> {
        self.changes.borrow_mut().push(enabled);
        if self.fail_on_change.get() == Some(enabled) {
            return Err(io::Error::other(format!(
                "could not change login item to {enabled}"
            )));
        }
        self.enabled.set(enabled);
        self.registered.set(enabled);
        if self.fail_after_change.get() == Some(enabled) {
            return Err(io::Error::other(format!(
                "could not finish changing login item to {enabled}"
            )));
        }
        Ok(())
    }

    fn snapshot(&self) -> io::Result<Self::Snapshot> {
        Ok(TestSnapshot {
            enabled: self.enabled.get(),
            registered: self.registered.get(),
        })
    }

    fn restore(&self, snapshot: &Self::Snapshot) -> io::Result<()> {
        self.restores.borrow_mut().push(*snapshot);
        if self.fail_restore.get() {
            return Err(io::Error::other("could not restore native snapshot"));
        }
        self.enabled.set(snapshot.enabled);
        self.registered.set(snapshot.registered);
        Ok(())
    }
}

#[test]
fn absent_registration_can_be_disabled_idempotently() {
    let backend = TestBackend::new(false);

    reconcile(&backend, false).expect("absent registration is already disabled");

    assert!(!backend.enabled.get());
    assert!(backend.changes.borrow().is_empty());
}

#[test]
fn existing_registration_can_be_enabled_idempotently() {
    let backend = TestBackend::new(true);

    reconcile(&backend, true).expect("existing registration is already enabled");

    assert!(backend.enabled.get());
    assert!(backend.changes.borrow().is_empty());
}

#[test]
fn startup_reconciliation_failure_is_returned_as_a_nonfatal_diagnostic() {
    let backend = TestBackend::new(false);
    backend.fail_after_change.set(Some(true));

    let diagnostic = reconcile_for_startup(&backend, true);

    assert_eq!(
        diagnostic.as_deref(),
        Some("could not finish changing login item to true")
    );
    assert!(!backend.enabled.get());
    assert!(!backend.registered.get());
    assert_eq!(backend.restores.borrow().len(), 1);
}

#[test]
fn startup_diagnostic_preserves_change_and_restore_failures() {
    let backend = TestBackend::new(false);
    backend.fail_after_change.set(Some(true));
    backend.fail_restore.set(true);

    let diagnostic = reconcile_for_startup(&backend, true)
        .expect("startup change and restore failures must remain explicit");

    assert!(diagnostic.contains("could not finish changing login item to true"));
    assert!(diagnostic.contains("could not restore native snapshot"));
}

#[test]
fn windows_run_command_quotes_an_executable_path_with_spaces() {
    assert_eq!(
        windows_run_command(Path::new(
            r"C:\Users\Jane Doe\Browser Recall\browser-recall-desktop.exe"
        ))
        .expect("quote Windows executable path"),
        r#""C:\Users\Jane Doe\Browser Recall\browser-recall-desktop.exe""#,
    );
}

#[test]
fn windows_startup_approved_requires_enabled_status_and_zero_timestamp() {
    assert!(windows_startup_approved_enabled(&[
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    .expect("parse enabled StartupApproved value"));
    assert!(!windows_startup_approved_enabled(&[
        0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    .expect("disabled status must remain disabled"));
    assert!(!windows_startup_approved_enabled(&[
        0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    .expect("an enabled status with a disable timestamp is not enabled"));
    assert!(windows_startup_approved_enabled(&[0x02, 0x00]).is_err());
}

#[test]
fn failed_config_persistence_restores_the_previous_native_state() {
    let backend = TestBackend::new(false);

    let error = persist_preference(&backend, true, || {
        Err(io::Error::other("config write failed"))
    })
    .expect_err("failed persistence must be reported");

    assert_eq!(error.to_string(), "config write failed");
    assert!(!backend.enabled.get());
    assert_eq!(*backend.changes.borrow(), vec![true]);
    assert_eq!(
        *backend.restores.borrow(),
        vec![TestSnapshot {
            enabled: false,
            registered: false,
        }]
    );
}

#[test]
fn failed_persistence_restores_registered_but_disabled_state_exactly() {
    let backend = TestBackend::with_state(false, true);

    persist_preference(&backend, false, || {
        Err(io::Error::other("config write failed"))
    })
    .expect_err("failed persistence must be reported");

    assert!(!backend.enabled.get());
    assert!(backend.registered.get());
    assert_eq!(*backend.changes.borrow(), vec![false]);
}

#[test]
fn failed_native_change_does_not_persist_the_new_preference() {
    let backend = TestBackend::new(false);
    backend.fail_after_change.set(Some(true));
    let save_attempted = Cell::new(false);

    let error = persist_preference(&backend, true, || {
        save_attempted.set(true);
        Ok(())
    })
    .expect_err("failed native registration must be reported");

    assert_eq!(
        error.to_string(),
        "could not finish changing login item to true"
    );
    assert!(!save_attempted.get());
    assert!(!backend.enabled.get());
    assert!(!backend.registered.get());
    assert_eq!(*backend.changes.borrow(), vec![true]);
}

#[test]
fn rollback_failure_keeps_both_errors_explicit() {
    let backend = TestBackend::new(false);
    let save_attempted = Cell::new(false);

    let error = persist_preference(&backend, true, || {
        save_attempted.set(true);
        backend.fail_restore.set(true);
        Err(io::Error::other("config write failed"))
    })
    .expect_err("failed rollback must be reported");

    assert!(save_attempted.get());
    assert!(error.to_string().contains("config write failed"));
    assert!(error
        .to_string()
        .contains("could not restore native snapshot"));
    assert!(backend.enabled.get());
    assert_eq!(*backend.changes.borrow(), vec![true]);
}
