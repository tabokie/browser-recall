import AppKit
import Foundation
import ImageIO

struct Ripple: Decodable { let frame: Int; let x: Double; let y: Double; let phase: Double }
struct Zoom: Decodable { let scale: Double; let x: Double; let y: Double; let startFrame: Int; let endFrame: Int }
struct Recipe: Decodable { let clickRipples: [Ripple]; let zoom: Zoom? }
struct Recipes: Decodable {
    let recording: Recipe
    enum CodingKeys: String, CodingKey { case recording = "recording-pause" }
}
let recipe = try JSONDecoder().decode(Recipes.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))).recording
let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil)!
for ripple in recipe.clickRipples {
    let image = CGImageSourceCreateImageAtIndex(source, ripple.frame, nil)!
    let bitmap = NSBitmapImageRep(cgImage: image)
    var scale = 1.0, centerX = ripple.x, centerY = ripple.y
    if let zoom = recipe.zoom {
        let progress = min(1, max(0, Double(ripple.frame - zoom.startFrame) / Double(zoom.endFrame - zoom.startFrame)))
        scale += (zoom.scale - 1) * progress * progress * (3 - 2 * progress)
        centerX = zoom.x + (ripple.x - zoom.x) * scale
        centerY = zoom.y + (ripple.y - zoom.y) * scale
    }
    let radius = (7 + ripple.phase * 16) * scale
    var light = 0, sampled = 0
    for y in Int(centerY - radius - 1)...Int(centerY + radius + 1) {
        for x in Int(centerX - radius - 1)...Int(centerX + radius + 1) {
            let distance = hypot(Double(x) + 0.5 - centerX, Double(y) + 0.5 - centerY)
            guard abs(distance - radius) < 0.7 else { continue }
            let color = bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            let channels = [color.redComponent, color.greenComponent, color.blueComponent]
            if channels.min()! > 0.45 && channels.max()! - channels.min()! < 0.5 { light += 1 }
            sampled += 1
        }
    }
    guard Double(light) / Double(sampled) > 0.5 else {
        FileHandle.standardError.write(Data("Click ripple lacks contrast on recording-pause frame \(ripple.frame): \(light)/\(sampled) light pixels\n".utf8))
        exit(1)
    }
}
print("Recording-pause click ripples remain visible over the red button")
