import SwiftUI
import UIKit
import XCTest
@testable import Argmax

@MainActor
final class NativeTranscriptListTests: XCTestCase {
    func testInitialLayoutAndResizeStayAtTheLatestRow() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 24))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }

        guard let table = await waitForTable(in: host, where: { table in
            table.numberOfRows(inSection: 0) == state.items.count
                && table.contentSize.height > table.bounds.height
                && abs(tailGap(in: table)) < 1
        }) else {
            return XCTFail("The hosted transcript never laid out at its tail")
        }

        XCTAssertTrue(state.following)

        let originalHeight = table.bounds.height
        host.resize(to: CGSize(width: 320, height: 360))

        guard await waitForTable(in: host, where: { table in
            abs(table.bounds.height - originalHeight - 120) < 1 && abs(tailGap(in: table)) < 1
        }) != nil else {
            return XCTFail("A pinned transcript did not follow its tail after resizing: table=\(table.bounds), window=\(host.window.bounds), safeArea=\(table.safeAreaInsets), gap=\(tailGap(in: table))")
        }

        XCTAssertEqual(tailGap(in: table), 0, accuracy: 1)
        XCTAssertTrue(state.following)
    }

    func testDragDetachesAndHistoryChangesPreserveTheVisibleRow() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 28))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 260))
        defer { host.close() }

        guard let table = await waitForTable(in: host, where: { table in
            table.numberOfRows(inSection: 0) == state.items.count
                && abs(tailGap(in: table)) < 1
        }) else {
            return XCTFail("The hosted transcript did not finish its initial layout")
        }

        table.delegate?.scrollViewWillBeginDragging?(table)
        table.scrollToRow(at: IndexPath(row: 12, section: 0), at: .top, animated: false)
        table.delegate?.scrollViewDidEndDragging?(table, willDecelerate: false)

        guard let detachedTable = await waitForTable(in: host, where: { table in
            !state.following
                && (table.indexPathsForVisibleRows?.first?.row ?? 0) > 2
                && tailGap(in: table) > 28
        }), let anchor = detachedTable.indexPathsForVisibleRows?.first else {
            return XCTFail("Dragging did not detach the transcript from the live tail")
        }

        let anchorID = state.items[anchor.row].id
        let anchorY = detachedTable.rectForRow(at: anchor).minY - detachedTable.contentOffset.y
        var revised = state.items
        revised[anchor.row - 2].height += 72
        let older = transcriptItems(count: 4, prefix: "older")
        let updated = older + revised
        guard let newAnchorRow = updated.firstIndex(where: { $0.id == anchorID }) else {
            return XCTFail("The visible row disappeared from the updated test data")
        }
        let newAnchor = IndexPath(row: newAnchorRow, section: 0)

        state.items = updated

        guard let updatedTable = await waitForTable(in: host, where: { table in
            guard table.numberOfRows(inSection: 0) == updated.count else { return false }
            let updatedY = table.rectForRow(at: newAnchor).minY - table.contentOffset.y
            return abs(updatedY - anchorY) < 1
        }) else {
            return XCTFail("Prepending and resizing rows moved the reader's visible anchor")
        }

        XCTAssertFalse(state.following)
        XCTAssertEqual(
            updatedTable.rectForRow(at: newAnchor).minY - updatedTable.contentOffset.y,
            anchorY,
            accuracy: 1
        )
    }

    func testExplicitScrollRequestReturnsADetachedReaderToLatest() async {
        let state = TranscriptListTestState(items: transcriptItems(count: 24))
        let host = TranscriptListTestHost(state: state, size: CGSize(width: 320, height: 240))
        defer { host.close() }

        guard let table = await waitForTable(in: host, where: { table in
            table.numberOfRows(inSection: 0) == state.items.count
                && abs(tailGap(in: table)) < 1
        }) else {
            return XCTFail("The hosted transcript did not finish its initial layout")
        }

        table.delegate?.scrollViewWillBeginDragging?(table)
        table.scrollToRow(at: IndexPath(row: 5, section: 0), at: .top, animated: false)
        table.delegate?.scrollViewDidEndDragging?(table, willDecelerate: false)

        guard await waitForTable(in: host, where: {
            !state.following && tailGap(in: $0) > 28
        }) != nil else {
            return XCTFail("The transcript did not detach before the explicit request")
        }

        state.scrollRequest += 1

        guard await waitForTable(in: host, where: {
            state.following && abs(tailGap(in: $0)) < 1
        }) != nil else {
            return XCTFail("The explicit scroll request did not return to the latest row")
        }
    }
}

private struct TranscriptListTestItem: Identifiable, Equatable {
    let id: String
    var height: CGFloat
}

@MainActor
private final class TranscriptListTestState: ObservableObject {
    @Published var items: [TranscriptListTestItem]
    @Published var following = true
    @Published var scrollRequest = 0

    init(items: [TranscriptListTestItem]) {
        self.items = items
    }
}

private struct TranscriptListTestView: View {
    @ObservedObject var state: TranscriptListTestState

    var body: some View {
        NativeTranscriptList(
            items: state.items,
            sessionID: "session-1",
            scrollRequest: state.scrollRequest,
            following: $state.following
        ) { item in
            Text(item.id)
                .frame(maxWidth: .infinity, minHeight: item.height, alignment: .leading)
                .accessibilityIdentifier(item.id)
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

    var table: NativeTranscriptTableView? {
        descendant(of: NativeTranscriptTableView.self, in: controller.view)
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
private func waitForTable(
    in host: TranscriptListTestHost,
    where condition: (NativeTranscriptTableView) -> Bool
) async -> NativeTranscriptTableView? {
    for _ in 0..<100 {
        host.layout()
        if let table = host.table, condition(table) { return table }
        await Task.yield()
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return nil
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
private func tailGap(in table: UITableView) -> CGFloat {
    table.contentSize.height + table.adjustedContentInset.bottom
        - table.contentOffset.y - table.bounds.height
}
