import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Ripple: Decodable { let frame: Int; let x: Double; let y: Double; let phase: Double }
struct Zoom: Decodable { let scale: Double; let x: Double; let y: Double; let startFrame: Int; let endFrame: Int }
struct Recipe: Decodable { let clickRipples: [Ripple]?; let zoom: Zoom? }
guard CommandLine.arguments.count == 4,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil) else { fatalError("Expected source, output, and recipe") }
let recipe = try JSONDecoder().decode(Recipe.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])))
let count = CGImageSourceGetCount(source)
guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL, UTType.gif.identifier as CFString, count, nil) else { fatalError("Cannot create click GIF") }
CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
for index in 0..<count {
    guard let image = CGImageSourceCreateImageAtIndex(source, index, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) else { fatalError("Cannot read click frame") }
    var scale = 1.0, anchor = NSPoint.zero
    if let zoom = recipe.zoom {
        let progress = min(1, max(0, Double(index - zoom.startFrame) / Double(zoom.endFrame - zoom.startFrame)))
        scale += (zoom.scale - 1) * progress * progress * (3 - 2 * progress)
        anchor = NSPoint(x: zoom.x, y: Double(image.height) - zoom.y)
    }
    let ripple = recipe.clickRipples?.first(where: { $0.frame == index })
    guard ripple != nil || scale != 1 else {
        CGImageDestinationAddImage(destination, image, properties)
        continue
    }
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: image.width, pixelsHigh: image.height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot draw click ripple") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let offset = NSPoint(x: (1 - scale) * anchor.x, y: (1 - scale) * anchor.y)
    NSImage(cgImage: image, size: .zero).draw(in: NSRect(x: offset.x, y: offset.y, width: Double(image.width) * scale, height: Double(image.height) * scale), from: .zero, operation: .copy, fraction: 1)
    if let ripple = ripple {
        let center = NSPoint(x: offset.x + ripple.x * scale, y: offset.y + (Double(image.height) - ripple.y) * scale)
        // Keep the baked native-demo pointer above the replacement ring.
        let clip = NSBezierPath(rect: NSRect(x: 0, y: 0, width: image.width, height: image.height))
        let pointer = NSBezierPath()
        for (index, vertex) in [(0.0, 0.0), (0, 23), (5.5, 17.5), (10.5, 27), (14.5, 25), (9.5, 15.5), (18, 15.5)].enumerated() {
            let point = NSPoint(x: center.x + vertex.0 * scale, y: center.y - vertex.1 * scale)
            if index == 0 { pointer.move(to: point) } else { pointer.line(to: point) }
        }
        pointer.close()
        clip.append(pointer)
        clip.windingRule = .evenOdd
        clip.addClip()
        let radius = (7 + ripple.phase * 16) * scale
        let ring = NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        let opacity = 1 - ripple.phase * 0.5
        NSColor(calibratedWhite: 0, alpha: opacity * 0.8).setStroke()
        ring.lineWidth = 5 * scale
        ring.stroke()
        NSColor(calibratedWhite: 1, alpha: opacity).setStroke()
        ring.lineWidth = 3 * scale
        ring.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let rendered = bitmap.cgImage else { fatalError("Cannot render click ripple") }
    CGImageDestinationAddImage(destination, rendered, properties)
}
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot finish click GIF") }
