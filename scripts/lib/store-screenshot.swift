import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func exportScreenshot(input: String, output: String) throws {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width == 1760, image.height == 1028 else {
        throw NSError(domain: "StoreScreenshot", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Expected a 1760 × 1028 documentation screenshot: \(input)"])
    }
    let width = 1280
    let height = 800
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
        throw NSError(domain: "StoreScreenshot", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot create an opaque sRGB canvas"])
    }
    // Fill the 16:10 canvas uniformly. Only wallpaper at the left and right is
    // cropped; the entire 1600 × 868 browser window stays inside the canvas.
    let scale = CGFloat(height) / CGFloat(image.height)
    let drawnWidth = CGFloat(image.width) * scale
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: (CGFloat(width) - drawnWidth) / 2, y: 0,
                                   width: drawnWidth, height: CGFloat(height)))
    guard let result = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "StoreScreenshot", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot create PNG output: \(output)"])
    }
    CGImageDestinationAddImage(destination, result, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "StoreScreenshot", code: 4,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot save PNG output: \(output)"])
    }
}

do {
    guard CommandLine.arguments.count == 3 else {
        throw NSError(domain: "StoreScreenshot", code: 5,
                      userInfo: [NSLocalizedDescriptionKey: "Usage: store-screenshot INPUT OUTPUT"])
    }
    try exportScreenshot(input: CommandLine.arguments[1], output: CommandLine.arguments[2])
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
