import SwiftUI

struct RemoteRecoveryScreen: View {
    let client: BridgeClient
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.dismiss) private var dismiss
    @State private var operations: [UnresolvedRemoteOperation] = []
    @State private var failure: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.row) {
                Text("These actions may already have completed on your Mac. Check the affected chat before clearing its recovery record.")
                    .typeMeta()
                if operations.isEmpty { Text("No unconfirmed actions.").typeContent() }
                ForEach(operations, id: \.identity.operationId) { operation in
                    VStack(alignment: .leading, spacing: Spacing.snug) {
                        Text(label(operation.channel)).typeContent()
                        if let sessionID = sessionID(operation) {
                            Text(dashboard.row(forSessionID: sessionID)?.workspace.taskLabel ?? "Chat no longer listed").typeMeta()
                        }
                        if operation.hostInterrupted {
                            Button("I've checked this action") {
                                Task {
                                    do {
                                        try await client.acknowledgeOperation(operation.identity.operationId)
                                        await reload()
                                    } catch { failure = hostFailureMessage(error) }
                                }
                            }
                            .typeContent()
                            Text("Clears this record without sending another action.").typeMeta()
                        } else {
                            Text("Still awaiting a confirmed result. Repeat the original action to recover its result safely.").typeMeta()
                        }
                    }
                    .padding(Spacing.row)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.card))
                }
                if let failure { Text(failure).typeMeta().foregroundStyle(Theme.rose) }
            }
            .screenGutter()
        }
        .background(Theme.ground.ignoresSafeArea())
        .safeAreaInset(edge: .top) { ScreenHeader(title: "Unconfirmed actions", onBack: { dismiss() }) }
        .task { await reload() }
    }

    private func reload() async {
        do { operations = try await client.unresolvedOperations(); failure = nil }
        catch { failure = hostFailureMessage(error) }
    }

    private func sessionID(_ operation: UnresolvedRemoteOperation) -> String? {
        (try? JSONDecoder().decode([String: TranscriptJSONValue].self, from: operation.input))?["sessionId"]?.string
    }

    /// The journal holds this app's own mutation channels
    /// (`Bridge/Channels.swift`); the names must match those, or every row
    /// falls through to the generic label.
    private func label(_ channel: String) -> String {
        switch channel {
        case "providers:send-input", "providers:send-queued-message-now": return "Send message"
        case "providers:cancel-queued-message": return "Cancel queued message"
        case "providers:launch": return "Start chat"
        case "providers:terminate": return "Stop chat"
        case "workspaces:create-isolated", "workspaces:create-current", "workspaces:create-scratch":
            return "Create chat"
        case "workspaces:autotitle", "workspaces:set-label": return "Rename chat"
        case "workspaces:set-pinned": return "Update chat pin"
        case "workspaces:archive": return "Archive chat"
        case "session:multitask": return "Dispatch a chat"
        case "session:fork": return "Fork chat"
        case "questions:resolve": return "Answer question"
        case "git:view-or-create-pr": return "Open pull request"
        case "attachments:save-image": return "Save image"
        case "remote:register-push-device", "remote:unregister-push-device": return "Update push pairing"
        default: return "Remote action"
        }
    }
}
