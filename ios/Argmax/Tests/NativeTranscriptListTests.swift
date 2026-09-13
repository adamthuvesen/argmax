import SwiftUI
import UIKit
import XCTest
@testable import Argmax

@MainActor
final class NativeTranscriptListTests: XCTestCase {
    func testInitialLayoutResizeAndContentGrowthStayAtTheLatestRow() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 24))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }

        guard let scrollView = await waitForScrollView(in: host, where: {
            $0.contentSize.height > $0.bounds.height && abs(tailGap(in: $0)) < 1
        }) else {
            return XCTFail("The hosted transcript never laid out at its tail")
        }

        XCTAssertTrue(state.following)
        let originalHeight = scrollView.bounds.height
        host.resize(to: CGSize(width: 320, height: 360))

        guard await waitForScrollView(in: host, where: {
            abs($0.bounds.height - originalHeight - 120) < 1 && abs(tailGap(in: $0)) < 1
        }) != nil else {
            return XCTFail("A pinned transcript did not follow its tail after resizing")
        }

        let oldContentHeight = scrollView.contentSize.height
        state.items[state.items.count - 1].height += 96

        guard await waitForScrollView(in: host, where: {
            $0.contentSize.height >= oldContentHeight + 95 && abs(tailGap(in: $0)) < 1
        }) != nil else {
            return XCTFail("A streaming row height change moved the transcript from its tail")
        }

        XCTAssertTrue(state.following)
    }

    func testDetachedHistoryChangesPreserveTheReadingPosition() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 28))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 260))
        defer { host.close() }

        guard let scrollView = await waitForScrollView(in: host, where: {
            $0.contentSize.height > $0.bounds.height && abs(tailGap(in: $0)) < 1
        }) else {
            return XCTFail("The hosted transcript did not finish its initial layout")
        }

        state.following = false
        await settle(host)
        state.rowFrames.removeAll()
        scrollView.setContentOffset(CGPoint(x: 0, y: 500), animated: false)

        guard await waitForScrollView(in: host, where: {
            !$0.isDragging && abs($0.contentOffset.y - 500) < 1
        }) != nil else {
            return XCTFail("The test transcript did not move to its reading position")
        }
        await settle(host)

        let oldContentHeight = scrollView.contentSize.height
        let viewport = scrollView.convert(scrollView.bounds, to: host.window)
        guard let anchor = state.rowFrames
            .filter({ $0.value.frame.maxY > viewport.minY && $0.value.frame.minY < viewport.maxY })
            .min(by: { $0.value.frame.minY < $1.value.frame.minY }) else {
            return XCTFail("The hosted transcript did not report a visible reading anchor")
        }
        var revised = state.items
        revised[2].height += 72
        state.items = transcriptItems(count: 4, prefix: "older") + revised

        guard let updated = await waitForScrollView(in: host, where: {
            $0.contentSize.height >= oldContentHeight + 4 * 44 - 1
                && state.rowFrames[anchor.key]?.itemCount == state.items.count
                && abs((state.rowFrames[anchor.key]?.frame.minY ?? CGFloat.infinity)
                    - anchor.value.frame.minY) < 1
        }) else {
            return XCTFail(
                "Prepending and resizing earlier rows moved \(anchor.key); "
                    + "y=\(state.rowFrames[anchor.key]?.frame.minY ?? CGFloat.infinity), "
                    + "expected=\(anchor.value.frame.minY)"
            )
        }

        guard let updatedAnchorY = state.rowFrames[anchor.key]?.frame.minY else {
            return XCTFail("The visible reading anchor disappeared after prepending history")
        }
        XCTAssertFalse(state.following)
        XCTAssertEqual(updatedAnchorY, anchor.value.frame.minY, accuracy: 1)
        XCTAssertGreaterThan(updated.contentSize.height, oldContentHeight)
    }

    func testExplicitScrollRequestAndSessionResetReturnToLatest() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 24))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }

        guard let scrollView = await waitForScrollView(in: host, where: {
            $0.contentSize.height > $0.bounds.height && abs(tailGap(in: $0)) < 1
        }) else {
            return XCTFail("The hosted transcript did not finish its initial layout")
        }

        state.following = false
        await settle(host)
        scrollView.setContentOffset(CGPoint(x: 0, y: 160), animated: false)

        guard await waitForScrollView(in: host, where: {
            tailGap(in: $0) > 28 && abs($0.contentOffset.y - 160) < 1
        }) != nil else {
            return XCTFail("The transcript did not settle at its detached reading position")
        }
        await settle(host)
        state.scrollRequest += 1

        guard await waitForScrollView(in: host, where: {
            state.following && abs(tailGap(in: $0)) < 1
        }) != nil else {
            return XCTFail("The explicit scroll request did not return to the latest row")
        }

        state.following = false
        await settle(host)
        scrollView.setContentOffset(CGPoint(x: 0, y: 160), animated: false)
        await settle(host)
        state.sessionID = "session-2"

        guard await waitForScrollView(in: host, where: {
            state.following && abs(tailGap(in: $0)) < 1
        }) != nil else {
            return XCTFail("A new session did not start at its latest row")
        }
    }

    /// The transcript is an eager stack on purpose: a lazy stack guesses the
    /// height of rows it has not realised, and the tail scroll lands on that
    /// guess, past the real last row. Pin that the tail row is realised and
    /// the viewport actually sits at the real content end.
    func testEagerStackRealizesTheTailRow() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 500))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }

        guard await waitForScrollView(in: host, where: {
            abs(tailGap(in: $0)) < 1 && state.appearedIDs.contains("item-499")
        }) != nil else {
            return XCTFail("The eager transcript did not present its tail row at the tail")
        }
    }

    func testUserScrollPhasesDetachUntilTheReaderFinishesNearTheTail() {
        XCTAssertFalse(TranscriptScrollBehavior.following(
            from: .idle, after: .tracking, tailGap: 0, current: true
        ))
        XCTAssertFalse(TranscriptScrollBehavior.following(
            from: .interacting, after: .decelerating, tailGap: 4, current: false
        ))
        XCTAssertFalse(TranscriptScrollBehavior.following(
            from: .decelerating, after: .idle, tailGap: 120, current: false
        ))
        XCTAssertTrue(TranscriptScrollBehavior.following(
            from: .decelerating, after: .idle, tailGap: 27, current: false
        ))
        XCTAssertTrue(TranscriptScrollBehavior.following(
            from: .idle, after: .animating, tailGap: 120, current: true
        ))
        XCTAssertTrue(TranscriptScrollBehavior.following(
            from: .animating, after: .idle, tailGap: 120, current: true
        ))
    }

    func testKeyboardInsetUsesOnlyTheVisibleKeyboardOverlap() {
        XCTAssertEqual(
            transcriptKeyboardInset(keyboardTop: 538, containerBottom: 874),
            336
        )
        XCTAssertEqual(
            transcriptKeyboardInset(keyboardTop: 874, containerBottom: 874),
            0
        )
        XCTAssertEqual(
            transcriptKeyboardInset(keyboardTop: 900, containerBottom: 874),
            0
        )
    }
}

private struct TranscriptListTestItem: Identifiable, Equatable {
    let id: String
    var height: CGFloat
}

private struct TranscriptListTestRowGeometry: Equatable {
    let frame: CGRect
    let itemCount: Int
}

@MainActor
private final class TranscriptListTestState: ObservableObject {
    @Published var items: [TranscriptListTestItem]
    @Published var following = true
    @Published var scrollRequest = 0
    @Published var sessionID = "session-1"
    @Published var appearedIDs: Set<String> = []
    var rowFrames: [String: TranscriptListTestRowGeometry] = [:]

    init(items: [TranscriptListTestItem]) {
        self.items = items
    }
}

private struct TranscriptListTestView: View {
    @ObservedObject var state: TranscriptListTestState

    var body: some View {
        let itemCount = state.items.count
        NativeTranscriptList(
            items: state.items,
            sessionID: state.sessionID,
            scrollRequest: state.scrollRequest,
            following: $state.following
        ) { item in
            Text(item.id)
                .frame(maxWidth: .infinity, minHeight: item.height, alignment: .leading)
                .accessibilityIdentifier(item.id)
                .onAppear { state.appearedIDs.insert(item.id) }
                .onGeometryChange(for: TranscriptListTestRowGeometry.self) { proxy in
                    TranscriptListTestRowGeometry(
                        frame: proxy.frame(in: .global),
                        itemCount: itemCount
                    )
                } action: { value in
                    state.rowFrames[item.id] = value
                }
        }
    }
}

@MainActor
private final class TranscriptListTestHost {
    let state: TranscriptListTestState
    let window: UIWindow
    let controller: UIHostingController<TranscriptListTestView>

    init(state: TranscriptListTestState, size: CGSize) {
        self.state = state
        window = UIWindow(frame: CGRect(origin: .zero, size: size))
        controller = UIHostingController(rootView: TranscriptListTestView(state: state))
        window.rootViewController = controller
        window.isHidden = false
        layout()
    }

    var scrollView: UIScrollView? {
        descendant(of: UIScrollView.self, in: controller.view)
    }

    func resize(to size: CGSize) {
        window.frame = CGRect(origin: .zero, size: size)
        layout()
    }

    func layout() {
        controller.view.frame = window.bounds
        window.setNeedsLayout()
        window.layoutIfNeeded()
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
    }

    func close() {
        window.isHidden = true
        window.rootViewController = nil
    }
}

@MainActor
private func waitForScrollView(
    in host: TranscriptListTestHost,
    where condition: (UIScrollView) -> Bool
) async -> UIScrollView? {
    for _ in 0..<120 {
        host.layout()
        if let scrollView = host.scrollView, condition(scrollView) { return scrollView }
        await Task.yield()
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return nil
}

@MainActor
private func settle(_ host: TranscriptListTestHost) async {
    for _ in 0..<3 {
        host.layout()
        await Task.yield()
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

@MainActor
private func descendant<ViewType: UIView>(of type: ViewType.Type, in view: UIView) -> ViewType? {
    if let match = view as? ViewType { return match }
    for subview in view.subviews {
        if let match = descendant(of: type, in: subview) { return match }
    }
    return nil
}

private func transcriptItems(count: Int, prefix: String = "item") -> [TranscriptListTestItem] {
    (0..<count).map { TranscriptListTestItem(id: "\(prefix)-\($0)", height: 44) }
}

@MainActor
private func tailGap(in scrollView: UIScrollView) -> CGFloat {
    scrollView.contentSize.height + scrollView.adjustedContentInset.bottom
        - scrollView.contentOffset.y - scrollView.bounds.height
}
