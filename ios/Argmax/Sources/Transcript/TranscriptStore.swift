import Combine
import Foundation
import OSLog

/// Native transcript state for the one chat currently on screen.
///
/// `DashboardStore` remains the only consumer of `BridgeClient`'s streams and
/// fans frames into `receive`. Reads here are ordinary correlated RPCs, so a
/// transcript cannot steal a dashboard event from the app-wide store.
@MainActor
final class TranscriptStore: ObservableObject {
    @Published private(set) var items: [TranscriptItem] = []
    @Published private(set) var session: NativeSession?
    @Published private(set) var composer: NativeComposerState?
    @Published private(set) var phase: TranscriptLoadPhase = .idle
    @Published private(set) var connection: BridgeConnection = .connecting
    @Published private(set) var showingCachedContent = false
    @Published private(set) var thinkingStart: TranscriptThinking?
    private var thinkingBaseline: Set<String> = []

    #if DEBUG
    /// Simulator-scenario seam: the delegated-work sheet's child activity,
    /// which a scenario has no socket to ask a host for.
    var previewAgentItems: [TranscriptItem]?
    #endif

    func beginThinking() -> TranscriptThinking {
        let start = TranscriptThinking(id: UUID().uuidString,
                                       startedAt: ISO8601DateFormatter.withMilliseconds.string(from: Date()))
        thinkingBaseline = Set(items.map(\.id))
        thinkingStart = start
        return start
    }

    func cancelThinking(_ start: TranscriptThinking) {
        if thinkingStart == start { thinkingStart = nil }
    }

    var isLoading: Bool { phase == .loading }
    var failure: String? {
        guard case .failed(let message) = phase else { return nil }
        return message
    }
    var sessionID: String? { openSessionID }

    let client: BridgeClient
    private let cache: DeviceCache

    private var ownerID: UUID?
    private var openSessionID: String?
    /// When the open chat was asked for, until its live rows are published.
    private var openedAt: ContinuousClock.Instant?
    private var metadata: TranscriptSessionMetadata?
    private var workspacePath: String?
    private var eventsByID: [String: TranscriptEvent] = [:]
    private var rawOutputsByID: [String: TranscriptRawOutput] = [:]
    private var pendingApprovals: [TranscriptApproval] = []
    private var eventCursor: Int64?
    private var rawOutputCursor: Int64?
    private var changeCursor: Int64?
    private var generation = 0
    private var contentVersion = 0
    private var hasMoreHistory = false
    private var projectionVersion = 0
    private var projectionTask: Task<Void, Never>?
    private var cacheTask: Task<Void, Never>?
    private var recent: [String: RecentTranscript] = [:]
    private var recentOrder: [String] = []

    private struct RecentTranscript {
        let stored: StoredTranscript
        let items: [TranscriptItem]
        let byteCost: Int
    }

    private struct StoredTranscript: Codable, Sendable {
        let page: TranscriptPage
        let metadata: TranscriptSessionMetadata?
        let title: String?
        let workspacePath: String?
    }

    private var readTask: Task<Void, Never>?
    private var metadataTask: Task<Void, Never>?
    private var transcriptDirty = false
    /// The read in flight began while the socket was not live, so the
    /// request is sent after the next authentication.
    private var readAwaitsConnection = false
    private var authoritativeReadRequested = false
    private var metadataDirty = false

    init(client: BridgeClient, cache: DeviceCache = .shared) {
        self.cache = cache
        self.client = client
    }

    deinit {
        readTask?.cancel()
        metadataTask?.cancel()
        projectionTask?.cancel()
        cacheTask?.cancel()
    }

    /// Give a screen ownership of the shared store and open its chat. A stale
    /// screen may later disappear without closing the newer screen's chat.
    func claim(_ owner: UUID, sessionID: String) {
        ownerID = owner
        openSession(sessionID)
    }

    @discardableResult
    func relinquish(_ owner: UUID) -> Bool {
        guard ownerID == owner else { return false }
        ownerID = nil
        closeSession()
        return true
    }

    func openSession(_ id: String) {
        if openSessionID == id {
            authoritativeReadRequested = true
            metadataDirty = true
            scheduleReads()
            return
        }
        discardOpenChat()
        openSessionID = id
        openedAt = ContinuousClock.now
        showingCachedContent = false
        contentVersion = 0
        hasMoreHistory = false
        phase = .loading
        if let cached = recent[id] {
            restore(cached.stored)
            // Painted in this frame, so its documents must be ready in this
            // frame too. The cache may have evicted some since the chat was
            // last open; the few missing ones cost far less here than a
            // relayout each once they land.
            let missing = Self.tailProseKeys(cached.items, workspacePath: workspacePath)
                .filter { TranscriptMarkdownCache.shared.cached($0) == nil }
            if !missing.isEmpty { TranscriptMarkdownCache.shared.store(TranscriptMarkdownCache.prepare(missing)) }
            items = cached.items
            phase = .ready
            reportOpened(cached: true)
            recentOrder.removeAll { $0 == id }
            recentOrder.append(id)
        } else {
            let startedGeneration = generation
            Task { [weak self, client, cache] in
                let cached = await cache.read(StoredTranscript.self,
                    scope: client.cacheNamespace, key: "transcript-\(id)")
                guard let self, self.generation == startedGeneration,
                      self.contentVersion == 0, let cached else { return }
                self.restore(cached)
                self.updateProjection()
            }
        }
        authoritativeReadRequested = true
        metadataDirty = true
        scheduleReads()
    }

    func closeSession() {
        discardOpenChat()
        openSessionID = nil
        phase = .idle
        showingCachedContent = false
        transcriptDirty = false
        authoritativeReadRequested = false
        metadataDirty = false
    }

    /// Everything the chat on screen accumulated, dropped: in-flight reads and
    /// projections cancelled, and the generation bumped so one that is already
    /// running throws its page away instead of applying it to the next chat.
    private func discardOpenChat() {
        flushPendingCache()
        generation += 1
        projectionVersion += 1
        projectionTask?.cancel()
        projectionTask = nil
        readTask?.cancel()
        metadataTask?.cancel()
        readTask = nil
        metadataTask = nil
        thinkingStart = nil
        thinkingBaseline = []
        metadata = nil
        workspacePath = nil
        eventsByID = [:]
        rawOutputsByID = [:]
        pendingApprovals = []
        eventCursor = nil
        rawOutputCursor = nil
        changeCursor = nil
        items = []
        session = nil
        composer = nil
    }

    /// An explicit refresh is authoritative and waits until the host's
    /// mutation pages have drained.
    func reload() async {
        guard openSessionID != nil else { return }
        authoritativeReadRequested = true
        metadataDirty = true
        scheduleReads()
        await readTask?.value
        await metadataTask?.value
        await waitForProjection()
    }

    /// Reconcile composer metadata after a queue action. The action may fail
    /// because another client already consumed the row, in which case its
    /// removal event can predate this phone's request.
    func refreshMetadata() async {
        guard openSessionID != nil else { return }
        metadataDirty = true
        scheduleReads()
        while let task = metadataTask { await task.value }
    }

    /// Fan-in from `DashboardStore`'s sole bridge event loop.
    func receive(event: BridgeEvent) {
        switch event {
        case .resync:
            authoritativeReadRequested = true
            metadataDirty = true
            scheduleReads()
        case .push(let channel, let payload):
            guard channel == "dashboard:delta",
                  let hint = try? JSONDecoder().decode(TranscriptDeltaHint.self, from: payload)
            else { return }
            if hint.resyncRequired == true {
                authoritativeReadRequested = true
                metadataDirty = true
            } else {
                if let id = openSessionID, hint.changedSessionIds?.contains(id) == true {
                    transcriptDirty = true
                }
                if hint.dashboardChanged == true { metadataDirty = true }
            }
            scheduleReads()
        }
    }

    /// Fan-in from `DashboardStore`'s sole connection-state loop.
    func receive(connection state: BridgeConnection) {
        connection = state
        switch state {
        case .live:
            if openSessionID != nil, case .failed = phase { phase = .loading }
            // A read queued while the socket was down goes out on this
            // connection, so it already sees everything the gap missed.
            // Asking again downloaded the whole chat twice on every cold
            // open, a notification tap's included.
            if readTask == nil || !readAwaitsConnection { authoritativeReadRequested = true }
            metadataDirty = true
            scheduleReads()
        case .unauthorized:
            phase = .failed("This iPhone is no longer paired with the Mac.")
        case .connecting, .reconnecting:
            break
        }
    }

    /// Fast metadata updates from the dashboard snapshot. The store also reads
    /// the richer dashboard shape for pending messages and reasoning effort.
    func receive(snapshot: DashboardSnapshot, authoritative: Bool = true) {
        guard let id = openSessionID,
              let row = snapshot.sessions.first(where: { $0.id == id })
        else {
            // An authoritative dashboard removal must not be resurrected by disk.
            if let id = openSessionID, authoritative, connection == .live {
                contentVersion += 1
                recent.removeValue(forKey: id)
                removedChats.insert(id)
                pendingCache = nil
                let scope = client.cacheNamespace
                Task { [cache] in await cache.remove(scope: scope, key: "transcript-\(id)") }
                cacheTask?.cancel()
                closeSession()
                phase = .failed("This chat is no longer available on the Mac.")
            }
            return
        }
        let workspace = snapshot.workspaces.first { $0.id == row.workspaceId }
        workspacePath = workspace?.path
        let current = metadata
        ingest(metadata: TranscriptSessionMetadata(
            id: row.id,
            workspaceId: row.workspaceId,
            provider: row.provider,
            modelLabel: row.modelLabel,
            modelId: row.modelId,
            prompt: row.prompt,
            state: row.state,
            attention: row.attention,
            reasoningEffort: row.reasoningEffort ?? current?.reasoningEffort
        ), title: workspace?.taskLabel, pendingMessages: nil)
    }

    /// Apply the richer, authoritative dashboard read used by the native
    /// transcript. Unlike `DashboardSnapshot`, this includes the queue, so an
    /// absent session key means the host has no queued rows for this chat.
    func receive(snapshot: TranscriptDashboardSnapshot) {
        guard let id = openSessionID,
              let row = snapshot.sessions.first(where: { $0.id == id })
        else {
            updateProjection()
            return
        }
        let workspace = snapshot.workspaces.first(where: { $0.id == row.workspaceId })
        workspacePath = workspace?.path
        ingest(
            metadata: row,
            title: workspace?.taskLabel,
            pendingMessages: snapshot.pendingMessages[id] ?? []
        )
    }

    /// Test and preview seam: apply exactly the page a host would answer.
    func ingest(page: TranscriptPage, for sessionID: String, authoritative: Bool = false) {
        guard openSessionID == sessionID else { return }
        apply(page, authoritative: authoritative)
    }

    /// Seed a simulator preview or a unit test without opening a socket.
    func preview(
        page: TranscriptPage,
        metadata row: TranscriptSessionMetadata,
        title: String = "Preview",
        workspacePath: String? = nil,
        pendingMessages: [TranscriptPendingMessage] = [],
        isLoading: Bool = false
    ) {
        discardOpenChat()
        openSessionID = row.id
        self.workspacePath = workspacePath
        ingest(metadata: row, title: title, pendingMessages: pendingMessages)
        apply(page, authoritative: true)
        projectionTask?.cancel()
        projectionTask = nil
        publishProjection(TranscriptProjection.project(events: Array(eventsByID.values),
            session: metadata, pendingApprovals: pendingApprovals, workspacePath: workspacePath))
        showingCachedContent = false
        phase = isLoading ? .loading : .ready
    }

    /// Load the trace for one provider-native child without changing the
    /// parent transcript on screen.
    func loadAgentEvents(for agent: TranscriptAgent) async throws -> [TranscriptItem] {
        let workspacePath = workspacePath
        #if DEBUG
        if let previewAgentItems { return previewAgentItems }
        #endif
        let page = try await client.transcriptAgentEvents(agent)
        return TranscriptProjection.project(
            events: page.events,
            includingChildActivity: true,
            workspacePath: workspacePath
        )
    }

    // MARK: - Serialized reads

    private func scheduleReads() {
        guard openSessionID != nil else { return }
        if readTask == nil, transcriptDirty || authoritativeReadRequested {
            readTask = Task { [weak self] in await self?.drainTranscriptReads() }
        }
        if metadataTask == nil, metadataDirty {
            metadataTask = Task { [weak self] in await self?.drainMetadataReads() }
        }
    }

    private func drainTranscriptReads() async {
        let startedGeneration = generation
        defer {
            readTask = nil
            if generation == startedGeneration, transcriptDirty || authoritativeReadRequested { scheduleReads() }
        }
        while !Task.isCancelled, generation == startedGeneration, let id = openSessionID {
            let authoritative = authoritativeReadRequested || changeCursor == nil
            readAwaitsConnection = connection != .live
            authoritativeReadRequested = false
            transcriptDirty = false
            do {
                var page = try await client.transcriptEvents(
                    sessionID: id,
                    eventCursor: authoritative ? nil : eventCursor,
                    rawOutputCursor: authoritative ? nil : rawOutputCursor,
                    changeCursor: authoritative ? nil : changeCursor
                )
                guard generation == startedGeneration, openSessionID == id else { return }
                apply(page, authoritative: authoritative)
                while page.hasMore, !Task.isCancelled {
                    page = try await client.transcriptEvents(
                        sessionID: id,
                        eventCursor: eventCursor,
                        rawOutputCursor: rawOutputCursor,
                        changeCursor: changeCursor
                    )
                    guard generation == startedGeneration, openSessionID == id else { return }
                    apply(page, authoritative: false)
                }
                // `.ready` comes from the projection that paints the page:
                // flipping it here shows the empty-chat placeholder for the
                // frame between the page landing and its rows existing.
            } catch {
                guard generation == startedGeneration else { return }
                phase = .failed(hostFailureMessage(error))
            }
            if !transcriptDirty && !authoritativeReadRequested { return }
        }
    }

    private func drainMetadataReads() async {
        let startedGeneration = generation
        defer {
            metadataTask = nil
            if generation == startedGeneration, metadataDirty { scheduleReads() }
        }
        while !Task.isCancelled, generation == startedGeneration, let id = openSessionID {
            metadataDirty = false
            do {
                async let dashboardRead = client.transcriptDashboard()
                async let approvalsRead = client.transcriptPendingApprovals(sessionID: id)
                let (dashboard, approvals) = try await (dashboardRead, approvalsRead)
                guard generation == startedGeneration, openSessionID == id else { return }
                pendingApprovals = approvals
                receive(snapshot: dashboard)
            } catch {
                Self.log.error("transcript metadata read failed: \(String(describing: error), privacy: .public)")
            }
            if !metadataDirty { return }
        }
    }

    private func apply(_ page: TranscriptPage, authoritative: Bool) {
        guard let id = openSessionID else { return }
        contentVersion += 1
        hasMoreHistory = page.hasMore
        if authoritative || page.resetRequired {
            eventsByID = [:]
            rawOutputsByID = [:]
        }
        for deleted in page.deletedEventIds { eventsByID.removeValue(forKey: deleted) }
        for deleted in page.deletedRawOutputIds { rawOutputsByID.removeValue(forKey: deleted) }
        for event in page.events where event.sessionId == id {
            if event.payloadObject["traceSyntheticSuperseded"]?.bool == true {
                eventsByID.removeValue(forKey: event.id)
            } else {
                eventsByID[event.id] = event
            }
        }
        for output in page.rawOutputs where output.sessionId == id { rawOutputsByID[output.id] = output }
        if authoritative || page.resetRequired {
            eventCursor = page.eventCursor
            rawOutputCursor = page.rawOutputCursor
            changeCursor = page.changeCursor
        } else {
            eventCursor = max(eventCursor ?? 0, page.eventCursor)
            rawOutputCursor = max(rawOutputCursor ?? 0, page.rawOutputCursor)
            if let incoming = page.changeCursor { changeCursor = max(changeCursor ?? 0, incoming) }
        }
        updateProjection()
    }

    private func ingest(
        metadata row: TranscriptSessionMetadata,
        title: String?,
        pendingMessages: [TranscriptPendingMessage]?
    ) {
        if let session, row.state != session.state, row.state != .running {
            thinkingStart = nil
        }
        metadata = row
        let displayTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedTitle = displayTitle.flatMap { $0.isEmpty ? nil : $0 } ?? openingLine(row.prompt)
        session = NativeSession(
            sessionId: row.id,
            title: resolvedTitle,
            state: row.state,
            attention: row.attention
        )

        let catalogModel = ProviderCatalog.bundled.model(provider: row.provider, modelId: row.modelId)
        let messages = pendingMessages ?? composer?.queued.map {
            TranscriptPendingMessage(
                id: $0.id,
                sessionId: row.id,
                content: $0.text,
                modelLabel: nil,
                modelId: nil,
                reasoningEffort: nil,
                recoveryStatus: nil,
                queuedAt: ""
            )
        } ?? []
        composer = NativeComposerState(
            sessionId: row.id,
            provider: row.provider,
            modelId: row.modelId,
            // The catalogue wins when it knows the id, as on desktop: an
            // agent-launched or imported session stores the raw API id
            // ("claude-opus-5") as its label.
            modelLabel: catalogModel?.label ?? row.modelLabel,
            effort: row.reasoningEffort,
            efforts: catalogModel?.reasoningEfforts.map(\.rawValue) ?? [],
            queued: messages.map { entry in
                NativeQueuedMessage(
                    id: entry.id,
                    text: entry.content,
                    canSteer: canSteer(entry, session: row)
                )
            },
            running: row.state == .running
        )
        updateProjection()
    }

    private func restore(_ cached: StoredTranscript) {
        eventsByID = Dictionary(cached.page.events.map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
        rawOutputsByID = Dictionary(cached.page.rawOutputs.map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
        workspacePath = cached.workspacePath
        // Cached cursors are never a substitute for authoritative recovery.
        if metadata == nil, let row = cached.metadata {
            ingest(metadata: row, title: cached.title, pendingMessages: [])
        }
        showingCachedContent = true
    }

    func waitForProjection() async {
        while let task = projectionTask { await task.value }
    }

    func flushCache() async {
        await cacheTask?.value
        for flush in flushTasks.values { await flush.value }
    }

    private func updateProjection() {
        // Metadata lands before the first page (the dashboard snapshot is
        // handed over on appear), and a projection over zero events is the
        // prompt bubble alone. Painting that first, then the transcript, is
        // the flicker on every cold open. Wait for content: a page from the
        // host or a cached copy from disk.
        guard contentVersion > 0 || showingCachedContent else { return }
        // The remote byte budget can split the opening history into forward
        // pages. Their intermediate tails are old messages, so publishing
        // each one makes the list chase history before reaching live output.
        // Metadata updates must wait for the final page too.
        guard !hasMoreHistory else { return }
        projectionVersion += 1
        guard projectionTask == nil else { return }
        let startedGeneration = generation
        projectionTask = Task { [weak self] in
            // Fold metadata and event bursts into a single projection without delaying first paint.
            await Task.yield()
            guard let self else { return }
            while !Task.isCancelled, self.generation == startedGeneration {
                guard !self.hasMoreHistory else {
                    self.projectionTask = nil
                    return
                }
                let version = self.projectionVersion
                let includesLiveContent = self.contentVersion > 0
                let events = Array(self.eventsByID.values)
                let metadata = self.metadata
                let approvals = self.pendingApprovals
                let workspacePath = self.workspacePath
                let fallback = self.rawFallbackItems()
                let job = Task.detached(priority: .userInitiated) {
                    NativePerformance.measure("Transcript projection") {
                        TranscriptProjection.project(events: events, session: metadata,
                            pendingApprovals: approvals, workspacePath: workspacePath)
                    }
                }
                let projected = await withTaskCancellationHandler {
                    await job.value
                } onCancel: { job.cancel() }
                guard !Task.isCancelled, self.generation == startedGeneration else { return }
                if self.items.isEmpty {
                    // A row paints plain text until its Markdown is prepared,
                    // and every document that lands after the first paint
                    // re-lays out the eager stack under it. Two at a time,
                    // that was a relayout per prose row for seconds after an
                    // open. Preparing all of them costs a few milliseconds
                    // off the main actor (27 ms for 123 documents on the
                    // simulator), so the first frame is the finished one.
                    // Later projections prepare their changed rows lazily.
                    let keys = Self.tailProseKeys(projected, workspacePath: workspacePath)
                        .filter { TranscriptMarkdownCache.shared.cached($0) == nil }
                    if !keys.isEmpty {
                        let prepared = await Task.detached(priority: .userInitiated) {
                            TranscriptMarkdownCache.prepare(keys)
                        }.value
                        guard !Task.isCancelled, self.generation == startedGeneration else { return }
                        TranscriptMarkdownCache.shared.store(prepared)
                    }
                }
                // Publish what was projected even when newer content landed
                // meanwhile. A running chat invalidates the projection on
                // every streamed chunk, so waiting for a quiet moment left an
                // opened chat blank for the whole turn; the next pass below
                // catches the list up.
                self.publishProjection(projected.isEmpty ? fallback : projected)
                // Readiness and the rows it describes must change together.
                if includesLiveContent { self.showingCachedContent = false }
                self.reportOpened(cached: !includesLiveContent)
                // Content has arrived by now (the guard above), so an empty
                // projection is a genuinely empty chat.
                if self.phase == .loading { self.phase = .ready }
                self.cacheCurrentTranscript()
                if version != self.projectionVersion { continue }
                self.projectionTask = nil
                return
            }
        }
    }

    /// The prose the list paints when it opens at the tail: the newest
    /// bubbles, well past what the mounted row window holds, and within the
    /// Markdown cache's 128 documents. Rows paged in later prepare lazily.
    nonisolated static func tailProseKeys(_ items: [TranscriptItem], workspacePath: String?, limit: Int = 96) -> [TranscriptMarkdownKey] {
        var keys: [TranscriptMarkdownKey] = []
        for item in items.reversed() where keys.count < limit {
            switch item {
            case .user(let message), .assistant(let message):
                keys.append(TranscriptMarkdownKey(text: message.text, workspacePath: workspacePath, isThinking: false))
            default:
                continue
            }
        }
        return keys
    }

    /// The `perf` log's chat-open milestones: first rows of any kind, then
    /// the first rows built from the host's authoritative read.
    private func reportOpened(cached: Bool) {
        guard let openedAt, !items.isEmpty else { return }
        NativePerformance.event("Chat painted")
        NativePerformance.log.debug("chat open→\(cached ? "saved" : "live", privacy: .public) rows ms=\((ContinuousClock.now - openedAt).milliseconds) rows=\(self.items.count) events=\(self.eventsByID.count)")
        if !cached { self.openedAt = nil }
    }

    private func publishProjection(_ projected: [TranscriptItem]) {
        if items != projected { items = projected }
        if thinkingStart != nil, items.contains(where: { item in
            guard !thinkingBaseline.contains(item.id) else { return false }
            switch item {
            case .user, .notice: return false
            default: return true
            }
        }) {
            thinkingStart = nil
        }
    }

    /// The open chat's latest state, until `cacheCurrentTranscript` has
    /// encoded and stored it.
    private var pendingCache: (id: String, stored: StoredTranscript, items: [TranscriptItem])?
    private var lastCachedAt = ContinuousClock.now
    /// Stores started as a chat was left; the next chat's cache task must
    /// not cancel them.
    private var flushTasks: [UUID: Task<Void, Never>] = [:]
    /// Chats the Mac removed, which an in-flight store must not bring back.
    private var removedChats: Set<String> = []

    private func cacheCurrentTranscript() {
        guard let id = openSessionID, !showingCachedContent else { return }
        let stored = StoredTranscript(page: TranscriptPage(events: Array(eventsByID.values),
            rawOutputs: Array(rawOutputsByID.values), eventCursor: eventCursor ?? 0,
            rawOutputCursor: rawOutputCursor ?? 0, changeCursor: changeCursor,
            deletedEventIds: [], deletedRawOutputIds: [], resetRequired: false, hasMore: false),
            metadata: metadata, title: session?.title, workspacePath: workspacePath)
        pendingCache = (id, stored, items)
        let version = projectionVersion
        let capturedContentVersion = contentVersion
        cacheTask?.cancel()
        cacheTask = Task { [weak self] in
            // A streaming chat projects per chunk, and encoding the whole
            // transcript each time was a quarter of the CPU streaming cost.
            // Wait for a pause, or at most a few seconds into a long stream.
            if let self, ContinuousClock.now - self.lastCachedAt < Self.cacheStaleness {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            }
            guard !Task.isCancelled, let self, self.openSessionID == id,
                  self.projectionVersion == version, self.contentVersion == capturedContentVersion,
                  let pending = self.pendingCache, pending.id == id else { return }
            self.pendingCache = nil
            self.lastCachedAt = .now
            await self.store(pending.stored, items: pending.items, for: id)
        }
    }

    private static let cacheStaleness: Duration = .seconds(5)

    /// Leaving a chat before its latest state was stored stores it now, so
    /// coming back opens from memory rather than waiting for the Mac.
    private func flushPendingCache() {
        guard let pending = pendingCache else { return }
        pendingCache = nil
        cacheTask?.cancel()
        let key = UUID()
        flushTasks[key] = Task { [weak self] in
            await self?.store(pending.stored, items: pending.items, for: pending.id)
            self?.flushTasks[key] = nil
        }
    }

    /// Encode once, off the main actor: the size budgets the in-memory copy
    /// and the same bytes go to disk.
    private func store(_ stored: StoredTranscript, items projected: [TranscriptItem], for id: String) async {
        let data = await Task.detached(priority: .utility) { try? JSONEncoder().encode(stored) }.value
        guard !Task.isCancelled, !removedChats.contains(id) else { return }
        let byteCost = data?.count ?? Int.max / 4
        // Leave room for decoded models and projected text as well as wire bytes.
        if byteCost < 4 * 1_024 * 1_024 {
            recent[id] = RecentTranscript(stored: stored, items: projected, byteCost: byteCost * 2)
            recentOrder.removeAll { $0 == id }
            recentOrder.append(id)
            while recentOrder.count > 8 || recent.values.reduce(0, { $0 + $1.byteCost }) > 16 * 1_024 * 1_024 {
                recent.removeValue(forKey: recentOrder.removeFirst())
            }
        }
        if let data { await cache.write(encoded: data, scope: client.cacheNamespace, key: "transcript-\(id)") }
    }

    private func rawFallbackItems() -> [TranscriptItem] {
        let clearedAt = eventsByID.values.filter { $0.type == "session.cleared" }.map(\.createdAt).max()
        return rawOutputsByID.values
            .filter { output in
                if let clearedAt, output.createdAt <= clearedAt { return false }
                let text = output.content.trimmingCharacters(in: .whitespacesAndNewlines)
                return !text.isEmpty && !text.hasPrefix("{") && !text.hasPrefix("[") &&
                    !TranscriptError.isRedundantProviderDiagnostic(text)
            }
            .sorted { lhs, rhs in
                if let left = lhs.rowCursor, let right = rhs.rowCursor, left != right { return left < right }
                return lhs.createdAt == rhs.createdAt ? lhs.id < rhs.id : lhs.createdAt < rhs.createdAt
            }
            .map { output in
                .error(TranscriptError(
                    id: "raw-\(output.id)",
                    message: output.content,
                    code: output.stream,
                    operation: nil,
                    createdAt: output.createdAt
                ))
            }
    }

    private func canSteer(_ message: TranscriptPendingMessage, session: TranscriptSessionMetadata) -> Bool {
        let hasContextHeadroom: Bool
        if session.provider == "codex", let window = session.contextWindow, window > 0 {
            hasContextHeadroom = Double(session.contextTokens ?? 0) / Double(window) < 0.85
        } else {
            hasContextHeadroom = true
        }
        return session.state == .running &&
            ["claude", "codex", "opencode"].contains(session.provider) &&
            hasContextHeadroom &&
            (message.modelId == nil || message.modelId == session.modelId) &&
            (message.reasoningEffort == nil || message.reasoningEffort == session.reasoningEffort)
    }

    private func openingLine(_ prompt: String) -> String {
        let line = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Chat"
        return line.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static let log = Logger(subsystem: "com.argmax.remote", category: "transcript")
}

private struct TranscriptDeltaHint: Decodable {
    var changedSessionIds: [String]?
    var dashboardChanged: Bool?
    var resyncRequired: Bool?
}
