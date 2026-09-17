import SwiftUI
import UIKit
import XCTest
@testable import Argmax

@MainActor
final class NativeTranscriptListTests: XCTestCase {
    func testCachedChatRefreshDoesNotResizeTranscriptHeader() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = DeviceCache(directory: directory)
        let socket = TestBridgeSocket(holdAuth: true)
        let client = try BridgeClient(
            pairingURL: XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=header-test")),
            operationDirectory: directory, monitorNetwork: false, socketFactory: { _ in socket }
        )
        let metadata = TranscriptSessionMetadata(
            id: "s-1", workspaceId: "w-1", provider: "claude", modelLabel: "Opus",
            modelId: "claude-opus", prompt: "Go", state: .complete, attention: .normal,
            reasoningEffort: "high"
        )
        let page = TranscriptPage(events: [TranscriptEvent(
            id: "answer", sessionId: "s-1", type: "message.completed",
            message: String(repeating: "A cached answer with unchanged content.\n\n", count: 30),
            payload: .object([:]), createdAt: "2026-01-01T00:00:01.000Z", rowCursor: 1
        )], rawOutputs: [], eventCursor: 1, rawOutputCursor: 0, changeCursor: 1,
           deletedEventIds: [], deletedRawOutputIds: [], resetRequired: true, hasMore: false)
        let seed = TranscriptStore(client: client, cache: cache)
        seed.preview(page: page, metadata: metadata)
        seed.ingest(page: page, for: "s-1")
        await seed.waitForProjection()
        await seed.flushCache()
        seed.closeSession()

        let transcript = TranscriptStore(client: client, cache: cache)
        let dashboard = DashboardStore(client: client, cache: cache)
        dashboard.ingest(snapshot: previewSnapshot)
        let root = TranscriptScreen(row: previewRow)
            .environmentObject(transcript)
            .environmentObject(dashboard)
            .environmentObject(ChatNavigator())
            .environmentObject(PushDelegate())
            .environmentObject(Appearance(store: UserDefaults(suiteName: UUID().uuidString)!))
        let controller = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true; window.rootViewController = nil; transcript.closeSession() }
        func layout() {
            controller.view.frame = window.bounds
            window.setNeedsLayout()
            window.layoutIfNeeded()
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        }
        for _ in 0..<60 {
            layout()
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(transcript.showingCachedContent)
        XCTAssertFalse(transcript.items.isEmpty)
        let scroll = try XCTUnwrap(descendant(of: UIScrollView.self, in: controller.view, where: {
            !($0 is UITextView) && $0.contentSize.height >
                $0.bounds.height - $0.adjustedContentInset.top - $0.adjustedContentInset.bottom
        }))
        let oldInset = scroll.adjustedContentInset.top
        let oldFrame = scroll.convert(scroll.bounds, to: window)
        let oldItems = transcript.items
        let oldOffset = scroll.contentOffset.y
        transcript.ingest(page: page, for: "s-1", authoritative: true)
        await transcript.waitForProjection()
        for _ in 0..<30 {
            layout()
            XCTAssertEqual(scroll.contentOffset.y, oldOffset, accuracy: 0.5,
                           "Identical live content must not transiently move the reading position")
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertFalse(transcript.showingCachedContent)
        XCTAssertEqual(transcript.items, oldItems)
        XCTAssertEqual(scroll.adjustedContentInset.top, oldInset, accuracy: 0.5,
                       "Replacing identical cached content must not change the header height")
        XCTAssertEqual(scroll.convert(scroll.bounds, to: window).minY, oldFrame.minY, accuracy: 0.5)
        XCTAssertEqual(scroll.bounds.height, oldFrame.height, accuracy: 0.5)
        await client.disconnect()
    }

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

    func testNewTurnResumesFollowingWithItsPromptAtTheTop() async {
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
        await settle(host)

        state.items.append(.init(id: "new-prompt", height: 44))
        state.turnAnchorID = "new-prompt"

        guard await waitForScrollView(in: host, where: { scrollView in
            guard let frame = state.rowFrames["new-prompt"]?.frame else { return false }
            let viewport = scrollView.convert(scrollView.bounds, to: host.window)
            return state.following && abs(frame.minY - viewport.minY - scrollView.adjustedContentInset.top) < 1
        }) != nil else {
            return XCTFail("A new turn did not place its prompt at the top inset")
        }

        state.items.append(contentsOf: transcriptItems(count: 2, prefix: "short-output"))
        guard await waitForScrollView(in: host, where: { scrollView in
            guard let frame = state.rowFrames["new-prompt"]?.frame else { return false }
            let viewport = scrollView.convert(scrollView.bounds, to: host.window)
            return abs(frame.minY - viewport.minY - scrollView.adjustedContentInset.top) < 1
        }) != nil else {
            return XCTFail("Short output moved the new prompt away from the top inset")
        }

        state.items.append(contentsOf: transcriptItems(count: 8, prefix: "long-output"))
        guard await waitForScrollView(in: host, where: {
            abs(tailGap(in: $0)) < 1 && state.rowFrames["new-prompt"]?.frame.minY ?? .infinity < $0.frame.minY
        }) != nil else {
            return XCTFail("Long output did not yield the turn floor to tail following")
        }
    }

    func testOpeningShortExistingTurnEndsAtReplyWithoutReservedSpace() async {
        var items = transcriptItems(count: 24)
        items.append(.init(id: "existing-prompt", height: 44))
        items.append(.init(id: "existing-reply", height: 88))
        let state = TranscriptListTestState(items: items, turnAnchorID: "existing-prompt")
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }

        guard let scrollView = await waitForScrollView(in: host, where: {
            abs(tailGap(in: $0)) < 1 && state.rowFrames["existing-reply"] != nil
        }) else {
            return XCTFail("Opening a chat did not reach its last reply")
        }
        for _ in 0..<20 { await settle(host) }
        XCTAssertEqual(scrollView.contentSize.height, 24 * 44 + 44 + 88 + 36, accuracy: 1)
        XCTAssertEqual(tailGap(in: scrollView), 0, accuracy: 1)
    }

    func testActiveTurnKeepsPromptBelowHeaderAndReopeningRemovesReservation() async {
        var items = transcriptItems(count: 24)
        let state = TranscriptListTestState(items: items)
        state.headerHeight = 100
        state.composerHeight = 120
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 390, height: 844))
        defer { host.close() }

        guard await waitForScrollView(in: host, where: { abs(tailGap(in: $0)) < 1 }) != nil else {
            return XCTFail("The initial transcript did not reach its tail")
        }
        items.append(.init(id: "prompt", height: 44))
        items.append(.init(id: "reply", height: 180))
        state.items = items
        state.turnAnchorID = "prompt"

        guard await waitForScrollView(in: host, where: { scrollView in
            guard let prompt = state.rowFrames["prompt"]?.frame else { return false }
            let viewport = scrollView.convert(scrollView.bounds, to: host.window)
            return abs(prompt.minY - viewport.minY - scrollView.adjustedContentInset.top) < 1
        }) != nil else {
            let scrollView = host.scrollView!
            return XCTFail("Prompt y=\(state.rowFrames["prompt"]?.frame.minY ?? -1), viewport=\(scrollView.convert(scrollView.bounds, to: host.window)), insets=\(scrollView.adjustedContentInset)")
        }
        for _ in 0..<20 { await settle(host) }
        let scrollView = host.scrollView!
        let viewport = scrollView.convert(scrollView.bounds, to: host.window)
        XCTAssertEqual(state.rowFrames["prompt"]!.frame.minY,
                       viewport.minY + scrollView.adjustedContentInset.top, accuracy: 1)
        XCTAssertLessThanOrEqual(state.rowFrames["item-23"]!.frame.maxY,
                                 viewport.minY + scrollView.adjustedContentInset.top + 1,
                                 "The previous response must be entirely above the visible transcript")

        state.sessionID = "reopened-session"
        for _ in 0..<20 { await settle(host) }
        XCTAssertEqual(scrollView.contentSize.height, 24 * 44 + 44 + 180 + 36, accuracy: 1)
        XCTAssertEqual(tailGap(in: scrollView), 0, accuracy: 1)
    }

    func testLoadingHistoryDoesNotStartAnActiveTurn() async {
        let state = TranscriptListTestState(items: [])
        state.isReady = false
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }
        await settle(host)
        state.items = transcriptItems(count: 24)
        state.turnAnchorID = "item-23"
        state.isReady = true
        guard let scrollView = await waitForScrollView(in: host, where: {
            $0.contentSize.height > 1000 && abs(tailGap(in: $0)) < 1
        }) else { return XCTFail("Loaded history did not reach its tail") }
        for _ in 0..<20 { await settle(host) }
        XCTAssertEqual(scrollView.contentSize.height, 24 * 44 + 36, accuracy: 1)
        XCTAssertEqual(tailGap(in: scrollView), 0, accuracy: 1)
    }

    func testOpeningChatShorterThanViewportHasNoEmptySpaceAbovePrompt() async {
        let state = TranscriptListTestState(items: [.init(id: "prompt", height: 44),
                                                   .init(id: "reply", height: 88)],
                                            turnAnchorID: "prompt")
        state.headerHeight = 100
        state.composerHeight = 120
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 390, height: 844))
        defer { host.close() }
        for _ in 0..<20 { await settle(host) }
        guard let scrollView = host.scrollView, let prompt = state.rowFrames["prompt"] else {
            return XCTFail("The short chat did not lay out")
        }
        let viewport = scrollView.convert(scrollView.bounds, to: host.window)
        XCTAssertEqual(prompt.frame.minY,
                       viewport.minY + scrollView.adjustedContentInset.top + 16, accuracy: 1)
        XCTAssertEqual(scrollView.contentSize.height, 44 + 88 + 36, accuracy: 1)
    }

    func testNewlyLaunchedChatPlacesFirstPromptAtTop() async {
        let state = TranscriptListTestState(items: [])
        state.anchorInitialTurn = true
        state.isReady = false
        state.headerHeight = 100
        state.composerHeight = 120
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 390, height: 844))
        defer { host.close() }
        await settle(host)
        state.items = [.init(id: "first-prompt", height: 180), .init(id: "reply", height: 88)]
        state.turnAnchorID = "first-prompt"
        state.isReady = true
        for _ in 0..<20 { await settle(host) }
        guard let scrollView = host.scrollView, let prompt = state.rowFrames["first-prompt"] else {
            return XCTFail("The newly launched chat did not lay out")
        }
        let viewport = scrollView.convert(scrollView.bounds, to: host.window)
        XCTAssertEqual(prompt.frame.minY,
                       viewport.minY + scrollView.adjustedContentInset.top, accuracy: 1)
    }

    func testSteeringKeepsDetachedReadingPosition() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 28))
        state.turnAnchorID = "item-27"
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
        await settle(host)

        let viewport = scrollView.convert(scrollView.bounds, to: host.window)
        guard let anchor = state.rowFrames
            .filter({ $0.value.frame.maxY > viewport.minY && $0.value.frame.minY < viewport.maxY })
            .min(by: { $0.value.frame.minY < $1.value.frame.minY }) else {
            return XCTFail("The hosted transcript did not report a visible reading anchor")
        }

        state.items.append(.init(id: "steering", height: 44))

        guard await waitForScrollView(in: host, where: { _ in
            state.rowFrames["steering"] != nil
                && abs((state.rowFrames[anchor.key]?.frame.minY ?? .infinity) - anchor.value.frame.minY) < 1
        }) != nil else {
            return XCTFail("Steering moved the detached reading position")
        }
        XCTAssertFalse(state.following)
    }

    /// Opening a long chat prepares a Markdown document per prose row, so
    /// rows above the viewport change height for a second or two after the
    /// first paint. Each one used to push the visible rows down for the frame
    /// before the tail scroll pulled them back: the flicker on open.
    func testHistoryResizingWhileFollowingNeverMovesTheVisibleTail() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 40))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }

        guard let scrollView = await waitForScrollView(in: host, where: {
            $0.contentSize.height > $0.bounds.height && abs(tailGap(in: $0)) < 1
        }) else {
            return XCTFail("The hosted transcript did not finish its initial layout")
        }
        for _ in 0..<20 { await settle(host) }
        guard let settled = state.rowFrames["item-39"]?.frame.minY else {
            return XCTFail("The transcript did not report its tail row")
        }
        let contentHeight = scrollView.contentSize.height

        state.rowTops.removeAll()
        state.items[3].height += 120
        for _ in 0..<20 { await settle(host) }
        state.items[7].height -= 20
        for _ in 0..<20 { await settle(host) }

        XCTAssertEqual(scrollView.contentSize.height, contentHeight + 100, accuracy: 1,
                       "The history rows did not actually resize")
        let moved = (state.rowTops["item-39"] ?? []).filter { abs($0 - settled) > 1 }
        XCTAssertTrue(moved.isEmpty,
                      "History resizing moved the visible tail to \(moved) instead of \(settled)")
        XCTAssertTrue(state.following)
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
        XCTAssertTrue(TranscriptScrollBehavior.following(
            from: .decelerating, after: .idle, tailGap: 120, current: false,
            turnScrollPending: true
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
    @Published var turnAnchorID: String?
    @Published var isReady = true
    var anchorInitialTurn = false
    @Published var appearedIDs: Set<String> = []
    var rowFrames: [String: TranscriptListTestRowGeometry] = [:]
    /// Every position a row has been laid out at, so a test can catch a
    /// single displaced frame that a later pass corrects.
    var rowTops: [String: [CGFloat]] = [:]
    var headerHeight: CGFloat = 0
    var composerHeight: CGFloat = 0

    init(items: [TranscriptListTestItem], turnAnchorID: String? = nil) {
        self.items = items
        self.turnAnchorID = turnAnchorID
    }
}

private struct TranscriptListTestView: View {
    @ObservedObject var state: TranscriptListTestState

    var body: some View {
        let itemCount = state.items.count
        VStack(spacing: 0) {
            NativeTranscriptList(
                items: state.items,
                sessionID: state.sessionID,
                scrollRequest: state.scrollRequest,
                turnAnchorID: state.turnAnchorID,
                anchorInitialTurn: state.anchorInitialTurn,
                isReady: state.isReady,
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
                        state.rowTops[item.id, default: []].append(value.frame.minY)
                    }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { Color.clear.frame(height: state.headerHeight) }
        .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: state.composerHeight) }
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
private func descendant<ViewType: UIView>(
    of type: ViewType.Type, in view: UIView, where condition: (ViewType) -> Bool = { _ in true }
) -> ViewType? {
    if let match = view as? ViewType, condition(match) { return match }
    for subview in view.subviews {
        if let match = descendant(of: type, in: subview, where: condition) { return match }
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
