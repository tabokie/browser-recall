import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

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
let selectedWindow = args[2] == "frame-browser" && args.count == 4
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
    var position = CGPoint(x: 80, y: 50)
    var size = CGSize(width: 1160, height: 900)
    guard AXUIElementSetAttributeValue(window, "AXPosition" as CFString, AXValueCreate(.cgPoint, &position)!) == .success,
          AXUIElementSetAttributeValue(window, "AXSize" as CFString, AXValueCreate(.cgSize, &size)!) == .success else {
        fail("Cannot position documentation window")
    }
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
case "click":
    guard args.count == 4 else { fail("Expected accessible label") }
    clickPoint(point(control(args[3])))
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
    guard args.count == (args[2] == "capture-browser" ? 5 : 4) else { fail("Expected output path and browser title for browser capture") }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
    let ownedWindows = windows.filter {
        ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
    }
    let candidates = args[2] == "capture-browser"
        ? ownedWindows.filter { ($0[kCGWindowName as String] as? String)?.contains(args[4]) == true }
        : ownedWindows
    guard let info = candidates.max(by: {
        let a = CGRect(dictionaryRepresentation: $0[kCGWindowBounds as String] as! CFDictionary)!
        let b = CGRect(dictionaryRepresentation: $1[kCGWindowBounds as String] as! CFDictionary)!
        return a.width * a.height < b.width * b.height
    }) else { fail("No visible application window") }
    let id = CGWindowID(info[kCGWindowNumber as String] as! UInt32)
    let captured: CGImage?
    if args[2] == "capture-browser" {
        let bounds = CGRect(dictionaryRepresentation: info[kCGWindowBounds as String] as! CFDictionary)!
        // Core Graphics expects raw window IDs, not CFNumber objects. Restrict
        // capture to this process so an overlapping user window cannot leak in.
        var ids: [UnsafeRawPointer?] = ownedWindows.map {
            UnsafeRawPointer(bitPattern: UInt($0[kCGWindowNumber as String] as! UInt32))
        }
        let windowArray = ids.withUnsafeMutableBufferPointer {
            CFArrayCreate(nil, $0.baseAddress, $0.count, nil)!
        }
        captured = CGImage(windowListFromArrayScreenBounds: bounds, windowArray: windowArray, imageOption: [.boundsIgnoreFraming, .bestResolution])
    } else {
        captured = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .bestResolution])
    }
    guard let image = captured,
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        fail("Cannot capture Browser Recall; check Screen Recording permission")
    }
    try png.write(to: URL(fileURLWithPath: args[3]))
default:
    fail("Unknown operation: \(args[2])")
}
