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
