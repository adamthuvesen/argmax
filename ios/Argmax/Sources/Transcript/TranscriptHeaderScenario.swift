#if DEBUG
import SwiftUI

/// Opens the real chat screen with deterministic content and no host connection.
struct TranscriptHeaderScenario: View {
    @StateObject private var content = TranscriptHeaderScenarioContent()
    @StateObject private var navigator = ChatNavigator()
    @StateObject private var push = PushDelegate()
    @State private var path = NavigationPath()
    @State private var opened = false

    let appearance: Appearance

    private let dark = ProcessInfo.processInfo.arguments.contains("-scenario-dark")
    private let large = ProcessInfo.processInfo.arguments.contains("-scenario-large")

    var body: some View {
        NavigationStack(path: $path) {
            Button("Open chat") { path.append(content.row) }
                .navigationDestination(for: ChatRow.self) { row in
                    TranscriptScreen(row: row)
                        .task {
                            // The screen claims its session on appearance. Seed
                            // after that claim so its disconnected preview
                            // client cannot replace the fixture with an error.
                            await Task.yield()
                            content.seedTranscript()
                        }
                }
                .reviewDestinations(store: content.dashboard, onPop: { path.removeLast() })
        }
        .environmentObject(content.dashboard)
        .environmentObject(content.transcript)
        .environmentObject(navigator)
        .environmentObject(push)
        .environmentObject(appearance)
        .appearance(appearance)
        .preferredColorScheme(dark ? .dark : .light)
        .environment(\.dynamicTypeSize, large ? .accessibility1 : .large)
        .onAppear {
            guard !opened else { return }
            opened = true
            path.append(content.row)
        }
        .onChange(of: navigator.review) { _, route in
            guard let route else { return }
            navigator.review = nil
            path.append(route)
        }
    }
}

@MainActor
private final class TranscriptHeaderScenarioContent: ObservableObject {
    let dashboard: DashboardStore
    let transcript: TranscriptStore
    let row: ChatRow

    init() {
        let client = previewClient()
        dashboard = DashboardStore(client: client)
        transcript = TranscriptStore(client: client)

        var workspace = previewWorkspace
        workspace.taskLabel = "Repository overview"
        workspace.branch = "main"
        if ProcessInfo.processInfo.arguments.contains("-scenario-scratch") {
            workspace.kind = .scratch
            workspace.projectId = scratchProjectID
        }
        var session = previewSession
        session.state = .complete
        dashboard.ingest(snapshot: DashboardSnapshot(
            projects: previewSnapshot.projects,
            workspaces: [workspace],
            sessions: [session]
        ))
        row = ChatRow(
            workspace: workspace,
            session: session,
            projectName: workspace.kind == .scratch ? "Chat" : "argmax",
            attention: session.attention,
            working: false
        )
    }

    func seedTranscript() {
        let events = (0..<24).flatMap { turn -> [TranscriptEvent] in
            let question = "Review the repository structure, part \(turn + 1)."
            let answer = "The code is organized by feature. Each screen owns its view state, while shared models describe sessions and workspaces.\n\n" +
                "The transcript remains readable as new answers arrive and earlier work scrolls beneath the header."
            return [
                Self.event(turn * 2 + 1, type: "user.message", text: question),
                Self.event(turn * 2 + 2, type: "message.completed", text: answer)
            ]
        }
        transcript.preview(
            page: TranscriptPage(events: events, rawOutputs: [], eventCursor: 48,
                                 rawOutputCursor: 0, changeCursor: 1,
                                 deletedEventIds: [], deletedRawOutputIds: [],
                                 resetRequired: false, hasMore: false),
            metadata: TranscriptSessionMetadata(
                id: row.session.id, workspaceId: row.workspace.id,
                provider: row.session.provider, modelLabel: row.session.modelLabel,
                modelId: row.session.modelId, prompt: row.session.prompt,
                state: row.session.state, attention: row.session.attention,
                reasoningEffort: row.session.reasoningEffort
            ),
            title: row.workspace.taskLabel,
            workspacePath: row.workspace.path
        )
    }

    private static func event(_ index: Int, type: String, text: String) -> TranscriptEvent {
        TranscriptEvent(
            id: "header-event-\(index)", sessionId: previewSession.id,
            type: type, message: text, payload: .object([:]),
            createdAt: String(format: "2026-01-01T00:%02d:%02d.000Z", index / 60, index % 60),
            rowCursor: Int64(index)
        )
    }
}
#endif
