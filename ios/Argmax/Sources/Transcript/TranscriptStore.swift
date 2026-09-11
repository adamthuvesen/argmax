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

    var isLoading: Bool { phase == .loading }
    var failure: String? {
        guard case .failed(let message) = phase else { return nil }
        return message
    }
    var sessionID: String? { openSessionID }

    let client: BridgeClient

    private var ownerID: UUID?
    private var openSessionID: String?
    private var metadata: TranscriptSessionMetadata?
    private var workspacePath: String?
    private var eventsByID: [String: TranscriptEvent] = [:]
    private var rawOutputsByID: [String: TranscriptRawOutput] = [:]
    private var pendingApprovals: [TranscriptApproval] = []
    private var eventCursor: Int64?
    private var rawOutputCursor: Int64?
    private var changeCursor: Int64?
    private var generation = 0

    private var readTask: Task<Void, Never>?
    private var metadataTask: Task<Void, Never>?
    private var transcriptDirty = false
    private var authoritativeReadRequested = false
    private var metadataDirty = false

    init(client: BridgeClient) {
        self.client = client
    }

    deinit {
        readTask?.cancel()
        metadataTask?.cancel()
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
        generation += 1
        readTask?.cancel()
        metadataTask?.cancel()
        readTask = nil
        metadataTask = nil
        openSessionID = id
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
        phase = .loading
        authoritativeReadRequested = true
        metadataDirty = true
        scheduleReads()
    }

    func closeSession() {
        generation += 1
        readTask?.cancel()
        metadataTask?.cancel()
        readTask = nil
        metadataTask = nil
        openSessionID = nil
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
        phase = .idle
        transcriptDirty = false
        authoritativeReadRequested = false
        metadataDirty = false
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
            authoritativeReadRequested = true
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
    func receive(snapshot: DashboardSnapshot) {
        guard let id = openSessionID,
              let row = snapshot.sessions.first(where: { $0.id == id })
        else { return }
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
            reasoningEffort: current?.reasoningEffort,
            agentMode: row.agentMode
        ), title: workspace?.taskLabel, pendingMessages: nil)
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
        workspacePath: String? = nil
    ) {
        generation += 1
        readTask?.cancel()
        metadataTask?.cancel()
        readTask = nil
        metadataTask = nil
        openSessionID = row.id
        self.workspacePath = workspacePath
        eventsByID = [:]
        rawOutputsByID = [:]
        pendingApprovals = []
        eventCursor = nil
        rawOutputCursor = nil
        changeCursor = nil
        ingest(metadata: row, title: title, pendingMessages: [])
        apply(page, authoritative: true)
        phase = .ready
    }

    /// Load the trace for one provider-native child without changing the
    /// parent transcript on screen.
    func loadAgentEvents(for agent: TranscriptAgent) async throws -> [TranscriptItem] {
        let workspacePath = workspacePath
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
                phase = .ready
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
                if let row = dashboard.sessions.first(where: { $0.id == id }) {
                    let workspace = dashboard.workspaces.first(where: { $0.id == row.workspaceId })
                    workspacePath = workspace?.path
                    ingest(
                        metadata: row,
                        title: workspace?.taskLabel,
                        pendingMessages: dashboard.pendingMessages[id] ?? []
                    )
                } else {
                    updateProjection()
                }
            } catch {
                Self.log.error("transcript metadata read failed: \(String(describing: error), privacy: .public)")
            }
            if !metadataDirty { return }
        }
    }

    private func apply(_ page: TranscriptPage, authoritative: Bool) {
        guard let id = openSessionID else { return }
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
                agentMode: row.agentMode ?? "auto",
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
            modelLabel: row.modelLabel,
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

    private func updateProjection() {
        let projected = TranscriptProjection.project(
            events: Array(eventsByID.values),
            session: metadata,
            pendingApprovals: pendingApprovals,
            workspacePath: workspacePath
        )
        if projected.isEmpty {
            items = rawFallbackItems()
        } else {
            items = projected
        }
    }

    private func rawFallbackItems() -> [TranscriptItem] {
        let clearedAt = eventsByID.values.filter { $0.type == "session.cleared" }.map(\.createdAt).max()
        return rawOutputsByID.values
            .filter { output in
                if let clearedAt, output.createdAt <= clearedAt { return false }
                let text = output.content.trimmingCharacters(in: .whitespacesAndNewlines)
                return !text.isEmpty && !text.hasPrefix("{") && !text.hasPrefix("[")
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
        session.state == .running &&
            (session.provider == "claude" || session.provider == "codex") &&
            (message.modelId == nil || message.modelId == session.modelId) &&
            (message.reasoningEffort == nil || message.reasoningEffort == session.reasoningEffort) &&
            message.agentMode == (session.agentMode ?? "auto")
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
