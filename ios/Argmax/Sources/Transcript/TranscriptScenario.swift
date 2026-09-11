#if DEBUG
import SwiftUI

/// Deterministic UI-test content using the production projection, transcript,
/// composer, and rich viewers. The preview client never opens a connection.
struct TranscriptScenario: View {
    @StateObject private var scenario = TranscriptScenarioState()
    @StateObject private var navigator = ChatNavigator()
    @State private var input = ""
    @State private var dark = ProcessInfo.processInfo.arguments.contains("-scenario-dark")
    @State private var large = ProcessInfo.processInfo.arguments.contains("-scenario-large")

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Stream", action: scenario.stream)
                Button("Prepend", action: scenario.prepend)
                Button("Rich", action: scenario.showRich)
                Button("Theme") { dark.toggle() }
                Button("Size") { large.toggle() }
            }
            .font(.caption)
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
            .dynamicTypeSize(.large)
            NativeTranscriptView(client: scenario.client, onOpenFile: { _ in }, onRevisePlan: {})
            TranscriptComposer(workspaceID: "w-scenario", input: $input)
        }
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
