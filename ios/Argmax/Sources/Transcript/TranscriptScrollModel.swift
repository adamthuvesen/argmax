import SwiftUI

/// Every decision the transcript's scroll view makes, away from SwiftUI so a
/// test can replay an event sequence. `NativeTranscriptList` turns its layout
/// callbacks into `Event`s and carries out the `Effect`s; it decides nothing.
///
/// A class, held in `@State` and never observed: most events arrive once per
/// scroll frame, and a state write per frame re-evaluated the list's body, and
/// with it every realised row's layout, on every frame of a drag. Only
/// `layout` reaches the body, and only when a measurement really moved.
final class TranscriptScrollModel {
    enum Event: Equatable {
        case geometry(previous: TranscriptScrollGeometry, next: TranscriptScrollGeometry)
        case phase(previous: ScrollPhase, next: ScrollPhase, geometry: TranscriptScrollGeometry)
        case followingChanged(Bool)
        case itemsChanged([String])
        case turnFloorChanged
        case turnContextChanged(previous: TranscriptTurnContext, next: TranscriptTurnContext)
        case presentationChanged
        case sessionChanged
        case scrollRequested
        case rowTop(id: String, top: CGFloat)
        case contentHeight(CGFloat)
        /// The yield after `scheduleTailScroll` or `scheduleAnchorScroll` ended.
        case tailScrollDue
        case anchorScrollDue
    }

    enum Effect: Equatable {
        case setFollowing(Bool)
        /// Waits for the layout pass to finish. Issued from inside a geometry
        /// action a scroll is resolved against half-updated content and lands
        /// short.
        case scheduleTailScroll
        case scheduleAnchorScroll
        case scrollToBottom
        case scrollTo(y: CGFloat)
        case loadEarlier
        case loadLater
    }

    /// What the list's props say at the moment of an event.
    struct Inputs: Equatable {
        var turnAnchorID: String?
        var anchorInitialTurn = false
        var hasEarlier = false
        var hasLater = false
        var firstItemID: String?
        var lastItemID: String?
    }

    /// The `following` binding's value. The list copies it in before each event.
    var following = true
    private(set) var layout = TranscriptScrollLayout()
    private let reading = TranscriptReadingPosition()
    private var phase: ScrollPhase = .idle
    private var tailScrollScheduled = false
    private var anchorScrollScheduled = false
    private var turnScrollPending = false
    private var earlierBoundaryRequested: String?
    private var laterBoundaryRequested: String?

    func handle(_ event: Event, _ inputs: Inputs) -> [Effect] {
        var effects: [Effect] = []
        switch event {
        case .geometry(let previous, let next):
            geometryChanged(previous: previous, next: next, inputs, &effects)
        case .phase(let previous, let next, let geometry):
            phaseChanged(previous: previous, next: next, geometry: geometry, inputs, &effects)
        case .followingChanged(let isFollowing):
            guard isFollowing else { break }
            earlierBoundaryRequested = nil
            laterBoundaryRequested = nil
            reading.release()
            requestFollowingPosition(&effects)
        case .itemsChanged(let ids):
            reading.retain(Set(ids))
            if earlierBoundaryRequested != ids.first { earlierBoundaryRequested = nil }
            if laterBoundaryRequested != ids.last { laterBoundaryRequested = nil }
            if following { requestFollowingPosition(&effects) }
        case .turnFloorChanged, .presentationChanged:
            // On a real device the initial bottom request can finish before
            // row and viewport measurements establish the turn floor. Resolve
            // the target again once that reservation becomes concrete.
            if following { requestFollowingPosition(&effects) }
        case .turnContextChanged(let previous, let next):
            // Opening or restoring history establishes a baseline, not a new
            // turn. Only a new prompt in an already-live chat earns a floor.
            guard previous.sessionID == next.sessionID,
                  previous.isReady, next.isReady,
                  previous.anchorID != next.anchorID,
                  let anchorID = next.anchorID else { break }
            layout.activeTurnAnchorID = anchorID
            reading.release()
            turnScrollPending = phase.isUserControlled
            setFollowing(true, &effects)
            requestFollowingPosition(&effects)
        case .sessionChanged:
            layout.activeTurnAnchorID = nil
            earlierBoundaryRequested = nil
            laterBoundaryRequested = nil
            phase = .idle
            setFollowing(true, &effects)
            requestFollowingPosition(&effects)
        case .scrollRequested:
            setFollowing(true, &effects)
            requestFollowingPosition(&effects)
        case .rowTop(let id, let top):
            rowTopChanged(id, top: top, inputs, &effects)
        case .contentHeight(let height):
            if abs(layout.naturalContentHeight - height) > 0.5 { layout.naturalContentHeight = height }
        case .tailScrollDue:
            tailScrollScheduled = false
            guard following, !phase.isUserControlled else { break }
            let reserved = layout.reservedTurnAnchorID(inputs)
            if layout.turnFloorHeight(reservedAnchorID: reserved) > 0,
               let anchor = layout.turnAnchor, anchor.id == reserved {
                // ScrollPosition already includes the top safe-area inset.
                // Adding it again hides the prompt under the header.
                effects.append(.scrollTo(y: anchor.top))
            } else {
                effects.append(.scrollToBottom)
            }
        case .anchorScrollDue:
            anchorScrollScheduled = false
            guard !phase.isUserControlled, let wanted = reading.pendingAnchorOffset() else { break }
            effects.append(.scrollTo(y: wanted + reading.topInset))
        }
        return effects
    }

    private func geometryChanged(
        previous: TranscriptScrollGeometry,
        next: TranscriptScrollGeometry,
        _ inputs: Inputs,
        _ effects: inout [Effect]
    ) {
        reading.visibleTop = next.visibleTop
        reading.topInset = next.topInset
        if abs(layout.viewportHeight - next.viewportHeight) > 0.5 { layout.viewportHeight = next.viewportHeight }
        if abs(layout.topInset - next.topInset) > 0.5 { layout.topInset = next.topInset }
        if abs(layout.bottomInset - next.bottomInset) > 0.5 { layout.bottomInset = next.bottomInset }
        if following && !phase.isUserControlled && !next.isAtTail {
            requestFollowingPosition(&effects)
        }
        requestWindowPage(at: next, whileFollowing: following, inputs, &effects)
        // A scroll whose offset moves without a phase transition (a
        // programmatic offset set) never passes through the phase callback, so
        // the reading anchor would keep pointing at where the reader used to
        // be. Only an offset move re-anchors: when content above the reader
        // changes height the offset is untouched, and re-anchoring there would
        // adopt the walked-down position before the compensation scroll has
        // applied. While a compensation scroll is in flight its own
        // intermediate offsets must not re-anchor, or the anchor lands on
        // whatever row happens to be under the top edge mid-flight.
        if !following && !phase.isUserControlled && !anchorScrollScheduled
            && previous.visibleTop != next.visibleTop {
            reading.anchor(at: next.visibleTop)
        }
    }

    private func phaseChanged(
        previous: ScrollPhase,
        next: ScrollPhase,
        geometry: TranscriptScrollGeometry,
        _ inputs: Inputs,
        _ effects: inout [Effect]
    ) {
        phase = next
        let updated = TranscriptScrollBehavior.following(
            from: previous,
            after: next,
            tailGap: geometry.tailGap,
            current: following,
            turnScrollPending: turnScrollPending,
            hasLater: inputs.hasLater
        )
        setFollowing(updated, &effects)
        guard next == .idle else { return }
        turnScrollPending = false
        if updated {
            requestFollowingPosition(&effects)
        } else {
            reading.anchor(at: geometry.visibleTop)
            requestWindowPage(at: geometry, whileFollowing: false, inputs, &effects)
        }
    }

    private func requestWindowPage(
        at geometry: TranscriptScrollGeometry,
        whileFollowing isFollowing: Bool,
        _ inputs: Inputs,
        _ effects: inout [Effect]
    ) {
        guard !isFollowing, !phase.isUserControlled else { return }
        // Two screens of lead: the window is a few dozen rows, so a page has
        // to land while the reader still has content above them to read.
        let lead = max(240, 2 * geometry.viewportHeight)
        if inputs.hasEarlier, geometry.visibleTop <= lead,
           let boundary = inputs.firstItemID, earlierBoundaryRequested != boundary {
            earlierBoundaryRequested = boundary
            effects.append(.loadEarlier)
            return
        }
        if inputs.hasLater, geometry.tailGap <= lead,
           let boundary = inputs.lastItemID, laterBoundaryRequested != boundary {
            laterBoundaryRequested = boundary
            effects.append(.loadLater)
        }
    }

    /// An eager stack keeps the scroll offset, not the view under it, when
    /// content above the reader changes height: older history landing, or a
    /// card above finishing, would walk the paragraph they are reading down
    /// the screen. Put the anchored row back where it was. Never fight an
    /// active gesture: the tail path checks the same phase, and once the reader
    /// lets go the idle transition re-anchors where they landed.
    private func rowTopChanged(_ id: String, top: CGFloat, _ inputs: Inputs, _ effects: inout [Effect]) {
        if id == inputs.turnAnchorID {
            let next = TranscriptTurnAnchorMeasurement(id: id, top: top)
            if layout.turnAnchor != next { layout.turnAnchor = next }
        }
        let moved = reading.rowTopChanged(id, top: top, following: following)
        guard moved, !phase.isUserControlled, !anchorScrollScheduled else { return }
        anchorScrollScheduled = true
        effects.append(.scheduleAnchorScroll)
    }

    private func requestFollowingPosition(_ effects: inout [Effect]) {
        guard !tailScrollScheduled else { return }
        tailScrollScheduled = true
        effects.append(.scheduleTailScroll)
    }

    private func setFollowing(_ value: Bool, _ effects: inout [Effect]) {
        guard following != value else { return }
        following = value
        effects.append(.setFollowing(value))
    }
}

/// The measurements the list's body reads. Writes keep a half-point dead band,
/// so a settled layout never re-evaluates the body.
struct TranscriptScrollLayout: Equatable {
    var viewportHeight: CGFloat = 0
    var topInset: CGFloat = 0
    var bottomInset: CGFloat = 0
    var naturalContentHeight: CGFloat = 0
    var turnAnchor: TranscriptTurnAnchorMeasurement?
    var activeTurnAnchorID: String?

    var usableViewportHeight: CGFloat {
        max(0, viewportHeight - topInset - bottomInset)
    }

    func reservedTurnAnchorID(_ inputs: TranscriptScrollModel.Inputs) -> String? {
        activeTurnAnchorID ?? (inputs.anchorInitialTurn ? inputs.turnAnchorID : nil)
    }

    /// Whether the scroll view holds its bottom edge still when content
    /// resizes under it. Rows are eager, so a row above the viewport finishing
    /// its Markdown changes its height, and with the content's top held still
    /// every row below walks down the screen until the tail scroll catches up
    /// a frame later. Opening a long chat prepares a document per prose row,
    /// two at a time, so that lands as a burst of visible jumps. Holding the
    /// bottom still while following absorbs them: what is on screen never
    /// moves. A reader who has scrolled away owns the offset through
    /// `TranscriptReadingPosition`, and a chat shorter than the viewport has no
    /// tail to hold, so both keep the top.
    func holdsBottomOnResize(following: Bool) -> Bool {
        following && naturalContentHeight > usableViewportHeight
    }

    /// Keep enough empty tail beneath the latest prompt for the physical
    /// bottom to put that prompt row directly below the header. The row's own
    /// padding separates the bubble from the header without exposing history.
    /// Real output replaces this reservation point for point, then ordinary
    /// tail following takes over once the turn is taller than the viewport.
    func turnFloorHeight(reservedAnchorID: String?) -> CGFloat {
        guard viewportHeight > 0,
              let anchor = turnAnchor,
              anchor.id == reservedAnchorID else { return 0 }
        let reservation = anchor.top + usableViewportHeight - naturalContentHeight
        return min(max(0, reservation), usableViewportHeight)
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

    /// Windowing unmounts rows in both directions. Their last measured tops
    /// must not compete with mounted rows when the next reading anchor is
    /// chosen, or compensation can wait forever on an id that cannot move.
    func retain(_ ids: Set<String>) {
        rowTops = rowTops.filter { ids.contains($0.key) }
        if let anchorID, !ids.contains(anchorID) { release() }
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
        turnScrollPending: Bool = false,
        hasLater: Bool = false
    ) -> Bool {
        if turnScrollPending { return true }
        if phase.isUserControlled { return false }
        if phase == .idle && previous.isUserControlled { return !hasLater && tailGap < 28 }
        return current
    }
}

struct TranscriptScrollGeometry: Equatable {
    var tailGap: CGFloat = 0
    var visibleTop: CGFloat = 0
    var topInset: CGFloat = 0
    var bottomInset: CGFloat = 0
    var viewportHeight: CGFloat = 0

    init(tailGap: CGFloat = 0, visibleTop: CGFloat = 0, topInset: CGFloat = 0, bottomInset: CGFloat = 0, viewportHeight: CGFloat = 0) {
        self.tailGap = tailGap
        self.visibleTop = visibleTop
        self.topInset = topInset
        self.bottomInset = bottomInset
        self.viewportHeight = viewportHeight
    }

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

struct TranscriptTurnAnchorMeasurement: Equatable {
    let id: String
    let top: CGFloat
}

struct TranscriptTurnContext: Equatable {
    let sessionID: String
    let anchorID: String?
    let isReady: Bool
}

private extension ScrollPhase {
    var isUserControlled: Bool {
        self == .tracking || self == .interacting || self == .decelerating
    }
}
