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

    private func label(_ channel: String) -> String {
        switch channel {
        case "session:send-message", "session:follow-up": return "Send message"
        case "session:stop", "session:terminate": return "Stop chat"
        case "session:launch": return "Start chat"
        case "workspaces:archive": return "Archive chat"
        case "approvals:respond": return "Answer approval"
        default: return "Remote action"
        }
    }
}
