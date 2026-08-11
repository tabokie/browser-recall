use tauri::{WebviewWindow, Window};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::WindowsAndMessaging::{
    LoadImageW, SendMessageW, HICON, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, LR_SHARED,
    SM_CXICON, SM_CXSMICON, WM_SETICON,
};

const APPLICATION_ICON_RESOURCE_ID: usize = 32_512;

pub fn install_webview(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("could not get the main window handle: {error}"))?;
    install_for_handle(hwnd)
}

pub fn install(window: &Window) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("could not get the main window handle: {error}"))?;
    install_for_handle(hwnd)
}

fn install_for_handle(hwnd: HWND) -> Result<(), String> {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        return Err("GetDpiForWindow returned zero".to_string());
    }

    let small_size = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) };
    let big_size = unsafe { GetSystemMetricsForDpi(SM_CXICON, dpi) };
    if small_size <= 0 || big_size <= 0 {
        return Err(format!(
            "Windows returned invalid icon sizes {small_size}px and {big_size}px at {dpi} DPI"
        ));
    }

    let module = unsafe { GetModuleHandleW(None) }
        .map_err(|error| format!("could not get the executable module handle: {error}"))?;
    set_icon(hwnd, HINSTANCE(module.0), ICON_SMALL, small_size)?;
    set_icon(hwnd, HINSTANCE(module.0), ICON_BIG, big_size)?;
    Ok(())
}

fn set_icon(
    hwnd: windows::Win32::Foundation::HWND,
    module: HINSTANCE,
    kind: u32,
    size: i32,
) -> Result<(), String> {
    let resource = PCWSTR::from_raw(APPLICATION_ICON_RESOURCE_ID as *const u16);
    let handle = unsafe {
        LoadImageW(
            Some(module),
            resource,
            IMAGE_ICON,
            size,
            size,
            LR_DEFAULTCOLOR | LR_SHARED,
        )
    }
    .map_err(|error| format!("could not load the {size}px executable icon: {error}"))?;
    let icon = HICON(handle.0);
    unsafe {
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(kind as usize)),
            Some(LPARAM(icon.0 as isize)),
        );
    }
    Ok(())
}
