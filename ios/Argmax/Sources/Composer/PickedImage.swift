import ImageIO
import UIKit

/// A photo chosen in the composer, encoded the way the host's attachment store
/// takes it: PNG, JPEG, GIF or WebP bytes, inside the same two caps the
/// desktop composer respects before it uploads.
///
/// An iPhone's own library is mostly HEIC, which the store rejects, and a
/// full-resolution photo is several times the byte cap — so anything that is
/// not already an acceptable, sensibly sized image is redrawn as JPEG rather
/// than refused.
struct PickedImage: Equatable {
    /// One of the four types the host's `AttachmentMimeType` allows.
    let mimeType: String
    let data: Data

    /// Long-edge cap, `MAX_ATTACHMENT_DIMENSION_PX` in
    /// `src/renderer/lib/composerAttachments.ts`: base64 of the bytes has to
    /// survive the provider's single-line JSON stream.
    static let maxLongEdge: CGFloat = 1920
    /// `ATTACHMENT_BYTE_CAP` in `src-tauri/src/ipc/validation.rs`. The host
    /// rejects anything past it, so a phone that sent it would only learn
    /// after the upload.
    static let byteCap = 10 * 1024 * 1024

    /// The container these bytes are in, by magic number, or nil for anything
    /// the store does not accept (HEIC included). File extensions are not
    /// available here: the picker hands over bytes.
    static func mimeType(sniffing data: Data) -> String? {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if data.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if data.count > 12, data.starts(with: Array("RIFF".utf8)),
           data[data.index(data.startIndex, offsetBy: 8)..<data.index(data.startIndex, offsetBy: 12)]
            .elementsEqual(Array("WEBP".utf8)) { return "image/webp" }
        return nil
    }

    /// Pass acceptable bytes through untouched — a screenshot stays a lossless
    /// PNG, a GIF keeps its animation — and redraw everything else as a JPEG
    /// no longer than `maxLongEdge`. Nil when the bytes are not an image at
    /// all, or when even the redraw lands over the byte cap.
    static func encoded(from data: Data) -> PickedImage? {
        if let mimeType = mimeType(sniffing: data), data.count <= byteCap,
           let longEdge = longEdge(of: data), longEdge <= maxLongEdge {
            return PickedImage(mimeType: mimeType, data: data)
        }
        guard let image = UIImage(data: data),
              let jpeg = downscaled(image).jpegData(compressionQuality: 0.85),
              jpeg.count <= byteCap
        else { return nil }
        return PickedImage(mimeType: "image/jpeg", data: jpeg)
    }

    /// Pixel dimensions from the header, without decoding the whole image.
    private static func longEdge(of data: Data) -> CGFloat? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? CGFloat,
              let height = properties[kCGImagePropertyPixelHeight] as? CGFloat
        else { return nil }
        return max(width, height)
    }

    private static func downscaled(_ image: UIImage) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxLongEdge, longest > 0 else { return image }
        let scale = maxLongEdge / longest
        let size = CGSize(
            width: (image.size.width * scale).rounded(),
            height: (image.size.height * scale).rounded()
        )
        let format = UIGraphicsImageRendererFormat.default()
        // Points, not the screen's pixels: the size above is already the
        // pixel count we want.
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
