import Foundation

// What "Start chat" resolves to, as a value.
//
// Starting a chat is two calls: create a workspace, then launch a provider
// into it. Which `workspaces:create-*` runs is the whole of what the mode
// picker decides, and the launch payload is the same object every time. Both
// are pure functions of the sheet's choices, which is what lets a test pin
// them against `src/renderer/mobile/NewSessionScreen.tsx` without a socket.

/// Where a new chat's files live. Listed in the order the sheet offers them.
enum NewChatMode: String, CaseIterable, Hashable, Sendable, Identifiable {
    /// A fresh worktree off the project's current branch.
    case worktree
    /// The project's own checkout, shared with anything else working in it.
    case current
    /// A fresh worktree off a branch you pick. Same channel as `worktree`;
    /// the difference is entirely which `baseRef` goes out.
    case branchFrom
    /// No repository at all: an app-owned scratch directory with one empty
    /// commit.
    case sideChat

    var id: String { rawValue }

    /// Sentence case, and CONTEXT.md's words.
    var title: String {
        switch self {
        case .worktree: return "New worktree"
        case .current: return "Current checkout"
        case .branchFrom: return "Branch from…"
        case .sideChat: return "Side chat"
        }
    }

    /// Only "Branch from…" asks which branch.
    var takesBaseRef: Bool { self == .branchFrom }
}

/// The sheet's choices, resolved into the two calls that start a chat.
struct NewChatPlan: Sendable {
    var creation: WorkspaceCreation
    var model: ModelSelection
    var prompt: String
    var taskLabel: String
    var titleModelId: String
    /// Images already stored on the Mac under the launcher's own key. The
    /// label and the auto-title read `prompt`, which stays the typed text —
    /// only the launch itself names the files, so a chat is never called
    /// after a screenshot's path.
    var attachments: [ComposerAttachment] = []

    /// Build the plan, or nil when a repository mode has no project to run
    /// in — the same guard that keeps the primary button disabled.
    init?(
        mode: NewChatMode,
        project: ProjectSummary?,
        baseRef: String?,
        model: ModelSelection,
        titleModelId: String,
        prompt: String,
        attachments: [ComposerAttachment] = []
    ) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        // A picture with no task is not a chat: the label, the greeting and
        // the auto-title all read the words, so the launcher keeps asking for
        // them even once an image is attached.
        guard !trimmed.isEmpty else { return nil }
        let taskLabel = NewChatPlan.taskLabel(fromPrompt: trimmed)

        switch mode {
        case .sideChat:
            creation = .scratch(CreateScratchWorkspaceInput(taskLabel: taskLabel, kind: nil))
        case .current:
            guard let project else { return nil }
            creation = .current(CreateCurrentWorkspaceInput(projectId: project.id, taskLabel: taskLabel))
        case .worktree, .branchFrom:
            guard let project else { return nil }
            // "Branch from…" is unusable until a branch is chosen; the
            // renderer falls back to the project's current branch for a plain
            // new worktree rather than sending null, so the base is recorded
            // rather than inferred later.
            if mode == .branchFrom, baseRef == nil { return nil }
            creation = .isolated(
                CreateIsolatedWorkspaceInput(
                    projectId: project.id,
                    taskLabel: taskLabel,
                    baseRef: baseRef ?? project.currentBranch
                )
            )
        }

        self.model = model
        self.prompt = trimmed
        self.taskLabel = taskLabel
        self.titleModelId = titleModelId
        self.attachments = attachments
    }

    func launchInput(workspaceID: String) -> LaunchSessionInput {
        LaunchSessionInput(
            workspaceId: workspaceID,
            provider: model.provider,
            // The reference for the agent to read the image inline, beside
            // the list the host records with the message — both, the way the
            // desktop launcher sends them.
            prompt: ([prompt] + attachments.map { "@\($0.filePath)" }).joined(separator: " "),
            modelLabel: model.label,
            modelId: model.modelId,
            reasoningEffort: model.reasoningEffort?.rawValue,
            attachments: attachments
        )
    }

    func autoTitleInput(workspaceID: String) -> AutoTitleWorkspaceInput {
        AutoTitleWorkspaceInput(
            workspaceId: workspaceID,
            provider: model.provider,
            modelId: titleModelId,
            prompt: prompt
        )
    }

    /// `titleFromPrompt` in `src/renderer/lib/projects.ts`: the first line,
    /// elided past 64 characters. The chat wears this until the auto-title
    /// call comes back with something shorter.
    static func taskLabel(fromPrompt prompt: String) -> String {
        // By newline *character*, not by "\n": Swift reads "\r\n" as one
        // grapheme, so splitting on the linefeed alone leaves a CRLF prompt
        // whole. Empty subsequences are kept, because a prompt that opens
        // with a blank line has an empty first line, exactly as the renderer
        // reads it.
        let firstLine = (prompt.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).first ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if firstLine.isEmpty { return "Local agent task" }
        guard firstLine.count > 64 else { return firstLine }
        return "\(firstLine.prefix(61))..."
    }
}
