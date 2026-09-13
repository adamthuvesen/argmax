import Foundation
import SwiftUI

/// Everything needed to send a card response as the next user turn.
///
/// The timeline owns the card, while the current session row owns these
/// values. Keeping that boundary explicit prevents a question or plan from
/// guessing which model and mode the provider is already using.
struct TranscriptSendContext: Equatable, Sendable {
    var sessionID: String
    var provider: String
    var modelLabel: String
    var modelID: String
    var reasoningEffort: String?
    var agentMode: String
    var isRunning: Bool
}

protocol TranscriptInteractionClient: Sendable {
    func sendInput(_ input: SendInputInput) async throws -> SendInputResult
    func terminateSession(sessionID: String) async throws -> HostOk
    func resolveTranscriptQuestion(
        _ input: ResolveTranscriptQuestionInput
    ) async throws -> TranscriptQuestionResolution
    func resolveTranscriptApproval(
        approvalID: String,
        resolution: TranscriptApprovalResolution
    ) async throws -> TranscriptApprovalRequest
}

extension BridgeClient: TranscriptInteractionClient {}

/// Executes the write side of native transcript cards.
///
/// Legacy question and plan tools end their provider-side control call with a
/// denial, so their reply is a new user message. Codex's blocking question
/// keeps the provider request alive and resolves it through the question
/// broker instead, without stopping or starting a turn.
@MainActor
final class TranscriptInteractionCoordinator: ObservableObject {
    @Published private(set) var failure: String?

    private let client: any TranscriptInteractionClient

    init(client: any TranscriptInteractionClient) {
        self.client = client
    }

    func answerQuestion(
        _ response: TranscriptQuestionResponse,
        card: TranscriptQuestionCard,
        context: TranscriptSendContext
    ) async -> Bool {
        guard let requestID = card.requestID else {
            return await sendAfterStopping(
                response.displayText,
                context: context,
                agentMode: context.agentMode
            )
        }
        return await resolveQuestion(
            sessionID: card.sessionID ?? context.sessionID,
            requestID: requestID,
            answers: response.answers,
            dismissed: nil
        )
    }

    func dismissQuestion(
        card: TranscriptQuestionCard,
        context: TranscriptSendContext
    ) async -> Bool {
        guard let requestID = card.requestID else { return true }
        return await resolveQuestion(
            sessionID: card.sessionID ?? context.sessionID,
            requestID: requestID,
            answers: [:],
            dismissed: true
        )
    }

    func sendMessage(_ message: String, context: TranscriptSendContext) async -> Bool {
        await send(message, context: context, agentMode: context.agentMode, stopFirst: false)
    }

    func acceptPlan(context: TranscriptSendContext) async -> Bool {
        await sendAfterStopping("Proceed with the plan above.", context: context, agentMode: "auto")
    }

    func resolveApproval(
        id: String,
        resolution: TranscriptApprovalResolution
    ) async -> Bool {
        failure = nil
        do {
            _ = try await client.resolveTranscriptApproval(approvalID: id, resolution: resolution)
            return true
        } catch {
            failure = hostFailureMessage(error)
            return false
        }
    }

    func stopSession(id: String) async -> Bool {
        failure = nil
        do {
            _ = try await client.terminateSession(sessionID: id)
            return true
        } catch {
            failure = hostFailureMessage(error)
            return false
        }
    }

    func clearFailure() {
        failure = nil
    }

    private func resolveQuestion(
        sessionID: String,
        requestID: String,
        answers: [String: [String]],
        dismissed: Bool?
    ) async -> Bool {
        failure = nil
        do {
            _ = try await client.resolveTranscriptQuestion(ResolveTranscriptQuestionInput(
                sessionId: sessionID,
                requestId: requestID,
                answers: answers,
                dismissed: dismissed
            ))
            return true
        } catch {
            failure = hostFailureMessage(error)
            return false
        }
    }

    private func sendAfterStopping(
        _ text: String,
        context: TranscriptSendContext,
        agentMode: String
    ) async -> Bool {
        await send(text, context: context, agentMode: agentMode, stopFirst: context.isRunning)
    }

    private func send(
        _ text: String,
        context: TranscriptSendContext,
        agentMode: String,
        stopFirst: Bool
    ) async -> Bool {
        failure = nil
        do {
            if stopFirst {
                _ = try await client.terminateSession(sessionID: context.sessionID)
            }
            _ = try await client.sendInput(SendInputInput(
                sessionId: context.sessionID,
                input: text,
                provider: context.provider,
                modelLabel: context.modelLabel,
                modelId: context.modelID,
                reasoningEffort: context.reasoningEffort,
                agentMode: agentMode
            ))
            return true
        } catch {
            failure = hostFailureMessage(error)
            return false
        }
    }
}

/// The timeline's interactive cases share one action coordinator so every
/// write has the same stop-before-answer and error behavior.
struct TranscriptInteractiveRow: View {
    let item: TranscriptItem
    let client: BridgeClient
    let onOpenFile: (String) -> Void
    var onRevisePlan: () -> Void = {}
    var onOpenSession: ((String) -> Void)?

    @EnvironmentObject private var transcript: TranscriptStore
    @EnvironmentObject private var dashboard: DashboardStore
    @StateObject private var actions: TranscriptInteractionCoordinator

    init(
        item: TranscriptItem,
        client: BridgeClient,
        onOpenFile: @escaping (String) -> Void,
        onRevisePlan: @escaping () -> Void = {},
        onOpenSession: ((String) -> Void)? = nil
    ) {
        self.item = item
        self.client = client
        self.onOpenFile = onOpenFile
        self.onRevisePlan = onRevisePlan
        self.onOpenSession = onOpenSession
        _actions = StateObject(wrappedValue: TranscriptInteractionCoordinator(client: client))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            switch item {
            case .plan(let plan):
                TranscriptPlanCard(
                    plan: plan,
                    client: client,
                    onOpenFile: onOpenFile,
                    onAccept: {
                        guard let context = sendContext else { return false }
                        let sent = await actions.acceptPlan(context: context)
                        if sent { await transcript.reload() }
                        return sent
                    },
                    onRevise: onRevisePlan
                )
            case .approval(let approval):
                TranscriptApprovalCard(approval: approval) { resolution in
                    let resolved = await actions.resolveApproval(id: approval.id, resolution: resolution)
                    if resolved { await transcript.reload() }
                    return resolved
                }
            case .agents(let group):
                TranscriptAgentGroupView(
                    group: group,
                    client: client,
                    onLoadEvents: loadAgentEvents,
                    onOpenFile: onOpenFile
                )
            case .multitask(let multitask):
                let live = liveMultitask(for: multitask)
                TranscriptMultitaskRow(
                    multitask: multitask,
                    liveState: live?.state,
                    liveLabel: live?.label,
                    client: client,
                    onLoad: loadMultitask,
                    onOpenFile: onOpenFile,
                    onOpenFullChat: onOpenSession
                )
            default:
                EmptyView()
            }

            if let failure = actions.failure {
                Text(failure)
                    .typeStyle(.footnote)
                    .foregroundStyle(Theme.rose)
                    .accessibilityLabel("Action failed. \(failure)")
            }
        }
    }

    private var sendContext: TranscriptSendContext? {
        guard let composer = transcript.composer else { return nil }
        return TranscriptSendContext(
            sessionID: composer.sessionId,
            provider: composer.provider,
            modelLabel: composer.modelLabel,
            modelID: composer.modelId,
            reasoningEffort: composer.effort,
            agentMode: dashboard.snapshot.sessions.first { $0.id == composer.sessionId }?.agentMode ?? "auto",
            isRunning: composer.running
        )
    }

    private func context(for session: TranscriptSessionMetadata) -> TranscriptSendContext {
        TranscriptSendContext(
            sessionID: session.id,
            provider: session.provider,
            modelLabel: session.modelLabel,
            modelID: session.modelId,
            reasoningEffort: session.reasoningEffort,
            agentMode: session.agentMode ?? "auto",
            isRunning: session.state == .running
        )
    }

    private func loadAgentEvents(_ agent: TranscriptAgent) async throws -> [TranscriptItem] {
        try await transcript.loadAgentEvents(for: agent)
    }

    private func loadMultitask(_ sessionID: String) async throws -> TranscriptMultitaskDetailSnapshot {
        async let page = client.transcriptEvents(sessionID: sessionID)
        async let dashboard = client.transcriptDashboard()
        let (loadedPage, loadedDashboard) = try await (page, dashboard)
        guard let session = loadedDashboard.sessions.first(where: { $0.id == sessionID }) else {
            throw BridgeError.malformedResponse
        }
        let workspacePath = loadedDashboard.workspaces.first { $0.id == session.workspaceId }?.path
        return TranscriptMultitaskDetailSnapshot(
            items: TranscriptProjection.project(events: loadedPage.events, workspacePath: workspacePath),
            sendContext: context(for: session),
            workspacePath: workspacePath
        )
    }

    private func liveMultitask(
        for multitask: TranscriptMultitask
    ) -> (state: String, label: String?)? {
        guard let childSessionID = multitask.childSessionId,
              let session = dashboard.snapshot.sessions.first(where: { $0.id == childSessionID })
        else { return nil }
        let label = dashboard.snapshot.workspaces.first(where: { $0.id == session.workspaceId })?.taskLabel
        return (session.state.rawWire, label)
    }
}
