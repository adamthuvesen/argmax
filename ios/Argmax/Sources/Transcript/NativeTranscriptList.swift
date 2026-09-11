import SwiftUI

/// A SwiftUI transcript that follows live output until the reader moves away
/// from it. Stable row identities let SwiftUI retain the visible reading
/// position when older history arrives above the viewport.
struct NativeTranscriptList<Item: Identifiable & Equatable, Row: View, Footer: View>: View
where Item.ID == String {
    let items: [Item]
    let sessionID: String
    let scrollRequest: Int
    var presentationID = ""
    @Binding var following: Bool
    @ViewBuilder var row: (Item) -> Row
    /// Live state under the last row: the thinking cue. It is not a row, so
    /// its coming and going never changes row identities or the tail scroll's
    /// target.
    @ViewBuilder var footer: () -> Footer

    @State private var position = ScrollPosition(idType: String.self)
    // Row tops and the reading anchor live outside SwiftUI state: they are
    // written from layout callbacks and only ever read to restore a scroll
    // offset, so they must not re-evaluate this body when they change.
    @State private var readingPosition = TranscriptReadingPosition()
    private static var contentSpace: String { "transcript-content" }
    // Scroll geometry is read where it is needed and never stored: a state
    // write per scroll frame re-evaluated this body, and with it every
    // realised row's layout, on every frame of a drag.
    @State private var phase: ScrollPhase = .idle
    @State private var tailScrollScheduled = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Not a `LazyVStack`. A lazy stack sizes every row it has not
                // realised at the average of the ones it has, and a chat is a
                // few short rows around one very tall answer, so that average
                // is thousands of points off. The content height it reports
                // is the sum of those guesses; the tail scroll lands at that
                // guessed end, past the real last row, and the viewport shows
                // the empty remainder of an over-estimated slot with nothing
                // left to realise and correct it. Seen as an opened or
                // just-sent chat that is blank until it is scrolled by hand.
                // Eager rows have exact heights, so the content end is real.
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        row(item)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Spacing.gutter)
                            .onGeometryChange(for: CGFloat.self) {
                                $0.frame(in: .named(Self.contentSpace)).minY
                            } action: { top in
                                rowTopChanged(item.id, top: top)
                            }
                    }
                }
                .scrollTargetLayout()
                footer()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Spacing.gutter)
            }
            .padding(.top, 16)
            .padding(.bottom, 20)
            .coordinateSpace(name: Self.contentSpace)
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
            readingPosition.visibleTop = next.visibleTop
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
            if next == .idle {
                if updated {
                    requestScrollToTail()
                } else {
                    readingPosition.anchor(at: context.geometry.visibleRect.minY)
                }
            }
        }
        .onChange(of: following) { _, next in
            if next {
                readingPosition.release()
                requestScrollToTail()
            }
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

    /// An eager stack keeps the scroll offset, not the view under it, when
    /// content above the reader changes height: older history landing, or a
    /// card above finishing, would walk the paragraph they are reading down
    /// the screen. Put the anchored row back where it was.
    private func rowTopChanged(_ id: String, top: CGFloat) {
        guard let wanted = readingPosition.rowTopChanged(id, top: top, following: following) else { return }
        withTransaction(Transaction(animation: nil)) {
            position.scrollTo(y: wanted)
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

/// The row the reader is on while detached from the tail, and where it sat in
/// the viewport, in scroll-content coordinates.
final class TranscriptReadingPosition {
    private var rowTops: [String: CGFloat] = [:]
    private var anchorID: String?
    private var anchorOffset: CGFloat = 0
    var visibleTop: CGFloat = 0

    /// Anchor on the row under the top of the viewport.
    func anchor(at visibleTop: CGFloat) {
        self.visibleTop = visibleTop
        guard let row = rowTops.filter({ $0.value <= visibleTop }).max(by: { $0.value < $1.value })
            ?? rowTops.min(by: { $0.value < $1.value }) else { return }
        anchorID = row.key
        anchorOffset = row.value - visibleTop
    }

    func release() { anchorID = nil }

    /// The offset that puts the anchored row back, when this change moved it.
    func rowTopChanged(_ id: String, top: CGFloat, following: Bool) -> CGFloat? {
        rowTops[id] = top
        guard !following, id == anchorID else { return nil }
        let wanted = top - anchorOffset
        guard abs(wanted - visibleTop) > 0.5 else { return nil }
        return wanted
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
    var visibleTop: CGFloat = 0

    init() {}

    init(_ geometry: ScrollGeometry) {
        visibleTop = geometry.visibleRect.minY
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
