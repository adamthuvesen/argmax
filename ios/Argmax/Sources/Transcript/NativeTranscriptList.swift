import SwiftUI

/// A SwiftUI transcript that follows live output until the reader moves away
/// from it. Stable row identities let SwiftUI retain the visible reading
/// position when older history arrives above the viewport.
struct NativeTranscriptList<Item: Identifiable & Equatable, Row: View, Footer: View>: View
where Item.ID == String {
    let items: [Item]
    let sessionID: String
    let scrollRequest: Int
    var turnAnchorID: String?
    var anchorInitialTurn = false
    var isReady = true
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
    @State private var anchorScrollScheduled = false
    @State private var turnScrollPending = false
    @State private var viewportHeight: CGFloat = 0
    @State private var topInset: CGFloat = 0
    @State private var bottomInset: CGFloat = 0
    @State private var naturalContentHeight: CGFloat = 0
    @State private var turnAnchorMeasurement: TranscriptTurnAnchorMeasurement?
    @State private var activeTurnAnchorID: String?

    private var reservedTurnAnchorID: String? {
        activeTurnAnchorID ?? (anchorInitialTurn ? turnAnchorID : nil)
    }

    private var turnContext: TranscriptTurnContext {
        TranscriptTurnContext(sessionID: sessionID, anchorID: turnAnchorID, isReady: isReady)
    }

    /// Keep enough empty tail beneath the latest prompt for the physical
    /// bottom to put that prompt at the transcript's 16-point top inset.
    /// Real output replaces this reservation point for point, then ordinary
    /// tail following takes over once the turn is taller than the viewport.
    private var turnFloorHeight: CGFloat {
        guard viewportHeight > 0,
              let anchor = turnAnchorMeasurement,
              anchor.id == reservedTurnAnchorID else { return 0 }
        let usableViewportHeight = max(0, viewportHeight - topInset - bottomInset)
        let reservation = anchor.top - 16 + usableViewportHeight - naturalContentHeight
        return min(max(0, reservation), usableViewportHeight)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                VStack(spacing: 0) {
                    // Not a `LazyVStack`. A lazy stack sizes every row it has
                    // not realised at the average of the ones it has, and a
                    // chat is a few short rows around one very tall answer,
                    // so that average is thousands of points off. Eager rows
                    // have exact heights, so the content end is real.
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
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    if abs(naturalContentHeight - height) > 0.5 { naturalContentHeight = height }
                }
                Color.clear.frame(height: turnFloorHeight)
            }
            .coordinateSpace(name: Self.contentSpace)
        }
        // The bottom initial-offset anchor is spent on the first layout, empty
        // or not. Content that lands after an empty first layout would start
        // at the top and be walked to the tail over several frames; a fresh
        // scroll view when the first rows arrive paints once, at the tail.
        .id(items.isEmpty)
        .background(.clear)
        // A transcript drag is a reading gesture, so give the screen back to
        // the conversation immediately. Interactive dismissal can stop
        // between keyboard frames and leave the manually inset composer
        // stranded above the bottom edge.
        .scrollDismissesKeyboard(.immediately)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.top, for: .alignment)
        .scrollPosition($position)
        .accessibilityIdentifier("native-transcript")
        .onScrollGeometryChange(for: TranscriptScrollGeometry.self) { value in
            TranscriptScrollGeometry(value)
        } action: { previous, next in
            readingPosition.visibleTop = next.visibleTop
            readingPosition.topInset = next.topInset
            if abs(viewportHeight - next.viewportHeight) > 0.5 { viewportHeight = next.viewportHeight }
            if abs(topInset - next.topInset) > 0.5 { topInset = next.topInset }
            if abs(bottomInset - next.bottomInset) > 0.5 { bottomInset = next.bottomInset }
            if following && !phase.isUserControlled && !next.isAtTail {
                requestFollowingPosition()
            }
            // A scroll whose offset moves without a phase transition (a
            // programmatic offset set) never passes through
            // `onScrollPhaseChange`, so the reading anchor would keep
            // pointing at where the reader used to be. Only an offset move
            // re-anchors: when content above the reader changes height the
            // offset is untouched, and re-anchoring there would adopt the
            // walked-down position before the compensation scroll has
            // applied. While a compensation scroll is in flight its own
            // intermediate offsets must not re-anchor, or the anchor lands
            // on whatever row happens to be under the top edge mid-flight.
            if !following && !phase.isUserControlled && !anchorScrollScheduled
                && previous.visibleTop != next.visibleTop {
                readingPosition.anchor(at: next.visibleTop)
            }
        }
        .onScrollPhaseChange { previous, next, context in
            phase = next
            let updated = TranscriptScrollBehavior.following(
                from: previous,
                after: next,
                tailGap: TranscriptScrollGeometry(context.geometry).tailGap,
                current: following,
                turnScrollPending: turnScrollPending
            )
            if following != updated { following = updated }
            if next == .idle {
                turnScrollPending = false
                if updated {
                    requestFollowingPosition()
                } else {
                    readingPosition.anchor(at: context.geometry.visibleRect.minY)
                }
            }
        }
        .onChange(of: following) { _, next in
            if next {
                readingPosition.release()
                requestFollowingPosition()
            }
        }
        .onChange(of: items) { _, _ in
            if following { requestFollowingPosition() }
        }
        .onChange(of: turnFloorHeight) { _, _ in
            // On a real device the initial bottom request can finish before
            // row and viewport measurements establish the turn floor. Resolve
            // the target again once that reservation becomes concrete.
            if following { requestFollowingPosition() }
        }
        .onChange(of: turnContext) { previous, next in
            // Opening or restoring history establishes a baseline, not a new
            // turn. Only a new prompt in an already-live chat earns a floor.
            guard previous.sessionID == next.sessionID,
                  previous.isReady, next.isReady,
                  previous.anchorID != next.anchorID,
                  let anchorID = next.anchorID else { return }
            activeTurnAnchorID = anchorID
            readingPosition.release()
            turnScrollPending = phase.isUserControlled
            if !following { following = true }
            requestFollowingPosition()
        }
        .onChange(of: presentationID) { _, _ in
            if following { requestFollowingPosition() }
        }
        .onChange(of: sessionID, initial: true) { _, _ in
            activeTurnAnchorID = nil
            phase = .idle
            following = true
            requestFollowingPosition()
        }
        .onChange(of: scrollRequest) { _, _ in
            following = true
            requestFollowingPosition()
        }
    }

    /// An eager stack keeps the scroll offset, not the view under it, when
    /// content above the reader changes height: older history landing, or a
    /// card above finishing, would walk the paragraph they are reading down
    /// the screen. Put the anchored row back where it was. The write waits
    /// for the layout pass to finish: issued from inside a geometry action
    /// it is resolved against the half-updated content and lands short. And
    /// never fight an active gesture: the tail path checks the same phase,
    /// and once the reader lets go the idle transition re-anchors where
    /// they landed.
    private func rowTopChanged(_ id: String, top: CGFloat) {
        if id == turnAnchorID {
            let next = TranscriptTurnAnchorMeasurement(id: id, top: top)
            if turnAnchorMeasurement != next { turnAnchorMeasurement = next }
        }
        let moved = readingPosition.rowTopChanged(id, top: top, following: following)
        guard moved, !phase.isUserControlled, !anchorScrollScheduled else { return }
        anchorScrollScheduled = true
        Task { @MainActor in
            await Task.yield()
            anchorScrollScheduled = false
            guard !phase.isUserControlled, let wanted = readingPosition.pendingAnchorOffset() else { return }
            withTransaction(Transaction(animation: nil)) {
                position.scrollTo(y: wanted + readingPosition.topInset)
            }
        }
    }

    private func requestFollowingPosition() {
        guard !tailScrollScheduled else { return }
        tailScrollScheduled = true
        Task { @MainActor in
            await Task.yield()
            if following && !phase.isUserControlled {
                withTransaction(Transaction(animation: nil)) {
                    if turnFloorHeight > 0,
                       let anchor = turnAnchorMeasurement,
                       anchor.id == reservedTurnAnchorID {
                        // ScrollPosition already includes the top safe-area
                        // inset. Adding it again hides the prompt under the header.
                        position.scrollTo(y: anchor.top - 16)
                    } else {
                        position.scrollTo(edge: .bottom)
                    }
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
    /// The scroll view's top content inset. `ScrollPosition.scrollTo(y:)`
    /// measures from the inset-inclusive origin while row tops and the
    /// geometry's visible rect measure from the content origin, so a
    /// compensation scroll has to add it or lands short by exactly the inset.
    var topInset: CGFloat = 0

    /// Anchor on the row under the top of the viewport.
    func anchor(at visibleTop: CGFloat) {
        self.visibleTop = visibleTop
        pendingCompensation = false
        guard let row = rowTops.filter({ $0.value <= visibleTop }).max(by: { $0.value < $1.value })
            ?? rowTops.min(by: { $0.value < $1.value }) else { return }
        anchorID = row.key
        anchorOffset = row.value - visibleTop
    }

    func release() {
        anchorID = nil
        pendingCompensation = false
    }

    /// The offset that puts the anchored row back, when this change moved it.
    /// Returns whether the anchored row moved and a compensation is due;
    /// `pendingAnchorOffset` resolves it from the latest recorded tops, so
    /// the scroll is computed against finished layout, not a mid-update one.
    func rowTopChanged(_ id: String, top: CGFloat, following: Bool) -> Bool {
        rowTops[id] = top
        guard !following, id == anchorID else { return false }
        let moved = abs(top - anchorOffset - visibleTop) > 0.5
        if moved { pendingCompensation = true }
        return moved
    }

    private var pendingCompensation = false

    func pendingAnchorOffset() -> CGFloat? {
        guard pendingCompensation, let anchorID, let top = rowTops[anchorID] else { return nil }
        pendingCompensation = false
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
        current: Bool,
        turnScrollPending: Bool = false
    ) -> Bool {
        if turnScrollPending { return true }
        if phase.isUserControlled { return false }
        if phase == .idle && previous.isUserControlled { return tailGap < 28 }
        return current
    }
}

private struct TranscriptScrollGeometry: Equatable {
    var tailGap: CGFloat = 0
    var visibleTop: CGFloat = 0
    var topInset: CGFloat = 0
    var bottomInset: CGFloat = 0
    var viewportHeight: CGFloat = 0

    init() {}

    init(_ geometry: ScrollGeometry) {
        visibleTop = geometry.visibleRect.minY
        tailGap = geometry.contentSize.height + geometry.contentInsets.bottom
            - geometry.visibleRect.maxY
        topInset = geometry.contentInsets.top
        bottomInset = geometry.contentInsets.bottom
        viewportHeight = geometry.visibleRect.height
    }

    var isAtTail: Bool { tailGap <= 0.5 }
}

private struct TranscriptTurnAnchorMeasurement: Equatable {
    let id: String
    let top: CGFloat
}

private struct TranscriptTurnContext: Equatable {
    let sessionID: String
    let anchorID: String?
    let isReady: Bool
}

extension NativeTranscriptList where Footer == EmptyView {
    init(
        items: [Item],
        sessionID: String,
        scrollRequest: Int,
        turnAnchorID: String? = nil,
        anchorInitialTurn: Bool = false,
        isReady: Bool = true,
        presentationID: String = "",
        following: Binding<Bool>,
        @ViewBuilder row: @escaping (Item) -> Row
    ) {
        self.init(items: items, sessionID: sessionID, scrollRequest: scrollRequest,
                  turnAnchorID: turnAnchorID, anchorInitialTurn: anchorInitialTurn, isReady: isReady,
                  presentationID: presentationID, following: following, row: row) { EmptyView() }
    }
}

private extension ScrollPhase {
    var isUserControlled: Bool {
        self == .tracking || self == .interacting || self == .decelerating
    }
}
