import Foundation

// The host-derived meaning is generated from its Rust binding.
// This extension keeps projection-only conveniences.
extension TranscriptEvent {
    var timelineMeaning: TimelineSemantics.Event? {
        semantic?.version == 1 ? semantic?.event : nil
    }

    var timelineContext: TimelineSemantics.Context? {
        semantic?.version == 1 ? semantic?.context : nil
    }

    var semanticParentToolUseId: String? {
        if let context = timelineContext { return context.parentToolUseId }
        return payloadObject["parent_tool_use_id"]?.string
    }

    var semanticProviderInvocationId: String? {
        if let context = timelineContext { return context.providerInvocationId }
        return payloadObject["providerInvocationId"]?.string
    }

    var semanticProviderChildSessionId: String? {
        if let context = timelineContext { return context.providerChildSessionId }
        return payloadObject["providerChildSessionId"]?.string
    }

    var semanticProviderParentConversationId: String? {
        if let context = timelineContext { return context.providerParentConversationId }
        return payloadObject["providerParentConversationId"]?.string
    }

    var messageMeaning: TimelineSemantics.Message? {
        guard let timelineMeaning, case .message(let message) = timelineMeaning else { return nil }
        return message
    }

    var toolMeaning: TimelineSemantics.Tool? {
        guard let timelineMeaning, case .tool(let tool) = timelineMeaning else { return nil }
        return tool
    }

    var approvalMeaning: TimelineSemantics.Approval? {
        guard let timelineMeaning, case .approval(let approval) = timelineMeaning else { return nil }
        return approval
    }

    var agentMeaning: TimelineSemantics.Agent? {
        guard let timelineMeaning, case .agent(let agent) = timelineMeaning else { return nil }
        return agent
    }

    var lifecycleMeaning: TimelineSemantics.Lifecycle? {
        guard let timelineMeaning, case .lifecycle(let lifecycle) = timelineMeaning else { return nil }
        return lifecycle
    }

    var multitaskMeaning: TimelineSemantics.Multitask? {
        guard let timelineMeaning, case .multitask(let multitask) = timelineMeaning else { return nil }
        return multitask
    }

    var visualizationMeaning: TimelineSemantics.Visualization? {
        if let timelineMeaning {
            guard case .visualization(let value) = timelineMeaning else { return nil }
            return value
        }
        let payload = payloadObject
        guard type == "visualization.published",
              let artifactID = payload["artifactId"]?.string, UUID(uuidString: artifactID) != nil,
              let title = payload["title"]?.string,
              let summary = payload["summary"]?.string,
              let format = payload["format"]?.string, ["html", "image"].contains(format) else { return nil }
        return .init(kind: "visualization", artifactId: artifactID, title: title, format: format,
                     summary: summary, mode: payload["mode"]?.string == "wide" ? "wide" : nil)
    }

    var errorMeaning: TimelineSemantics.Error? {
        guard let timelineMeaning, case .error(let error) = timelineMeaning else { return nil }
        return error
    }

    var semanticToolUseId: String? {
        if let tool = toolMeaning { return tool.toolUseId }
        let payload = payloadObject
        return payload["tool_use_id"]?.string ?? payload["id"]?.string ?? payload["call_id"]?.string
    }

    var semanticDelivery: String? {
        if let message = messageMeaning { return message.delivery }
        return payloadObject["delivery"]?.string
    }

    var semanticApprovalId: String? {
        if let approval = approvalMeaning { return approval.approvalId }
        return payloadObject["approvalId"]?.string
    }

    var semanticApprovalProvider: String? {
        if let approval = approvalMeaning { return approval.provider }
        return payloadObject["provider"]?.string
    }

    var semanticApprovalResolution: String? {
        if let approval = approvalMeaning { return approval.resolution }
        return payloadObject["status"]?.string ?? payloadObject["resolution"]?.string
    }

    var isUserMessage: Bool {
        if let timelineMeaning {
            guard case .message(let message) = timelineMeaning else { return false }
            return message.role == "user"
        }
        return type == "user.message"
    }

    var isAssistantAnswer: Bool {
        if let timelineMeaning {
            guard case .message(let message) = timelineMeaning else { return false }
            return message.role == "assistant" && message.content == "answer" && !message.rawStream
        }
        return type == "message.completed" || (type == "message.delta"
            && payloadObject["thinking"]?.bool != true && payloadObject["stream"]?.string == nil)
    }

    var isToolStart: Bool {
        if let timelineMeaning {
            guard case .tool(let tool) = timelineMeaning else { return false }
            return tool.phase == "started"
        }
        return type == "command.started"
    }

    var isToolCompletion: Bool {
        if let timelineMeaning {
            guard case .tool(let tool) = timelineMeaning else { return false }
            return tool.phase == "completed"
        }
        return type == "command.completed"
    }
}
