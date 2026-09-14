import UIKit
import XCTest
@testable import Argmax

@MainActor
final class ComposerTextInputTests: XCTestCase {
    override func tearDown() {
        UIPasteboard.general.items = []
        super.tearDown()
    }

    func testStandardPasteRoutesAnImageWithoutChangingText() {
        let textView = ComposerTextView()
        textView.text = "keep this draft"
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        UIPasteboard.general.image = image
        var pasted: [NSItemProvider] = []
        textView.onPasteImages = { pasted = $0 }

        textView.paste(nil)

        XCTAssertEqual(textView.text, "keep this draft")
        XCTAssertEqual(pasted.count, 1)
        XCTAssertTrue(pasted[0].hasItemConformingToTypeIdentifier("public.image"))
    }

    func testProviderRoutingLeavesPlainTextForUITextView() {
        let textView = ComposerTextView()
        let provider = NSItemProvider(object: "ordinary text" as NSString)

        XCTAssertFalse(textView.routePastedImages(from: [provider]))
    }
}
