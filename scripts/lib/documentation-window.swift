import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

let args = CommandLine.arguments
if args.count == 3 && args[1] == "pid" {
    guard let running = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: args[2]).resolvingSymlinksInPath().path
    }) else { fail("Documentation app is not running") }
    print(running.processIdentifier)
    exit(0)
}
guard args.count >= 3, let pid = Int32(args[1]) else { fail("Expected PID and operation") }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func descendants(_ element: AXUIElement) -> [AXUIElement] {
    [element] + ((attribute(element, "AXChildren") as? [AXUIElement]) ?? []).flatMap { descendants($0) }
}

func label(_ element: AXUIElement) -> String {
    ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXIdentifier", "AXDOMIdentifier"]
        .compactMap { attribute(element, $0) as? String }.joined(separator: " | ")
}

let appWindows = (attribute(app, "AXWindows") as? [AXUIElement]) ?? []
let selectedWindow = args[2] == "frame-browser" && args.count == 6
    ? appWindows.first(where: { label($0).contains(args[3]) })
    : appWindows.first
guard let window = selectedWindow else {
    fail("Browser Recall window unavailable; check Accessibility permission")
}

func clickPoint(_ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
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

func control(_ name: String) -> AXUIElement {
    let candidates = descendants(window).filter { element in
        ["AXTitle", "AXDescription", "AXValue", "AXIdentifier", "AXDOMIdentifier"].contains {
            attribute(element, $0) as? String == name
        }
    }
    guard let element = candidates.first(where: {
        (attribute($0, "AXRole") as? String) != "AXStaticText"
    }) ?? candidates.first else { fail("Missing control: \(name)") }
    return element
}

switch args[2] {
case "dump":
    print(descendants(window).map(label).joined(separator: "\n"))
case "frame", "frame-browser":
    let dimensionIndex = args[2] == "frame-browser" ? 4 : 3
    guard args.count == dimensionIndex + 2,
          let width = Double(args[dimensionIndex]), let height = Double(args[dimensionIndex + 1]),
          width > 0, height > 0 else { fail("Expected positive window width and height") }
    var position = CGPoint(x: 80, y: 50)
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
case "unfocus":
    guard let rawPosition = attribute(window, "AXPosition") else { fail("No window position") }
    var position = CGPoint.zero
    AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position)
    // The content gutter takes keyboard focus out of search; the titlebar does not.
    clickPoint(CGPoint(x: position.x + 282, y: position.y + 180))
    // Park the pointer outside the captured window to avoid hover-only controls.
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
            mouseCursorPosition: CGPoint(x: position.x - 10, y: position.y - 10), mouseButton: .left)?.post(tap: .cghidEventTap)
case "visible-text":
    guard args.count == 4 else { fail("Expected text to verify in the window") }
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard let rawPosition = attribute(window, "AXPosition"), let rawSize = attribute(window, "AXSize"),
          AXValueGetValue(rawPosition as! AXValue, .cgPoint, &origin),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else { fail("No window frame") }
    let frame = CGRect(origin: origin, size: size)
    let visible = descendants(window).filter { label($0).contains(args[3]) }.contains { element in
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
    guard args.count == pixelIndex + 2,
          let pixelWidth = Int(args[pixelIndex]), let pixelHeight = Int(args[pixelIndex + 1]),
          pixelWidth > 0, pixelHeight > 0 else {
        fail("Expected output path, optional browser title, and positive output pixel dimensions")
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
    configuration.width = pixelWidth
    configuration.height = pixelHeight
    configuration.scalesToFit = true
    configuration.preservesAspectRatio = false
    configuration.showsCursor = false
    configuration.captureResolution = .best
    let filter: SCContentFilter
    if browserCapture {
        guard let display = content.displays.first(where: {
            $0.frame.intersects(selected.frame)
        }) else { fail("Browser window is not on a capturable display") }
        let visibleOwnedWindows = ownedWindows.filter {
            $0.frame.intersects(selected.frame)
        }
        filter = SCContentFilter(display: display, including: visibleOwnedWindows)
        configuration.sourceRect = CGRect(
            x: selected.frame.minX - display.frame.minX,
            y: selected.frame.minY - display.frame.minY,
            width: selected.frame.width,
            height: selected.frame.height
        )
        configuration.ignoreShadowsDisplay = true
    } else {
        filter = SCContentFilter(desktopIndependentWindow: selected)
        configuration.ignoreShadowsSingleWindow = true
    }

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
          image.height == pixelHeight,
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        fail("ScreenCaptureKit did not produce the requested documentation pixels")
    }
    try png.write(to: URL(fileURLWithPath: args[3]))
default:
    fail("Unknown operation: \(args[2])")
}
