import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

struct Camera: Decodable {
    let x: Double; let y: Double; let width: Double; let height: Double
    var rect: NSRect { NSRect(x: x, y: y, width: width, height: height) }
}
struct Pose: Decodable { let frame: Int; let crop: Camera }
struct State: Decodable { let frame: Int; let overview: Int; let context: [Int]? }
struct Scene: Decodable {
    let width: Double; let height: Double
    let poses: [Pose]; let states: [State]
}
struct Recipe: Decodable {
    let marginPixels: Double; let windowRadiusPixels: Double; let scene: Scene
}

guard CommandLine.arguments.count == 5,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let wallpaper = NSImage(contentsOfFile: CommandLine.arguments[3]) else { fail("Expected source, output, wallpaper, and recipe") }
let recipe = try JSONDecoder().decode(Recipe.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[4])))
let scene = recipe.scene
let count = CGImageSourceGetCount(source)
let width = 720.0, height = 440.0
let aspect = width / height
var images: [Int: CGImage] = [:]
func image(_ index: Int) -> CGImage {
    if let cached = images[index] { return cached }
    guard index >= 0, index < count,
          let decoded = CGImageSourceCreateImageAtIndex(source, index, nil), decoded.width == Int(width), decoded.height == Int(height) else { fail("Invalid saved GIF frame") }
    images[index] = decoded
    return decoded
}
func mix(_ from: NSRect, _ to: NSRect, _ progress: Double) -> NSRect {
    NSRect(x: from.minX + (to.minX - from.minX) * progress,
           y: from.minY + (to.minY - from.minY) * progress,
           width: from.width + (to.width - from.width) * progress,
           height: from.height + (to.height - from.height) * progress)
}
func view(_ crop: NSRect) -> NSRect {
    let overview = crop == NSRect(x: 0, y: 0, width: scene.width, height: scene.height)
    let margin = overview ? recipe.marginPixels : 0
    let scale = min((width - margin * 2) / crop.width, (height - margin * 2) / crop.height)
    return NSRect(x: crop.midX - width / scale / 2, y: crop.midY - height / scale / 2, width: width / scale, height: height / scale)
}
func cameras(_ index: Int) -> (NSRect, NSRect) {
    guard let to = scene.poses.first(where: { $0.frame >= index }) else { fail("Missing saved camera pose") }
    if to.frame == 0 { return (to.crop.rect, view(to.crop.rect)) }
    let from = scene.poses.last(where: { $0.frame < to.frame })!
    let progress = Double(index - from.frame) / Double(to.frame - from.frame)
    let eased = progress * progress * (3 - 2 * progress)
    return (mix(from.crop.rect, to.crop.rect, eased), mix(view(from.crop.rect), view(to.crop.rect), eased))
}
func content(_ crop: NSRect) -> NSRect {
    let scale = min(width / crop.width, height / crop.height)
    return NSRect(x: (width - crop.width * scale) / 2, y: (height - crop.height * scale) / 2, width: crop.width * scale, height: crop.height * scale)
}
let window = NSRect(x: 0, y: 0, width: scene.width, height: scene.height)
let initialView = view(window)
let wallpaperScale = max(initialView.width / wallpaper.size.width, initialView.height / wallpaper.size.height)
let wallpaperRect = NSRect(x: initialView.midX - wallpaper.size.width * wallpaperScale / 2, y: initialView.midY - wallpaper.size.height * wallpaperScale / 2, width: wallpaper.size.width * wallpaperScale, height: wallpaper.size.height * wallpaperScale)
guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL, UTType.gif.identifier as CFString, count, nil) else { fail("Cannot create framed GIF") }
CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)

for index in 0..<count {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width), pixelsHigh: Int(height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap),
          let state = scene.states.last(where: { $0.frame <= index }) else { fail("Invalid saved scene") }
    let (crop, camera) = cameras(index)
    let scale = width / camera.width
    func project(_ rect: NSRect) -> NSRect {
        NSRect(x: (rect.minX - camera.minX) * scale,
               y: height - (rect.maxY - camera.minY) * scale,
               width: rect.width * scale, height: rect.height * scale)
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    graphics.imageInterpolation = .high
    // Wallpaper and window share one world-space camera. Only the actual
    // window has rounded corners; a close-up has no inset viewport border.
    wallpaper.draw(in: project(wallpaperRect), from: .zero, operation: .copy, fraction: 1)
    NSBezierPath(roundedRect: project(window), xRadius: recipe.windowRadiusPixels * scale, yRadius: recipe.windowRadiusPixels * scale).addClip()
    // Saved overview pixels supply the surroundings omitted by a tight source
    // crop. The current native frame supplies the action at its captured pose.
    NSImage(cgImage: image(state.overview), size: .zero).draw(in: project(window), from: content(window), operation: .sourceOver, fraction: 1)
    for context in state.context ?? [] {
        let contextCrop = cameras(context).0
        NSImage(cgImage: image(context), size: .zero).draw(in: project(contextCrop), from: content(contextCrop), operation: .sourceOver, fraction: 1)
    }
    NSImage(cgImage: image(index), size: .zero).draw(in: project(crop), from: content(crop), operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let rendered = bitmap.cgImage,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) else { fail("Cannot render framed GIF") }
    CGImageDestinationAddImage(destination, rendered, properties)
}
guard CGImageDestinationFinalize(destination) else { fail("Cannot finish framed GIF") }
