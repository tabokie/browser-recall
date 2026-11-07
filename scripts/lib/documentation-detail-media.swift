import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

struct Crop: Decodable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Pointer: Decodable { let x: Double; let y: Double }
struct Frame: Decodable {
    let path: String
    let crop: Crop
    let cursor: Pointer?
    let click: Double?
    let keys: String?
    let delay: Double
}
struct Job: Decodable { let output: String; let poster: String; let posterFrame: Int; let frames: [Frame] }
guard CommandLine.arguments.count == 2 else { fail("Expected a detail animation job") }
let job = try JSONDecoder().decode(Job.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
guard job.frames.count >= 2, job.frames.indices.contains(job.posterFrame) else { fail("A detail animation needs multiple frames and a valid poster") }
let width = 720, height = 440
guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: job.output) as CFURL, UTType.gif.identifier as CFString, job.frames.count, nil) else { fail("Cannot create GIF") }
CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
var sources: [String: CGImage] = [:]
for (index, frame) in job.frames.enumerated() {
    guard frame.delay >= 0.04,
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { fail("Invalid animation frame") }
    if sources[frame.path] == nil {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: frame.path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Cannot read native frame: \(frame.path)") }
        sources[frame.path] = image
    }
    let image = sources[frame.path]!
    let crop = frame.crop
    guard crop.x >= 0, crop.y >= 0, crop.width > 0, crop.height > 0,
          crop.x + crop.width <= Double(image.width), crop.y + crop.height <= Double(image.height),
          let clipped = image.cropping(to: CGRect(x: crop.x, y: crop.y, width: crop.width, height: crop.height)) else { fail("Invalid native frame crop: \(frame.path)") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    graphics.imageInterpolation = .high
    NSColor(calibratedRed: 1, green: 0.98, blue: 0.95, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    let scale = min(Double(width) / crop.width, Double(height) / crop.height)
    let size = NSSize(width: Double(clipped.width) * scale, height: Double(clipped.height) * scale)
    let rect = NSRect(x: (Double(width) - size.width) / 2, y: (Double(height) - size.height) / 2, width: size.width, height: size.height)
    NSImage(cgImage: clipped, size: .zero).draw(in: rect, from: .zero, operation: .copy, fraction: 1)
    if let cursor = frame.cursor {
        let point = NSPoint(x: rect.minX + (cursor.x - crop.x) * scale,
                            y: rect.maxY - (cursor.y - crop.y) * scale)
        if let phase = frame.click {
            let radius = 7 + phase * 16
            NSColor(calibratedRed: 0.86, green: 0.36, blue: 0.12, alpha: 1 - phase * 0.7).setStroke()
            let ring = NSBezierPath(ovalIn: NSRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
            ring.lineWidth = 2.5
            ring.stroke()
        }
        // NSCursor.arrow.image is empty on recent macOS releases. Draw a
        // consistent, outlined arrow so the pointer is visible on every frame.
        let arrow = NSBezierPath()
        let vertices: [(Double, Double)] = [(0, 0), (0, 23), (5.5, 17.5), (10.5, 27), (14.5, 25), (9.5, 15.5), (18, 15.5)]
        for (index, vertex) in vertices.enumerated() {
            let target = NSPoint(x: point.x + vertex.0, y: point.y - vertex.1)
            if index == 0 { arrow.move(to: target) } else { arrow.line(to: target) }
        }
        arrow.close()
        arrow.lineJoinStyle = .round
        arrow.lineWidth = 2.5
        NSColor.white.setStroke()
        arrow.stroke()
        NSColor.black.setFill()
        arrow.fill()
    }
    if let keys = frame.keys {
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 18, weight: .medium), .foregroundColor: NSColor.white]
        let text = keys as NSString
        let textSize = text.size(withAttributes: attributes)
        let badge = NSRect(x: 20, y: 18, width: textSize.width + 28, height: 36)
        NSColor(calibratedWhite: 0.12, alpha: 0.9).setFill()
        NSBezierPath(roundedRect: badge, xRadius: 8, yRadius: 8).fill()
        text.draw(at: NSPoint(x: badge.minX + 14, y: badge.minY + 7), withAttributes: attributes)
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let rendered = bitmap.cgImage else { fail("Cannot render frame") }
    if index == job.posterFrame {
        guard let png = bitmap.representation(using: .png, properties: [:]) else { fail("Cannot encode poster") }
        try png.write(to: URL(fileURLWithPath: job.poster))
    }
    CGImageDestinationAddImage(destination, rendered, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: frame.delay, kCGImagePropertyGIFUnclampedDelayTime: frame.delay]] as CFDictionary)
}
guard CGImageDestinationFinalize(destination) else { fail("Cannot finish GIF") }
