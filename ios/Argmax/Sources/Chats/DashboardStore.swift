import Combine
import Foundation
import OSLog

/// The chat list's model: one snapshot, kept current by deltas.
///
/// SQLite-first and delta-driven, the same contract the desktop keeps — one
/// `dashboard:list` at start and then `dashboard:delta` frames, with no
/// recurring poll. A `resync` frame means the host dropped events for this
/// client, so the snapshot is reloaded rather than patched.
@MainActor
final class DashboardStore: ObservableObject {
    @Published private(set) var snapshot = DashboardSnapshot()
    @Published private(set) var sections = ChatSections()
    @Published private(set) var connection: BridgeConnection = .connecting
    /// Why the last load failed, cleared by the next one that works. The
    /// list keeps its rows: stale chats read better than an empty screen.
    @Published private(set) var loadFailure: BridgeError?
    /// Whether a `dashboard:list` has ever come back. `connection` going
    /// `.live` only says the socket authenticated — the first snapshot is a
    /// round trip behind it — so an empty list before this is "not yet"
    /// rather than "no chats". Set from the answer, not from `ingest`, which
    /// drops a snapshot equal to the one already held: a Mac with genuinely
    /// no chats answers with exactly that.
    @Published private(set) var loadedOnce = false
    @Published private(set) var isCachedSnapshot = false
    /// Invalidations are signals, not state. A busy turn pushes a delta per
    /// streamed chunk, and a published counter bumped per chunk re-rendered
    /// every view observing this store — the chat list under the open
    /// transcript included — twenty times a second, which is the scroll
    /// stutter in a running chat. Only the screens that refetch subscribe.
    /// Detail sheets use transcript invalidations too, including child
    /// sessions whose events do not change the parent's projected rows.
    let transcriptChanged = PassthroughSubject<Void, Never>()
    /// The workspaces whose review may have changed.
    let reviewChanged = PassthroughSubject<Set<String>, Never>()
    private var snapshotVersion = 0
    private var cacheWrite: Task<Void, Never>?

    private func invalidateReviews(_ ids: Set<String>) {
        if !ids.isEmpty { reviewChanged.send(ids) }
    }

    /// Read acknowledgements arrive in the same dashboard rows on every device.
    var unreadWorkspaceIDs: Set<String> {
        Set(snapshot.workspaces.filter { workspace in
            guard let viewed = workspace.lastViewedAt.flatMap(parseWireTimestamp),
                  let activity = parseWireTimestamp(workspace.lastActivityAt) else { return false }
            return activity > viewed
        }.map(\.id))
    }

    func markViewed(_ workspace: WorkspaceSummary) async {
        guard let viewed = workspace.lastViewedAt.flatMap(parseWireTimestamp),
              let activity = parseWireTimestamp(workspace.lastActivityAt), activity > viewed else { return }
        do {
            let _: [WorkspaceSummary] = try await client.request(
                "workspaces:mark-viewed",
                input: MarkWorkspacesViewedInput(workspaces: [
                    .init(workspaceId: workspace.id, observedActivityAt: workspace.lastActivityAt)
                ]),
                as: [WorkspaceSummary].self
            )
            // The host delta supplies authoritative rows. Applying an RPC
            // response here could overwrite newer activity received meanwhile.
        } catch {
            Self.log.error("Could not sync viewed chat: \(String(describing: error), privacy: .public)")
        }
    }

    /// The clock the 30-minute Priority idle rule runs against. A view ticks
    /// it once a minute; a test sets it outright.
    var now: Date { didSet { regroup() } }

    let client: BridgeClient
    private let cache: DeviceCache
    // The bridge streams have one consumer. Forward transcript invalidations
    // here so opening a chat cannot steal dashboard frames from the list.
    var onTranscriptEvent: ((BridgeEvent) -> Void)?
    var onTranscriptConnection: ((BridgeConnection) -> Void)?
    var onTranscriptSnapshot: ((DashboardSnapshot) -> Void)?
    private var eventLoop: Task<Void, Never>?
    private var connectionLoop: Task<Void, Never>?

    init(client: BridgeClient, now: Date = Date(), cache: DeviceCache = .shared) {
        self.cache = cache
        self.client = client
        self.now = now
        Task { [weak self, client, cache] in
            let cached = await cache.read(DashboardSnapshot.self,
                scope: client.cacheNamespace, key: "dashboard")
            guard let self, self.snapshotVersion == 0, let cached else { return }
            self.snapshot = cached
            self.loadedOnce = true
            self.isCachedSnapshot = true
            self.regroup()
        }
    }

    deinit {
        eventLoop?.cancel()
        connectionLoop?.cancel()
        cacheWrite?.cancel()
    }

    /// Connect, start listening, and load the first snapshot.
    func start() {
        guard eventLoop == nil else { return }
        eventLoop = Task { [weak self] in
            guard let events = self?.client.events else { return }
            for await event in events {
                guard let self else { return }
                self.onTranscriptEvent?(event)
                self.transcriptChanged.send()
                switch event {
                case .push(let channel, let payload):
                    if channel == "dashboard:delta" { self.apply(payload) }
                case .resync:
                    self.invalidateReviews(Set(self.snapshot.workspaces.map(\.id)))
                    await self.reload()
                }
            }
        }
        connectionLoop = Task { [weak self] in
            guard let states = self?.client.connectionStates else { return }
            for await state in states {
                guard let self else { return }
                self.connection = state
                self.onTranscriptConnection?(state)
                if state == .live {
                    self.transcriptChanged.send()
                    self.invalidateReviews(Set(self.snapshot.workspaces.map(\.id)))
                    // A reconnect misses whatever changed while the socket
                    // was down, and the host replays nothing, so the
                    // snapshot is reloaded rather than resumed.
                    await self.reload()
                }
            }
        }
        Task { await client.connect() }
    }

    func stop() {
        eventLoop?.cancel()
        eventLoop = nil
        connectionLoop?.cancel()
        connectionLoop = nil
        Task { [client] in await client.disconnect() }
    }

    /// Foregrounding: the radio dropped the socket without closing it, so
    /// stop waiting out the backoff.
    func resume() {
        Task { [client] in await client.reconnectNow(force: true) }
    }

    /// Pull to refresh, and every path that needs the whole list again.
    func reload() async {
        let requestedAtVersion = snapshotVersion
        do {
            let loaded = try await client.request("dashboard:list", as: DashboardSnapshot.self)
            loadFailure = nil
            loadedOnce = true
            isCachedSnapshot = false
            // A mutation response or pushed delta can advance the local
            // snapshot while this read is in flight. Its rows are newer than
            // a full snapshot whose database read began before they existed.
            // The delta loop schedules another read when reconciliation is
            // needed, so never let this older answer erase those rows.
            guard snapshotVersion == requestedAtVersion else { return }
            ingest(snapshot: loaded)
        } catch let error as BridgeError {
            loadFailure = error
        } catch {
            loadFailure = .malformedResponse
        }
    }

    /// Advance the Priority clock. A row ages out thirty minutes after its
    /// last message, which a per-minute tick is close enough to notice.
    func refreshClock() {
        now = Date()
    }

    // MARK: - Seams
    //
    // The socket and the tests drive the store through these two, so a test
    // needs a snapshot and a delta rather than a host.

    func ingest(snapshot loaded: DashboardSnapshot) {
        snapshotVersion += 1
        let before = Dictionary(uniqueKeysWithValues: snapshot.workspaces.map { ($0.id, $0) })
        let after = Dictionary(uniqueKeysWithValues: loaded.workspaces.map { ($0.id, $0) })
        invalidateReviews(Set(before.keys).union(after.keys).filter { before[$0] != after[$0] })
        saveCache(loaded)
        guard loaded != snapshot else { return }
        snapshot = loaded
        onTranscriptSnapshot?(loaded)
        regroup()
    }

    func ingest(delta: DashboardDelta) {
        snapshotVersion += 1
        var sessionWorkspaces = Dictionary(uniqueKeysWithValues: snapshot.sessions.map { ($0.id, $0.workspaceId) })
        var affected = Set(delta.workspaces?.map(\.id) ?? [])
        for row in delta.sessions ?? [] {
            if let previous = sessionWorkspaces[row.id] { affected.insert(previous) }
            sessionWorkspaces[row.id] = row.workspaceId
        }
        affected.formUnion((delta.changedSessionIds ?? []).compactMap { sessionWorkspaces[$0] })
        invalidateReviews(affected)
        let merged = mergeDashboardDelta(snapshot, delta)
        // Most deltas change nothing here (a streamed chunk carries only
        // `changedSessionIds`); handing an unchanged snapshot to the open
        // transcript made it republish and re-project per chunk.
        guard merged != snapshot else { return }
        snapshot = merged
        onTranscriptSnapshot?(merged)
        saveCache(merged)
        regroup()
    }

    /// Resolve navigation independently of list visibility. Multitasks stay
    /// out of the list but can still be opened as a full conversation.
    func row(forSessionID id: String) -> ChatRow? {
        if let row = (sections.pinned + sections.priority + sections.chats).first(where: { $0.session.id == id }) {
            return row
        }
        guard let session = snapshot.sessions.first(where: { $0.id == id }),
              let workspace = snapshot.workspaces.first(where: { $0.id == session.workspaceId }) else { return nil }
        return ChatRow(workspace: workspace, session: session,
                       projectName: snapshot.projects.first { $0.id == workspace.projectId }?.name,
                       attention: session.attention, working: session.state == .running)
    }

    private func apply(_ payload: Data) {
        do {
            let delta = try JSONDecoder().decode(DashboardDelta.self, from: payload)
            Self.log.debug("dashboard:delta sessions=\(delta.sessions?.count ?? 0) workspaces=\(delta.workspaces?.count ?? 0) changed=\(delta.dashboardChanged ?? false)")
            ingest(delta: delta)
            // Most deltas carry no rows at all — a pin, a state flip, a new
            // turn arrive as `dashboardChanged` and the client re-reads. The
            // renderer folds a burst into one read 100 ms later; so do we.
            if delta.resyncRequired == true {
                Task { await reload() }
            } else if delta.dashboardChanged == true {
                scheduleMetadataReload()
            }
        } catch {
            // A delta the phone cannot read is a phone that stops updating
            // until the next reload — say so rather than sitting quietly stale.
            Self.log.error("dashboard:delta undecodable: \(String(describing: error), privacy: .public)")
        }
    }

    private static let log = Logger(subsystem: "com.argmax.remote", category: "dashboard")

    private var metadataReload: Task<Void, Never>?
    private var metadataDirty = false

    /// One `dashboard:list` per burst of hints: a hint that lands while a read
    /// is in flight marks it dirty and the loop goes round once more.
    private func scheduleMetadataReload() {
        if metadataReload != nil {
            metadataDirty = true
            return
        }
        metadataReload = Task { [weak self] in
            defer { self?.metadataReload = nil }
            repeat {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, !Task.isCancelled else { return }
                self.metadataDirty = false
                await self.reload()
            } while self?.metadataDirty == true
        }
    }

    private func saveCache(_ value: DashboardSnapshot) {
        cacheWrite?.cancel()
        let scope = client.cacheNamespace
        cacheWrite = Task {
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await cache.write(value, scope: scope, key: "dashboard")
        }
    }

    private func regroup() {
        let grouped = groupChatRows(snapshot: snapshot, now: now, unreadWorkspaceIDs: unreadWorkspaceIDs)
        guard grouped != sections else { return }
        sections = grouped
    }
}
