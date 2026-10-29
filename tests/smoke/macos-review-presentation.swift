import AppKit

// A standalone AppKit process with no status item or Browser Recall launch.
// The production ReviewEnvironment uses a recorder instead of StoreKit here.
@MainActor
@main
final class ReviewProbe: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var previousApplication: NSRunningApplication?
  var finished = false

  static func main() {
    let application = NSApplication.shared
    let delegate = ReviewProbe()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    previousApplication = NSWorkspace.shared.frontmostApplication
    window = NSWindow(
      contentRect: NSRect(x: 80, y: 80, width: 400, height: 240),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.title = "Browser Recall review regression probe"
    window.makeKeyAndOrderFront(nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
      self.finish("Native review probe timed out", status: 1)
    }
    DispatchQueue.main.async {
      NSApp.activate(ignoringOtherApps: true)
      self.window.makeKeyAndOrderFront(nil)
      self.waitForFocus(remaining: 100)
    }
  }

  func waitForFocus(remaining: Int) {
    if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow" {
      runChecks(nativeFocus: false)
      return
    }
    guard remaining > 0 else {
      finish("Could not focus the no-tray AppKit probe", status: 1)
      return
    }
    guard NSApp.isActive && window.isKeyWindow else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        self.waitForFocus(remaining: remaining - 1)
      }
      return
    }
    runChecks(nativeFocus: true)
  }

  func runChecks(nativeFocus: Bool) {
    var time: TimeInterval = 100
    var calls = 0
    let content = window.contentView!
    let frame = content.frame
    let windowFrame = window.frame
    // Locked sessions cannot focus an application. Still verify the actual
    // default gate rejects that session, then exercise the remaining native
    // window/monitor/controller behavior with a controlled focus predicate.
    var actualTime: TimeInterval = 0
    let actual = ReviewEnvironment(
      clock: { actualTime }, present: { _ in preconditionFailure("Inactive session presented") })
    actualTime = 3
    if !nativeFocus { precondition(actual.prepare(window: window) == 0) }
    var focused = true
    let environment = ReviewEnvironment(
      clock: { time },
      hasFocus: { candidate in
        focused && (!nativeFocus || (NSApp.isActive && candidate.isKeyWindow))
      },
      present: { controller in
        precondition(Thread.isMainThread, "Presentation must run on the AppKit main thread")
        precondition(controller.view === content, "Tauri content view must be preserved")
        calls += 1
      })
    environment.monitorActivity()
    precondition(
      environment.prepare(window: window) == 0, "Initial activity must prevent presentation")
    time += 3
    let initial = environment.prepare(window: window)
    precondition(initial != 0, "Quiet active window must be eligible")

    let event = NSEvent.mouseEvent(
      with: .mouseMoved, location: .zero, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    NSApp.sendEvent(event)
    precondition(
      environment.activityEpoch != initial,
      "Production native monitor must observe real AppKit events")
    precondition(
      environment.prepare(window: window) == 0, "Native activity must reset the quiet interval")
    time += 10
    precondition(
      !environment.request(window: window, epoch: initial),
      "Activity must invalidate an old request even after another quiet interval")

    let current = environment.prepare(window: window)
    window.orderOut(nil)
    time += 3
    precondition(
      !environment.request(window: window, epoch: environment.activityEpoch),
      "Hidden window cannot present")
    window.makeKeyAndOrderFront(nil)
    focused = false
    if nativeFocus { window.resignKey() }
    time += 3
    precondition(
      !environment.request(window: window, epoch: environment.activityEpoch),
      "Unfocused window cannot present")
    focused = true
    window.makeKey()
    let sheet = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 200, height: 100),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.beginSheet(sheet)
    time += 3
    precondition(
      !environment.request(window: window, epoch: environment.activityEpoch),
      "An attached sheet must prevent presentation")
    window.endSheet(sheet)
    sheet.orderOut(nil)
    window.makeKey()
    precondition(calls == 0, "Rejected requests cannot invoke the presenter")
    time += 3
    // Native focus loss must invalidate a reservation even if a later focus
    // change completes before the frontend cancellation IPC is delivered.
    NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: NSApp)
    time += 3
    precondition(
      !environment.request(window: window, epoch: current),
      "Native focus loss must invalidate earlier activity epochs")
    let ready = environment.prepare(window: window)
    precondition(
      environment.request(window: window, epoch: ready),
      "Eligible native request must reach the presenter")
    precondition(calls == 1, "Successful request must call the presenter once")
    precondition(
      window.contentView === content && content.frame == frame && window.frame == windowFrame,
      "Attaching the StoreKit view controller must preserve content identity and geometry")
    precondition(
      environment.request(window: window, epoch: ready),
      "Existing view controller must remain usable")
    precondition(
      calls == 2 && window.contentView === content,
      "Repeated presentation must preserve the controller")
    environment.stopMonitoring()
    finish(
      "Native review readiness, cancellation, and content preservation passed (focus: \(nativeFocus ? "AppKit" : "controlled; macOS session locked"))",
      status: 0)
  }

  func finish(_ message: String, status: Int32) {
    guard !finished else { return }
    finished = true
    window?.orderOut(nil)
    window?.close()
    previousApplication?.activate(options: [])
    print(message)
    exit(status)
  }
}
