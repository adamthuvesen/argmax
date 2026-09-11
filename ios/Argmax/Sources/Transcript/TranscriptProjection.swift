import Foundation

enum TranscriptProjection {
    static func project(
        events source: [TranscriptEvent],
        session: TranscriptSessionMetadata? = nil,
        pendingApprovals: [TranscriptApproval] = [],
        includingChildActivity: Bool = false,
        workspacePath: String? = nil
    ) -> [TranscriptItem] {
        let events = visibleEvents(source, includingChildActivity: includingChildActivity)
        let toolStarts = correlatedTools(
            events: events,
            sessionRunning: session?.state == .running,
            workspacePath: workspacePath
        )
        let todoAtEvent = todoSnapshots(events: events)
        let multitasks = foldedMultitasks(events: events)
        let lastUserAt = events.last(where: { $0.type == "user.message" })?.createdAt ?? ""
        var items: [TranscriptItem] = []
        var activeTurnID = session.map { "opening-\($0.id)" } ?? "opening"
        var answerSegment = 0
        var answerOpen = false
        var pickedQuestionInTurn = false
        var pickedPlanInTurn = false

        if !events.contains(where: { $0.type == "user.message" }),
           !source.contains(where: { $0.type == "session.cleared" }),
           let session,
           !session.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            items.append(.user(TranscriptMessage(
                id: "synth-user-\(session.id)",
                role: .user,
                text: session.prompt,
                createdAt: events.first?.createdAt ?? "",
                isStreaming: false,
                isSteering: false,
                originLabel: nil,
                attachments: []
            )))
        }

        for event in events {
            let payload = event.payloadObject
            let isAnswer = event.type == "message.completed" || (
                event.type == "message.delta" &&
                    payload["thinking"]?.bool != true &&
                    payload["stream"]?.string == nil
            )
            if !isAnswer, answerOpen {
                answerSegment += 1
                answerOpen = false
            }
            if event.type == "user.message" {
                let steering = payload["delivery"]?.string == "steer"
                if !steering {
                    activeTurnID = event.id
                    answerSegment = 0
                    answerOpen = false
                    pickedQuestionInTurn = false
                    pickedPlanInTurn = false
                }
                items.append(.user(TranscriptMessage(
                    id: "user-\(event.id)",
                    role: .user,
                    text: displayMessage(event.message, attachments: attachments(payload["attachments"])),
                    createdAt: event.createdAt,
                    isStreaming: false,
                    isSteering: steering,
                    originLabel: payload["origin"]?.object?["label"]?.string,
                    attachments: attachments(payload["attachments"])
                )))
                continue
            }

            if event.type == "message.delta" {
                if payload["thinking"]?.bool == true {
                    appendThought(event, streaming: session?.state == .running && event.createdAt > lastUserAt, to: &items)
                } else if let stream = payload["stream"]?.string,
                          stream == "stderr" || stream == "stdout" || stream == "pty" {
                    appendLog(event, stream: stream, to: &items)
                } else {
                    appendAssistant(
                        event,
                        blockID: "\(activeTurnID)-\(answerSegment)",
                        streaming: true,
                        to: &items
                    )
                    answerOpen = true
                }
                continue
            }

            if event.type == "message.completed" {
                appendAssistant(
                    event,
                    blockID: "\(activeTurnID)-\(answerSegment)",
                    streaming: false,
                    to: &items
                )
                answerOpen = true
                continue
            }

            if event.type == "command.started", let tool = toolStarts[event.id] {
                let normalized = normalizedToolName(tool.name)
                if isQuestionTool(normalized) {
                    if !pickedQuestionInTurn, let questions = questions(from: tool.inputObject) {
                        pickedQuestionInTurn = true
                        items.append(.question(TranscriptQuestionCard(
                            id: "question-\(tool.id)",
                            toolUseId: tool.toolUseId,
                            createdAt: tool.createdAt,
                            questions: questions,
                            isOutstanding: tool.createdAt > lastUserAt
                        )))
                    }
                    continue
                }
                if isPlanTool(normalized) {
                    if !pickedPlanInTurn,
                       tool.status != .running,
                       let markdown = tool.inputObject["plan"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !markdown.isEmpty {
                        pickedPlanInTurn = true
                        items.append(.plan(TranscriptPlan(
                            id: "plan-\(tool.id)",
                            toolUseId: tool.toolUseId,
                            markdown: markdown,
                            createdAt: tool.createdAt,
                            isOutstanding: tool.createdAt > lastUserAt
                        )))
                    }
                    continue
                }
                if tool.surface == "todo" || isHiddenTool(normalized) { continue }
                if tool.isAgent {
                    let childTools = toolStarts.values
                        .filter { $0.parentToolUseId == tool.toolUseId && !$0.isAgent }
                        .sorted(by: toolOrder)
                        .map(\.presentation)
                    let agent = TranscriptAgent(
                        id: "agent-\(tool.id)",
                        parentSessionId: event.sessionId,
                        toolUseId: tool.toolUseId,
                        name: tool.agentCodename ?? tool.preview ?? "Agent",
                        prompt: tool.inputObject["prompt"]?.string ?? tool.inputObject["instructions"]?.string,
                        status: tool.status,
                        createdAt: tool.createdAt,
                        completedAt: tool.completedAt,
                        providerChildSessionId: tool.providerChildSessionId,
                        providerParentConversationId: tool.providerParentConversationId,
                        agentCodename: tool.agentCodename,
                        children: childTools
                    )
                    appendAgent(agent, to: &items)
                } else if tool.parentToolUseId == nil || includingChildActivity {
                    appendTool(tool.presentation, to: &items)
                }
                continue
            }

            if let todo = todoAtEvent[event.id] {
                items.append(.todo(todo))
                continue
            }

            if event.type.hasPrefix("approval.") || event.type == "permission.blocked" {
                if var approval = approval(from: event) {
                    if let index = items.firstIndex(where: { $0.id == "approval-\(approval.id)" }),
                       case .approval(let previous) = items[index] {
                        approval.provider = approval.provider ?? previous.provider
                        approval.command = payload["command"]?.string ?? previous.command
                        approval.workingDirectory = approval.workingDirectory ?? previous.workingDirectory
                        approval.riskLevel = approval.riskLevel ?? previous.riskLevel
                        approval.createdAt = previous.createdAt
                        items[index] = .approval(approval)
                    } else {
                        items.append(.approval(approval))
                    }
                }
                continue
            }

            if event.type == "multitask.launched", let multitask = multitasks[event.id] {
                items.append(.multitask(multitask))
                continue
            }

            if event.type == "multitask.finished" {
                if !multitasks.values.contains(where: { $0.id == "multitask-\(event.id)" }) { continue }
                if let multitask = multitasks[event.id] { items.append(.multitask(multitask)) }
                continue
            }

            if let notice = notice(from: event) {
                appendNotice(notice, to: &items)
                if event.type == "session.moved" || event.type == "session.provider-changed" {
                    activeTurnID = "after-\(event.id)"
                }
                continue
            }

            if event.type == "error", payload["truncatedEventId"] == nil {
                items.append(.error(TranscriptError(
                    id: "error-\(event.id)",
                    message: event.message,
                    code: payload["code"]?.string,
                    operation: payload["operation"]?.string,
                    createdAt: event.createdAt
                )))
            }
        }

        let existingApprovalIDs = Set(items.compactMap { item -> String? in
            guard case .approval(let approval) = item else { return nil }
            return approval.id
        })
        for approval in pendingApprovals where !existingApprovalIDs.contains(approval.id) {
            items.append(.approval(approval))
        }
        return items.sorted(by: itemOrder)
    }

    // MARK: - Ordering and visibility

    static func visibleEvents(
        _ source: [TranscriptEvent],
        includingChildActivity: Bool = false
    ) -> [TranscriptEvent] {
        var byID: [String: TranscriptEvent] = [:]
        for event in source { byID[event.id] = event }
        var events = Array(byID.values).sorted(by: eventOrder)
        if let clear = events.last(where: { $0.type == "session.cleared" }) {
            events.removeAll { compare($0, clear) != .orderedDescending }
        }
        events.removeAll { event in
            let payload = event.payloadObject
            if payload["raw"]?.bool == true || payload["traceSyntheticSuperseded"]?.bool == true { return true }
            if event.message == "turn.completed" { return true }
            if event.type == "error" && event.message == "event payload truncated" && payload["truncatedEventId"] != nil {
                return true
            }
            if event.type == "message.completed" || event.type == "message.delta" {
                if !includingChildActivity && payload["parent_tool_use_id"]?.string != nil { return true }
                let item = payload["item"]?.object
                let isAgentMessage = payload["item_type"]?.string == "agent_message" || item?["type"]?.string == "agent_message"
                if !includingChildActivity && isAgentMessage && (
                    payload["thread_id"]?.string != nil || payload["sender_thread_id"]?.string != nil ||
                    item?["thread_id"]?.string != nil || item?["sender_thread_id"]?.string != nil
                ) { return true }
            }
            return false
        }
        return pruneAnswerDeltas(suppressAssistantAfterCards(events))
    }

    private static func suppressAssistantAfterCards(_ events: [TranscriptEvent]) -> [TranscriptEvent] {
        let tools = correlatedTools(events: events, sessionRunning: false)
        var cardStarted = false
        var pickedQuestion = false
        var pickedPlan = false
        return events.filter { event in
            if event.type == "user.message", event.payloadObject["delivery"]?.string != "steer" {
                cardStarted = false
                pickedQuestion = false
                pickedPlan = false
                return true
            }
            if event.type == "command.started", let tool = tools[event.id] {
                let name = normalizedToolName(tool.name)
                if isQuestionTool(name), !pickedQuestion, questions(from: tool.inputObject) != nil {
                    pickedQuestion = true
                    if event.payloadObject["delivery"]?.string != "async" { cardStarted = true }
                }
                if isPlanTool(name), !pickedPlan, tool.status != .running,
                   let plan = tool.inputObject["plan"]?.string,
                   !plan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    pickedPlan = true
                    cardStarted = true
                }
                return true
            }
            if cardStarted,
               (event.type == "message.completed" || event.type == "message.delta"),
               event.payloadObject["thinking"]?.bool != true {
                return false
            }
            return true
        }
    }

    private enum Boundary {
        case none
        case user
        case tool(String?)
        case completed(String)
    }

    private static func pruneAnswerDeltas(_ events: [TranscriptEvent]) -> [TranscriptEvent] {
        var boundary = Boundary.none
        var retained: [TranscriptEvent] = []
        for event in events.reversed() {
            let payload = event.payloadObject
            if event.type == "message.delta", payload["thinking"]?.bool != true {
                let superseded: Bool
                switch boundary {
                case .completed: superseded = true
                case .tool(let completed):
                    let delta = event.message.trimmingCharacters(in: .whitespacesAndNewlines)
                    superseded = delta.count >= 3 && completed?.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(delta) == true
                default: superseded = false
                }
                if superseded { continue }
            }
            retained.append(event)
            if event.type == "user.message", payload["delivery"]?.string != "steer" {
                boundary = .user
            } else if event.type == "message.completed" {
                boundary = .completed(event.message)
            } else if event.type == "command.started", payload["parent_tool_use_id"]?.string == nil {
                if case .completed(let text) = boundary { boundary = .tool(text) }
            }
        }
        return retained.reversed()
    }

    private static func eventOrder(_ lhs: TranscriptEvent, _ rhs: TranscriptEvent) -> Bool {
        compare(lhs, rhs) == .orderedAscending
    }

    private static func compare(_ lhs: TranscriptEvent, _ rhs: TranscriptEvent) -> ComparisonResult {
        if let left = lhs.rowCursor, let right = rhs.rowCursor, left != right {
            return left < right ? .orderedAscending : .orderedDescending
        }
        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt < rhs.createdAt ? .orderedAscending : .orderedDescending
        }
        if lhs.id == rhs.id { return .orderedSame }
        return lhs.id < rhs.id ? .orderedAscending : .orderedDescending
    }

    private static func itemOrder(_ lhs: TranscriptItem, _ rhs: TranscriptItem) -> Bool {
        if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
        return lhs.id < rhs.id
    }

    // MARK: - Messages

    private static func appendAssistant(
        _ event: TranscriptEvent,
        blockID: String,
        streaming: Bool,
        to items: inout [TranscriptItem]
    ) {
        let id = "answer-\(blockID)"
        let attachments = attachments(event.payloadObject["attachments"])
        if case .assistant(var previous)? = items.last, previous.id == id {
            if previous.text == event.message { return }
            previous.text = combinedText(previous.text, event.message)
            previous.isStreaming = streaming
            if !attachments.isEmpty { previous.attachments = attachments }
            items[items.count - 1] = .assistant(previous)
            return
        }
        items.append(.assistant(TranscriptMessage(
            id: id,
            role: .assistant,
            text: event.message,
            createdAt: event.createdAt,
            isStreaming: streaming,
            isSteering: false,
            originLabel: nil,
            attachments: attachments
        )))
    }

    private static func appendThought(
        _ event: TranscriptEvent,
        streaming: Bool,
        to items: inout [TranscriptItem]
    ) {
        if case .thought(var previous)? = items.last {
            if event.payloadObject["providerEventType"]?.string == "item.completed" {
                previous.text = completedThoughtText(existing: previous.text, event: event)
            } else {
                previous.text = combinedText(previous.text, event.message)
            }
            previous.isStreaming = streaming
            items[items.count - 1] = .thought(previous)
            return
        }
        items.append(.thought(TranscriptThought(
            id: "thought-\(event.id)",
            text: event.message,
            createdAt: event.createdAt,
            isStreaming: streaming
        )))
    }

    private static func completedThoughtText(existing: String, event: TranscriptEvent) -> String {
        let completed = event.message
        guard !completed.isEmpty else { return existing }

        // Codex first emits live summary fragments, then an authoritative item.completed
        // whose summary array contains those same fragments with final separators.
        let streamedSummary = (event.payloadObject["summary"]?.array ?? [])
            .compactMap(\.string)
            .joined()
        let streamedCandidates = [completed, streamedSummary].filter { !$0.isEmpty }
        if let streamed = streamedCandidates.first(where: { existing.hasSuffix($0) }) {
            let prefix = String(existing.dropLast(streamed.count))
            return joinThoughtParagraphs(prefix, completed)
        }
        return joinThoughtParagraphs(existing, completed)
    }

    private static func joinThoughtParagraphs(_ existing: String, _ incoming: String) -> String {
        guard !existing.isEmpty else { return incoming }
        if existing.hasSuffix("\n\n") { return existing + incoming }
        if existing.hasSuffix("\n") { return existing + "\n" + incoming }
        return existing + "\n\n" + incoming
    }

    private static func appendLog(_ event: TranscriptEvent, stream: String, to items: inout [TranscriptItem]) {
        let error = TranscriptError(
            id: "log-\(event.id)",
            message: event.message,
            code: stream,
            operation: nil,
            createdAt: event.createdAt
        )
        items.append(.error(error))
    }

    private static func combinedText(_ existing: String, _ incoming: String) -> String {
        if incoming.hasPrefix(existing) { return incoming }
        if existing.hasSuffix(incoming) { return existing }
        return existing + incoming
    }

    private static func attachments(_ value: TranscriptJSONValue?) -> [TranscriptAttachment] {
        (value?.array ?? []).compactMap { entry in
            guard let object = entry.object, let path = object["filePath"]?.string else { return nil }
            return TranscriptAttachment(
                filePath: path,
                mimeType: object["mimeType"]?.string ?? "application/octet-stream",
                sizeBytes: Int(object["sizeBytes"]?.number ?? 0)
            )
        }
    }

    private static func displayMessage(_ message: String, attachments: [TranscriptAttachment]) -> String {
        var display = message
        for attachment in attachments {
            display = display.replacingOccurrences(of: "@\(attachment.filePath)", with: "")
        }
        return display.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Tools and interactive cards

    private struct ProjectedTool {
        var id: String
        var toolUseId: String
        var name: String
        var inputObject: [String: TranscriptJSONValue]
        var inputText: String?
        var output: String?
        var error: String?
        var status: TranscriptToolStatus
        var createdAt: String
        var completedAt: String?
        var parentToolUseId: String?
        var surface: String?
        var providerChildSessionId: String?
        var providerParentConversationId: String?
        var agentCodename: String?
        var workspacePath: String?

        var isAgent: Bool { TranscriptProjection.isAgentTool(normalizedToolName(name)) }
        var preview: String? {
            TranscriptProjection.preview(name: name, input: inputObject, workspacePath: workspacePath)
        }

        var presentation: TranscriptTool {
            let filePath = TranscriptProjection.path(in: inputObject)
            return TranscriptTool(
                id: "tool-\(id)",
                toolUseId: toolUseId,
                name: name,
                summary: TranscriptProjection.summary(name: name, preview: preview),
                input: inputText,
                output: output,
                error: error,
                status: status,
                createdAt: createdAt,
                completedAt: completedAt,
                filePath: filePath,
                fileLabel: filePath.map { TranscriptProjection.relativePath($0, workspacePath: workspacePath) }
            )
        }
    }

    private static func correlatedTools(
        events: [TranscriptEvent],
        sessionRunning: Bool,
        workspacePath: String? = nil
    ) -> [String: ProjectedTool] {
        let completions = events.filter { $0.type == "command.completed" }
        var usedCompletions = Set<String>()
        var result: [String: ProjectedTool] = [:]
        for start in events where start.type == "command.started" {
            let payload = start.payloadObject
            let toolUseID = string(payload, keys: ["id", "call_id"]) ?? start.id
            let invocation = payload["providerInvocationId"]?.string
            let completion = completions.first { event in
                guard !usedCompletions.contains(event.id) else { return false }
                let endPayload = event.payloadObject
                let endID = string(endPayload, keys: ["tool_use_id", "id", "call_id"])
                let endInvocation = endPayload["providerInvocationId"]?.string
                return endID == toolUseID && (invocation == nil ? endInvocation == nil : endInvocation == invocation)
            }
            if let completion { usedCompletions.insert(completion.id) }
            let endPayload = completion?.payloadObject ?? [:]
            let input = mergedInput(payload, endPayload)
            let name = toolName(payload)
            let failed = isFailed(endPayload)
            let status: TranscriptToolStatus = completion == nil
                ? (sessionRunning ? .running : .done)
                : (failed ? .failed : .done)
            result[start.id] = ProjectedTool(
                id: start.id,
                toolUseId: toolUseID,
                name: name,
                inputObject: input,
                inputText: formatted(input),
                output: output(endPayload),
                error: failed ? error(endPayload) : nil,
                status: status,
                createdAt: start.createdAt,
                completedAt: completion?.createdAt,
                parentToolUseId: payload["parent_tool_use_id"]?.string,
                surface: payload["surface"]?.string,
                providerChildSessionId: payload["providerChildSessionId"]?.string,
                providerParentConversationId: payload["providerParentConversationId"]?.string,
                agentCodename: string(payload, keys: ["agentCodename", "agentNickname"]),
                workspacePath: workspacePath
            )
        }
        return result
    }

    private static func toolName(_ payload: [String: TranscriptJSONValue]) -> String {
        let input = objectValue(payload["input"])
        if payload["name"]?.string?.lowercased() == "other", let embedded = input["_toolName"]?.string {
            return embedded
        }
        if let server = payload["server"]?.string, let tool = payload["tool"]?.string {
            return tool.contains(".") ? tool : "\(server).\(tool)"
        }
        return payload["name"]?.string ?? payload["type"]?.string ?? "Tool"
    }

    private static func mergedInput(
        _ start: [String: TranscriptJSONValue],
        _ end: [String: TranscriptJSONValue]
    ) -> [String: TranscriptJSONValue] {
        var value: [String: TranscriptJSONValue] = [:]
        for source in [start, end] {
            for key in ["parameters", "arguments", "args", "input"] {
                for (field, fieldValue) in objectValue(source[key]) { value[field] = fieldValue }
            }
        }
        return value
    }

    private static func objectValue(_ value: TranscriptJSONValue?) -> [String: TranscriptJSONValue] {
        if let object = value?.object { return object }
        guard let string = value?.string,
              let data = string.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(TranscriptJSONValue.self, from: data)
        else { return [:] }
        return decoded.object ?? [:]
    }

    private static func output(_ payload: [String: TranscriptJSONValue]) -> String? {
        if let content = payload["content"]?.string { return unwrapTextEnvelope(content) }
        if let content = payload["content"]?.array {
            let text = content.compactMap { $0.object?["text"]?.string }.joined(separator: "\n")
            if !text.isEmpty { return unwrapTextEnvelope(text) }
        }
        if let output = payload["output"]?.string { return unwrapTextEnvelope(output) }
        if let result = payload["result"]?.string { return unwrapTextEnvelope(result) }
        return nil
    }

    private static func unwrapTextEnvelope(_ string: String) -> String {
        guard let data = string.data(using: .utf8),
              let json = try? JSONDecoder().decode(TranscriptJSONValue.self, from: data),
              let object = json.object,
              Set(object.keys).isSubset(of: ["type", "text"]),
              let type = object["type"]?.string?.lowercased(), type == "text",
              let text = object["text"]?.string
        else { return string }
        return text
    }

    private static func isFailed(_ payload: [String: TranscriptJSONValue]) -> Bool {
        let status = payload["status"]?.string?.lowercased()
        if status == "failed" || status == "error" || status == "cancelled" { return true }
        if let exitCode = payload["exit_code"]?.number, exitCode != 0 { return true }
        if let error = payload["error"] {
            if error.bool == true { return true }
            if let text = error.string, !text.isEmpty { return true }
        }
        return false
    }

    private static func error(_ payload: [String: TranscriptJSONValue]) -> String? {
        payload["error"]?.string ?? output(payload)
    }

    private static func normalizedToolName(_ name: String) -> String {
        String(name.lowercased().filter { $0.isLetter || $0.isNumber })
    }

    private static func isQuestionTool(_ name: String) -> Bool {
        name == "askuserquestion" || name == "askquestiontoolcall" || name == "sendusermessage"
    }

    private static func isPlanTool(_ name: String) -> Bool { name == "exitplanmode" }

    private static func isAgentTool(_ name: String) -> Bool {
        name == "task" || name == "agent" || name == "subagent" || name == "tasktoolcall" ||
            name == "collabtoolcall" || name == "spawnagent" || name.hasSuffix("subagent")
    }

    private static func isHiddenTool(_ name: String) -> Bool {
        [
            "taskcreate", "taskupdate", "todowrite", "updatetodostoolcall", "updatetodos",
            "getcommandorsubagentoutput", "wait", "closeagent", "sendmessagetothread",
            "getmcptoolstoolcall", "toolsearch"
        ].contains(name)
    }

    private static func questions(from input: [String: TranscriptJSONValue]) -> [TranscriptQuestion]? {
        guard let raw = input["questions"]?.array else { return nil }
        let parsed = raw.compactMap { value -> TranscriptQuestion? in
            guard let object = value.object,
                  let question = object["question"]?.string,
                  !question.isEmpty,
                  let rawOptions = object["options"]?.array,
                  rawOptions.count <= 4
            else { return nil }
            let options = rawOptions.compactMap { option -> TranscriptQuestionOption? in
                guard let object = option.object,
                      let label = object["label"]?.string,
                      !label.isEmpty
                else { return nil }
                return TranscriptQuestionOption(label: label, detail: object["description"]?.string)
            }
            guard !options.isEmpty else { return nil }
            return TranscriptQuestion(
                question: question,
                header: object["header"]?.string ?? "",
                options: options,
                allowsMultiple: object["multiSelect"]?.bool == true
            )
        }
        return parsed.isEmpty ? nil : parsed
    }

    private static func appendTool(_ tool: TranscriptTool, to items: inout [TranscriptItem]) {
        if case .tools(var group)? = items.last {
            group.tools.append(tool)
            items[items.count - 1] = .tools(group)
        } else {
            items.append(.tools(TranscriptToolGroup(
                id: "tools-\(tool.id)",
                tools: [tool],
                createdAt: tool.createdAt
            )))
        }
    }

    private static func appendAgent(_ agent: TranscriptAgent, to items: inout [TranscriptItem]) {
        if case .agents(var group)? = items.last {
            group.agents.append(agent)
            items[items.count - 1] = .agents(group)
        } else {
            items.append(.agents(TranscriptAgentGroup(
                id: "agents-\(agent.id)",
                agents: [agent],
                createdAt: agent.createdAt
            )))
        }
    }

    private static func toolOrder(_ lhs: ProjectedTool, _ rhs: ProjectedTool) -> Bool {
        lhs.createdAt == rhs.createdAt ? lhs.id < rhs.id : lhs.createdAt < rhs.createdAt
    }

    private static func preview(
        name: String,
        input: [String: TranscriptJSONValue],
        workspacePath: String?
    ) -> String? {
        let normalized = normalizedToolName(name)
        if isAgentTool(normalized) {
            return string(input, keys: ["description", "subagent_type", "subagentType", "prompt"])
        }
        if normalized.contains("bash") || normalized.contains("shell") || normalized.contains("exec") {
            return string(input, keys: ["command", "cmd"])?.split(separator: "\n").first.map(String.init)
        }
        if let path = path(in: input) {
            return relativePath(path, workspacePath: workspacePath)
        }
        return string(input, keys: ["query", "pattern", "search_term", "url"])
    }

    private static func path(in input: [String: TranscriptJSONValue]) -> String? {
        string(input, keys: ["file_path", "filePath", "path", "relative_path"])
    }

    static func relativePath(_ path: String, workspacePath: String?) -> String {
        guard path.hasPrefix("/"), var root = workspacePath, root.hasPrefix("/") else { return path }
        while root.count > 1, root.hasSuffix("/") { root.removeLast() }
        if path == root { return "." }
        let prefix = root == "/" ? root : "\(root)/"
        guard path.hasPrefix(prefix) else { return path }
        return String(path.dropFirst(prefix.count))
    }

    private static func summary(name: String, preview: String?) -> String {
        let words = name
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        guard let preview, !preview.isEmpty else { return words }
        return "\(words) · \(String(preview.prefix(72)))"
    }

    private static func formatted(_ object: [String: TranscriptJSONValue]) -> String? {
        guard !object.isEmpty,
              let data = try? JSONEncoder.pretty.encode(TranscriptJSONValue.object(object)),
              let value = String(data: data, encoding: .utf8)
        else { return nil }
        return value
    }

    private static func string(
        _ object: [String: TranscriptJSONValue],
        keys: [String]
    ) -> String? {
        for key in keys {
            if let value = object[key]?.string, !value.isEmpty { return value }
        }
        return nil
    }

    // MARK: - Todos, approvals, multitasks and notices

    private static func todoSnapshots(events: [TranscriptEvent]) -> [String: TranscriptTodoList] {
        var items: [TranscriptTodoItem] = []
        var latestByTurn: [String: (eventID: String, list: TranscriptTodoList)] = [:]
        var turnID = "opening"
        for event in events {
            if event.type == "user.message", event.payloadObject["delivery"]?.string != "steer" { turnID = event.id }
            guard event.type == "todo.updated", let rawItems = event.payloadObject["items"]?.array else { continue }
            let incoming = rawItems.enumerated().compactMap { index, value in
                todoItem(value, fallbackID: "item-\(index)")
            }
            guard !incoming.isEmpty else { continue }
            if event.payloadObject["mode"]?.string == "snapshot" {
                items = incoming.compactMap { item in
                    guard let status = item.status else { return nil }
                    return TranscriptTodoItem(id: item.id, text: item.text, status: status)
                }
            } else {
                for item in incoming {
                    if item.status == nil {
                        items.removeAll { $0.id == item.id }
                    } else if let index = items.firstIndex(where: { $0.id == item.id }) {
                        items[index] = TranscriptTodoItem(
                            id: item.id,
                            text: item.text ?? items[index].text,
                            status: item.status ?? items[index].status
                        )
                    } else if let status = item.status {
                        items.append(TranscriptTodoItem(id: item.id, text: item.text, status: status))
                    }
                }
            }
            let list = TranscriptTodoList(id: "todo-\(turnID)", items: items, createdAt: event.createdAt)
            latestByTurn[turnID] = (event.id, list)
        }
        return Dictionary(uniqueKeysWithValues: latestByTurn.values.map { ($0.eventID, $0.list) })
    }

    private static func todoItem(
        _ value: TranscriptJSONValue,
        fallbackID: String
    ) -> (id: String, text: String?, status: TranscriptTodoStatus?)? {
        guard let object = value.object else { return nil }
        let id = object["id"]?.string ?? object["text"]?.string ?? fallbackID
        let rawStatus = object["status"]?.string
        if rawStatus == "removed" { return (id, nil, nil) }
        guard let rawStatus, let status = TranscriptTodoStatus(rawValue: rawStatus) else { return nil }
        return (id, object["text"]?.string, status)
    }

    private static func approval(from event: TranscriptEvent) -> TranscriptApproval? {
        let payload = event.payloadObject
        let status: TranscriptApprovalStatus
        switch event.type {
        case "approval.requested": status = .pending
        case "permission.blocked": status = .blocked
        default:
            status = TranscriptApprovalStatus(rawValue: string(payload, keys: ["status", "resolution"]) ?? "") ?? .cancelled
        }
        let id = payload["approvalId"]?.string ?? event.id
        let command = payload["command"]?.string ?? event.message
        guard !command.isEmpty else { return nil }
        return TranscriptApproval(
            id: id,
            provider: payload["provider"]?.string,
            command: command,
            workingDirectory: payload["cwd"]?.string,
            riskLevel: payload["riskLevel"]?.string,
            status: status,
            createdAt: event.createdAt
        )
    }

    private static func foldedMultitasks(events: [TranscriptEvent]) -> [String: TranscriptMultitask] {
        var anchorByChild: [String: String] = [:]
        var result: [String: TranscriptMultitask] = [:]
        for event in events where event.type == "multitask.launched" || event.type == "multitask.finished" {
            let payload = event.payloadObject
            let child = payload["childSessionId"]?.string ?? event.id
            let anchor = anchorByChild[child] ?? event.id
            anchorByChild[child] = anchor
            let previous = result[anchor]
            result[anchor] = TranscriptMultitask(
                id: "multitask-\(anchor)",
                childSessionId: payload["childSessionId"]?.string ?? previous?.childSessionId,
                taskLabel: payload["taskLabel"]?.string ?? previous?.taskLabel ?? event.message,
                prompt: payload["prompt"]?.string ?? previous?.prompt,
                answer: payload["answer"]?.string ?? previous?.answer,
                state: payload["state"]?.string ?? previous?.state,
                createdAt: previous?.createdAt ?? event.createdAt
            )
        }
        return result
    }

    private static func notice(from event: TranscriptEvent) -> TranscriptNotice? {
        let payload = event.payloadObject
        switch event.type {
        case "session.compacting", "session.compacted":
            return TranscriptNotice(
                id: "compaction-\(event.id)",
                text: event.message.isEmpty ? "Context compacted" : event.message,
                kind: .compacting(
                    preTokens: payload["preTokens"]?.number.map(Int.init),
                    postTokens: payload["postTokens"]?.number.map(Int.init)
                ),
                createdAt: event.createdAt
            )
        case "session.provider-changed":
            let to = payload["provider"]?.string ?? event.message
            return TranscriptNotice(
                id: "provider-\(event.id)",
                text: event.message.isEmpty ? "Switched provider to \(to)" : event.message,
                kind: .providerChanged(
                    from: payload["from"]?.string,
                    to: to,
                    modelLabel: payload["modelLabel"]?.string
                ),
                createdAt: event.createdAt
            )
        case "session.moved":
            return TranscriptNotice(
                id: "move-\(event.id)",
                text: event.message,
                kind: .moved(
                    destinationProject: payload["destinationProjectName"]?.string,
                    checkoutMode: payload["checkoutMode"]?.string
                ),
                createdAt: event.createdAt
            )
        case "session.note":
            return TranscriptNotice(
                id: "note-\(event.id)",
                text: event.message,
                kind: .note(operation: payload["operation"]?.string),
                createdAt: event.createdAt
            )
        default: return nil
        }
    }

    private static func appendNotice(_ notice: TranscriptNotice, to items: inout [TranscriptItem]) {
        if case .notice(let previous)? = items.last,
           case .compacting = previous.kind,
           case .compacting = notice.kind {
            items[items.count - 1] = .notice(TranscriptNotice(
                id: previous.id,
                text: notice.text,
                kind: notice.kind,
                createdAt: previous.createdAt
            ))
        } else {
            items.append(.notice(notice))
        }
    }
}

private extension TranscriptJSONValue {
    var number: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }
}

private extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
