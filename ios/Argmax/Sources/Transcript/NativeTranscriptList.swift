import SwiftUI

/// A lazy SwiftUI transcript that follows live output until the reader moves
/// away from it. Stable row identities let SwiftUI retain the visible reading
/// position when older history arrives above the viewport.
struct NativeTranscriptList<Item: Identifiable & Equatable, Row: View, Footer: View>: View
where Item.ID == String {
    let items: [Item]
    let sessionID: String
    let scrollRequest: Int
    var presentationID = ""
    @Binding var following: Bool
    @ViewBuilder var row: (Item) -> Row
    /// Live state under the last row: the thinking cue. It sits outside the
    /// lazy stack on purpose. A lazy row that comes and goes is sized by the
    /// stack's estimate (the average realised row, hundreds of points) for a
    /// layout pass before it is measured, and following the tail through
    /// that pass is the transcript lurching down and back on every tool
    /// start and finish. A plain footer is measured the moment it appears.
    @ViewBuilder var footer: () -> Footer

    @State private var position = ScrollPosition(idType: String.self)
    // Scroll geometry is read where it is needed and never stored: a state
    // write per scroll frame re-evaluated this body, and with it every
    // realised row's layout, on every frame of a drag.
    @State private var phase: ScrollPhase = .idle
    @State private var tailScrollScheduled = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                LazyVStack(spacing: 0) {
                    ForEach(items) { item in
                        row(item)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Spacing.gutter)
                    }
                }
                .scrollTargetLayout()
                footer()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Spacing.gutter)
            }
            .padding(.top, 16)
            .padding(.bottom, 20)
        }
        // The bottom initial-offset anchor is spent on the first layout, empty
        // or not. Content that lands after an empty first layout would start
        // at the top and be walked to the tail over several frames; a fresh
        // scroll view when the first rows arrive paints once, at the tail.
        .id(items.isEmpty)
        .background(.clear)
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .scrollPosition($position)
        .accessibilityIdentifier("native-transcript")
        .onScrollGeometryChange(for: TranscriptScrollGeometry.self) { value in
            TranscriptScrollGeometry(value)
        } action: { _, next in
            if following && !phase.isUserControlled && !next.isAtTail {
                requestScrollToTail()
            }
        }
        .onScrollPhaseChange { previous, next, context in
            phase = next
            let updated = TranscriptScrollBehavior.following(
                from: previous,
                after: next,
                tailGap: TranscriptScrollGeometry(context.geometry).tailGap,
                current: following
            )
            if following != updated { following = updated }
            if next == .idle && updated {
                requestScrollToTail()
            }
        }
        .onChange(of: following) { _, next in
            if next { requestScrollToTail() }
        }
        .onChange(of: items) { _, _ in
            if following { requestScrollToTail() }
        }
        .onChange(of: presentationID) { _, _ in
            if following { requestScrollToTail() }
        }
        .onChange(of: sessionID, initial: true) { _, _ in
            phase = .idle
            following = true
            requestScrollToTail()
        }
        .onChange(of: scrollRequest) { _, _ in
            following = true
            requestScrollToTail()
        }
    }

    private func requestScrollToTail() {
        guard !tailScrollScheduled else { return }
        tailScrollScheduled = true
        Task { @MainActor in
            await Task.yield()
            if following && !phase.isUserControlled {
                withTransaction(Transaction(animation: nil)) {
                    position.scrollTo(edge: .bottom)
                }
            }
            tailScrollScheduled = false
        }
    }
}

enum TranscriptScrollBehavior {
    static func following(
        from previous: ScrollPhase,
        after phase: ScrollPhase,
        tailGap: CGFloat,
        current: Bool
    ) -> Bool {
        if phase.isUserControlled { return false }
        if phase == .idle && previous.isUserControlled { return tailGap < 28 }
        return current
    }
}

private struct TranscriptScrollGeometry: Equatable {
    var tailGap: CGFloat = 0

    init() {}

    init(_ geometry: ScrollGeometry) {
        tailGap = geometry.contentSize.height + geometry.contentInsets.bottom
            - geometry.visibleRect.maxY
    }

    var isAtTail: Bool { tailGap <= 0.5 }
}

extension NativeTranscriptList where Footer == EmptyView {
    init(
        items: [Item],
        sessionID: String,
        scrollRequest: Int,
        presentationID: String = "",
        following: Binding<Bool>,
        @ViewBuilder row: @escaping (Item) -> Row
    ) {
        self.init(items: items, sessionID: sessionID, scrollRequest: scrollRequest,
                  presentationID: presentationID, following: following, row: row) { EmptyView() }
    }
}

private extension ScrollPhase {
    var isUserControlled: Bool {
        self == .tracking || self == .interacting || self == .decelerating
    }
}
