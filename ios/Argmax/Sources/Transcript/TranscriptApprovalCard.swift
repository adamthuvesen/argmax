import SwiftUI

enum TranscriptApprovalResolution: String, Encodable, Sendable {
    case approved
    case rejected
}

struct TranscriptApprovalRequest: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var command: String
    var cwd: String
    var provider: String
    var providerInvocationId: String?
    var providerRequestId: String?
    var riskLevel: String
    var status: String
    var createdAt: String
    var resolvedAt: String?
}

struct ResolveTranscriptApprovalInput: Encodable, Sendable {
    var approvalId: String
    var status: TranscriptApprovalResolution
}

extension BridgeClient {
    func pendingTranscriptApprovals() async throws -> [TranscriptApprovalRequest] {
        try await request(
            "approvals:pending",
            input: EmptyInput(),
            as: [TranscriptApprovalRequest].self
        )
    }

    func resolveTranscriptApproval(
        approvalID: String,
        resolution: TranscriptApprovalResolution
    ) async throws -> TranscriptApprovalRequest {
        try await request(
            "approvals:resolve",
            input: ResolveTranscriptApprovalInput(approvalId: approvalID, status: resolution),
            as: TranscriptApprovalRequest.self
        )
    }
}

struct TranscriptApprovalAction: Equatable, Sendable {
    struct Argument: Equatable, Sendable, Identifiable {
        var key: String
        var value: String

        var id: String { key }
    }

    var title: String
    var arguments: [Argument]
}

/// Shell commands stay intact. Provider tool requests are encoded as
/// `ToolName\n{json}`. Only scalar values describe the permission decision.
func transcriptApprovalAction(_ command: String) -> TranscriptApprovalAction {
    guard let newline = command.firstIndex(of: "\n") else {
        return TranscriptApprovalAction(title: command, arguments: [])
    }
    let title = command[..<newline].trimmingCharacters(in: .whitespacesAndNewlines)
    let rawJSON = String(command[command.index(after: newline)...])
    guard let data = rawJSON.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return TranscriptApprovalAction(title: command, arguments: [])
    }
    let arguments = object.keys.sorted().compactMap { key -> TranscriptApprovalAction.Argument? in
        let value = object[key]
        switch value {
        case let string as String:
            return .init(key: key, value: string)
        case let bool as Bool:
            return .init(key: key, value: bool ? "true" : "false")
        case let number as NSNumber:
            return .init(key: key, value: number.stringValue)
        case _ as NSNull:
            return .init(key: key, value: "null")
        default:
            return nil
        }
    }
    return TranscriptApprovalAction(title: title, arguments: arguments)
}

struct TranscriptApprovalCard: View {
    let approval: TranscriptApproval
    let onResolve: (TranscriptApprovalResolution) async -> Bool

    @State private var submitting: TranscriptApprovalResolution?
    @State private var submitted: TranscriptApprovalResolution?
    @State private var failure: String?

    private var action: TranscriptApprovalAction {
        transcriptApprovalAction(approval.command)
    }

    private var isPending: Bool { approval.status == .pending && submitted == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.row) {
            HStack(alignment: .firstTextBaseline) {
                Label {
                    Text("Approval needed").typeStyle(.footnote, weight: .semibold)
                } icon: {
                    Image(systemName: "lock.shield").typeSymbol(.subheadline, weight: .semibold)
                }
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: Spacing.snug)
                if let riskLevel = approval.riskLevel, riskLevel != "low" {
                    AttentionCapsule(
                        label: riskLevel.capitalized,
                        color: riskLevel == "high" ? Theme.rose : Theme.amber
                    )
                }
            }

            Text(action.title)
                .typeStyle(.footnote, mono: true)
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            if !action.arguments.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.tight) {
                    ForEach(action.arguments) { argument in
                        HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
                            Text(argument.key)
                                .typeChip()
                                .foregroundStyle(Theme.muted)
                            Text(argument.value)
                                .typeStyle(.footnote, mono: true)
                                .foregroundStyle(Theme.ink)
                                .textSelection(.enabled)
                                .lineLimit(3)
                        }
                    }
                }
            }

            if let workingDirectory = approval.workingDirectory, !workingDirectory.isEmpty {
                Label {
                    Text(workingDirectory).typeStyle(.caption, mono: true)
                } icon: {
                    Image(systemName: "folder").typeSymbol(.caption)
                }
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }

            if let failure {
                Text(failure)
                    .typeStyle(.footnote)
                    .foregroundStyle(Theme.rose)
                    .accessibilityLabel("Could not send response. \(failure)")
            }

            if isPending {
                HStack(spacing: Spacing.snug) {
                    QuietButton(title: submitting == .rejected ? "Rejecting…" : "Reject") {
                        resolve(.rejected)
                    }
                    .disabled(submitting != nil)

                    PrimaryButton(
                        title: submitting == .approved ? "Approving…" : "Approve",
                        busy: submitting == .approved
                    ) {
                        resolve(.approved)
                    }
                    .disabled(submitting != nil)
                }
            } else {
                Label {
                    Text(statusLabel).typeStyle(.footnote, weight: .medium)
                } icon: {
                    Image(systemName: statusImage).typeSymbol(.footnote, weight: .medium)
                }
                    .foregroundStyle(statusColor)
                    .accessibilityLabel(statusLabel)
            }
        }
        .padding(Spacing.row)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Command approval")
    }

    private var statusLabel: String {
        if let submitted { return submitted == .approved ? "Approved" : "Rejected" }
        switch approval.status {
        case .approved: return "Approved"
        case .rejected: return "Rejected"
        case .cancelled: return "No longer active"
        case .blocked: return "Blocked"
        case .pending: return "Pending"
        }
    }

    private var statusImage: String {
        statusLabel == "Approved" ? "checkmark.circle.fill" : "xmark.circle.fill"
    }

    private var statusColor: Color {
        statusLabel == "Approved" ? Theme.sage : Theme.muted
    }

    private func resolve(_ resolution: TranscriptApprovalResolution) {
        guard submitting == nil else { return }
        submitting = resolution
        failure = nil
        Task {
            let ok = await onResolve(resolution)
            if ok {
                submitted = resolution
                Haptics.success()
            } else {
                failure = "The provider did not accept the response. Try again."
                Haptics.error()
            }
            submitting = nil
        }
    }
}
