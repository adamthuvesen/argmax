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
        var pickedLegacyQuestionInTurn = false

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
                    pickedLegacyQuestionInTurn = false
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
                    appendThought(event, streaming: false, to: &items)
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
                    let requestID = tool.inputObject["requestId"]?.string
                        ?? payload["requestId"]?.string
                    if (requestID != nil || !pickedLegacyQuestionInTurn),
                       let questions = questions(from: tool.inputObject) {
                        let sessionIsActive = session.map {
                            $0.state == .running || $0.state == .waiting
                        } ?? true
                        if requestID == nil { pickedLegacyQuestionInTurn = true }
                        items.append(.question(TranscriptQuestionCard(
                            id: "question-\(tool.id)",
                            toolUseId: tool.toolUseId,
                            createdAt: tool.createdAt,
                            questions: questions,
                            isOutstanding: requestID == nil
                                ? tool.createdAt > lastUserAt
                                : tool.completedAt == nil && sessionIsActive,
                            sessionID: event.sessionId,
                            requestID: requestID
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
                        children: childTools,
                        backgroundLaunch: tool.backgroundLaunch
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

            if event.type == "error", payload["truncatedEventId"] == nil,
               !TranscriptError.isRedundantProviderDiagnostic(event.message) {
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
        if let liveID = TranscriptThinking.liveThoughtID(
            in: items,
            sessionIsWorking: session?.state == .running && session?.attention == .normal
        ), let index = items.lastIndex(where: { $0.id == liveID }),
           case .thought(var thought) = items[index] {
            thought.isStreaming = true
            items[index] = .thought(thought)
        }
        // Each item is appended when its first contributing event is visited,
        // and events are already in canonical cursor order. The synthetic
        // prompt and unpersisted approvals provide the leading and trailing
        // fallback positions for items without a source cursor.
        return items
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
        var pickedLegacyQuestion = false
        var activeBlockingQuestions = Set<String>()
        return events.filter { event in
            if event.type == "user.message", event.payloadObject["delivery"]?.string != "steer" {
                cardStarted = false
                pickedLegacyQuestion = false
                activeBlockingQuestions.removeAll()
                return true
            }
            if event.type == "command.started", let tool = tools[event.id] {
                let name = normalizedToolName(tool.name)
                if isQuestionTool(name), questions(from: tool.inputObject) != nil {
                    let requestID = tool.inputObject["requestId"]?.string
                        ?? event.payloadObject["requestId"]?.string
                    let delivery = tool.inputObject["delivery"]?.string
                        ?? event.payloadObject["delivery"]?.string
                    if requestID != nil {
                        if delivery == "blocking" {
                            activeBlockingQuestions.insert(tool.toolUseId)
                        }
                    } else if !pickedLegacyQuestion {
                        pickedLegacyQuestion = true
                        if delivery != "async" { cardStarted = true }
                    }
                }
                return true
            }
            if event.type == "command.completed" {
                let payload = event.payloadObject
                if let toolUseID = string(payload, keys: ["tool_use_id", "id", "call_id"]) {
                    activeBlockingQuestions.remove(toolUseID)
                }
                return true
            }
            if (cardStarted || !activeBlockingQuestions.isEmpty),
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
                previous.text = combinedThoughtText(previous.text, event.message)
            }
            previous.isStreaming = streaming
            items[items.count - 1] = .thought(previous)
            return
        }
        items.append(.thought(TranscriptThought(
            id: "thought-\(event.id)",
            text: splitCollapsedThoughtTitles(event.message),
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
        // The fragments we already hold carry the separators we gave them, so
        // the match has to ignore whitespace or the summary lands twice.
        for candidate in [completed, streamedSummary] where !candidate.isEmpty {
            if let matched = trailingMatch(of: candidate, in: existing) {
                return joinThoughtParagraphs(String(existing.dropLast(matched)), completed)
            }
        }
        return joinThoughtParagraphs(existing, completed)
    }

    /// How many trailing characters of `existing` spell `candidate`, ignoring
    /// whitespace on either side, or nil when it does not end with it.
    private static func trailingMatch(of candidate: String, in existing: String) -> Int? {
        var existingIndex = existing.endIndex
        var candidateIndex = candidate.endIndex
        var consumed = 0
        while candidateIndex > candidate.startIndex {
            let nextCandidate = candidate.index(before: candidateIndex)
            candidateIndex = nextCandidate
            if candidate[nextCandidate].isWhitespace { continue }
            var matched = false
            while existingIndex > existing.startIndex {
                let nextExisting = existing.index(before: existingIndex)
                existingIndex = nextExisting
                consumed += 1
                if existing[nextExisting].isWhitespace { continue }
                guard existing[nextExisting] == candidate[nextCandidate] else { return nil }
                matched = true
                break
            }
            guard matched else { return nil }
        }
        return consumed
    }

    /// Codex sends each reasoning summary as its own `**Header**` fragment.
    /// Glued end to end the delimiters collapse into `****` and the summaries
    /// render as one run-on line, so a fragment that opens a header opens a
    /// paragraph too. Mid-word deltas still join without a seam.
    private static func combinedThoughtText(_ existing: String, _ incoming: String) -> String {
        if incoming.hasPrefix(existing) { return splitCollapsedThoughtTitles(incoming) }
        if existing.hasSuffix(incoming) { return existing }
        if incoming.hasPrefix("**") && existing.hasSuffix("**") {
            return joinThoughtParagraphs(existing, incoming)
        }
        return splitCollapsedThoughtTitles(existing + incoming)
    }

    private static func joinThoughtParagraphs(_ existing: String, _ incoming: String) -> String {
        guard !existing.isEmpty else { return splitCollapsedThoughtTitles(incoming) }
        if existing.hasSuffix("\n\n") { return splitCollapsedThoughtTitles(existing + incoming) }
        if existing.hasSuffix("\n") { return splitCollapsedThoughtTitles(existing + "\n" + incoming) }
        return splitCollapsedThoughtTitles(existing + "\n\n" + incoming)
    }

    /// `**A****B**` is two Codex titles, not four asterisks of prose.
    private static func splitCollapsedThoughtTitles(_ text: String) -> String {
        text.replacingOccurrences(of: "****", with: "**\n\n**")
    }

    private static func appendLog(_ event: TranscriptEvent, stream: String, to items: inout [TranscriptItem]) {
        if TranscriptError.isRedundantProviderDiagnostic(event.message) { return }
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
        var activity: TranscriptToolActivity
        var completionObserved: Bool
        var completionStatus: String?
        var backgroundLaunch: Bool

        var isAgent: Bool { TranscriptProjection.isAgentTool(normalizedToolName(name)) }
        var preview: String? {
            TranscriptProjection.preview(name: name, input: inputObject, workspacePath: workspacePath)
        }

        var presentation: TranscriptTool {
            let activityPath = activity.kind == .edit && activity.targets.count == 1
                ? activity.targets.first
                : nil
            // Codex file_change carries its path inside input.changes[]. The
            // host already extracts that shape into activity.targets, so use
            // the single observed target when there is no top-level path.
            let filePath = TranscriptProjection.path(in: inputObject) ?? activityPath
            var tool = TranscriptTool(
                id: "tool-\(id)",
                toolUseId: toolUseId,
                name: name,
                summary: "",
                input: inputText,
                output: output,
                error: error,
                status: status,
                createdAt: createdAt,
                completedAt: completedAt,
                filePath: filePath,
                fileLabel: filePath.map { TranscriptProjection.relativePath($0, workspacePath: workspacePath) },
                changeCounts: TranscriptProjection.changeCounts(activity: activity, input: inputObject),
                activity: activity,
                completionObserved: completionObserved,
                completionStatus: completionStatus
            )
            tool.summary = TranscriptProjection.toolSummary(tool, name: name, preview: preview)
            return tool
        }
    }

    private struct NativeAgentLifecycle {
        var phase: String
        var createdAt: String
        var status: String?
        var metadata: [String: TranscriptJSONValue]
    }

    private static func correlatedTools(
        events: [TranscriptEvent],
        sessionRunning: Bool,
        workspacePath: String? = nil
    ) -> [String: ProjectedTool] {
        let completions = events.filter { $0.type == "command.completed" }
        let sessionEndAt = events.reduce(into: "") { latest, event in
            let isSessionEnd = event.type == "session.completed" ||
                event.type == "session.cancelled" ||
                event.type == "session.recovered-from-crash"
            if isSessionEnd,
               event.payloadObject["raw"]?.bool != true,
               string(event.payloadObject, keys: ["parent_tool_use_id", "parentToolUseId"]) == nil,
               event.createdAt > latest {
                latest = event.createdAt
            }
        }
        var nativeAgentLifecycles: [String: NativeAgentLifecycle] = [:]
        for event in events where event.type == "agent.started" || event.type == "agent.completed" {
            let payload = event.payloadObject
            guard let runID = payload["agentRunId"]?.string else { continue }
            let key = nativeAgentLifecycleKey(
                invocationID: payload["providerInvocationId"]?.string,
                runID: runID
            )
            var metadata = nativeAgentLifecycles[key]?.metadata ?? [:]
            for (field, value) in payload where value != .null { metadata[field] = value }
            nativeAgentLifecycles[key] = NativeAgentLifecycle(
                phase: event.type == "agent.completed" ? "completed" : "started",
                createdAt: event.createdAt,
                status: payload["status"]?.string,
                metadata: metadata
            )
        }
        let latestAnswer = events.last { event in
            let payload = event.payloadObject
            return event.type == "message.completed" || (
                event.type == "message.delta" &&
                    payload["thinking"]?.bool != true &&
                    payload["stream"]?.string == nil
            )
        }
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
            let lifecycle = isAgentTool(normalizedToolName(name))
                ? nativeAgentLifecycles[nativeAgentLifecycleKey(invocationID: invocation, runID: toolUseID)]
                : nil
            let hasLaterAnswer = latestAnswer.map { compare(start, $0) == .orderedAscending } ?? false
            let isAgent = isAgentTool(normalizedToolName(name))
            let activity = mergedActivity(
                start: decodedActivity(payload["activity"]),
                end: decodedActivity(endPayload["activity"])
            ) ?? legacyActivity(name: name, input: input)
            let transportStatus: TranscriptToolStatus = completion == nil
                ? (sessionRunning && (!hasLaterAnswer || isAgent) ? .running : .done)
                : (failed ? .failed : .done)
            // An agent launch the turn has already moved past is kept
            // `.running` by the session, not by any evidence: the child
            // reports back as a `<task-notification>` prompt the normalizer
            // does not parse, so no completion for it ever arrives, and the
            // `isAgentTool` branch above would hold the row up for the rest
            // of the session — silencing the cue and the beat through every
            // later gap. The desktop marks the same row
            // `backgroundLaunch` (`sessionConversationModel.ts`), running by
            // inference rather than by evidence, so it loses its vote for
            // the turn's beat and its band while keeping its nest. A launch
            // the turn is still blocked on — nothing answered after it — or
            // one whose child lifecycle spoke, is genuinely running and
            // keeps both.
            let backgroundLaunch = isAgent && lifecycle == nil && completion == nil
                && sessionRunning && hasLaterAnswer
            let status: TranscriptToolStatus
            if let lifecycle {
                if lifecycle.phase == "started" {
                    status = sessionEndAt >= lifecycle.createdAt ? .failed : .running
                } else {
                    status = (lifecycle.status == "completed" || lifecycle.status == "success") ? .done : .failed
                }
            } else {
                status = transportStatus
            }
            let metadata = lifecycle?.metadata ?? [:]
            result[start.id] = ProjectedTool(
                id: start.id,
                toolUseId: toolUseID,
                name: name,
                inputObject: input,
                inputText: formatted(displayInput(input, name: name)),
                output: displayOutput(output(endPayload), name: name),
                error: status == .failed ? displayOutput(error(endPayload), name: name) : nil,
                status: status,
                createdAt: start.createdAt,
                completedAt: status == .running
                    ? nil
                    : (lifecycle?.phase == "completed"
                        ? lifecycle?.createdAt
                        : (lifecycle?.phase == "started" ? sessionEndAt : completion?.createdAt)),
                parentToolUseId: payload["parent_tool_use_id"]?.string,
                surface: payload["surface"]?.string,
                providerChildSessionId: payload["providerChildSessionId"]?.string
                    ?? metadata["providerChildSessionId"]?.string,
                providerParentConversationId: payload["providerParentConversationId"]?.string
                    ?? metadata["providerParentConversationId"]?.string,
                agentCodename: string(payload, keys: ["agentCodename", "agentNickname"])
                    ?? string(metadata, keys: ["agentCodename", "agentNickname"]),
                workspacePath: workspacePath,
                activity: activity,
                completionObserved: completion != nil,
                completionStatus: completionStatus(endPayload),
                backgroundLaunch: backgroundLaunch
            )
        }
        return result
    }

    private static func nativeAgentLifecycleKey(invocationID: String?, runID: String) -> String {
        "\(invocationID ?? "")\u{0}\(runID)"
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

    private static func decodedActivity(_ value: TranscriptJSONValue?) -> TranscriptToolActivity? {
        guard let object = value?.object,
              object["version"]?.number == 1,
              let kindValue = object["kind"]?.string,
              let kind = TranscriptToolActivityKind(rawValue: kindValue),
              let evidenceValue = object["evidence"]?.string,
              let evidence = TranscriptToolActivityEvidence(rawValue: evidenceValue),
              let targetValues = object["targets"]?.array
        else { return nil }
        let targets = targetValues.compactMap(\.string)
        guard targets.count == targetValues.count else { return nil }
        let operation: TranscriptToolActivityOperation?
        if let value = object["operation"]?.string {
            guard let decoded = TranscriptToolActivityOperation(rawValue: value) else { return nil }
            operation = decoded
        } else {
            operation = nil
        }
        let toolCount: Int?
        if let value = object["toolCount"]?.number {
            guard value >= 0, value.rounded(.towardZero) == value, value <= Double(Int.max) else { return nil }
            toolCount = Int(value)
        } else {
            toolCount = nil
        }
        return TranscriptToolActivity(
            version: 1,
            kind: kind,
            evidence: evidence,
            targets: targets,
            operation: operation,
            toolCount: toolCount
        )
    }

    /// A completion may add result-derived facts such as the number of tools
    /// discovered. A generic completion must never erase the specific action
    /// already reported at start.
    private static func mergedActivity(
        start: TranscriptToolActivity?,
        end: TranscriptToolActivity?
    ) -> TranscriptToolActivity? {
        guard let end else { return start }
        guard let start else { return end }
        let preservesStartKind = end.kind == .tool ||
            ([.imageCapture, .imageGenerate, .computer, .browser].contains(start.kind) && end.kind == .image)
        return TranscriptToolActivity(
            version: end.version,
            kind: preservesStartKind ? start.kind : end.kind,
            evidence: preservesStartKind ? start.evidence : end.evidence,
            targets: end.targets.isEmpty ? start.targets : end.targets,
            operation: end.operation ?? start.operation,
            toolCount: end.toolCount ?? start.toolCount
        )
    }

    private static func completionStatus(_ payload: [String: TranscriptJSONValue]) -> String? {
        if payload["cancelled"]?.bool == true || payload["canceled"]?.bool == true {
            return "cancelled"
        }
        return payload["status"]?.string
    }

    /// Old timeline rows predate the activity contract. Keep their labels
    /// useful with exact, provider-observed tool identities; arbitrary shell
    /// source remains command activity.
    private static func legacyActivity(
        name: String,
        input: [String: TranscriptJSONValue]
    ) -> TranscriptToolActivity {
        let leaf = name.components(separatedBy: "__").last?
            .components(separatedBy: ".").last ?? name
        let normalized = normalizedToolName(leaf)
        let kind: TranscriptToolActivityKind
        switch normalized {
        case "read", "readfile", "shuntread": kind = .read
        case "edit", "write", "writefile", "filechange", "searchreplace", "applypatch": kind = .edit
        case "imageview", "viewimage": kind = .image
        case "grep", "search", "searchfiles", "findinfiles": kind = .search
        case "glob", "list", "listfiles", "findfiles": kind = .list
        case "websearch", "searchquery": kind = .webSearch
        case "webfetch", "fetchurl": kind = .webFetch
        case "toolsearch", "searchtool", "getmcptoolstoolcall": kind = .discovery
        case "commandexecution", "bash", "shell", "runterminalcommand", "exec", "execcommand": kind = .command
        case "skill", "useskill", "loadskill": kind = .skill
        case "screenshot", "capturescreenshot": kind = .imageCapture
        case "imagegen", "imagegenerate", "generateimage": kind = .imageGenerate
        case "sendmessage", "sessionmessage": kind = .agentMessage
        case "waitagent", "wait", "sessionwait", "sessionstatus", "sessionread": kind = .agentWait
        case "closeagent", "taskstop", "sessionstop": kind = .agentStop
        case "todowrite", "updatetodos", "updatetodostoolcall": kind = .plan
        default: kind = .tool
        }
        let targets = path(in: input).map { [$0] } ?? []
        return TranscriptToolActivity(
            version: 1,
            kind: kind,
            evidence: kind == .command ? .command : .tool,
            targets: targets,
            operation: nil,
            toolCount: nil
        )
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
        // A cancelled call is an interruption, not a failure — the desktop's
        // `detectToolError` does not count one either.
        if ["cancelled", "canceled", "interrupted"].contains(status) ||
            payload["cancelled"]?.bool == true || payload["canceled"]?.bool == true {
            return false
        }
        if status == "failed" || status == "error" { return true }
        if payload["is_error"]?.bool == true || payload["isError"]?.bool == true { return true }
        if let error = payload["error"] {
            if error.bool == true { return true }
            if let text = error.string, !text.isEmpty { return true }
        }
        if payload["noMatches"]?.bool == true { return false }
        if let exitCode = payload["exit_code"]?.number, exitCode != 0 { return true }
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

    private static func isAgentTool(_ name: String) -> Bool {
        name == "task" || name == "agent" || name == "subagent" || name == "tasktoolcall" ||
            name == "collabtoolcall" || name == "spawnagent" || name.hasSuffix("subagent")
    }

    private static func isHiddenTool(_ name: String) -> Bool {
        [
            "taskcreate", "taskupdate", "todowrite", "updatetodostoolcall", "updatetodos",
            "getcommandorsubagentoutput", "wait", "closeagent", "sendmessagetothread"
        ].contains(name)
    }

    private static func questions(from input: [String: TranscriptJSONValue]) -> [TranscriptQuestion]? {
        guard let raw = input["questions"]?.array else { return nil }
        let parsed = raw.compactMap { value -> TranscriptQuestion? in
            guard let object = value.object,
                  let question = object["question"]?.string,
                  !question.isEmpty
            else { return nil }
            let responseID = object["id"]?.string
            let rawOptions = object["options"]?.array ?? []
            guard rawOptions.count <= 4 else { return nil }
            let options = rawOptions.compactMap { option -> TranscriptQuestionOption? in
                guard let object = option.object,
                      let label = object["label"]?.string,
                      !label.isEmpty
                else { return nil }
                return TranscriptQuestionOption(label: label, detail: object["description"]?.string)
            }
            if responseID != nil, options.count != rawOptions.count { return nil }
            let freeformOnly = responseID != nil && rawOptions.isEmpty
            guard !options.isEmpty || freeformOnly else { return nil }
            return TranscriptQuestion(
                question: question,
                header: object["header"]?.string ?? "",
                options: options,
                allowsMultiple: responseID == nil && object["multiSelect"]?.bool == true,
                responseID: responseID,
                allowsOther: responseID == nil || object["isOther"]?.bool == true || freeformOnly,
                isSecret: responseID != nil && object["isSecret"]?.bool == true
            )
        }
        let responseIDs = parsed.compactMap(\.responseID)
        if !responseIDs.isEmpty,
           (parsed.count != raw.count || responseIDs.count != raw.count
                || Set(responseIDs).count != responseIDs.count) {
            return nil
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
            guard let text = string(input, keys: ["description", "subagent_type", "subagentType", "prompt"])
            else { return nil }
            let stripped = withoutImageMarkers(text)
            return stripped.isEmpty ? nil : stripped
        }
        if normalized.contains("bash") || normalized.contains("shell") || normalized.contains("exec") {
            return string(input, keys: ["command", "cmd"])
                .map(unwrapShellCommand)?
                .split(separator: "\n").first.map(String.init)
        }
        if let path = path(in: input) {
            return relativePath(path, workspacePath: workspacePath)
        }
        return string(input, keys: ["query", "pattern", "search_term", "url"])
    }

    /// The command as the agent meant it, peeking through the `/bin/zsh -lc
    /// '…'` / `bash -c "…"` launcher a provider wraps it in: the desktop's
    /// `unwrapBashCommand` (`toolCalls.ts`). Left in, the launcher was most
    /// of what a row had room to show.
    static func unwrapShellCommand(_ command: String) -> String {
        let launcher = try! NSRegularExpression(
            pattern: "^(?:[\\w./-]+/)?(?:zsh|bash|sh)\\s+-l?c\\s+(.+)$",
            options: [.caseInsensitive, .dotMatchesLineSeparators]
        )
        var text = withoutOuterQuotes(command.trimmingCharacters(in: .whitespacesAndNewlines))
        for _ in 0..<2 {
            let range = NSRange(text.startIndex..., in: text)
            guard let match = launcher.firstMatch(in: text, range: range),
                  let innerRange = Range(match.range(at: 1), in: text) else { break }
            let inner = withoutOuterQuotes(String(text[innerRange]).trimmingCharacters(in: .whitespacesAndNewlines))
            if inner.isEmpty || inner == text { break }
            text = inner
        }
        return text
    }

    private static func withoutOuterQuotes(_ text: String) -> String {
        guard let first = text.first, let last = text.last, text.count >= 2,
              first == last, "'\"`".contains(first) else { return text }
        return String(text.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Generic commands and integration calls still need the useful detail
    /// they carried before activity metadata supplied their lifecycle verb.
    private static func toolSummary(_ tool: TranscriptTool, name: String, preview: String?) -> String {
        switch tool.activity.kind {
        case .command:
            guard let preview, !preview.isEmpty else { return tool.activitySummary }
            let command = String(preview.prefix(72))
            switch tool.activityState {
            case .running: return "Running \(command)"
            case .succeeded: return "Ran \(command)"
            // An unconfirmed call has not been approved, so its detail stays
            // out of the summary, like the search and edit kinds.
            case .unconfirmed: return tool.activitySummary
            default: return "\(tool.activitySummary): \(command)"
            }
        case .tool:
            let detail = toolDetail(name: name, preview: preview)
            switch tool.activityState {
            case .running: return "Using \(detail)"
            case .succeeded: return "Used \(detail)"
            case .failed: return "\(detail) failed"
            case .cancelled: return "\(detail) cancelled"
            case .unconfirmed: return detail
            }
        default:
            return tool.activitySummary
        }
    }

    private static func toolDetail(name: String, preview: String?) -> String {
        var parts = name.split { !$0.isLetter && !$0.isNumber }.map(String.init)
        if parts.first?.lowercased() == "mcp" { parts.removeFirst() }
        let words = parts.joined(separator: " ")
        let title = words.isEmpty ? "Tool" : words.prefix(1).uppercased() + words.dropFirst()
        guard let preview, !preview.isEmpty else { return title }
        return "\(title) · \(String(preview.prefix(72)))"
    }

    /// Codex passes an attached image to a subagent as a `[local_image:/abs/path]`
    /// marker at the head of the prompt. In a one-line row that path is all the
    /// reader sees, so drop the markers and keep the instruction.
    private static func withoutImageMarkers(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\\[local_image:[^\\]]*\\]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
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

    private static let agentMessageTransportKeys: Set<String> = [
        "agentId", "agent_id", "pin",
        "receiverThreadIds", "receiver_thread_ids",
        "resumedAgentId", "resumed_agent_id",
        "senderThreadId", "sender_thread_id",
        "targetThreadId", "target_thread_id",
        "threadId", "thread_id", "to"
    ]

    private static func foldedToolName(_ name: String) -> String {
        name.lowercased().replacingOccurrences(of: "-", with: "").replacingOccurrences(of: "_", with: "")
    }

    private static func isAgentMessageTool(_ name: String) -> Bool {
        let folded = foldedToolName(name)
        return folded == "sendmessage" || folded == "sendinput" || folded.hasSuffix("sessionmessage")
    }

    /// Codex collab `send_message` bodies are Fernet tokens (`gAAAAA…`).
    private static func isOpaqueCiphertext(_ value: String) -> Bool {
        let compact = String(value.filter { !$0.isWhitespace })
        guard compact.count >= 80, compact.hasPrefix("gAAAAA") else { return false }
        return compact.utf8.allSatisfy {
            ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57)
                || $0 == 45 || $0 == 95 || $0 == 61
        }
    }

    private static func isLaunchMetadata(_ value: String) -> Bool {
        let normalized = value.lowercased()
        return normalized.contains("resumedagentid")
            || normalized.contains("this tool result is internal metadata")
            || normalized.contains("subagent started in background")
    }

    private static func displayInput(
        _ object: [String: TranscriptJSONValue],
        name: String
    ) -> [String: TranscriptJSONValue] {
        let dropTransport = isAgentMessageTool(name)
        var result: [String: TranscriptJSONValue] = [:]
        for (key, value) in object {
            if dropTransport, agentMessageTransportKeys.contains(key) { continue }
            if dropTransport, case .string(let text) = value, isOpaqueCiphertext(text) { continue }
            result[key] = value
        }
        return result
    }

    private static func displayOutput(_ value: String?, name: String) -> String? {
        guard let value else { return nil }
        if isAgentMessageTool(name), isOpaqueCiphertext(value) || isLaunchMetadata(value) { return nil }
        return value
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

    /// The activity row's `+N −N`, derived from the same provider payloads as
    /// the desktop. A missing body or whole-file deletion has no line count.
    private static func changeCounts(
        activity: TranscriptToolActivity,
        input: [String: TranscriptJSONValue]
    ) -> TranscriptChangeCounts? {
        guard activity.kind == .edit else { return nil }
        if let changes = input["changes"]?.array {
            let counts = changes.compactMap { value in
                value.object.flatMap { changeCounts(in: $0) }
            }
            guard !counts.isEmpty else { return nil }
            return TranscriptChangeCounts(
                additions: counts.reduce(0) { $0 + $1.additions },
                deletions: counts.reduce(0) { $0 + $1.deletions }
            )
        }
        return changeCounts(in: input)
    }

    private static func changeCounts(
        in input: [String: TranscriptJSONValue]
    ) -> TranscriptChangeCounts? {
        let operation = changeOperation(in: input)
        if operation == "delete" || operation == "remove" { return nil }

        let add = input["add"]?.object ?? input["create"]?.object
        let update = input["update"]?.object ?? input["edit"]?.object
        let isCreate = operation == "add" || operation == "create" || add != nil
        let content = add.flatMap { string($0, keys: ["content", "text"]) }
            ?? string(input, keys: ["content", "text", "new_text"])
        if isCreate, let content {
            return TranscriptChangeCounts(additions: textLineCount(content), deletions: 0)
        }

        let diff = string(input, keys: ["unified_diff", "diff", "patch"])
            ?? update.flatMap { string($0, keys: ["unified_diff", "diff", "patch"]) }
        if let diff {
            let parsed = diffLineCounts(diff)
            if parsed.additions > 0 || parsed.deletions > 0 { return parsed }
            if isCreate {
                return TranscriptChangeCounts(additions: textLineCount(diff), deletions: 0)
            }
        }

        if let edits = input["edits"]?.array {
            let counts = edits.compactMap { value -> TranscriptChangeCounts? in
                guard let edit = value.object else { return nil }
                return replacementCounts(in: edit)
            }
            guard !counts.isEmpty else { return nil }
            return TranscriptChangeCounts(
                additions: counts.reduce(0) { $0 + $1.additions },
                deletions: counts.reduce(0) { $0 + $1.deletions }
            )
        }

        if let counts = update.flatMap({ replacementCounts(in: $0) }) ?? replacementCounts(in: input) {
            return counts
        }
        if let content {
            return TranscriptChangeCounts(additions: textLineCount(content), deletions: 0)
        }
        return nil
    }

    private static func replacementCounts(
        in input: [String: TranscriptJSONValue]
    ) -> TranscriptChangeCounts? {
        let old = string(input, keys: ["old_string", "oldString", "before", "old"])
        let new = string(input, keys: ["new_string", "newString", "after", "new"])
        guard old != nil || new != nil else { return nil }
        return TranscriptChangeCounts(
            additions: textLineCount(new ?? ""),
            deletions: textLineCount(old ?? "")
        )
    }

    private static func changeOperation(
        in input: [String: TranscriptJSONValue]
    ) -> String? {
        if let direct = string(input, keys: ["operation", "kind", "type"]) {
            return direct.lowercased()
        }
        for key in ["kind", "type", "operation"] {
            if let nested = input[key]?.object,
               let value = string(nested, keys: ["type", "kind", "operation"]) {
                return value.lowercased()
            }
        }
        return nil
    }

    private static func diffLineCounts(_ diff: String) -> TranscriptChangeCounts {
        var additions = 0
        var deletions = 0
        for case .hunk(_, _, let lines) in DiffParser.parse(diff) {
            for line in lines {
                if line.kind == .addition { additions += 1 }
                if line.kind == .deletion { deletions += 1 }
            }
        }
        return TranscriptChangeCounts(additions: additions, deletions: deletions)
    }

    /// A final newline terminates the preceding line. It does not add an
    /// extra empty line to the activity total.
    private static func textLineCount(_ text: String) -> Int {
        guard !text.isEmpty else { return 0 }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
        return text.hasSuffix("\n") ? lines - 1 : lines
    }

    // MARK: - Todos, approvals, multitasks and notices

    /// Same fold as `src/renderer/lib/todoList.ts`: snapshots replace, merges
    /// patch by id, and each turn that touched the plan keeps the list as it
    /// stood when that turn ended.
    private static func todoSnapshots(events: [TranscriptEvent]) -> [String: TranscriptTodoList] {
        var items: [TranscriptTodoItem] = []
        var latestByTurn: [String: (eventID: String, list: TranscriptTodoList)] = [:]
        var turnID = "opening"
        for event in events {
            if event.type == "user.message", event.payloadObject["delivery"]?.string != "steer" {
                turnID = event.id
            }
            guard event.type == "todo.updated" else { continue }
            guard let rawItems = event.payloadObject["items"]?.array else { continue }
            let incoming = rawItems.compactMap(todoItem)
            guard !incoming.isEmpty else { continue }
            if event.payloadObject["mode"]?.string == "snapshot" {
                items = incoming.filter { $0.status != .removed }
            } else {
                for item in incoming { items = mergeTodo(items, item) }
            }
            if items.isEmpty {
                latestByTurn.removeValue(forKey: turnID)
                continue
            }
            let list = TranscriptTodoList(id: "todo-\(turnID)", items: items, createdAt: event.createdAt)
            latestByTurn[turnID] = (event.id, list)
        }
        return Dictionary(uniqueKeysWithValues: latestByTurn.values.map { ($0.eventID, $0.list) })
    }

    private static func todoItem(_ value: TranscriptJSONValue) -> TranscriptTodoItem? {
        guard let object = value.object else { return nil }
        guard let rawStatus = object["status"]?.string,
              let status = TranscriptTodoStatus(rawValue: rawStatus)
        else { return nil }
        return TranscriptTodoItem(
            id: nonempty(object["id"]?.string),
            text: nonempty(object["text"]?.string),
            status: status
        )
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    private static func mergeTodo(
        _ items: [TranscriptTodoItem],
        _ incoming: TranscriptTodoItem
    ) -> [TranscriptTodoItem] {
        if incoming.status == .removed {
            guard let id = incoming.id else { return items }
            return items.filter { $0.id != id }
        }
        guard let id = incoming.id else { return items + [incoming] }
        if let index = items.firstIndex(where: { $0.id == id }) {
            var next = items
            next[index] = TranscriptTodoItem(
                id: id,
                text: incoming.text ?? items[index].text,
                status: incoming.status
            )
            return next
        }
        return items + [incoming]
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
