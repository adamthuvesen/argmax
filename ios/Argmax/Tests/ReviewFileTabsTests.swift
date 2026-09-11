import SwiftUI
import UIKit
import XCTest
@testable import Argmax

@MainActor
final class ReviewFileTabsTests: XCTestCase {
    private let file = ReviewDetail.file(workspaceID: "workspace", path: "src/App.swift")
    private let readme = ReviewDetail.file(workspaceID: "workspace", path: "README.md")

    func testOpeningTheSameDetailTwiceSelectsOneTab() {
        var state = ReviewFileTabsState()

        state.open(file)
        state.open(file)

        XCTAssertEqual(state.open, [file])
        XCTAssertEqual(state.active, file)
    }

    func testTheSamePathInDifferentComparisonsGetsSeparateTabs() {
        let branch = ReviewDetail.diff(workspaceID: "workspace", path: "src/App.swift", scope: .branch)
        let uncommitted = ReviewDetail.diff(workspaceID: "workspace", path: "src/App.swift", scope: .uncommitted)
        var state = ReviewFileTabsState()

        state.open(branch)
        state.open(uncommitted)

        XCTAssertEqual(state.open, [branch, uncommitted])
        XCTAssertEqual(state.active, uncommitted)
    }

    func testClosingTheActiveTabSelectsItsNeighbor() {
        let diff = ReviewDetail.diff(workspaceID: "workspace", path: "src/App.swift", scope: .branch)
        var state = ReviewFileTabsState()
        state.open(file)
        state.open(diff)
        state.open(readme)
        state.select(diff)

        state.close(diff)

        XCTAssertEqual(state.open, [file, readme])
        XCTAssertEqual(state.active, readme, "the tab to the right keeps the reading position")
    }

    func testClosingAnInactiveTabKeepsTheSelection() {
        var state = ReviewFileTabsState()
        state.open(file)
        state.open(readme)

        state.close(file)

        XCTAssertEqual(state.open, [readme])
        XCTAssertEqual(state.active, readme)
    }

    func testReturningToTheListKeepsOpenTabs() {
        var state = ReviewFileTabsState(initial: file)

        state.showList()

        XCTAssertEqual(state.open, [file])
        XCTAssertNil(state.active)
    }

    func testTabAccessibilityNamesCarryTheFullPathAndKind() {
        let diff = ReviewDetail.diff(workspaceID: "workspace", path: "Sources/Feature/App.swift", scope: .committed)
        let file = ReviewDetail.file(workspaceID: "workspace", path: "Sources/Feature/App.swift")

        XCTAssertEqual(diff.accessibilityDescription, "Diff Sources/Feature/App.swift, Committed")
        XCTAssertEqual(file.accessibilityDescription, "File Sources/Feature/App.swift")
    }

    /// Kept as test attachments so the compact strip is visible at the phone
    /// width in both appearances and at an accessibility text size.
    func testTabStripRendersAtPhoneWidth() async throws {
        let details = [
            ReviewDetail.diff(workspaceID: "workspace", path: "Sources/Feature/App.swift", scope: .branch),
            ReviewDetail.file(workspaceID: "workspace", path: "Tests/Feature/AppTests.swift")
        ]
        let configurations: [(String, ColorScheme, DynamicTypeSize)] = [
            ("Light", .light, .large),
            ("Dark", .dark, .large),
            ("Accessibility", .light, .accessibility3)
        ]

        for (name, scheme, typeSize) in configurations {
            let view = ReviewFileTabs(
                details: details,
                active: details[0],
                onSelect: { _ in },
                onClose: { _ in },
                onShowList: {}
            )
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, typeSize)
            .frame(width: 393)

            let controller = UIHostingController(rootView: view)
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let previousKeyWindow = scene.windows.first { $0.isKeyWindow }
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 150)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            controller.view.frame = window.bounds
            window.layoutIfNeeded()
            controller.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            controller.view.layoutIfNeeded()
            var rendered = false
            let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
                rendered = controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
            }
            XCTAssertTrue(rendered)
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
            XCTAssertEqual(image.size.width, 393, accuracy: 0.5)

            let attachment = XCTAttachment(image: image)
            attachment.name = "Review file tabs - \(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }
}
