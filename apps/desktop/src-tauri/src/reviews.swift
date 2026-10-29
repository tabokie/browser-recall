import AppKit
import StoreKit

// AppKit readiness and StoreKit presentation stay on the main thread. The same
// implementation runs in the no-tray native probe with a recording presenter.
@MainActor
final class ReviewEnvironment: NSObject {
  private let clock: () -> TimeInterval
  private let present: (NSViewController) -> Void
  private let hasFocus: @MainActor (NSWindow) -> Bool
  private var lastActivity: TimeInterval
  private(set) var activityEpoch: UInt64 = 1
  private var monitor: Any?
  private var monitoring = false

  init(
    clock: @escaping () -> TimeInterval,
    hasFocus: @escaping @MainActor (NSWindow) -> Bool = { NSApp.isActive && $0.isKeyWindow },
    present: @escaping (NSViewController) -> Void
  ) {
    self.clock = clock
    self.present = present
    self.hasFocus = hasFocus
    self.lastActivity = clock()
    super.init()
  }

  func monitorActivity() {
    guard !monitoring else { return }
    monitoring = true
    for name in [NSApplication.didResignActiveNotification, NSWindow.didResignKeyNotification] {
      NotificationCenter.default.addObserver(
        self, selector: #selector(focusChanged), name: name, object: nil)
    }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [
      .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
      .mouseMoved, .scrollWheel, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
    ]) { [weak self] event in
      self?.recordActivity()
      return event
    }
  }

  func stopMonitoring() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    monitoring = false
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func focusChanged(_ notification: Notification) { recordActivity() }

  private func recordActivity() {
    lastActivity = clock()
    activityEpoch &+= 1
  }

  func prepare(window: NSWindow) -> UInt64 {
    guard #available(macOS 13.0, *), hasFocus(window), window.isVisible,
      window.attachedSheet == nil, window.contentView != nil,
      clock() - lastActivity >= 3
    else { return 0 }
    return activityEpoch
  }

  func request(window: NSWindow, epoch: UInt64) -> Bool {
    guard epoch != 0, epoch == prepare(window: window) else { return false }
    if window.contentViewController == nil, let view = window.contentView {
      let controller = NSViewController()
      controller.view = view
      window.contentViewController = controller
    }
    guard let controller = window.contentViewController else { return false }
    present(controller)
    return true
  }
}

@MainActor
private let reviewEnvironment = ReviewEnvironment(
  clock: { ProcessInfo.processInfo.systemUptime },
  present: { controller in
    if #available(macOS 13.0, *) { AppStore.requestReview(in: controller) }
  }
)

@MainActor
@_cdecl("browser_recall_monitor_review_activity")
func browserRecallMonitorReviewActivity() { reviewEnvironment.monitorActivity() }

@MainActor
@_cdecl("browser_recall_prepare_review")
func browserRecallPrepareReview(_ pointer: UnsafeRawPointer) -> UInt64 {
  reviewEnvironment.prepare(window: Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue())
}

@MainActor
@_cdecl("browser_recall_request_review")
func browserRecallRequestReview(_ pointer: UnsafeRawPointer, _ epoch: UInt64) -> Bool {
  reviewEnvironment.request(
    window: Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue(), epoch: epoch
  )
}
