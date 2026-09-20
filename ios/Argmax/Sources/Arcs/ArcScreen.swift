import SwiftUI

/// One Arc, pushed from the chat list's Arcs section.
struct ArcRoute: Hashable {
    let arcID: String
}

/// The desktop Arc page, cut to what a phone is for: checking on the work.
///
/// It opens the coordinator and the members working now, reads the brief and
/// the timeline, and pauses, resumes, or ends the arc. Creating an arc,
/// starting a coordinator, and editing the brief stay on the Mac, which has
/// the model picker and the folder they need. See docs/arcs.md.
struct ArcScreen: View {
    let onBack: () -> Void
    /// Opens a chat by session id. Only called for ids `canOpen` accepted.
    let onOpenSession: (String) -> Void

    @EnvironmentObject private var store: DashboardStore
    @StateObject private var arc: ArcStore
    @State private var confirmingDone = false
    @State private var briefExpanded = false
    @Environment(\.accentTint) private var accent
    @Environment(\.openURL) private var openURL

    init(route: ArcRoute, client: BridgeClient, onBack: @escaping () -> Void, onOpenSession: @escaping (String) -> Void) {
        self.onBack = onBack
        self.onOpenSession = onOpenSession
        _arc = StateObject(wrappedValue: ArcStore(arcID: route.arcID, client: client))
    }

    #if DEBUG
    /// A preview's screen, over a store already holding what the Mac would send.
    init(seeded store: ArcStore) {
        onBack = {}
        onOpenSession = { _ in }
        _arc = StateObject(wrappedValue: store)
    }
    #endif

    var body: some View {
        ScrollView {
            content
                .screenGutter()
                .padding(.top, Spacing.snug)
                .padding(.bottom, Spacing.section)
        }
        .background(Theme.ground.ignoresSafeArea())
        .safeAreaInset(edge: .top, spacing: 0) {
            ScreenHeader(title: title, subtitle: subtitle, onBack: onBack) { stateMenu }
        }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .refreshable {
            async let detail: Void = arc.loadDetail()
            async let timeline: Void = arc.loadTimeline()
            _ = await (detail, timeline)
        }
        // The dashboard carries no arc detail, only the moments it moved.
        // Each task reruns when its key does, and the first run is the load.
        .task(id: detailKey) { await arc.loadDetail() }
        .task(id: timelineKey) { await arc.loadTimeline() }
        .confirmationDialog("Mark this arc done?", isPresented: $confirmingDone, titleVisibility: .visible) {
            Button("Mark done", role: .destructive) { Task { await change(to: .done) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its launches stop and it leaves this list. Reopen it from the Mac.")
        }
    }

    // MARK: - What the dashboard already knows

    private var summary: ArcSummary? {
        store.snapshot.arcs.first { $0.id == arc.arcID }
    }

    private var arcSessions: [SessionSummary] {
        store.snapshot.sessions.filter { $0.arcId == arc.arcID }
    }

    /// The desktop's refetch key for the detail: the arc row and its membership.
    private var detailKey: String {
        guard let summary else { return "" }
        return "\(summary.updatedAt)|\(summary.memberCount)|\(summary.coordinatorSessionId ?? "")|\(summary.state.rawWire)"
    }

    /// A new timeline row, or a member starting or settling. A member's
    /// finish and a coordinator's notes are recorded without touching the
    /// arc row, so its `lastEventAt` alone would miss the rows most worth
    /// seeing; the sessions' states move with them.
    private var timelineKey: String {
        let states = arcSessions
            .map { "\($0.id):\($0.state.rawWire)" }
            .sorted()
            .joined(separator: ",")
        return "\(summary?.lastEventAt ?? "")|\(detailKey)|\(states)"
    }

    private var record: ArcRecord? { arc.detail?.arc }
    private var state: ArcState? { record?.state ?? summary?.state }

    private var title: String { record?.name ?? summary?.name ?? "Arc" }

    private var subtitle: String? {
        guard let state else { return nil }
        let homeProject = record?.homeProjectId ?? summary?.homeProjectId
        let projectName = store.snapshot.projects.first { $0.id == homeProject }?.name
        return [state.label, projectName].compactMap { $0 }.joined(separator: " · ")
    }

    private func canOpen(_ sessionID: String) -> Bool {
        store.row(forSessionID: sessionID) != nil
    }

    // MARK: - Page

    @ViewBuilder
    private var content: some View {
        if let record, let detail = arc.detail {
            VStack(alignment: .leading, spacing: Spacing.section) {
                VStack(alignment: .leading, spacing: Spacing.row) {
                    Text(metaLine(record))
                        .typeMeta()
                    if let failure = arc.failure {
                        Text(failure)
                            .typeMeta()
                            .foregroundStyle(Theme.rose)
                    }
                    coordinator(record: record, detail: detail)
                }
                stats(detail)
                workingNow(record: record)
                brief(record)
                timeline
            }
        } else if let failure = arc.failure {
            EmptyState(
                mark: .glyph("exclamationmark.triangle"),
                message: failure,
                action: ("Retry", { Task { await arc.loadDetail() } })
            )
            .padding(.top, 120)
        } else {
            WorkingNest(size: 24, tint: Theme.muted)
                .accessibilityLabel("Loading arc…")
                .frame(maxWidth: .infinity)
                .padding(.top, 120)
        }
    }

    private func metaLine(_ record: ArcRecord) -> String {
        var parts: [String] = []
        if let created = parseWireTimestamp(record.createdAt) {
            parts.append("Started \(created.formatted(.dateTime.month(.abbreviated).day()))")
        }
        if let last = parseWireTimestamp(summary?.lastEventAt ?? record.updatedAt) {
            parts.append("last activity \(Self.relative.localizedString(for: last, relativeTo: store.now))")
        }
        return parts.joined(separator: " · ")
    }

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    // MARK: - Coordinator

    @ViewBuilder
    private func coordinator(record: ArcRecord, detail: ArcDetail) -> some View {
        let member = detail.members.first { $0.sessionId == record.coordinatorSessionId }
        let session = arcSessions.first { $0.id == record.coordinatorSessionId }
        VStack(alignment: .leading, spacing: Spacing.snug) {
            if let coordinatorID = record.coordinatorSessionId {
                PrimaryButton(title: "Open coordinator", systemImage: "safari") {
                    onOpenSession(coordinatorID)
                }
                .disabled(!canOpen(coordinatorID))
                if let member {
                    HStack(spacing: Spacing.tight + 2) {
                        ProviderMark(provider: member.provider, size: 14)
                        Text(coordinatorLine(member: member, state: session?.state ?? member.state))
                            .typeMeta()
                            .lineLimit(1)
                    }
                }
                if !canOpen(coordinatorID) {
                    Text("This chat is no longer in your recent chats.")
                        .typeMeta()
                }
            } else {
                Text("No coordinator. Start one on the Mac.")
                    .typeMeta()
            }
        }
    }

    private func coordinatorLine(member: ArcMemberSummary, state: SessionState) -> String {
        [ProviderMark.displayName(member.provider), member.modelLabel, describe(state)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private func describe(_ state: SessionState) -> String {
        switch state {
        case .created: return "Starting"
        case .running: return "Working"
        case .waiting: return "Waiting on you"
        case .blocked: return "Blocked"
        case .complete: return "Idle"
        case .failed: return "Failed"
        case .cancelled: return "Stopped"
        case .unknown(let raw): return raw.capitalized
        }
    }

    // MARK: - Stats

    private func stats(_ detail: ArcDetail) -> some View {
        let open = detail.members.filter { $0.prState == "OPEN" }.count
        let merged = detail.members.filter { $0.prState == "MERGED" }.count
        return HStack(alignment: .top, spacing: Spacing.snug) {
            stat("Working now", value: "\(workingMembers.count)")
            stat("Pull requests", value: pullRequestSummary(open: open, merged: merged))
            stat("Launches today", value: "\(detail.launchesLast24h) of \(detail.limits.maxLaunchesPerDay)")
        }
    }

    private func pullRequestSummary(open: Int, merged: Int) -> String {
        let parts = [open > 0 ? "\(open) open" : nil, merged > 0 ? "\(merged) merged" : nil].compactMap { $0 }
        return parts.isEmpty ? "None" : parts.joined(separator: " · ")
    }

    private func stat(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .typeStyle(.caption2)
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
            Text(value)
                .typeChrome()
                .monospacedDigit()
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
        .padding(Spacing.row)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.cell, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    // MARK: - Working now

    /// Read from the dashboard rather than `arc:get`, so a member starting or
    /// settling shows without waiting for a refetch.
    private var workingMembers: [SessionSummary] {
        arcSessions
            .filter { !isSettled($0.state) && $0.id != (record?.coordinatorSessionId ?? summary?.coordinatorSessionId) }
            .sorted { $0.startedAt > $1.startedAt }
    }

    @ViewBuilder
    private func workingNow(record: ArcRecord) -> some View {
        let members = workingMembers
        if !members.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                heading("Working now")
                ForEach(Array(members.enumerated()), id: \.element.id) { index, session in
                    memberRow(session, separated: index < members.count - 1)
                }
            }
        }
    }

    private func memberRow(_ session: SessionSummary, separated: Bool) -> some View {
        let workspace = store.snapshot.workspaces.first { $0.id == session.workspaceId }
        let projectName = store.snapshot.projects.first { $0.id == workspace?.projectId }?.name
        let label = workspace?.taskLabel.trimmingCharacters(in: .whitespaces) ?? ""
        return Button {
            onOpenSession(session.id)
        } label: {
            HStack(spacing: Spacing.row) {
                WorkingNest(size: 14, active: session.state == .running)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label.isEmpty ? "Untitled" : label)
                        .typeContent()
                        .lineLimit(1)
                    if let projectName {
                        Text("\(projectName) · \(describe(session.state))")
                            .typeMeta()
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, Spacing.row)
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .disabled(!canOpen(session.id))
        .overlay(alignment: .bottom) {
            if separated { HairlineDivider() }
        }
    }

    // MARK: - Brief

    private func brief(_ record: ArcRecord) -> some View {
        let text = record.brief.trimmingCharacters(in: .whitespacesAndNewlines)
        let long = text.count > 280 || text.filter(\.isNewline).count > 3
        return VStack(alignment: .leading, spacing: 0) {
            heading("Brief")
            if text.isEmpty {
                Text("No brief yet.")
                    .typeMeta()
            } else {
                Text(text)
                    .typeContent()
                    .lineLimit(briefExpanded || !long ? nil : 5)
                    .textSelection(.enabled)
                if long {
                    Button(briefExpanded ? "Show less" : "Show more") {
                        withAnimation(.easeOut(duration: 0.2)) { briefExpanded.toggle() }
                    }
                    .typeChrome()
                    .foregroundStyle(accent.color)
                    .padding(.top, Spacing.snug)
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: - Timeline

    @ViewBuilder
    private var timeline: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading("Timeline")
            if let failure = arc.timelineFailure {
                Text(failure)
                    .typeMeta()
                    .foregroundStyle(Theme.rose)
                    .padding(.bottom, Spacing.snug)
            }
            if let events = arc.events {
                if events.isEmpty {
                    Text("Nothing has happened yet. Members, pull requests, and notes show up here as the coordinator works.")
                        .typeMeta()
                } else {
                    ForEach(groupArcTimelineByDay(events, now: store.now)) { day in
                        Text(day.label)
                            .typeSectionHeading()
                            .padding(.top, Spacing.row)
                            .padding(.bottom, Spacing.tight)
                        ForEach(day.events) { event in
                            ArcTimelineRow(
                                event: event,
                                openTarget: openTarget(event)
                            )
                        }
                    }
                }
                if arc.cursor != nil {
                    QuietButton(title: arc.loadingEarlier ? "Loading…" : "Show earlier") {
                        Task { await arc.loadEarlier() }
                    }
                    .disabled(arc.loadingEarlier)
                    .padding(.top, Spacing.row)
                }
            } else if arc.timelineFailure == nil {
                WorkingNest(size: 24, tint: Theme.muted)
                    .accessibilityLabel("Loading timeline…")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.gutter)
            }
        }
    }

    /// A pull request row opens the pull request; any other row whose chat is
    /// still around opens the chat.
    private func openTarget(_ event: ArcTimelineEvent) -> (() -> Void)? {
        if let prUrl = event.prUrl, let url = URL(string: prUrl) {
            return { openURL(url) }
        }
        if let sessionID = event.sessionId, event.sessionAvailable, canOpen(sessionID) {
            return { onOpenSession(sessionID) }
        }
        return nil
    }

    private func heading(_ label: String) -> some View {
        Text(label)
            .typeSectionHeading()
            .padding(.bottom, Spacing.snug)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: - State

    @ViewBuilder
    private var stateMenu: some View {
        if let state, state == .active || state == .paused {
            Menu {
                Group {
                    if state == .active {
                        Button("Pause", systemImage: "pause") { Task { await change(to: .paused) } }
                    } else {
                        Button("Resume", systemImage: "play") { Task { await change(to: .active) } }
                    }
                    Button("Mark done", systemImage: "checkmark.square") { confirmingDone = true }
                }
                .tint(Color.primary)
            } label: {
                Image(systemName: "ellipsis")
                    .typeSymbol(.body, weight: .semibold)
                    .foregroundStyle(Theme.ink)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Theme.raised))
                    .contentShape(.rect)
            }
            .disabled(arc.changingState)
            .accessibilityLabel("Arc actions")
        }
    }

    private func change(to state: ArcState) async {
        if await arc.setState(state) {
            Haptics.success()
        } else {
            Haptics.error()
        }
    }
}

// MARK: - Timeline row

private struct ArcTimelineRow: View {
    let event: ArcTimelineEvent
    let openTarget: (() -> Void)?

    @State private var expanded = false
    @Environment(\.accentTint) private var accent
    @Environment(\.typeScale) private var typeScale

    /// A detail longer than this starts clamped.
    private static let clampCharacters = 240

    var body: some View {
        let presentation = presentArcEvent(event)
        let tone = presentation.tone.color(accent: accent.color)
        HStack(alignment: .top, spacing: Spacing.row) {
            Text(time)
                .typeStyle(.caption2, monospacedDigit: true)
                .foregroundStyle(Theme.muted)
                .frame(width: 40, alignment: .leading)
                .padding(.top, 2)
            glyph(presentation.glyph, tone: tone)
                .frame(width: 16, height: 16)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: Spacing.tight) {
                line(presentation)
                if let meta = meta(presentation) {
                    Text(meta)
                        .typeStyle(.caption2)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }
                if let detail {
                    detailView(detail, quote: presentation.detailIsQuote, tone: tone)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Spacing.snug)
        .contentShape(.rect)
        .onTapGesture { openTarget?() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(openTarget == nil ? [] : .isButton)
    }

    private var time: String {
        parseWireTimestamp(event.occurredAt)?.formatted(date: .omitted, time: .shortened) ?? ""
    }

    private var detail: String? {
        let text = event.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    private func line(_ presentation: ArcEventPresentation) -> some View {
        var text = Text(presentation.verb).font(typeScale.font(.subheadline, weight: .semibold))
        if let subject = presentation.subject {
            text = text + Text(" ") + Text(subject)
                .font(typeScale.font(.subheadline))
                .foregroundColor(openTarget == nil ? Theme.ink : accent.color)
        }
        return text
            .foregroundStyle(Theme.ink)
            .lineLimit(3)
    }

    private func meta(_ presentation: ArcEventPresentation) -> String? {
        let parts = [arcEventShowsProject(event) ? event.projectName : nil, presentation.badge]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func detailView(_ detail: String, quote: Bool, tone: Color) -> some View {
        let clampable = detail.count > Self.clampCharacters
        VStack(alignment: .leading, spacing: Spacing.tight) {
            Text(detail)
                .typeMeta()
                .foregroundStyle(quote ? Theme.mutedStrong : Theme.muted)
                .lineLimit(clampable && !expanded ? 4 : nil)
            if clampable {
                Button(expanded ? "Show less" : "Show more") {
                    withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
                }
                .typeStyle(.caption2, weight: .semibold)
                .foregroundStyle(accent.color)
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, quote ? Spacing.snug : 0)
        .overlay(alignment: .leading) {
            if quote {
                Rectangle()
                    .fill(tone.opacity(0.5))
                    .frame(width: 2)
            }
        }
    }

    @ViewBuilder
    private func glyph(_ glyph: ArcEventPresentation.Glyph, tone: Color) -> some View {
        let stroke = StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)
        switch glyph {
        case .symbol(let name):
            Image(systemName: name)
                .typeSymbol(size: 13, weight: .medium)
                .foregroundStyle(tone)
        case .pullRequest:
            GitPullRequestGlyph().stroke(tone, style: stroke)
        case .merged:
            GitMergeGlyph().stroke(tone, style: stroke)
        }
    }
}

// MARK: - List row

/// An Arc in the chat list's Arcs section: its name, what is moving, and when
/// it last did. Drawn like a chat row so the list stays one surface.
struct ArcListRow: View {
    let arc: ArcSummary
    /// Sessions in this arc, from the same snapshot the row came from.
    let sessions: [SessionSummary]
    let now: Date
    let separated: Bool
    let open: () -> Void

    @ScaledMetric(relativeTo: .body) private var titleLineHeight: CGFloat = 22

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 0) {
                Group {
                    if sessions.contains(where: { $0.state == .running }) {
                        WorkingNest(size: 16)
                    } else {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .typeSymbol(size: 14, weight: .medium)
                            .foregroundStyle(Theme.muted)
                    }
                }
                .frame(width: 16, height: titleLineHeight)
                .padding(.trailing, Spacing.snug)
                VStack(alignment: .leading, spacing: 3) {
                    Text(arc.name)
                        .typeRowTitle()
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(status)
                        .typeSubtitle(ink: Theme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: Spacing.row)
                VStack(alignment: .trailing, spacing: Spacing.tight) {
                    Text(compactElapsed(since: parseWireTimestamp(arc.lastEventAt ?? arc.updatedAt), now: now))
                        .typeStyle(.caption2)
                        .foregroundStyle(Theme.muted)
                        .monospacedDigit()
                    if arc.state == .paused {
                        AttentionCapsule(label: "Paused", color: Theme.amber)
                    }
                }
                .layoutPriority(1)
            }
            .padding(.vertical, Spacing.row)
            .screenGutter()
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .overlay(alignment: .bottomLeading) {
            if separated {
                HairlineDivider(inset: Spacing.gutter)
                    .padding(.trailing, Spacing.gutter)
            }
        }
        .accessibilityLabel("Arc \(arc.name), \(arc.state.label), \(status)")
    }

    private var coordinatorWorking: Bool {
        sessions.contains { $0.id == arc.coordinatorSessionId && $0.state == .running }
    }

    private var workingMembers: Int {
        sessions.filter { $0.id != arc.coordinatorSessionId && !isSettled($0.state) }.count
    }

    private var status: String {
        var parts: [String] = []
        if coordinatorWorking { parts.append("Coordinator working") }
        if workingMembers > 0 { parts.append("\(workingMembers) working") }
        if parts.isEmpty {
            parts.append(arc.memberCount == 1 ? "1 chat" : "\(arc.memberCount) chats")
        }
        return parts.joined(separator: " · ")
    }
}
