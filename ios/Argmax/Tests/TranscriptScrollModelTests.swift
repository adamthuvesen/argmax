import SwiftUI
import XCTest
@testable import Argmax

/// Two kinds of event sequence. The `scroll-*.json` fixtures were recorded from
/// the real list in hosted `NativeTranscriptListTests` runs, so replaying one
/// pins every decision the list made in that run. A hosted test cannot perform
/// a gesture during layout, so the sequences written out below cover the races
/// a reader's drag causes, named after the fix each one came from.
final class TranscriptScrollModelTests: XCTestCase {
    private typealias Model = TranscriptScrollModel
    private typealias Geometry = TranscriptScrollGeometry

    // MARK: - Recorded

    private struct Recording: Decodable {
        struct Step: Decodable {
            var following: Bool
            var event: RecordedEvent
            var inputs: RecordedInputs
            var effects: [String]
            var holdsBottom: Bool
            var turnFloor: CGFloat
        }
        var recordedFrom: String
        var steps: [Step]
    }

    private struct RecordedInputs: Decodable {
        var turnAnchorID: String?
        var anchorInitialTurn: Bool
        var hasEarlier: Bool
        var hasLater: Bool
        var firstItemID: String?
        var lastItemID: String?

        var inputs: Model.Inputs {
            Model.Inputs(turnAnchorID: turnAnchorID, anchorInitialTurn: anchorInitialTurn, hasEarlier: hasEarlier,
                         hasLater: hasLater, firstItemID: firstItemID, lastItemID: lastItemID)
        }
    }

    private struct RecordedEvent: Decodable {
        struct RecordedGeometry: Decodable {
            var tailGap, visibleTop, topInset, bottomInset, viewportHeight: CGFloat
            var geometry: Geometry {
                Geometry(tailGap: tailGap, visibleTop: visibleTop, topInset: topInset,
                         bottomInset: bottomInset, viewportHeight: viewportHeight)
            }
        }
        struct RecordedContext: Decodable {
            var sessionID: String
            var anchorID: String?
            var isReady: Bool
            var context: TranscriptTurnContext {
                TranscriptTurnContext(sessionID: sessionID, anchorID: anchorID, isReady: isReady)
            }
        }
        enum Keys: String, CodingKey { case kind, previous, next, geometry, value, ids, id, top }

        let event: Model.Event

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: Keys.self)
            func phase(_ key: Keys) throws -> ScrollPhase {
                switch try values.decode(String.self, forKey: key) {
                case "tracking": return .tracking
                case "interacting": return .interacting
                case "decelerating": return .decelerating
                case "animating": return .animating
                default: return .idle
                }
            }
            switch try values.decode(String.self, forKey: .kind) {
            case "geometry":
                event = .geometry(previous: try values.decode(RecordedGeometry.self, forKey: .previous).geometry,
                                  next: try values.decode(RecordedGeometry.self, forKey: .next).geometry)
            case "phase":
                event = .phase(previous: try phase(.previous), next: try phase(.next),
                               geometry: try values.decode(RecordedGeometry.self, forKey: .geometry).geometry)
            case "followingChanged": event = .followingChanged(try values.decode(Bool.self, forKey: .value))
            case "itemsChanged": event = .itemsChanged(try values.decode([String].self, forKey: .ids))
            case "turnFloorChanged": event = .turnFloorChanged
            case "turnContextChanged":
                event = .turnContextChanged(previous: try values.decode(RecordedContext.self, forKey: .previous).context,
                                            next: try values.decode(RecordedContext.self, forKey: .next).context)
            case "presentationChanged": event = .presentationChanged
            case "sessionChanged": event = .sessionChanged
            case "scrollRequested": event = .scrollRequested
            case "rowTop": event = .rowTop(id: try values.decode(String.self, forKey: .id), top: try values.decode(CGFloat.self, forKey: .top))
            case "contentHeight": event = .contentHeight(try values.decode(CGFloat.self, forKey: .value))
            case "tailScrollDue": event = .tailScrollDue
            case "anchorScrollDue": event = .anchorScrollDue
            case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: values, debugDescription: kind)
            }
        }
    }

    private func recordedName(_ effect: Model.Effect) -> String {
        switch effect {
        case .setFollowing(let value): return "setFollowing:\(value)"
        case .scheduleTailScroll: return "scheduleTailScroll"
        case .scheduleAnchorScroll: return "scheduleAnchorScroll"
        case .scrollToBottom: return "scrollToBottom"
        case .scrollTo(let y): return "scrollTo:\(y)"
        case .loadEarlier: return "loadEarlier"
        case .loadLater: return "loadLater"
        }
    }

    private func replay(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"), file: file, line: line)
        let recording = try JSONDecoder().decode(Recording.self, from: Data(contentsOf: url))
        XCTAssertFalse(recording.steps.isEmpty, file: file, line: line)
        let model = Model()
        for (index, step) in recording.steps.enumerated() {
            model.following = step.following
            let inputs = step.inputs.inputs
            let effects = model.handle(step.event.event, inputs)
            let context = "\(name) step \(index): \(step.event.event)"
            XCTAssertEqual(effects.map(recordedName), step.effects, context, file: file, line: line)
            XCTAssertEqual(model.layout.holdsBottomOnResize(following: model.following), step.holdsBottom, context, file: file, line: line)
            XCTAssertEqual(model.layout.turnFloorHeight(reservedAnchorID: model.layout.reservedTurnAnchorID(inputs)),
                           step.turnFloor, accuracy: 0.001, context, file: file, line: line)
        }
    }

    func testRecordedDetachedHistoryChange() throws { try replay("scroll-detached-history") }
    func testRecordedSteeringWhileDetached() throws { try replay("scroll-steering-detached") }
    func testRecordedNewTurn() throws { try replay("scroll-new-turn") }
    func testRecordedShortChat() throws { try replay("scroll-short-chat") }
    func testRecordedLoadingHistory() throws { try replay("scroll-loading-history") }
    func testRecordedLaunchedChat() throws { try replay("scroll-launched-chat") }

    // MARK: - Written out

    private func geometry(top: CGFloat = 0, tailGap: CGFloat = 500, inset: CGFloat = 0, height: CGFloat = 400) -> Geometry {
        Geometry(tailGap: tailGap, visibleTop: top, topInset: inset, viewportHeight: height)
    }

    /// A reader detached at `top`, with rows every 100 points, anchored at `top`.
    private func detachedModel(top: CGFloat = 500, inset: CGFloat = 0) -> (Model, Model.Inputs) {
        let model = Model()
        let inputs = Model.Inputs()
        model.following = false
        for row in 0..<10 { _ = model.handle(.rowTop(id: "row-\(row)", top: CGFloat(row) * 100), inputs) }
        _ = model.handle(.geometry(previous: geometry(top: top, inset: inset), next: geometry(top: top, inset: inset)), inputs)
        _ = model.handle(.phase(previous: .interacting, next: .idle, geometry: geometry(top: top, inset: inset)), inputs)
        return (model, inputs)
    }

    /// ac26da64: an offset that moves while idle and detached re-anchors.
    func testAnOffsetMoveWithoutAPhaseReanchors() {
        let (model, inputs) = detachedModel()
        _ = model.handle(.geometry(previous: geometry(top: 500), next: geometry(top: 300)), inputs)
        XCTAssertEqual(model.handle(.rowTop(id: "row-3", top: 350), inputs), [.scheduleAnchorScroll])
        XCTAssertEqual(model.handle(.anchorScrollDue, inputs), [.scrollTo(y: 350)])
    }

    /// ac26da64: content moving under an unmoved offset compensates rather
    /// than adopting the walked-down position.
    func testAContentMoveUnderAStillOffsetCompensates() {
        let (model, inputs) = detachedModel()
        _ = model.handle(.geometry(previous: geometry(top: 500, tailGap: 500), next: geometry(top: 500, tailGap: 700)), inputs)
        XCTAssertEqual(model.handle(.rowTop(id: "row-5", top: 700), inputs), [.scheduleAnchorScroll])
        XCTAssertEqual(model.handle(.anchorScrollDue, inputs), [.scrollTo(y: 700)])
    }

    /// ac26da64: a compensation scroll never fights an active gesture.
    func testACompensationWaitsOutAGesture() {
        let (model, inputs) = detachedModel()
        _ = model.handle(.phase(previous: .idle, next: .tracking, geometry: geometry(top: 500)), inputs)
        XCTAssertEqual(model.handle(.rowTop(id: "row-5", top: 700), inputs), [])
        XCTAssertEqual(model.handle(.anchorScrollDue, inputs), [])
        // Letting go re-anchors where the reader landed: nothing to put back.
        _ = model.handle(.phase(previous: .tracking, next: .idle, geometry: geometry(top: 700)), inputs)
        XCTAssertEqual(model.handle(.anchorScrollDue, inputs), [])
    }

    /// ac26da64: a gesture starting while a compensation is pending wins it.
    func testAGestureCancelsAScheduledCompensation() {
        let (model, inputs) = detachedModel()
        XCTAssertEqual(model.handle(.rowTop(id: "row-5", top: 700), inputs), [.scheduleAnchorScroll])
        _ = model.handle(.phase(previous: .idle, next: .tracking, geometry: geometry(top: 500)), inputs)
        XCTAssertEqual(model.handle(.anchorScrollDue, inputs), [])
    }

    /// ac26da64: the compensation's own intermediate offsets do not re-anchor.
    func testACompensationInFlightIgnoresItsOwnOffsets() {
        let (model, inputs) = detachedModel()
        XCTAssertEqual(model.handle(.rowTop(id: "row-5", top: 700), inputs), [.scheduleAnchorScroll])
        XCTAssertEqual(model.handle(.rowTop(id: "row-5", top: 800), inputs), [], "One write at a time")
        _ = model.handle(.geometry(previous: geometry(top: 500), next: geometry(top: 620)), inputs)
        XCTAssertEqual(model.handle(.anchorScrollDue, inputs), [.scrollTo(y: 800)],
                       "The anchor stays on the row the reader was on")
    }

    /// ac26da64: `ScrollPosition.scrollTo(y:)` measures from the inset-inclusive
    /// origin, so a compensation adds the top inset or lands short by it.
    func testACompensationAddsTheTopInset() {
        let (model, inputs) = detachedModel(inset: 100)
        XCTAssertEqual(model.handle(.rowTop(id: "row-5", top: 700), inputs), [.scheduleAnchorScroll])
        XCTAssertEqual(model.handle(.anchorScrollDue, inputs), [.scrollTo(y: 800)])
    }

    /// 6add8ead: the turn floor targets the prompt, capped at one usable
    /// viewport, and a bottom request can never land on the empty reservation.
    func testTheTurnFloorTargetsThePromptAndIsCapped() {
        let model = Model()
        let inputs = Model.Inputs(turnAnchorID: "prompt")
        let live = TranscriptTurnContext(sessionID: "s", anchorID: nil, isReady: true)
        _ = model.handle(.geometry(previous: geometry(), next: Geometry(tailGap: 0, topInset: 50, bottomInset: 50, viewportHeight: 500)), inputs)
        _ = model.handle(.turnContextChanged(previous: live, next: TranscriptTurnContext(sessionID: "s", anchorID: "prompt", isReady: true)), inputs)
        _ = model.handle(.tailScrollDue, inputs)
        _ = model.handle(.rowTop(id: "prompt", top: 900), inputs)
        _ = model.handle(.contentHeight(1000), inputs)
        XCTAssertEqual(model.layout.turnFloorHeight(reservedAnchorID: "prompt"), 300)
        XCTAssertEqual(model.handle(.tailScrollDue, inputs), [.scrollTo(y: 900)])
        _ = model.handle(.contentHeight(100), inputs)
        XCTAssertEqual(model.layout.turnFloorHeight(reservedAnchorID: "prompt"), 400, "Never more than one usable viewport")
        _ = model.handle(.contentHeight(1500), inputs)
        XCTAssertEqual(model.layout.turnFloorHeight(reservedAnchorID: "prompt"), 0)
        XCTAssertEqual(model.handle(.tailScrollDue, inputs), [.scrollToBottom], "Real output takes over from the floor")
    }

    /// 6add8ead: a measurement arriving after the first tail scroll resolves
    /// the target again.
    func testALateFloorRequestsTheFollowingPositionAgain() {
        let model = Model()
        XCTAssertEqual(model.handle(.turnFloorChanged, .init()), [.scheduleTailScroll])
        model.following = false
        _ = model.handle(.tailScrollDue, .init())
        XCTAssertEqual(model.handle(.turnFloorChanged, .init()), [])
    }

    /// 6370cc32: a chat shorter than the viewport keeps its top. A reader who
    /// detached keeps it too. Only a following chat that overflows holds the bottom.
    func testOnlyAFollowingChatThatOverflowsHoldsItsBottom() {
        let model = Model()
        _ = model.handle(.geometry(previous: geometry(), next: Geometry(tailGap: 0, topInset: 100, bottomInset: 100, viewportHeight: 800)), .init())
        _ = model.handle(.contentHeight(500), .init())
        XCTAssertFalse(model.layout.holdsBottomOnResize(following: true))
        _ = model.handle(.contentHeight(700), .init())
        XCTAssertTrue(model.layout.holdsBottomOnResize(following: true))
        XCTAssertFalse(model.layout.holdsBottomOnResize(following: false))
    }

    /// 01e31641: restoring history is a baseline, not a new turn. The store's
    /// half of that fix, holding back partial pages, is in TranscriptStoreTests.
    func testHistoryArrivingIsNotANewTurn() {
        let model = Model()
        model.following = false
        let loading = TranscriptTurnContext(sessionID: "s", anchorID: nil, isReady: false)
        let loaded = TranscriptTurnContext(sessionID: "s", anchorID: "prompt", isReady: true)
        XCTAssertEqual(model.handle(.turnContextChanged(previous: loading, next: loaded), .init()), [])
        XCTAssertNil(model.layout.activeTurnAnchorID)
        let otherChat = TranscriptTurnContext(sessionID: "t", anchorID: "other", isReady: true)
        XCTAssertEqual(model.handle(.turnContextChanged(previous: loaded, next: otherChat), .init()), [])
        XCTAssertFalse(model.following)
    }

    func testANewTurnDuringAGestureKeepsFollowingWhenTheGestureEnds() {
        let model = Model()
        let inputs = Model.Inputs(turnAnchorID: "next")
        _ = model.handle(.phase(previous: .idle, next: .tracking, geometry: geometry()), inputs)
        XCTAssertFalse(model.following)
        let before = TranscriptTurnContext(sessionID: "s", anchorID: "prompt", isReady: true)
        let after = TranscriptTurnContext(sessionID: "s", anchorID: "next", isReady: true)
        XCTAssertEqual(model.handle(.turnContextChanged(previous: before, next: after), inputs),
                       [.setFollowing(true), .scheduleTailScroll])
        XCTAssertEqual(model.handle(.tailScrollDue, inputs), [], "The tail scroll never fights a gesture")
        XCTAssertEqual(model.handle(.phase(previous: .tracking, next: .idle, geometry: geometry(top: 300)), inputs),
                       [.scheduleTailScroll])
        XCTAssertEqual(model.handle(.tailScrollDue, inputs), [.scrollToBottom])
    }

    func testAWindowPageIsRequestedOncePerBoundary() {
        let (model, _) = detachedModel(top: 900)
        let inputs = Model.Inputs(hasEarlier: true, firstItemID: "row-0")
        let near = geometry(top: 700)
        XCTAssertEqual(model.handle(.geometry(previous: geometry(top: 900), next: near), inputs), [.loadEarlier])
        XCTAssertEqual(model.handle(.geometry(previous: near, next: near), inputs), [], "Asked once for this boundary")
        _ = model.handle(.itemsChanged(["row-older"]), Model.Inputs(hasEarlier: true, firstItemID: "row-older"))
        XCTAssertEqual(model.handle(.geometry(previous: near, next: near), Model.Inputs(hasEarlier: true, firstItemID: "row-older")),
                       [.loadEarlier], "A new first row is a new boundary")
    }

    func testAPageNeverLandsDuringAGestureOrWhileFollowing() {
        let (model, _) = detachedModel(top: 900)
        let inputs = Model.Inputs(hasEarlier: true, firstItemID: "row-0")
        _ = model.handle(.phase(previous: .idle, next: .tracking, geometry: geometry(top: 900)), .init())
        XCTAssertEqual(model.handle(.geometry(previous: geometry(top: 900), next: geometry(top: 100)), inputs), [])
        XCTAssertEqual(model.handle(.phase(previous: .tracking, next: .idle, geometry: geometry(top: 100)), inputs), [.loadEarlier])
        model.following = true
        XCTAssertEqual(model.handle(.followingChanged(true), .init()), [.scheduleTailScroll])
    }

    func testOpeningASessionReturnsToTheTailAndForgetsTheTurn() {
        let (model, inputs) = detachedModel()
        XCTAssertEqual(model.handle(.sessionChanged, inputs), [.setFollowing(true), .scheduleTailScroll])
        XCTAssertNil(model.layout.activeTurnAnchorID)
        XCTAssertEqual(model.handle(.tailScrollDue, inputs), [.scrollToBottom])
    }

    func testAJumpToLatestReleasesTheReader() {
        let (model, inputs) = detachedModel()
        XCTAssertEqual(model.handle(.scrollRequested, inputs), [.setFollowing(true), .scheduleTailScroll])
        _ = model.handle(.followingChanged(true), inputs)
        XCTAssertEqual(model.handle(.rowTop(id: "row-5", top: 900), inputs), [], "Nothing left to put back")
    }

    func testRepeatedRequestsScheduleOneTailScroll() {
        let model = Model()
        XCTAssertEqual(model.handle(.presentationChanged, .init()), [.scheduleTailScroll])
        XCTAssertEqual(model.handle(.itemsChanged(["row"]), .init()), [])
        XCTAssertEqual(model.handle(.tailScrollDue, .init()), [.scrollToBottom])
        XCTAssertEqual(model.handle(.itemsChanged(["row", "next"]), .init()), [.scheduleTailScroll])
    }
}
