import SwiftUI
import UIKit

/// Reusable native cells bound to stable timeline identities. Only changed
/// rows are reconfigured during streaming, and reading older text detaches
/// scrolling from the live tail until the reader explicitly returns.
struct NativeTranscriptList<Item: Identifiable & Equatable, Row: View>: UIViewRepresentable
where Item.ID == String {
    let items: [Item]
    let sessionID: String
    let scrollRequest: Int
    var presentationID = ""
    @Binding var following: Bool
    @ViewBuilder var row: (Item) -> Row

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> NativeTranscriptTableView {
        let table = NativeTranscriptTableView(frame: .zero, style: .plain)
        table.backgroundColor = .clear
        table.separatorStyle = .none
        table.allowsSelection = false
        table.estimatedRowHeight = 120
        table.rowHeight = UITableView.automaticDimension
        table.keyboardDismissMode = .interactive
        table.contentInset = UIEdgeInsets(top: 16, left: 0, bottom: 20, right: 0)
        table.register(UITableViewCell.self, forCellReuseIdentifier: "transcript")
        table.delegate = context.coordinator
        table.accessibilityIdentifier = "native-transcript"
        context.coordinator.attach(table)
        return table
    }

    func updateUIView(_ table: NativeTranscriptTableView, context: Context) {
        context.coordinator.update(self, table: table)
    }

    @MainActor
    final class Coordinator: NSObject, UITableViewDelegate {
        private var parent: NativeTranscriptList
        private var dataSource: UITableViewDiffableDataSource<Int, String>?
        private var values: [String: Item] = [:]
        private var sessionID: String?
        private var scrollRequest = 0
        private var presentationID = ""
        private var followsTail = true
        private var applying = false
        private var pending: NativeTranscriptList?

        init(_ parent: NativeTranscriptList) { self.parent = parent }

        func attach(_ table: NativeTranscriptTableView) {
            dataSource = UITableViewDiffableDataSource(tableView: table) { [weak self] table, index, id in
                guard let self, let item = self.values[id] else { return nil }
                let cell = table.dequeueReusableCell(withIdentifier: "transcript", for: index)
                cell.backgroundColor = .clear
                cell.selectionStyle = .none
                cell.contentConfiguration = UIHostingConfiguration {
                    self.parent.row(item)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Spacing.gutter)
                        .padding(.vertical, Spacing.snug)
                }.margins(.all, 0)
                return cell
            }
            table.afterLayout = { [weak self, weak table] in
                guard let self, let table, self.followsTail, !table.isDragging,
                      !table.isDecelerating else { return }
                self.scrollToTail(table)
            }
        }

        func update(_ next: NativeTranscriptList, table: NativeTranscriptTableView) {
            // SwiftUI can publish another delta before UIKit finishes its
            // preceding snapshot. Retain the latest update, never overlap.
            guard !applying else { pending = next; return }
            let changedSession = sessionID != next.sessionID
            parent = next
            sessionID = next.sessionID
            if changedSession || scrollRequest != next.scrollRequest {
                followsTail = true
                publishFollowing(true)
            }
            scrollRequest = next.scrollRequest

            let incoming = Dictionary(uniqueKeysWithValues: next.items.map { ($0.id, $0) })
            let oldIDs = dataSource?.snapshot().itemIdentifiers ?? []
            let newIDs = next.items.map(\.id)
            let appearanceChanged = presentationID != next.presentationID
            presentationID = next.presentationID
            let changed = newIDs.filter {
                values[$0] != nil && (appearanceChanged || values[$0] != incoming[$0])
            }
            values = incoming
            guard oldIDs != newIDs || !changed.isEmpty else {
                if followsTail { scrollToTail(table) }
                return
            }

            let anchor = readingAnchor(table)
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(newIDs)
            snapshot.reconfigureItems(changed)
            applying = true
            dataSource?.apply(snapshot, animatingDifferences: false) { [weak self, weak table] in
                guard let self, let table else { return }
                table.layoutIfNeeded()
                if self.followsTail {
                    self.scrollToTail(table)
                } else if !table.isDragging, !table.isDecelerating,
                          let anchor, let index = self.dataSource?.indexPath(for: anchor.id) {
                    let offset = table.rectForRow(at: index).minY - anchor.offset
                    table.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
                }
                self.applying = false
                if let pending = self.pending {
                    self.pending = nil
                    self.update(pending, table: table)
                }
            }
        }

        private func readingAnchor(_ table: UITableView) -> (id: String, offset: CGFloat)? {
            guard !followsTail, let index = table.indexPathsForVisibleRows?.first,
                  let id = dataSource?.itemIdentifier(for: index) else { return nil }
            return (id, table.rectForRow(at: index).minY - table.contentOffset.y)
        }

        private func scrollToTail(_ table: UITableView) {
            let offset = max(-table.adjustedContentInset.top,
                table.contentSize.height - table.bounds.height + table.adjustedContentInset.bottom)
            if abs(table.contentOffset.y - offset) > 0.5 {
                table.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            }
        }

        private func publishFollowing(_ value: Bool) {
            guard parent.following != value else { return }
            let binding = parent.$following
            DispatchQueue.main.async { binding.wrappedValue = value }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            followsTail = false
            publishFollowing(false)
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { finishScroll(scrollView) }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { finishScroll(scrollView) }

        private func finishScroll(_ scrollView: UIScrollView) {
            let gap = scrollView.contentSize.height + scrollView.adjustedContentInset.bottom
                - scrollView.contentOffset.y - scrollView.bounds.height
            followsTail = gap < 28
            publishFollowing(followsTail)
        }
    }
}

final class NativeTranscriptTableView: UITableView {
    var afterLayout: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        afterLayout?()
    }
}
