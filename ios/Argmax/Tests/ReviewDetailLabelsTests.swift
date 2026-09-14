import XCTest
@testable import Argmax

/// The review header's two lines come straight off the open detail, so a path
/// that loses its directory or a diff that forgets its scope shows up here
/// rather than as a header that says less than it used to.
final class ReviewDetailLabelsTests: XCTestCase {
    func testTheHeaderNamesTheFileAndWhereItCameFrom() {
        let diff = ReviewDetail.diff(workspaceID: "workspace", path: "Sources/Feature/App.swift", scope: .committed)
        let file = ReviewDetail.file(workspaceID: "workspace", path: "Sources/Feature/App.swift")

        XCTAssertEqual(diff.fileName, "App.swift")
        XCTAssertEqual(diff.pathAndKind, "Sources/Feature · Committed")
        XCTAssertEqual(file.fileName, "App.swift")
        XCTAssertEqual(file.pathAndKind, "Sources/Feature · File")
    }

    /// A file at the checkout root has no directory to name, so the kind
    /// stands alone rather than following a leading separator.
    func testARootFileShowsOnlyItsKind() {
        let file = ReviewDetail.file(workspaceID: "workspace", path: "README.md")

        XCTAssertEqual(file.fileName, "README.md")
        XCTAssertEqual(file.pathAndKind, "File")
    }
}
