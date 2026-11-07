import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

let args = CommandLine.arguments
// This helper creates no menu bar item and can serve as a registration fixture.
if args.count == 2 && args[1] == "--check-no-tray" {
    print("no-tray")
    exit(0)
}
if args.count == 3 && args[1] == "url-handler" {
    guard let url = URL(string: args[2]) else { fail("Invalid URL") }
    print(NSWorkspace.shared.urlForApplication(toOpen: url)?.path ?? "none")
    exit(0)
}
if args.count == 3 && args[1] == "pid" {
    guard let running = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: args[2]).resolvingSymlinksInPath().path
    }) else { fail("Documentation app is not running") }
    print(running.processIdentifier)
    exit(0)
}
if args.count == 3 && args[1] == "open-editor" {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.arguments = ["-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    var opened: NSRunningApplication?
    var launchError: Error?
    var finished = false
    NSWorkspace.shared.open([URL(fileURLWithPath: args[2])], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"), configuration: configuration) { running, error in
        opened = running
        launchError = error
        finished = true
    }
    let deadline = Date().addingTimeInterval(10)
    while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    guard let running = opened else { fail("Cannot open temporary TextEdit document: \(String(describing: launchError))") }
    print(running.processIdentifier)
    exit(0)
}
guard args.count >= 3, let pid = Int32(args[1]) else { fail("Expected PID and operation") }
if args.count == 4 && ["quit", "quit-pid"].contains(args[2]) {
    let expected = URL(fileURLWithPath: args[3]).resolvingSymlinksInPath().path
    let matches = NSWorkspace.shared.runningApplications.filter {
        $0.bundleURL?.resolvingSymlinksInPath().path == expected && (args[2] == "quit" || $0.processIdentifier == pid)
    }
    for running in matches {
        running.terminate()
        let gracefulDeadline = Date().addingTimeInterval(2)
        while !running.isTerminated && Date() < gracefulDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        if !running.isTerminated { running.forceTerminate() }
        let forceDeadline = Date().addingTimeInterval(2)
        while !running.isTerminated && Date() < forceDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        guard running.isTerminated else { fail("Documentation app did not terminate") }
    }
    exit(0)
}
let app = AXUIElementCreateApplication(pid)
AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func descendants(_ element: AXUIElement) -> [AXUIElement] {
    let children = (attribute(element, "AXChildren") as? [AXUIElement]) ?? []
    let sheets = (attribute(element, "AXSheets") as? [AXUIElement]) ?? []
    return [element] + (children + sheets).flatMap { descendants($0) }
}

func label(_ element: AXUIElement) -> String {
    ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXIdentifier", "AXDOMIdentifier", "AXPlaceholderValue"]
        .compactMap { attribute(element, $0) as? String }.joined(separator: " | ")
}

let appWindows = (attribute(app, "AXWindows") as? [AXUIElement]) ?? []
let selectedWindow = ["frame-browser", "tap-browser"].contains(args[2]) && args.count == 6
    ? appWindows.first(where: { label($0).contains(args[3]) })
    : appWindows.first
guard let window = selectedWindow else {
    fail("Browser Recall window unavailable; check Accessibility permission")
}

func clickPoint(_ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func point(_ element: AXUIElement) -> CGPoint {
    guard let rawPosition = attribute(element, "AXPosition"), let rawSize = attribute(element, "AXSize") else {
        fail("Control has no accessible frame")
    }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else { fail("Invalid accessible frame") }
    return CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
}

func control(_ name: String, inside container: AXUIElement? = nil) -> AXUIElement {
    let candidates = descendants(container ?? window).filter { element in
        ["AXTitle", "AXDescription", "AXValue", "AXIdentifier", "AXDOMIdentifier", "AXPlaceholderValue"].contains {
            attribute(element, $0) as? String == name
        }
    }
    guard let element = candidates.first(where: {
        (attribute($0, "AXRole") as? String) != "AXStaticText"
    }) ?? candidates.first else { fail("Missing control: \(name)") }
    return element
}

switch args[2] {
case "tap-browser":
    guard args.count == 6, let x = Double(args[4]), let y = Double(args[5]),
          let raw = attribute(window, "AXPosition") else { fail("Expected browser title and click coordinates") }
    var origin = CGPoint.zero
    guard AXValueGetValue(raw as! AXValue, .cgPoint, &origin) else { fail("No browser window position") }
    clickPoint(CGPoint(x: origin.x + x, y: origin.y + y))
case "enabled":
    guard args.count == 4 else { fail("Expected accessible label") }
    print(attribute(control(args[3]), "AXEnabled") as? Bool == true ? "true" : "false")
case "bounds":
    guard args.count == 4 else { fail("Expected accessible label") }
    let target = control(args[3])
    var origin = CGPoint.zero
    var size = CGSize.zero
    var windowOrigin = CGPoint.zero
    guard let rawPosition = attribute(target, "AXPosition"), let rawSize = attribute(target, "AXSize"),
          let rawWindowPosition = attribute(window, "AXPosition"),
          AXValueGetValue(rawPosition as! AXValue, .cgPoint, &origin),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size),
          AXValueGetValue(rawWindowPosition as! AXValue, .cgPoint, &windowOrigin) else { fail("Control has no accessible bounds") }
    let data = try JSONSerialization.data(withJSONObject: ["x": origin.x - windowOrigin.x, "y": origin.y - windowOrigin.y, "width": size.width, "height": size.height])
    print(String(data: data, encoding: .utf8)!)
case "reveal":
    guard args.count == 4 else { fail("Expected accessible label") }
    let target = control(args[3])
    let scrolled = AXUIElementPerformAction(target, "AXScrollToVisible" as CFString)
    let focused = AXUIElementSetAttributeValue(target, "AXFocused" as CFString, kCFBooleanTrue)
    guard scrolled == .success || focused == .success else { fail("Cannot reveal \(args[3])") }
case "tap":
    guard args.count >= 4 && args.count <= 6 else { fail("Expected label, optional container and modifier") }
    if !label(window).contains("open-panel") {
        guard let running = NSRunningApplication(processIdentifier: pid) else { fail("Click target is unavailable") }
        running.activate(options: [.activateIgnoringOtherApps])
        let deadline = Date().addingTimeInterval(2)
        while !running.isActive && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        guard running.isActive else { fail("Cannot focus click target") }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    let container = args.count >= 5 && args[4] != "window" ? control(args[4]) : window
    let center = point(control(args[3], inside: container))
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: center, mouseButton: .left)
        event?.setIntegerValueField(.mouseEventClickState, value: 1)
        if args.count == 6 && args[5] == "command" { event?.flags = .maskCommand }
        event?.post(tap: .cghidEventTap)
        if type == .leftMouseDown { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    }
case "toggle-checkbox", "checkbox-point":
    guard args.count == 4 else { fail("Expected checkbox row label") }
    let controls = descendants(control("settingsModal"))
    guard let folderLabel = controls.first(where: {
        attribute($0, "AXRole") as? String == "AXStaticText" && attribute($0, "AXValue") as? String == args[3]
    }) else { fail("Missing bookmark folder: \(args[3])") }
    let labelPoint = point(folderLabel)
    let candidates = controls.filter { element in
        guard attribute(element, "AXRole") as? String == "AXCheckBox" else { return false }
        let checkboxPoint = point(element)
        return abs(checkboxPoint.y - labelPoint.y) < 3 && checkboxPoint.x < labelPoint.x
    }
    guard let checkbox = candidates.min(by: { abs(point($0).x - labelPoint.x) < abs(point($1).x - labelPoint.x) }) else { fail("Cannot find checkbox for \(args[3])") }
    if args[2] == "toggle-checkbox" { clickPoint(point(checkbox)) }
    else {
        var origin = CGPoint.zero
        guard let raw = attribute(window, "AXPosition"), AXValueGetValue(raw as! AXValue, .cgPoint, &origin) else { fail("No window position") }
        let center = point(checkbox)
        let data = try JSONSerialization.data(withJSONObject: ["x": center.x - origin.x, "y": center.y - origin.y])
        print(String(data: data, encoding: .utf8)!)
    }
case "set-value":
    guard args.count == 5 else { fail("Expected field and value") }
    let field = control(args[3])
    guard AXUIElementSetAttributeValue(field, "AXFocused" as CFString, kCFBooleanTrue) == .success,
          AXUIElementSetAttributeValue(field, "AXValue" as CFString, args[4] as CFString) == .success else { fail("Cannot enter value in \(args[3])") }
case "key":
    guard args.count == 4 else { fail("Expected key") }
    guard let running = NSRunningApplication(processIdentifier: pid) else { fail("Documentation app is unavailable") }
    running.activate(options: [.activateIgnoringOtherApps])
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    let activationDeadline = Date().addingTimeInterval(2)
    while !running.isActive && Date() < activationDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    guard running.isActive else { fail("Cannot focus documentation app for keyboard input") }
    let keys: [String: (CGKeyCode, CGEventFlags)] = [
        "enter": (36, []), "escape": (53, []), "copy": (8, .maskCommand),
        "paste": (9, .maskCommand), "select-all": (0, .maskCommand), "save": (1, .maskCommand),
        "go-to-folder": (5, [.maskCommand, .maskShift])
    ]
    guard let (code, flags) = keys[args[3]] else { fail("Unknown key") }
    let source = CGEventSource(stateID: .hidSystemState)
    let modifiers: [(CGKeyCode, CGEventFlags)] = [(55, .maskCommand), (56, .maskShift)].filter { flags.contains($0.1) }
    var pressedFlags: CGEventFlags = []
    for (modifier, flag) in modifiers {
        pressedFlags.insert(flag)
        let event = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: true)
        event?.flags = pressedFlags
        event?.post(tap: .cghidEventTap)
    }
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        event?.flags = flags
        if let character = ["enter": "\r", "copy": "c", "paste": "v", "select-all": "a", "save": "s"][args[3]] {
            let text = Array(character.utf16)
            event?.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
        }
        event?.post(tap: .cghidEventTap)
        // Hold a real down/up gesture, rather than posting both simultaneously.
        if down { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    }
    for (modifier, flag) in modifiers.reversed() {
        pressedFlags.remove(flag)
        let event = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: false)
        event?.flags = pressedFlags
        event?.post(tap: .cghidEventTap)
    }
case "clipboard":
    print(NSPasteboard.general.string(forType: .string) ?? "")
case "editor-text":
    guard let editor = descendants(window).first(where: { attribute($0, "AXRole") as? String == "AXTextArea" }),
          let text = attribute(editor, "AXValue") as? String else { fail("No native text editor") }
    print(text)
case "editor-command":
    guard args.count == 4,
          let character = ["paste": "V", "copy": "C", "select-all": "A", "save": "S"][args[3]],
          let menu = attribute(app, "AXMenuBar") else { fail("Expected a native editor command") }
    // Menu validation follows the actual mouse focus change asynchronously.
    // Wait for readiness before issuing the command once.
    let deadline = Date().addingTimeInterval(3)
    var readyItem: AXUIElement?
    repeat {
        readyItem = descendants(menu as! AXUIElement).first(where: {
            (attribute($0, "AXMenuItemCmdChar") as? String)?.uppercased() == character &&
            attribute($0, "AXMenuItemCmdModifiers") as? Int == 0 &&
            attribute($0, "AXEnabled") as? Bool == true
        })
        if readyItem != nil { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    } while Date() < deadline
    guard let item = readyItem, AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { fail("Cannot invoke native editor command: \(args[3])") }
case "reuse-url":
    guard args.count == 5, let url = URL(string: args[3]),
          let running = NSRunningApplication(processIdentifier: pid),
          let closeButton = attribute(window, kAXCloseButtonAttribute) else {
        fail("Expected app URL and application path")
    }
    guard AXUIElementPerformAction(closeButton as! AXUIElement, kAXPressAction as CFString) == .success else {
        fail("Cannot close Browser Recall window")
    }
    let hideDeadline = Date().addingTimeInterval(5)
    while !(attribute(app, "AXWindows") as? [AXUIElement] ?? []).isEmpty && Date() < hideDeadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard (attribute(app, "AXWindows") as? [AXUIElement] ?? []).isEmpty else {
        fail("Browser Recall window did not hide")
    }
    var delivered = false
    var openedPid: pid_t?
    var deliveryError: String?
    NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: args[4]), configuration: NSWorkspace.OpenConfiguration()) { opened, error in
        openedPid = opened?.processIdentifier
        deliveryError = error?.localizedDescription
        delivered = true
    }
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
        if delivered && running.isActive && !(attribute(app, "AXWindows") as? [AXUIElement] ?? []).isEmpty { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard deliveryError == nil, openedPid == pid, running.isActive,
          !(attribute(app, "AXWindows") as? [AXUIElement] ?? []).isEmpty else {
        fail("App URL did not reopen the existing process: \(deliveryError ?? String(describing: openedPid))")
    }
    let expectedPath = URL(fileURLWithPath: args[4]).resolvingSymlinksInPath().path
    let matches = NSWorkspace.shared.runningApplications.filter {
        $0.bundleURL?.resolvingSymlinksInPath().path == expectedPath
    }
    guard matches.count == 1 && matches[0].processIdentifier == pid else {
        fail("App URL launched another process")
    }
    print("App URL reopened the existing process \(pid)")
case "dump":
    print(appWindows.flatMap { descendants($0) }.map { element in
        "\(label(element)) | \(String(describing: attribute(element, "AXPosition"))) | \(String(describing: attribute(element, "AXSize")))"
    }.joined(separator: "\n"))
case "frame", "frame-browser":
    let dimensionIndex = args[2] == "frame-browser" ? 4 : 3
    guard args.count == dimensionIndex + 2,
          let width = Double(args[dimensionIndex]), let height = Double(args[dimensionIndex + 1]),
          width > 0, height > 0 else { fail("Expected positive window width and height") }
    var position = CGPoint(x: 80, y: 80)
    var size = CGSize(width: width, height: height)
    guard AXUIElementSetAttributeValue(window, "AXPosition" as CFString, AXValueCreate(.cgPoint, &position)!) == .success,
          AXUIElementSetAttributeValue(window, "AXSize" as CFString, AXValueCreate(.cgSize, &size)!) == .success else {
        fail("Cannot position documentation window")
    }
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
case "click":
    guard args.count == 4 else { fail("Expected accessible label") }
    guard let targetApplication = NSRunningApplication(processIdentifier: pid) else {
        fail("Browser Recall application unavailable")
    }
    targetApplication.activate(options: [.activateIgnoringOtherApps])
    let activationDeadline = Date().addingTimeInterval(2)
    while !targetApplication.isActive && Date() < activationDeadline {
        Thread.sleep(forTimeInterval: 0.02)
    }
    guard targetApplication.isActive else { fail("Cannot activate Browser Recall") }
    guard AXUIElementPerformAction(control(args[3]), kAXPressAction as CFString) == .success else {
        fail("Cannot press accessible control: \(args[3])")
    }
case "search":
    guard args.count == 4 else { fail("Expected search text") }
    let field = control("searchDraftInput")
    guard AXUIElementSetAttributeValue(field, "AXFocused" as CFString, kCFBooleanTrue) == .success else {
        fail("Cannot focus search")
    }
    guard AXUIElementSetAttributeValue(field, "AXValue" as CFString, args[3] as CFString) == .success else {
        fail("Cannot enter search text through Accessibility")
    }
case "scroll-start":
    guard args.count == 4 else { fail("Expected horizontal scrolling control") }
    let target = control(args[3])
    guard let targetApplication = NSRunningApplication(processIdentifier: pid) else {
        fail("Browser Recall application unavailable")
    }
    targetApplication.activate(options: [.activateIgnoringOtherApps])
    let activationDeadline = Date().addingTimeInterval(2)
    while !targetApplication.isActive && Date() < activationDeadline {
        Thread.sleep(forTimeInterval: 0.02)
    }
    guard targetApplication.isActive else { fail("Cannot activate Browser Recall") }
    let center = point(target)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
            mouseCursorPosition: center, mouseButton: .left)?.post(tap: .cghidEventTap)
    // Let WindowServer route the pointer into the chart before sending a wheel
    // event; the previous capture parks the pointer outside the window.
    Thread.sleep(forTimeInterval: 0.1)
    // Scroll the real viewport, including when years of empty days follow the
    // fixed fixture. The caller verifies the fixture label inside the viewport.
    guard let scroll = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                               wheelCount: 2, wheel1: 0, wheel2: 4096, wheel3: 0) else {
        fail("Cannot create horizontal scroll event")
    }
    scroll.location = center
    scroll.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.1)
case "unfocus", "park":
    guard let rawPosition = attribute(window, "AXPosition") else { fail("No window position") }
    var position = CGPoint.zero
    AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position)
    // The content gutter takes keyboard focus out of search; the titlebar does not.
    if args[2] == "unfocus" { clickPoint(CGPoint(x: position.x + 282, y: position.y + 180)) }
    // Park the pointer outside the captured window to avoid hover-only controls.
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
            mouseCursorPosition: CGPoint(x: position.x - 10, y: position.y - 10), mouseButton: .left)?.post(tap: .cghidEventTap)
case "visible-text":
    guard args.count == 4 || args.count == 5 else { fail("Expected text and optional containing control") }
    let container = args.count == 5 ? control(args[4]) : window
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard let rawPosition = attribute(container, "AXPosition"), let rawSize = attribute(container, "AXSize"),
          AXValueGetValue(rawPosition as! AXValue, .cgPoint, &origin),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else { fail("No window frame") }
    let frame = CGRect(origin: origin, size: size)
    let visible = descendants(container).filter { label($0).contains(args[3]) }.contains { element in
        guard let rawPosition = attribute(element, "AXPosition"), let rawSize = attribute(element, "AXSize") else { return false }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &origin),
              AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else { return false }
        return size.width > 0 && size.height > 0 && frame.contains(CGRect(origin: origin, size: size))
    }
    print(visible ? "true" : "false")
case "capture", "capture-browser":
    // ScreenCaptureKit needs a WindowServer-backed application connection even
    // though this helper does not present its own user interface. Initialize
    // AppKit only for captures so Accessibility-derived physical clicks retain
    // the established command-line helper behavior.
    let helperApplication = NSApplication.shared
    helperApplication.setActivationPolicy(.prohibited)
    let browserCapture = args[2] == "capture-browser"
    let pixelIndex = browserCapture ? 5 : 4
    guard args.count == pixelIndex + 4,
          let pixelWidth = Int(args[pixelIndex]), let pixelHeight = Int(args[pixelIndex + 1]),
          let padding = Double(args[pixelIndex + 2]),
          pixelWidth > 0, pixelHeight > 0, padding >= 0 else {
        fail("Expected output path, optional browser title, positive pixel dimensions, nonnegative padding, and wallpaper PNG path")
    }
    guard let wallpaperSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[pixelIndex + 3]) as CFURL, nil),
          let wallpaper = CGImageSourceCreateImageAtIndex(wallpaperSource, 0, nil) else {
        fail("Cannot read the fixed documentation wallpaper")
    }
    let contentSemaphore = DispatchSemaphore(value: 0)
    var shareableContent: SCShareableContent?
    var shareableContentError: Error?
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
        shareableContent = content
        shareableContentError = error
        contentSemaphore.signal()
    }
    guard contentSemaphore.wait(timeout: .now() + 10) == .success else {
        fail("Timed out while enumerating capturable windows")
    }
    if let error = shareableContentError {
        fail("Cannot enumerate capturable windows: \(error.localizedDescription)")
    }
    guard let content = shareableContent else { fail("No capturable windows available") }
    let ownedWindows = content.windows.filter {
        $0.owningApplication?.processID == pid && $0.windowLayer == 0
    }
    let candidates = browserCapture
        ? ownedWindows.filter { $0.title?.contains(args[4]) == true }
        : ownedWindows
    guard let selected = candidates.max(by: {
        $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
    }) else { fail("No visible application window") }

    let configuration = SCStreamConfiguration()
    // A fixed PNG size and .best capture resolution cannot force a 2× backing
    // store on a 1× display. ScreenCaptureKit scales the available window
    // pixels, and its default output color space follows the host display.
    configuration.width = pixelWidth
    configuration.height = pixelHeight
    configuration.scalesToFit = true
    configuration.preservesAspectRatio = false
    configuration.showsCursor = false
    configuration.captureResolution = .best
    configuration.shouldBeOpaque = false
    let captureFrame = selected.frame.insetBy(dx: -padding, dy: -padding)
    guard let display = content.displays.first(where: {
        $0.frame.contains(captureFrame)
    }) else { fail("Documentation window and wallpaper padding must fit on one display") }
    let capturedWindows = browserCapture
        ? ownedWindows.filter {
            $0.windowID == selected.windowID || selected.frame.contains($0.frame)
        }
        : [selected]
    // Capture only the selected window and its toolbar popup on transparency.
    // The fixed Sonoma asset supplies the background independently of the desktop.
    let filter = SCContentFilter(display: display, including: capturedWindows)
    configuration.sourceRect = CGRect(
        x: captureFrame.minX - display.frame.minX,
        y: captureFrame.minY - display.frame.minY,
        width: captureFrame.width,
        height: captureFrame.height
    )
    configuration.ignoreShadowsDisplay = false

    let captureSemaphore = DispatchSemaphore(value: 0)
    var capturedImage: CGImage?
    var captureError: Error?
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
        capturedImage = image
        captureError = error
        captureSemaphore.signal()
    }
    guard captureSemaphore.wait(timeout: .now() + 10) == .success else {
        fail("Timed out while capturing documentation pixels")
    }
    if let error = captureError {
        fail("Cannot capture Browser Recall: \(error.localizedDescription)")
    }
    guard let image = capturedImage,
          image.width == pixelWidth,
          image.height == pixelHeight else {
        fail("ScreenCaptureKit did not produce the requested documentation pixels")
    }
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: pixelWidth, height: pixelHeight,
                                  bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fail("Cannot create the documentation image")
    }
    // Center-cover the fixed wallpaper, then draw native pixels at their captured
    // dimensions. Only the wallpaper is resized; window pixels are not resampled.
    let canvas = CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight)
    let scale = max(canvas.width / CGFloat(wallpaper.width), canvas.height / CGFloat(wallpaper.height))
    let wallpaperRect = CGRect(x: (canvas.width - CGFloat(wallpaper.width) * scale) / 2,
                               y: (canvas.height - CGFloat(wallpaper.height) * scale) / 2,
                               width: CGFloat(wallpaper.width) * scale, height: CGFloat(wallpaper.height) * scale)
    context.interpolationQuality = .high
    context.draw(wallpaper, in: wallpaperRect)
    context.interpolationQuality = .none
    context.draw(image, in: canvas)
    guard let composed = context.makeImage(),
          let png = NSBitmapImageRep(cgImage: composed).representation(using: .png, properties: [:]) else {
        fail("Cannot encode the documentation image")
    }
    try png.write(to: URL(fileURLWithPath: args[3]))
default:
    fail("Unknown operation: \(args[2])")
}
