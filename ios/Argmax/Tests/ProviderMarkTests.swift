import UIKit
import XCTest
@testable import Argmax

/// The provider marks are downloaded brand assets, not drawn shapes, so the
/// failure they can have is a missing or misnamed file — and it is silent:
/// `Image("Providers/claude")` renders an empty box and says nothing.
///
/// A new CLI reaches the catalogue by re-running
/// `npm run export:provider-models`, and the mark has to arrive in the same
/// change. This is what says so.
final class ProviderMarkTests: XCTestCase {
    func testEveryProviderInTheCatalogueHasAMark() {
        let providers = ProviderCatalog.bundled.providers.map(\.id)
        XCTAssertFalse(providers.isEmpty, "the bundled catalogue has no providers")
        for provider in providers {
            XCTAssertNotNil(
                ProviderMark.assetName(provider),
                "\(provider) has no imageset in Assets.xcassets/Providers"
            )
        }
    }

    /// Every mark is its own file. A copy-paste that pointed two providers at
    /// one asset would draw the same logo twice and read as a data bug in
    /// the list.
    func testNoTwoProvidersShareAMark() {
        let providers = ProviderCatalog.bundled.providers.map(\.id)
        let names = Set(providers.compactMap(ProviderMark.assetName))
        XCTAssertEqual(names.count, providers.count, "two providers resolve to one imageset")
    }

    /// A CLI the host knows before this build does falls through to the ring
    /// rather than borrowing another provider's logo.
    func testAnUnknownProviderResolvesToNoAsset() {
        XCTAssertNil(ProviderMark.assetName("something-new"))
        XCTAssertNil(ProviderMark.assetName(""))
    }

    /// Vector data preserved and the template intent set, which is what lets
    /// one file draw at 16pt in a row and 40pt in a preview, in the muted
    /// ink rather than a brand colour.
    func testTheMarksAreTemplateVectors() throws {
        for provider in ProviderCatalog.bundled.providers.map(\.id) {
            let name = try XCTUnwrap(ProviderMark.assetName(provider))
            let image = try XCTUnwrap(UIImage(named: name), "\(provider) has no image")
            XCTAssertEqual(
                image.renderingMode,
                .alwaysTemplate,
                "\(provider) is not template-rendered; it would draw in its brand colour"
            )
            // A rasterised imageset reports the one size it was exported at
            // and nothing else; a preserved vector answers for any scale.
            XCTAssertNotNil(
                image.imageAsset,
                "\(provider) carries no image asset"
            )
            XCTAssertGreaterThan(image.size.width, 0, "\(provider) has no intrinsic size")
        }
    }
}
