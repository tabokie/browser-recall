use std::io;

pub fn is_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_version_at_least(13)
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub fn sync_login_item(enabled: bool) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        sync_macos_login_item(enabled)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Ok(())
    }
}

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
