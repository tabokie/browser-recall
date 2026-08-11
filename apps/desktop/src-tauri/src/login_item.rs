use std::io;
#[cfg(any(target_os = "windows", test))]
use std::path::Path;
use tauri::{AppHandle, Runtime};

const SKIP_LOGIN_ITEM_REGISTRATION_ENV: &str = "BROWSER_RECALL_SKIP_LOGIN_ITEM_REGISTRATION";

pub trait LoginItemBackend {
    type Snapshot;

    fn is_supported(&self) -> bool;
    fn is_enabled(&self) -> io::Result<bool>;
    fn is_registered(&self) -> io::Result<bool> {
        self.is_enabled()
    }
    fn set_enabled(&self, enabled: bool) -> io::Result<()>;
    fn snapshot(&self) -> io::Result<Self::Snapshot>;
    fn restore(&self, snapshot: &Self::Snapshot) -> io::Result<()>;
}

pub struct SystemLoginItem<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<'a, R: Runtime> SystemLoginItem<'a, R> {
    pub fn new(app: &'a AppHandle<R>) -> Self {
        Self { app }
    }

    pub fn supported(&self) -> bool {
        LoginItemBackend::is_supported(self)
    }

    pub fn persist<F>(&self, enabled: bool, persist: F) -> io::Result<()>
    where
        F: FnOnce() -> io::Result<()>,
    {
        persist_preference(self, enabled, persist)
    }
}

pub fn reconcile<B: LoginItemBackend + ?Sized>(backend: &B, enabled: bool) -> io::Result<()> {
    if enabled && !backend.is_supported() {
        return Err(io::Error::other(
            "Launch at login is unavailable on this OS",
        ));
    }
    if enabled && backend.is_enabled()? {
        return Ok(());
    }
    if !enabled && !backend.is_registered()? {
        return Ok(());
    }

    backend.set_enabled(enabled)?;
    let reconciled = if enabled {
        backend.is_enabled()?
    } else {
        !backend.is_registered()?
    };
    if reconciled {
        Ok(())
    } else {
        Err(io::Error::other(
            "OS launch-at-login registration did not reach the requested state",
        ))
    }
}

pub fn persist_preference<B, F>(backend: &B, enabled: bool, persist: F) -> io::Result<()>
where
    B: LoginItemBackend + ?Sized,
    F: FnOnce() -> io::Result<()>,
{
    let previous = reconcile_with_snapshot(backend, enabled)?;

    match persist() {
        Ok(()) => Ok(()),
        Err(persist_error) => match backend.restore(&previous) {
            Ok(()) => Err(persist_error),
            Err(rollback_error) => Err(compensation_error(
                "configuration persistence",
                persist_error,
                rollback_error,
            )),
        },
    }
}

pub fn reconcile_for_startup<B: LoginItemBackend + ?Sized>(
    backend: &B,
    enabled: bool,
) -> Option<String> {
    reconcile_with_snapshot(backend, enabled)
        .err()
        .map(|error| error.to_string())
}

fn reconcile_with_snapshot<B: LoginItemBackend + ?Sized>(
    backend: &B,
    enabled: bool,
) -> io::Result<B::Snapshot> {
    let previous = backend.snapshot()?;
    if let Err(change_error) = reconcile(backend, enabled) {
        return match backend.restore(&previous) {
            Ok(()) => Err(change_error),
            Err(rollback_error) => Err(compensation_error(
                "native login-item change",
                change_error,
                rollback_error,
            )),
        };
    }
    Ok(previous)
}

fn compensation_error(operation: &str, primary: io::Error, rollback: io::Error) -> io::Error {
    io::Error::other(format!(
        "{operation} failed: {primary}; restoring the previous login-item state also failed: {rollback}"
    ))
}

pub enum SystemLoginItemSnapshot {
    Suppressed,
    Unsupported,
    #[cfg(target_os = "macos")]
    Macos(isize),
    #[cfg(target_os = "windows")]
    Windows(WindowsLoginItemSnapshot),
    #[cfg(target_os = "linux")]
    Linux(bool),
}

impl<R: Runtime> LoginItemBackend for SystemLoginItem<'_, R> {
    type Snapshot = SystemLoginItemSnapshot;

    fn is_supported(&self) -> bool {
        let _ = self.app;
        if registration_suppressed() {
            return false;
        }

        platform_is_supported()
    }

    fn is_enabled(&self) -> io::Result<bool> {
        if registration_suppressed() || !platform_is_supported() {
            return Ok(false);
        }

        #[cfg(target_os = "macos")]
        return Ok(macos_login_item_status()? == MACOS_LOGIN_ITEM_ENABLED);

        #[cfg(target_os = "windows")]
        return windows_login_item_enabled(self.app);

        #[cfg(target_os = "linux")]
        {
            use tauri_plugin_autostart::ManagerExt;
            return self.app.autolaunch().is_enabled().map_err(io::Error::other);
        }

        #[allow(unreachable_code)]
        Ok(false)
    }

    fn is_registered(&self) -> io::Result<bool> {
        if registration_suppressed() || !platform_is_supported() {
            return Ok(false);
        }

        #[cfg(target_os = "macos")]
        return Ok(macos_login_item_status()? != MACOS_LOGIN_ITEM_NOT_REGISTERED);

        #[cfg(target_os = "windows")]
        return Ok(windows_registry_value_snapshot(
            WINDOWS_RUN_KEY,
            &self.app.package_info().name,
        )?
        .is_some());

        #[cfg(target_os = "linux")]
        {
            use tauri_plugin_autostart::ManagerExt;
            return self.app.autolaunch().is_enabled().map_err(io::Error::other);
        }

        #[allow(unreachable_code)]
        Ok(false)
    }

    fn set_enabled(&self, enabled: bool) -> io::Result<()> {
        if registration_suppressed() {
            return if enabled {
                Err(io::Error::other(
                    "Launch at login is disabled for this isolated runtime",
                ))
            } else {
                Ok(())
            };
        }
        if !platform_is_supported() {
            return if enabled {
                Err(io::Error::other(
                    "Launch at login is unavailable on this OS",
                ))
            } else {
                Ok(())
            };
        }

        #[cfg(target_os = "macos")]
        {
            let registered = macos_login_item_status()? != MACOS_LOGIN_ITEM_NOT_REGISTERED;
            if enabled && !registered {
                sync_macos_login_item(true)?;
            } else if !enabled && registered {
                sync_macos_login_item(false)?;
            }
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        return set_windows_login_item(self.app, enabled);

        #[cfg(target_os = "linux")]
        {
            use tauri_plugin_autostart::ManagerExt;
            let autostart = self.app.autolaunch();
            if enabled {
                autostart.enable().map_err(io::Error::other)?;
            } else if autostart.is_enabled().map_err(io::Error::other)? {
                autostart.disable().map_err(io::Error::other)?;
            }
            return Ok(());
        }

        #[allow(unreachable_code)]
        Ok(())
    }

    fn snapshot(&self) -> io::Result<Self::Snapshot> {
        if registration_suppressed() {
            return Ok(SystemLoginItemSnapshot::Suppressed);
        }
        if !platform_is_supported() {
            return Ok(SystemLoginItemSnapshot::Unsupported);
        }

        #[cfg(target_os = "macos")]
        return Ok(SystemLoginItemSnapshot::Macos(macos_login_item_status()?));

        #[cfg(target_os = "windows")]
        return Ok(SystemLoginItemSnapshot::Windows(
            windows_login_item_snapshot(self.app)?,
        ));

        #[cfg(target_os = "linux")]
        {
            use tauri_plugin_autostart::ManagerExt;
            return Ok(SystemLoginItemSnapshot::Linux(
                self.app
                    .autolaunch()
                    .is_enabled()
                    .map_err(io::Error::other)?,
            ));
        }

        #[allow(unreachable_code)]
        Ok(SystemLoginItemSnapshot::Unsupported)
    }

    fn restore(&self, snapshot: &Self::Snapshot) -> io::Result<()> {
        match snapshot {
            SystemLoginItemSnapshot::Suppressed | SystemLoginItemSnapshot::Unsupported => Ok(()),
            #[cfg(target_os = "macos")]
            SystemLoginItemSnapshot::Macos(status) => restore_macos_login_item_status(*status),
            #[cfg(target_os = "windows")]
            SystemLoginItemSnapshot::Windows(snapshot) => {
                restore_windows_login_item(self.app, snapshot)
            }
            #[cfg(target_os = "linux")]
            SystemLoginItemSnapshot::Linux(enabled) => reconcile(self, *enabled),
        }
    }
}

fn registration_suppressed() -> bool {
    std::env::var_os(SKIP_LOGIN_ITEM_REGISTRATION_ENV).is_some()
}

fn platform_is_supported() -> bool {
    #[cfg(target_os = "macos")]
    return macos_version_at_least(13);

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    return true;

    #[allow(unreachable_code)]
    false
}

#[cfg(any(target_os = "windows", test))]
#[cfg_attr(test, allow(dead_code))]
pub fn windows_run_command(executable: &Path) -> io::Result<String> {
    let executable = executable
        .to_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid executable path"))?;
    if executable.contains('"') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows executable path contains a quote",
        ));
    }
    Ok(format!("\"{executable}\""))
}

#[cfg(target_os = "windows")]
const WINDOWS_RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(target_os = "windows")]
const WINDOWS_STARTUP_APPROVED_KEY: &str =
    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
#[cfg(any(target_os = "windows", test))]
#[cfg_attr(test, allow(dead_code))]
const WINDOWS_STARTUP_APPROVED_ENABLED: [u8; 12] = [
    0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

#[cfg(target_os = "windows")]
pub struct WindowsRegistryValueSnapshot {
    value_type: winreg::enums::RegType,
    bytes: Vec<u8>,
}

#[cfg(target_os = "windows")]
pub struct WindowsLoginItemSnapshot {
    run: Option<WindowsRegistryValueSnapshot>,
    startup_approved: Option<WindowsRegistryValueSnapshot>,
}

#[cfg(any(target_os = "windows", test))]
#[cfg_attr(test, allow(dead_code))]
pub fn windows_startup_approved_enabled(bytes: &[u8]) -> io::Result<bool> {
    if bytes.len() != WINDOWS_STARTUP_APPROVED_ENABLED.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows StartupApproved login-item value must contain a 4-byte status and 8-byte timestamp",
        ));
    }
    let status = u32::from_le_bytes(
        bytes[..4]
            .try_into()
            .map_err(|_| io::Error::other("could not read Windows StartupApproved status"))?,
    );
    Ok(status == 0x02 && bytes[4..].iter().all(|byte| *byte == 0))
}

#[cfg(target_os = "windows")]
fn windows_login_item_enabled<R: Runtime>(app: &AppHandle<R>) -> io::Result<bool> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let Some(command) = windows_login_item_command(app)? else {
        return Ok(false);
    };
    let expected = windows_run_command(&std::env::current_exe()?)?;
    if command != expected {
        return Ok(false);
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let approved = match hkcu.open_subkey_with_flags(WINDOWS_STARTUP_APPROVED_KEY, KEY_READ) {
        Ok(approved) => approved,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    let value = match approved.get_raw_value(&app.package_info().name) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    windows_startup_approved_enabled(&value.bytes)
}

#[cfg(target_os = "windows")]
fn windows_login_item_snapshot<R: Runtime>(
    app: &AppHandle<R>,
) -> io::Result<WindowsLoginItemSnapshot> {
    let name = &app.package_info().name;
    Ok(WindowsLoginItemSnapshot {
        run: windows_registry_value_snapshot(WINDOWS_RUN_KEY, name)?,
        startup_approved: windows_registry_value_snapshot(WINDOWS_STARTUP_APPROVED_KEY, name)?,
    })
}

#[cfg(target_os = "windows")]
fn windows_registry_value_snapshot(
    key_path: &str,
    name: &str,
) -> io::Result<Option<WindowsRegistryValueSnapshot>> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(key_path, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    match key.get_raw_value(name) {
        Ok(value) => Ok(Some(WindowsRegistryValueSnapshot {
            value_type: value.vtype,
            bytes: value.bytes.into_owned(),
        })),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "windows")]
fn restore_windows_login_item<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &WindowsLoginItemSnapshot,
) -> io::Result<()> {
    let name = &app.package_info().name;
    restore_windows_registry_value(WINDOWS_RUN_KEY, name, snapshot.run.as_ref())?;
    restore_windows_registry_value(
        WINDOWS_STARTUP_APPROVED_KEY,
        name,
        snapshot.startup_approved.as_ref(),
    )
}

#[cfg(target_os = "windows")]
fn restore_windows_registry_value(
    key_path: &str,
    name: &str,
    snapshot: Option<&WindowsRegistryValueSnapshot>,
) -> io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::{RegKey, RegValue};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Some(snapshot) = snapshot {
        let (key, _) = hkcu.create_subkey(key_path)?;
        return key.set_raw_value(
            name,
            &RegValue {
                vtype: snapshot.value_type.clone(),
                bytes: snapshot.bytes.clone().into(),
            },
        );
    }

    let key = match hkcu.open_subkey_with_flags(key_path, KEY_SET_VALUE) {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "windows")]
fn windows_login_item_command<R: Runtime>(app: &AppHandle<R>) -> io::Result<Option<String>> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run = match hkcu.open_subkey_with_flags(WINDOWS_RUN_KEY, KEY_READ) {
        Ok(run) => run,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    match run.get_value(&app.package_info().name) {
        Ok(command) => Ok(Some(command)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "windows")]
fn set_windows_login_item<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE, REG_BINARY};
    use winreg::{RegKey, RegValue};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let name = &app.package_info().name;
    if enabled {
        let (run, _) = hkcu.create_subkey(WINDOWS_RUN_KEY)?;
        run.set_value(name, &windows_run_command(&std::env::current_exe()?)?)?;
        match hkcu.open_subkey_with_flags(WINDOWS_STARTUP_APPROVED_KEY, KEY_SET_VALUE) {
            Ok(approved) => {
                approved.set_raw_value(
                    name,
                    &RegValue {
                        vtype: REG_BINARY,
                        bytes: WINDOWS_STARTUP_APPROVED_ENABLED.to_vec().into(),
                    },
                )?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    } else {
        let run = match hkcu.open_subkey_with_flags(WINDOWS_RUN_KEY, KEY_SET_VALUE) {
            Ok(run) => run,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        match run.delete_value(name) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
const MACOS_LOGIN_ITEM_NOT_REGISTERED: isize = 0;
#[cfg(target_os = "macos")]
const MACOS_LOGIN_ITEM_ENABLED: isize = 1;
#[cfg(target_os = "macos")]
const MACOS_LOGIN_ITEM_REQUIRES_APPROVAL: isize = 2;

#[cfg(target_os = "macos")]
fn macos_version_at_least(required_major: u32) -> bool {
    let Ok(output) = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }

    let version = String::from_utf8_lossy(&output.stdout);
    let major = version
        .trim()
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    matches!(major, Some(value) if value >= required_major)
}

#[cfg(target_os = "macos")]
fn macos_login_item_status() -> io::Result<isize> {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let result = (|| {
            let service_class = objc_class("SMAppService")?;
            let service = send_id_message(service_class, "mainAppService")?;
            send_integer_message(service, "status")
        })();
        objc_autoreleasePoolPop(pool);
        result
    }
}

#[cfg(target_os = "macos")]
fn restore_macos_login_item_status(status: isize) -> io::Result<()> {
    if macos_login_item_status()? == status {
        return Ok(());
    }
    match status {
        MACOS_LOGIN_ITEM_NOT_REGISTERED => sync_macos_login_item(false)?,
        MACOS_LOGIN_ITEM_ENABLED | MACOS_LOGIN_ITEM_REQUIRES_APPROVAL => {
            sync_macos_login_item(true)?
        }
        _ => {
            return Err(io::Error::other(format!(
                "cannot restore unknown SMAppService status {status}"
            )))
        }
    }
    let restored = macos_login_item_status()?;
    if restored == status {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "restored SMAppService status {restored}, expected {status}"
        )))
    }
}

#[cfg(target_os = "macos")]
fn sync_macos_login_item(enabled: bool) -> io::Result<()> {
    if !macos_version_at_least(13) {
        return Err(io::Error::other(
            "Launch at login requires macOS 13 or newer",
        ));
    }

    unsafe {
        let pool = objc_autoreleasePoolPush();
        let result = sync_macos_login_item_inner(enabled);
        objc_autoreleasePoolPop(pool);
        result
    }
}

#[cfg(target_os = "macos")]
unsafe fn sync_macos_login_item_inner(enabled: bool) -> io::Result<()> {
    let service_class = objc_class("SMAppService")?;
    let service = send_id_message(service_class, "mainAppService")?;
    let mut error = std::ptr::null_mut();
    let selector = if enabled {
        "registerAndReturnError:"
    } else {
        "unregisterAndReturnError:"
    };
    let success = send_bool_error_message(service, selector, &mut error)?;
    if success {
        Ok(())
    } else {
        let action = if enabled { "register" } else { "unregister" };
        Err(io::Error::other(
            localized_error_message(error)
                .unwrap_or_else(|| format!("SMAppService {action} failed")),
        ))
    }
}

#[cfg(target_os = "macos")]
unsafe fn objc_class(name: &str) -> io::Result<ObjcId> {
    let name = std::ffi::CString::new(name)
        .map_err(|_| io::Error::other("invalid Objective-C class name"))?;
    let class = objc_getClass(name.as_ptr());
    if class.is_null() {
        Err(io::Error::other("required Objective-C class unavailable"))
    } else {
        Ok(class)
    }
}

#[cfg(target_os = "macos")]
unsafe fn selector(name: &str) -> io::Result<ObjcSel> {
    let name = std::ffi::CString::new(name)
        .map_err(|_| io::Error::other("invalid Objective-C selector"))?;
    let selector = sel_registerName(name.as_ptr());
    if selector.is_null() {
        Err(io::Error::other("failed to register Objective-C selector"))
    } else {
        Ok(selector)
    }
}

#[cfg(target_os = "macos")]
unsafe fn send_id_message(receiver: ObjcId, selector_name: &str) -> io::Result<ObjcId> {
    let selector = selector(selector_name)?;
    let send: extern "C" fn(ObjcId, ObjcSel) -> ObjcId =
        std::mem::transmute(objc_msgSend as *const ());
    let result = send(receiver, selector);
    if result.is_null() {
        Err(io::Error::other(format!(
            "Objective-C message {selector_name} returned null"
        )))
    } else {
        Ok(result)
    }
}

#[cfg(target_os = "macos")]
unsafe fn send_bool_error_message(
    receiver: ObjcId,
    selector_name: &str,
    error: *mut ObjcId,
) -> io::Result<bool> {
    let selector = selector(selector_name)?;
    let send: extern "C" fn(ObjcId, ObjcSel, *mut ObjcId) -> ObjcBool =
        std::mem::transmute(objc_msgSend as *const ());
    Ok(send(receiver, selector, error) != 0)
}

#[cfg(target_os = "macos")]
unsafe fn send_integer_message(receiver: ObjcId, selector_name: &str) -> io::Result<isize> {
    let selector = selector(selector_name)?;
    let send: extern "C" fn(ObjcId, ObjcSel) -> isize =
        std::mem::transmute(objc_msgSend as *const ());
    Ok(send(receiver, selector))
}

#[cfg(target_os = "macos")]
unsafe fn localized_error_message(error: ObjcId) -> Option<String> {
    if error.is_null() {
        return None;
    }
    let selector = selector("localizedDescription").ok()?;
    let send: extern "C" fn(ObjcId, ObjcSel) -> ObjcId =
        std::mem::transmute(objc_msgSend as *const ());
    nsstring_to_string(send(error, selector))
}

#[cfg(target_os = "macos")]
unsafe fn nsstring_to_string(string: ObjcId) -> Option<String> {
    if string.is_null() {
        return None;
    }
    let selector = selector("UTF8String").ok()?;
    let send: extern "C" fn(ObjcId, ObjcSel) -> *const std::ffi::c_char =
        std::mem::transmute(objc_msgSend as *const ());
    let pointer = send(string, selector);
    if pointer.is_null() {
        return None;
    }
    Some(
        std::ffi::CStr::from_ptr(pointer)
            .to_string_lossy()
            .into_owned(),
    )
}

#[cfg(target_os = "macos")]
type ObjcId = *mut std::ffi::c_void;
#[cfg(target_os = "macos")]
type ObjcSel = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type ObjcBool = i8;

#[cfg(target_os = "macos")]
#[link(name = "Foundation", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "ServiceManagement", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_autoreleasePoolPush() -> *mut std::ffi::c_void;
    fn objc_autoreleasePoolPop(pool: *mut std::ffi::c_void);
    fn objc_getClass(name: *const std::ffi::c_char) -> ObjcId;
    fn objc_msgSend();
    fn sel_registerName(name: *const std::ffi::c_char) -> ObjcSel;
}
