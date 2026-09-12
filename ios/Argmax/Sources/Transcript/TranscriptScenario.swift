#if DEBUG
import SwiftUI

/// Deterministic UI-test content using the production projection, transcript,
/// composer, and rich viewers. The preview client never opens a connection.
struct TranscriptScenario: View {
    @StateObject private var scenario = TranscriptScenarioState()
    @StateObject private var navigator = ChatNavigator()
    @State private var input = ""
    @State private var focusRequest = 0
    @State private var screenHeight: CGFloat = 0
    @State private var dark = ProcessInfo.processInfo.arguments.contains("-scenario-dark")
    @State private var large = ProcessInfo.processInfo.arguments.contains("-scenario-large")

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Stream", action: scenario.stream)
                Button("Prepend", action: scenario.prepend)
                Button("Rich", action: scenario.showRich)
                Button("Ask", action: scenario.ask)
                Button("Theme") { dark.toggle() }
                Button("Size") { large.toggle() }
            }
            .typeStyle(.caption)  // type-exception: the #if DEBUG scenario toolbar, which never ships
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
            .dynamicTypeSize(.large)
            NativeTranscriptView(
                client: scenario.client,
                onOpenFile: { _ in },
                onOpenDiff: { _ in },
                onRevisePlan: {}
            )
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    // The floor, not the bare composer: an outstanding question
                    // takes this slot, and its ceiling is read off the screen.
                    TranscriptComposerFloor(workspaceID: "w-scenario", client: scenario.client,
                                            screenHeight: screenHeight,
                                            draft: $input, focusRequest: $focusRequest)
                        .background(Theme.ground)
                }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }
        .background(Theme.ground)
        .environmentObject(scenario.transcript)
        .environmentObject(scenario.dashboard)
        .environmentObject(navigator)
        .preferredColorScheme(dark ? .dark : .light)
        .environment(\.dynamicTypeSize, large ? .accessibility1 : .large)
    }
}

@MainActor
private final class TranscriptScenarioState: ObservableObject {
    let client: BridgeClient
    let transcript: TranscriptStore
    let dashboard: DashboardStore
    private var revision: Int64 = 100
    private var streamCount = 0
    private var oldest = 20

    init() {
        client = previewClient()
        transcript = TranscriptStore(client: client)
        dashboard = DashboardStore(client: client)
        let events = (20..<50).flatMap { index in
            [event(index * 2, type: "user.message", text: "Question \(index)"),
             event(index * 2 + 1, type: index == 49 ? "message.delta" : "message.completed",
                   text: "Answer \(index)\n\nThis is a transcript paragraph used to verify stable reading while the conversation changes.")]
        }
        transcript.preview(page: page(events), metadata: metadata)
        if ProcessInfo.processInfo.arguments.contains("-scenario-user-bubble") {
            transcript.preview(page: page([
                event(1, type: "user.message", text: "Short prompt"),
                event(2, type: "user.message", text: String(repeating: "A long pasted prompt wraps across the phone.\n\n", count: 8)),
                event(3, type: "message.completed", text: "Reply after the prompt")
            ]), metadata: metadata)
        }
        if ProcessInfo.processInfo.arguments.contains("-scenario-activity") {
            transcript.preview(page: page(activityEvents()), metadata: metadata)
        }
        if ProcessInfo.processInfo.arguments.contains("-scenario-ask") { ask() }
    }

    /// Provider-neutral activity metadata rendered through the production
    /// projection. The fixture includes all four semantic colours and one MCP
    /// mark, so a simulator screenshot catches both palette and precedence.
    private func activityEvents() -> [TranscriptEvent] {
        var events = [event(1, type: "user.message", text: "Polish the transcript activity")]
        let calls: [(String, String, String, [String], Int?)] = [
            ("read", "Read", "read", ["Sources/App.swift", "Sources/Store.swift"], nil),
            ("edit", "Edit", "edit", ["Sources/App.swift"], nil),
            ("search", "Grep", "search", [], nil),
            ("image", "ViewImage", "image", ["design/wireframe.png"], nil),
            ("discover", "ToolSearch", "discovery", [], 3),
            ("command", "Bash", "command", [], nil),
            ("computer", "computer", "computer", [], nil),
            ("linear", "mcp__linear__list_issues", "tool", [], nil)
        ]
        for (offset, call) in calls.enumerated() {
            let cursor = 2 + offset * 2
            let activity = activity(kind: call.2, targets: call.3, toolCount: call.4)
            events.append(toolEvent(cursor, type: "command.started", id: call.0, name: call.1,
                                    activity: activity,
                                    filePath: call.2 == "edit" ? call.3.first : nil,
                                    completed: false))
            events.append(toolEvent(cursor + 1, type: "command.completed", id: call.0, name: call.1,
                                    activity: activity, completed: true))
        }
        events.append(event(18, type: "message.completed", text: "The activity summary is ready."))
        return events
    }

    private func activity(
        kind: String,
        targets: [String],
        toolCount: Int?
    ) -> TranscriptJSONValue {
        var object: [String: TranscriptJSONValue] = [
            "version": .number(1),
            "kind": .string(kind),
            "evidence": .string("native"),
            "targets": .array(targets.map(TranscriptJSONValue.string))
        ]
        if let toolCount { object["toolCount"] = .number(Double(toolCount)) }
        return .object(object)
    }

    private func toolEvent(
        _ index: Int,
        type: String,
        id: String,
        name: String,
        activity: TranscriptJSONValue,
        filePath: String? = nil,
        completed: Bool
    ) -> TranscriptEvent {
        var payload: [String: TranscriptJSONValue] = [
            completed ? "tool_use_id" : "id": .string(id),
            "activity": activity
        ]
        if completed {
            payload["output"] = .string("Completed")
        } else {
            payload["name"] = .string(name)
            if let filePath {
                payload["input"] = .object(["file_path": .string(filePath)])
            }
        }
        return TranscriptEvent(
            id: "activity-\(id)-\(completed ? "end" : "start")",
            sessionId: "s-scenario",
            type: type,
            message: name,
            payload: .object(payload),
            createdAt: String(format: "2026-01-01T00:01:%02d.000Z", index),
            rowCursor: Int64(index)
        )
    }

    func stream() {
        streamCount += 1
        let body = "Answer 49\n\n" + String(repeating: "More streamed content wraps across the available width.\n\n", count: streamCount * 3)
            + "Stream end \(streamCount)"
        revision += 1
        transcript.ingest(page: page([event(99, type: "message.delta", text: body)]), for: metadata.id)
    }

    func prepend() {
        let range = (oldest - 5)..<oldest
        oldest -= 5
        revision += 1
        let events = range.flatMap { index in
            [event(index * 2, type: "user.message", text: "Question \(index)"),
             event(index * 2 + 1, type: "message.completed", text: "Answer \(index)\n\nEarlier history loaded above the reader.")]
        }
        transcript.ingest(page: page(events), for: metadata.id)
    }

    /// A live question with the long option descriptions that made the dock
    /// scroll internally when it was capped at a fixed height.
    func ask() {
        let options: [(String, String)] = [
            ("Per-device (Recommended)",
             "Matches how theme, accent and mascot already work on the phone: it borrows the web key name (argmax.font.family) but holds its own value in UserDefaults."),
            ("Follow the Mac",
             "The phone reads the desktop's font setting over the bridge. New plumbing, and breaks the established per-device appearance rule.")
        ]
        let payload: [String: TranscriptJSONValue] = [
            "id": .string("ask-tool"),
            "name": .string("AskUserQuestion"),
            "input": .object(["questions": .array([
                .object([
                    "question": .string("Should the choice sync from the Mac or stay per-device?"),
                    "header": .string("Sync"),
                    "options": .array(options.map {
                        .object(["label": .string($0.0), "description": .string($0.1)])
                    })
                ])
            ])])
        ]
        revision += 1
        transcript.preview(page: page([
            event(1, type: "user.message", text: "Add custom font support"),
            TranscriptEvent(id: "ask-start", sessionId: "s-scenario", type: "command.started",
                            message: "AskUserQuestion", payload: .object(payload),
                            createdAt: "2026-01-01T00:01:00.000Z", rowCursor: 2)
        ]), metadata: metadata)
    }

    func showRich() {
        var source = #"""
        Native rich content

        $$\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$

        ```mermaid
        flowchart LR
            Input --> Native --> Output
        ```

        | Surface | Renderer |
        | --- | --- |
        | Math | SwaTex |
        | Diagram | MermaidKit |

        ```swift
        let answer = 42
        ```
        """#
        if ProcessInfo.processInfo.arguments.contains("-scenario-wide") {
            let equation = (1...40).map { "x_{\($0)}" }.joined(separator: " + ")
            let diagram = "flowchart LR\n" + (1...15).map { "N\($0)[Stage \($0)] --> N\($0 + 1)" }.joined(separator: "\n")
            source = "$$\(equation)$$\n\n```mermaid\n\(diagram)\n```"
        }
        transcript.preview(page: page([event(1, type: "user.message", text: "Render the examples"),
                                       event(2, type: "message.completed", text: source)]), metadata: metadata)
    }

    private var metadata: TranscriptSessionMetadata {
        TranscriptSessionMetadata(id: "s-scenario", workspaceId: "w-scenario", provider: "claude",
                                  modelLabel: "Opus", modelId: "claude-opus", prompt: "",
                                  state: .running, attention: .normal, reasoningEffort: "high", agentMode: "auto")
    }

    private func event(_ index: Int, type: String, text: String) -> TranscriptEvent {
        TranscriptEvent(id: "event-\(index)", sessionId: "s-scenario", type: type, message: text,
                        payload: .object([:]), createdAt: String(format: "2026-01-01T00:%02d:%02d.000Z", index / 60, index % 60),
                        rowCursor: Int64(index))
    }

    private func page(_ events: [TranscriptEvent]) -> TranscriptPage {
        TranscriptPage(events: events, rawOutputs: [], eventCursor: 99, rawOutputCursor: 0,
                       changeCursor: revision, deletedEventIds: [], deletedRawOutputIds: [],
                       resetRequired: false, hasMore: false)
    }
}
#endif
