import UIKit
import XCTest
@testable import Argmax

/// What the composer ships to the host's attachment store: one of four
/// container types, inside the long-edge and byte caps the desktop composer
/// respects before it uploads.
final class PickedImageTests: XCTestCase {
    private func image(width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    func testSniffsTheContainerFromMagicBytes() {
        XCTAssertEqual(PickedImage.mimeType(sniffing: try! XCTUnwrap(image(width: 4, height: 4).pngData())), "image/png")
        XCTAssertEqual(PickedImage.mimeType(sniffing: try! XCTUnwrap(image(width: 4, height: 4).jpegData(compressionQuality: 0.8))), "image/jpeg")
        XCTAssertEqual(PickedImage.mimeType(sniffing: Data("GIF89a…".utf8)), "image/gif")
        XCTAssertEqual(PickedImage.mimeType(sniffing: Data("RIFF????WEBPVP8 ".utf8)), "image/webp")
    }

    /// HEIC is what an iPhone's own library mostly holds, and the store
    /// rejects it: it has to be sniffed as unknown so the redraw takes over.
    func testUnknownContainersAreNotClaimed() {
        XCTAssertNil(PickedImage.mimeType(sniffing: Data([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])))
        XCTAssertNil(PickedImage.mimeType(sniffing: Data()))
    }

    /// A screenshot-sized PNG goes up byte for byte: no re-encode, no loss.
    func testAcceptableBytesPassThrough() throws {
        let png = try XCTUnwrap(image(width: 40, height: 30).pngData())
        let encoded = try XCTUnwrap(PickedImage.encoded(from: png))
        XCTAssertEqual(encoded.mimeType, "image/png")
        XCTAssertEqual(encoded.data, png)
    }

    /// A full-resolution photo is redrawn to the long-edge cap as JPEG.
    func testOversizedImagesAreRedrawnAsJpeg() throws {
        let png = try XCTUnwrap(image(width: 3000, height: 1500).pngData())
        let encoded = try XCTUnwrap(PickedImage.encoded(from: png))
        XCTAssertEqual(encoded.mimeType, "image/jpeg")
        let redrawn = try XCTUnwrap(UIImage(data: encoded.data))
        XCTAssertEqual(max(redrawn.size.width, redrawn.size.height), PickedImage.maxLongEdge)
        XCTAssertEqual(redrawn.size.height / redrawn.size.width, 0.5, accuracy: 0.01)
        XCTAssertLessThanOrEqual(encoded.data.count, PickedImage.byteCap)
    }

    func testNonImageBytesAreRefused() {
        XCTAssertNil(PickedImage.encoded(from: Data("not an image".utf8)))
    }
}
