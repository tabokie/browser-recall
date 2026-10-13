use objc2_app_kit::NSWindow;
use objc2_foundation::NSRect;

#[derive(Clone, Copy)]
pub(crate) struct RetainedFrame(NSRect);

pub(crate) fn capture(window: &NSWindow) -> RetainedFrame {
    RetainedFrame(window.frame())
}

pub(crate) fn restore(window: &NSWindow, frame: RetainedFrame) {
    // Tauri's macOS inner_size() reads the WKWebView frame, which can be
    // inset from the NSWindow content rectangle. Passing that size back to
    // setContentSize loses the inset on each restoration. Retain native
    // coordinates and restore the outer frame in one main-thread operation.
    if window.frame() != frame.0 {
        window.setFrame_display(frame.0, true);
    }
}
