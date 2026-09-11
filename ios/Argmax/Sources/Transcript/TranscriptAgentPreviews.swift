#if DEBUG
import SwiftUI

// Fixtures for the delegated-work sheet's `#Preview`s, and only for them.
//
// The sheet is only reachable from a chat whose agent has already run, which
// is the one state a design pass cannot produce on demand. This is the run
// that showed the spacing up: answers and folded thinking alternating, a
// nested agent at the top, and a name that is the prompt rather than a
// codename.

private func previewAgentMessage(_ id: String, _ text: String,
                                 role: TranscriptMessageRole = .assistant) -> TranscriptItem {
    let message = TranscriptMessage(
        id: id, role: role, text: text, createdAt: "2026-09-12T10:00:00.000Z",
        isStreaming: false, isSteering: role == .user, originLabel: nil, attachments: []
    )
    return role == .user ? .user(message) : .assistant(message)
}

private func previewAgentThought(_ id: String, _ text: String) -> TranscriptItem {
    .thought(TranscriptThought(id: id, text: text, createdAt: "2026-09-12T10:00:00.000Z",
                               isStreaming: false))
}

private func previewAgentTools(_ id: String, _ tools: [(String, String)]) -> TranscriptItem {
    .tools(TranscriptToolGroup(
        id: id,
        tools: tools.enumerated().map { index, tool in
            TranscriptTool(
                id: "\(id)-\(index)", toolUseId: "\(id)-\(index)", name: tool.0,
                summary: tool.1, input: nil, output: nil, error: nil, status: .done,
                createdAt: "2026-09-12T10:00:00.000Z", completedAt: "2026-09-12T10:00:04.000Z",
                filePath: nil, fileLabel: nil
            )
        },
        createdAt: "2026-09-12T10:00:00.000Z"
    ))
}

@MainActor
let previewDelegatedAgent = TranscriptAgent(
    id: "agent-preview",
    parentSessionId: "s-preview",
    toolUseId: "toolu-preview",
    // No codename, and a prompt that opens with an attachment token: the
    // navigation bar used to read "[local_image:/Users/adamthuvese…".
    name: "[local_image:/Users/you/Library/Application Support/com.argmax.rs/attachments/shot.jpg] Review the spacing",
    prompt: "Review the spacing in the subagent sheet.",
    status: .done,
    createdAt: "2026-09-12T10:00:00.000Z",
    completedAt: "2026-09-12T10:02:00.000Z",
    providerChildSessionId: nil,
    providerParentConversationId: nil,
    agentCodename: nil,
    children: []
)

@MainActor
let previewDelegatedAgentActivity: [TranscriptItem] = [
    .agents(TranscriptAgentGroup(
        id: "nested-preview",
        agents: [TranscriptAgent(
            id: "agent-nested", parentSessionId: "s-preview", toolUseId: "toolu-nested",
            name: "Check the notification path", prompt: nil, status: .done,
            createdAt: "2026-09-12T10:00:00.000Z", completedAt: "2026-09-12T10:00:40.000Z",
            providerChildSessionId: nil, providerParentConversationId: nil,
            agentCodename: "Scout", children: []
        )],
        createdAt: "2026-09-12T10:00:00.000Z"
    )),
    previewAgentMessage("answer-1", """
        I'll review the native transcript and completion-notice paths, then give a \
        focused verdict on the layout and the smallest implementation that fits the \
        existing attachment model.
        """),
    previewAgentThought("thought-1", "**Keeping output brief**"),
    previewAgentTools("tools-1", [("Read", "NativeTranscriptView.swift"),
                                  ("Grep", "completion notice")]),
    previewAgentMessage("answer-2", """
        The screenshot shows two distinct issues: the image sits inside a large padded \
        text bubble, and the notification banner contains Markdown delimiters.
        """),
    previewAgentThought("thought-2", "**Adding missing session default**\n\n**Searching session completion events**"),
    previewAgentMessage("steer-1", "Keep it to the layout.", role: .user),
    previewAgentMessage("answer-3", """
        The existing model already separates text from attachments, so this can be a \
        view-level layout change. Changing `TranscriptMarkdown` would not fix that banner.
        """)
]

@MainActor
private func previewAgentDetail(_ items: [TranscriptItem]) -> some View {
    TranscriptAgentDetail(
        agent: previewDelegatedAgent,
        client: previewClient(),
        onLoadEvents: { _ in items },
        onDismiss: {}
    )
    .environmentObject(previewStore())
    // Its own defaults, so a preview never writes the phone's appearance.
    .environmentObject(Appearance(store: UserDefaults(suiteName: "argmax.preview") ?? .standard))
}

#Preview("Delegated work · light") {
    previewAgentDetail(previewDelegatedAgentActivity)
        .preferredColorScheme(.light)
}

#Preview("Delegated work · dark") {
    previewAgentDetail(previewDelegatedAgentActivity)
        .preferredColorScheme(.dark)
}

#Preview("Delegated work · nothing to show") {
    previewAgentDetail([])
        .preferredColorScheme(.dark)
}
#endif
