#[cfg(target_os = "macos")]
#[path = "../src/macos_window_frame.rs"]
mod macos_window_frame;

#[cfg(target_os = "macos")]
fn main() {
    use objc2::{rc::autoreleasepool, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    autoreleasepool(|_| {
        let main_thread = MainThreadMarker::new().expect("native test must run on the main thread");
        let _application = NSApplication::sharedApplication(main_thread);
        let original = NSRect::new(NSPoint::new(170.0, 160.0), NSSize::new(980.0, 680.0));
        // AppKit initialization runs on the main thread. Disable release on
        // close because the retained Rust handle owns the test window.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(main_thread),
                original,
                NSWindowStyleMask::Titled | NSWindowStyleMask::FullSizeContentView,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setFrame_display(original, false);

        // Tauri reads the WKWebView's frame for inner_size(). A view inset or
        // an unfinished layout must not redefine the retained outer frame.
        let view = NSView::initWithFrame(NSView::alloc(main_thread), original);
        window.setContentView(Some(&view));
        view.setFrame(NSRect::new(NSPoint::ZERO, NSSize::new(980.0, 678.0)));
        assert_ne!(
            view.frame().size,
            window.frame().size,
            "the content view must be inset"
        );
        let retained = macos_window_frame::capture(&window);
        assert!(
            !window.isVisible(),
            "the regression must change a hidden window"
        );

        for cycle in 1..=5 {
            let changed = NSRect::new(NSPoint::new(250.0, 200.0), NSSize::new(1020.0, 720.0));
            window.setFrame_display(changed, false);
            assert_ne!(
                window.frame(),
                original,
                "cycle {cycle} must force restoration"
            );
            macos_window_frame::restore(&window, retained);
            assert_eq!(
                window.frame(),
                original,
                "cycle {cycle} must preserve the exact outer frame"
            );
        }
        println!(
            "five native frame restorations preserved position and size with an inset content view"
        );
    });
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("macOS native window frame check skipped");
}
