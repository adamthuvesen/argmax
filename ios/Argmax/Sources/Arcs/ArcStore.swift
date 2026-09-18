import Foundation

/// One Arc screen's reads: `arc:get` and the timeline's pages, plus the one
/// write the phone makes, `arc:set-state`.
///
/// Per screen rather than on `DashboardStore`: the detail belongs to one
/// pushed page, and the list must not re-render for it. The screen decides
/// when to refetch from the dashboard's own rows (`ArcScreen.detailKey` and
/// `timelineKey`), the same keys the desktop Arc page follows, so nothing
/// here polls.
@MainActor
final class ArcStore: ObservableObject {
    @Published private(set) var detail: ArcDetail?
    @Published private(set) var failure: String?
    /// Nil until the first page lands.
    @Published private(set) var events: [ArcTimelineEvent]?
    @Published private(set) var cursor: ArcTimelineCursor?
    @Published private(set) var timelineFailure: String?
    @Published private(set) var loadingEarlier = false
    @Published private(set) var changingState = false

    let arcID: String
    private let client: BridgeClient
    static let pageSize = 60

    init(arcID: String, client: BridgeClient) {
        self.arcID = arcID
        self.client = client
    }

    func loadDetail() async {
        do {
            detail = try await client.arcDetail(id: arcID)
            failure = nil
        } catch is CancellationError {
        } catch {
            failure = hostFailureMessage(error)
        }
    }

    /// The newest page, keeping as many rows as have already been paged in so
    /// a refresh never shortens what the reader scrolled through.
    func loadTimeline() async {
        do {
            let page = try await client.arcTimeline(
                arcID: arcID,
                before: nil,
                limit: max(Self.pageSize, events?.count ?? 0)
            )
            events = page.events
            cursor = page.nextCursor
            timelineFailure = nil
        } catch is CancellationError {
        } catch {
            timelineFailure = hostFailureMessage(error)
        }
    }

    func loadEarlier() async {
        guard let cursor, !loadingEarlier else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        do {
            let page = try await client.arcTimeline(arcID: arcID, before: cursor, limit: Self.pageSize)
            events = (events ?? []) + page.events
            self.cursor = page.nextCursor
            timelineFailure = nil
        } catch {
            timelineFailure = hostFailureMessage(error)
        }
    }

    /// Answers whether the host took it. The record it returns replaces the
    /// arc in place; the dashboard hint that follows refetches the rest.
    @discardableResult
    func setState(_ state: ArcState) async -> Bool {
        guard !changingState else { return false }
        changingState = true
        defer { changingState = false }
        do {
            let record = try await client.setArcState(id: arcID, state: state)
            detail?.arc = record
            failure = nil
            return true
        } catch {
            failure = hostFailureMessage(error)
            return false
        }
    }
}

#if DEBUG
extension ArcStore {
    /// Previews only: the rows `arc:get` and `arc:timeline` would have sent.
    func seed(detail: ArcDetail, events: [ArcTimelineEvent], cursor: ArcTimelineCursor?) {
        self.detail = detail
        self.events = events
        self.cursor = cursor
    }
}
#endif
