import AppKit
import CoreImage
import CoreMedia
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// Capture only the disposable browser. The test page uses a solid background
// under the toolbar so changes in this crop show the popup as macOS painted it.
final class PopupFrames: NSObject, SCStreamOutput {
    let directory: URL
    let context = CIContext()
    let firstChange = AsyncStream.makeStream(of: Void.self)
    var reference: [UInt8]?
    var previous: [Int] = []
    var index = 0
    var lastBuffer: CVPixelBuffer?

    init(directory: URL) { self.directory = directory }

    func save(_ buffer: CVPixelBuffer, as name: String) {
        let frame = CIImage(cvPixelBuffer: buffer)
        if let image = context.createCGImage(frame, from: frame.extent),
           let destination = CGImageDestinationCreateWithURL(
               directory.appendingPathComponent(name) as CFURL,
               UTType.png.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(destination, image, nil)
            CGImageDestinationFinalize(destination)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        let status = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]])?.first?[.status] as? Int
        guard type == .screen, status == SCFrameStatus.complete.rawValue, let buffer = sample.imageBuffer else { return }
        lastBuffer = buffer
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let width = CVPixelBufferGetWidth(buffer)
        guard let pointer = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else { return }
        guard let reference else {
            self.reference = Array(UnsafeBufferPointer(start: pointer, count: height * rowBytes))
            save(buffer, as: "reference.png")
            FileHandle.standardOutput.write(Data("READY\n".utf8))
            return
        }

        var changed = 0
        var bottom = 0
        var ink = 0
        for y in 60..<height {
            for x in 10..<(width - 15) {
                let p = y * rowBytes + x * 4
                let difference = (0..<3).contains {
                    abs(Int(pointer[p + $0]) - Int(reference[p + $0])) > 24
                }
                if !difference { continue }
                changed += 1
                bottom = y
                if pointer[p] < 125 && pointer[p + 1] < 125 && pointer[p + 2] < 125 {
                    ink += 1
                }
            }
        }
        guard changed >= 150 else { return }
        let metrics = [bottom, ink]
        guard metrics != previous else { return }
        previous = metrics
        save(buffer, as: "\(index).png")
        FileHandle.standardOutput.write(Data("\(index) \(bottom) \(ink)\n".utf8))
        if index == 0 {
            firstChange.continuation.yield()
            firstChange.continuation.finish()
        }
        index += 1
    }
}

@main
struct CapturePopupOpening {
    static func main() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let args = CommandLine.arguments
        guard args.count == 4, let pid = Int32(args[1]) else { throw CocoaError(.fileReadInvalidFileName) }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.title?.contains(args[2]) == true }),
              let browser = window.owningApplication,
              let display = content.displays.first(where: { $0.frame.contains(window.frame) }) else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        let config = SCStreamConfiguration()
        config.width = 450
        config.height = 738
        config.sourceRect = CGRect(
            x: window.frame.maxX - display.frame.minX - CGFloat(config.width),
            y: window.frame.minY - display.frame.minY + 30,
            width: CGFloat(config.width), height: CGFloat(config.height)
        )
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 120)
        config.queueDepth = 8
        config.showsCursor = false
        let output = PopupFrames(directory: URL(fileURLWithPath: args[3], isDirectory: true))
        let queue = DispatchQueue(label: "popup-opening-frames")
        // Keep transient Chrome popup windows in the display capture as they open.
        let excluded = content.applications.filter { $0.processID != browser.processID }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        // Measure the popup from its first visible change. The parent bounds
        // the wait for that frame separately from this observation window.
        for await _ in output.firstChange.stream { break }
        try await Task.sleep(for: .seconds(1))
        try await stream.stopCapture()
        queue.sync {}
        if let lastBuffer = output.lastBuffer { output.save(lastBuffer, as: "last.png") }
    }
}
