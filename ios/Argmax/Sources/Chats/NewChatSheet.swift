import PhotosUI
import SwiftUI
import UIKit

/// Start a chat.
///
/// The same four choices the web launcher makes — project, where the files
/// live, which agent, and the task — and the same two calls at the end of
/// them (`NewChatPlan`).
///
/// The prompt is first and biggest because it is the point: the other four
/// have a defensible default and the task does not. They sit under it in one
/// grid of equal cells, the way the desktop composer carries them in one
/// row, and each cell opens the app's own picker. This was a `Form` in the
/// first pass, which put the task last, behind three grouped-inset sections
/// and a navigation-link drill-down per choice.
struct NewChatSheet: View {
    @Environment(\.dismiss) private var dismiss

    // Read once, in `init`, to seed the pickers. Not observed: a delta
    // arriving while the sheet is open has nothing to say about the choices
    // being made in it, and redrawing a focused text editor for one would.
    private let client: BridgeClient
    private let preselectedProjectID: String?
    private let branchFromWorkspaceID: String?
    private let onLaunched: (WorkspaceSummary, SessionSummary) -> Void
    private let catalog = ProviderCatalog.bundled

    @State private var projects: [ProjectSummary]
    @State private var branches: [String] = []
    @State private var discovered: [ProviderCapability] = []
    @State private var projectID: String?
    @State private var mode: NewChatMode
    @State private var baseRef: String?
    @State private var model: ModelSelection
    @State private var prompt = ""
    @State private var launching = false
    @State private var failure: String?
    @State private var picking: Picking?
    @StateObject private var images = ComposerImages()
    @State private var photoPicks: [PhotosPickerItem] = []
    @StateObject private var dictation = Dictation()
    /// The draft as it stood when the mic was opened. Partial results rewrite
    /// the tail after it rather than stacking on each other.
    @State private var draftBeforeDictation = ""
    @FocusState private var promptFocused: Bool
    @Environment(\.accentTint) private var accent

    /// Which chip is open. One at a time, so one sheet.
    private enum Picking: String, Identifiable {
        case project
        case mode
        case branch
        case model
        case effort

        var id: String { rawValue }
    }

    @MainActor
    init(
        store: DashboardStore,
        client: BridgeClient,
        preselectedProjectID: String? = nil,
        branchFromWorkspaceID: String? = nil,
        onLaunched: @escaping (_ workspace: WorkspaceSummary, _ session: SessionSummary) -> Void
    ) {
        self.client = client
        self.preselectedProjectID = preselectedProjectID
        self.branchFromWorkspaceID = branchFromWorkspaceID
        self.onLaunched = onLaunched

        // Seed from the snapshot the list is already showing, so the sheet
        // paints its choices at once and `projects:list` only corrects them.
        let seeded = store.snapshot.projects.filter { $0.id != scratchProjectID }
        _projects = State(initialValue: seeded)

        // "New chat here" arrives as a workspace: its project, and its branch
        // as the base, which is what the web pre-selects for the same tap.
        let source = branchFromWorkspaceID.flatMap { id in
            store.snapshot.workspaces.first { $0.id == id }
        }
        let branchable = source.map { $0.kind == .git && !$0.sharedWorkspace && !$0.branch.isEmpty } ?? false
        _mode = State(initialValue: seeded.isEmpty ? .sideChat : (branchable ? .branchFrom : .worktree))
        _baseRef = State(initialValue: branchable ? source?.branch : nil)
        _projectID = State(
            initialValue: source?.projectId ?? preselectedProjectID ?? seeded.first?.id
        )
        _model = State(initialValue: catalog.factoryModel)
    }

    var body: some View {
        VStack(spacing: 0) {
            // A screen in the stack, like the transcript: back is the way out.
            ScreenHeader(title: "New chat", onBack: { dismiss() })
            hero
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(Theme.rose)
                    .screenGutter()
                    .padding(.bottom, Spacing.snug)
            }
            choiceRows
                .screenGutter()
                .padding(.bottom, Spacing.row)
            composerCard
                .screenGutter()
                .padding(.bottom, Spacing.row)
        }
        .background(Theme.ground)
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .sheet(item: $picking) { picker($0) }
        .task { await load() }
        .onChange(of: mode) { _, _ in
            Task { await loadBranchesIfNeeded() }
        }
        .onChange(of: projectID) { _, _ in
            baseRef = nil
            branches = []
            Task { await loadBranchesIfNeeded() }
        }
    }

    // MARK: - The task

    /// One line a day, so it reads as the app's voice rather than a slot
    /// machine. A side chat has no checkout to speak of, so it gets its own.
    static func greeting(for mode: NewChatMode) -> String {
        let lines = mode == .sideChat
            ? ["Ask away.", "No checkout, no ceremony.", "A quiet corner to think in."]
            : ["Clean slate.", "What are we building?", "Say the word.", "Fresh worktree, no history yet.", "Ready when you are."]
        let day = Calendar.current.ordinality(of: .day, in: .era, for: Date()) ?? 0
        return lines[day % lines.count]
    }

    // MARK: - The choices, and the one action

    // MARK: - The hero, and the composer

    /// The fox and its line, centred in the room above the composer — what
    /// the desktop chat shows before a first message, and the page's own
    /// greeting rather than an instruction (the placeholder is that).
    private var hero: some View {
        VStack(spacing: Spacing.row) {
            FoxMark(size: 72)
            Text(Self.greeting(for: mode))
                .font(.body.weight(.medium))
                .foregroundStyle(Theme.ink.opacity(0.85))
        }
        .allowsHitTesting(false)
    }

    /// The composer as the active chat draws it: one raised card holding the
    /// prompt, the choices as chips along the bottom, and the send button —
    /// so starting a chat and continuing one are the same gesture.
    private var composerCard: some View {
        VStack(alignment: .leading, spacing: Spacing.row) {
            if !images.isEmpty {
                ComposerImageStrip(images: images)
            }
            TextField(
                mode == .sideChat ? "Ask anything" : "Describe the task",
                text: $prompt,
                axis: .vertical
            )
            .font(.body)
            .foregroundStyle(Theme.ink)
            .tint(accent.color)
            .lineLimit(2...6)
            .focused($promptFocused)
            .submitLabel(.return)
            .accessibilityLabel("Task")
            HStack(alignment: .center, spacing: Spacing.snug) {
                AttachImageButton(picks: $photoPicks, busy: images.attaching)
                HStack(spacing: Spacing.snug) {
                    modelEffortControl
                }
                .composerChipSurface()
                Spacer(minLength: Spacing.tight)
                if dictation.available {
                    DictateButton(dictation: dictation, draft: { prompt }) { draft in
                        draftBeforeDictation = draft
                        failure = nil
                    }
                }
                sendButton
            }
        }
        .composerCardSurface()
        .onChange(of: photoPicks) { _, picks in
            guard !picks.isEmpty else { return }
            photoPicks = []
            Task {
                failure = await images.attach(picks, storeKey: attachmentStoreKey, client: client)
            }
        }
        .onChange(of: dictation.heard) { _, heard in
            prompt = draftWithDictation(draftBeforeDictation, heard: heard)
        }
        .onChange(of: dictation.failure) { _, reported in
            if let reported { failure = reported }
        }
        .onDisappear { dictation.stop() }
    }

    /// Where pre-launch images are stored: there is no session yet, so they
    /// go under the launcher's own folder for this project — `launcherDraftKey`
    /// on the desktop, and the hidden scratch project for a side chat, which
    /// is the key the web launcher uses for the same pick.
    private var attachmentStoreKey: String {
        "launch-\(mode == .sideChat ? scratchProjectID : (projectID ?? scratchProjectID))"
    }

    /// Where and in what, as a column above the composer — each a line you
    /// can read at a glance and tap to change. The model stays in the card,
    /// where the active chat keeps it.
    private var choiceRows: some View {
        VStack(alignment: .leading, spacing: Spacing.tight) {
            if !projects.isEmpty {
                ChoiceRow(systemImage: "folder", value: selectedProject?.name ?? "Choose project") { picking = .project }
                ChoiceRow(systemImage: "laptopcomputer", value: mode.title) { picking = .mode }
            }
            if mode.takesBaseRef {
                ChoiceRow(
                    systemImage: "arrow.triangle.branch",
                    value: baseRef ?? "Choose branch",
                    mono: baseRef != nil
                ) { picking = .branch }
            }
        }
    }

    /// Model and effort inside one chip: two decisions, two tap targets, one
    /// pill — the same pair `TranscriptComposer` draws once the chat exists.
    /// The provider mark stays in the picker, where the choice is made.
    @ViewBuilder
    private var modelEffortControl: some View {
        ComposerChipButton { picking = .model } content: {
            Text(model.label)
                .font(.subheadline)
                .foregroundStyle(Theme.ink)
        }
        .accessibilityLabel("Model, \(model.label)")
        if selectedModel?.supportsReasoningEffort == true {
            ComposerChipButton { picking = .effort } content: {
                Text(catalog.label(for: effortBinding.wrappedValue))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
            }
            .accessibilityLabel("Effort, \(catalog.label(for: effortBinding.wrappedValue))")
        }
    }

    private var sendButton: some View {
        Button {
            Task { await start() }
        } label: {
            Group {
                if launching {
                    ProgressView().tint(Theme.ground)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.ground)
                }
            }
            .frame(width: Spacing.composerControl, height: Spacing.composerControl)
            .background(Circle().fill(plan == nil ? Theme.muted.opacity(0.35) : accent.color))
        }
        .buttonStyle(.plain)
        .disabled(plan == nil || launching)
        .accessibilityLabel("Start chat")
        .animation(.easeOut(duration: 0.15), value: plan == nil)
    }

    // MARK: - Pickers

    @ViewBuilder
    private func picker(_ picking: Picking) -> some View {
        switch picking {
        case .project:
            PickerSheet(
                title: "Project",
                options: projects.map { PickerOption(value: $0.id, label: $0.name, detail: $0.currentBranch) },
                selection: Binding(get: { projectID ?? "" }, set: { projectID = $0 }),
                emptyMessage: "No project registered on your Mac."
            )
        case .mode:
            PickerSheet(
                title: "Workspace",
                options: NewChatMode.allCases.map { PickerOption(value: $0, label: $0.title, detail: hint($0)) },
                selection: $mode
            )
        case .branch:
            PickerSheet(
                title: "Branch from",
                options: branches.map { PickerOption(value: $0, label: $0, mono: true) },
                selection: Binding(get: { baseRef ?? "" }, set: { baseRef = $0 }),
                emptyMessage: "No branches came back from your Mac."
            )
        case .model:
            PickerSheet(
                title: "Model",
                options: modelOptions,
                selection: Binding(get: { "\(model.provider)/\(model.modelId)" }, set: chooseModel)
            )
        case .effort:
            EffortSheet(
                efforts: selectedModel?.reasoningEfforts ?? [],
                selection: effortBinding,
                label: { catalog.label(for: $0) }
            )
        }
    }

    /// Every model from every CLI in one list, grouped by provider — the
    /// desktop composer's model menu. Two chips for "which agent" and
    /// "which model" would be two taps for one decision that is really one.
    ///
    /// The mark and the CLI's availability ride on the group heading, which
    /// is where they belong: they are facts about the provider, and
    /// repeating them down four model rows says nothing new. The row's own
    /// columns are its label and its context window, which is the number
    /// you are choosing between when the labels all say GPT.
    private var modelOptions: [PickerOption<String>] {
        let catalogRows = catalog.providers.flatMap { provider -> [PickerOption<String>] in
            // Availability is advisory: the host's probe can be
            // inconclusive, and a CLI that changed its status command must
            // not lock the phone out of a provider that works. So the rows
            // dim and say why, and stay pickable.
            let reason = catalog.unavailability(provider.id, among: discovered)
            return provider.models.map { option in
                PickerOption(
                    value: "\(provider.id)/\(option.modelId)",
                    label: option.label,
                    detail: option.contextWindowLabel,
                    detailMono: true,
                    dimmed: reason != nil,
                    group: provider.displayName,
                    groupGlyph: AnyView(ProviderMark(provider: provider.id, size: 14)),
                    groupDetail: reason
                )
            }
        }
        return ModelRecency.prefixed(catalogRows)
    }

    /// One line per workspace mode, in the picker's trailing column. Kept
    /// here rather than on `NewChatMode`, which is the launch plan's value
    /// type and has no business carrying UI copy.
    private func hint(_ mode: NewChatMode) -> String? {
        switch mode {
        case .worktree: return selectedProject.map { "off \($0.currentBranch)" }
        case .current: return "shared"
        case .branchFrom: return "pick a base"
        case .sideChat: return "no repository"
        }
    }

    // MARK: - Choices

    private var selectedProject: ProjectSummary? {
        projects.first { $0.id == projectID }
    }

    private var selectedModel: CatalogModel? {
        catalog.model(provider: model.provider, modelId: model.modelId)
    }

    /// The two calls "Start chat" makes, or nil while the choices are not yet
    /// a launch. The button reads this rather than re-deriving the rules.
    private var plan: NewChatPlan? {
        NewChatPlan(
            mode: mode,
            project: selectedProject,
            baseRef: mode.takesBaseRef ? baseRef : nil,
            model: model,
            titleModelId: catalog.provider(model.provider)?.titleModelId ?? model.modelId,
            prompt: prompt,
            attachments: images.attachments
        )
    }

    /// Picking a model carries the chosen effort onto whatever ladder the new
    /// model offers, and switching provider comes along with it.
    private func chooseModel(_ id: String) {
        let parts = id.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2, let target = catalog.model(provider: parts[0], modelId: parts[1]) else { return }
        model = ModelSelection(
            provider: parts[0],
            label: target.label,
            modelId: target.modelId,
            reasoningEffort: catalog.resolveEffort(model.reasoningEffort, for: target)
        )
        ModelRecency.touch(id)
    }

    private var effortBinding: Binding<ReasoningEffort> {
        Binding(
            get: { model.reasoningEffort ?? selectedModel?.defaultEffort ?? catalog.defaultEffort },
            set: { model.reasoningEffort = $0 }
        )
    }

    // MARK: - Loading

    private func load() async {
        async let loadedProjects = try? await client.listProjects()
        async let loadedProviders = try? await client.discoverProviders()

        if let fetched = await loadedProjects {
            projects = fetched.filter { $0.id != scratchProjectID }
            if projectID == nil || !projects.contains(where: { $0.id == projectID }) {
                let preselected = projects.first { $0.id == preselectedProjectID }
                projectID = preselected?.id ?? projects.first?.id
            }
            if projects.isEmpty { mode = .sideChat }
        }
        if let capabilities = await loadedProviders {
            discovered = capabilities
            // Land on a provider the Mac can actually run, the way
            // `preferredLaunchProvider` seeds the desktop launcher.
            if let capability = capabilities.first(where: { $0.provider == model.provider }),
               !capability.usable,
               let preferred = catalog.preferredProvider(among: capabilities),
               let provider = catalog.provider(preferred) {
                chooseModel("\(preferred)/\(provider.defaultModel.modelId)")
            }
        }
        await loadBranchesIfNeeded()
    }

    private func loadBranchesIfNeeded() async {
        guard mode.takesBaseRef, let project = selectedProject else { return }
        do {
            branches = try await client.listBranches(projectID: project.id)
            if let baseRef, !branches.contains(baseRef) { self.baseRef = nil }
        } catch {
            branches = []
            failure = "Couldn't load branches."
        }
    }

    // MARK: - Starting

    private func start() async {
        guard let plan, !launching else { return }
        launching = true
        failure = nil
        // The words are already in the prompt; leaving the mic open past the
        // launch would keep dictating into a sheet that is closing.
        dictation.stop()

        do {
            let workspace = try await client.createWorkspace(plan.creation)
            let session: SessionSummary
            do {
                session = try await client.launchSession(plan.launchInput(workspaceID: workspace.id))
            } catch {
                // No session started, so the workspace and its worktree would
                // sit stranded with no explanation. A lost socket is the
                // exception: the host may have launched fine and only the
                // reply went missing, and archiving there would kill a live
                // chat and delete its worktree.
                if (error as? BridgeError) != .disconnected {
                    _ = try? await client.archiveWorkspace(workspaceID: workspace.id, force: true)
                }
                throw error
            }
            // Not awaited, and not a failure worth reporting: it is a second
            // CLI call, and the chat should open now wearing the first line
            // of its prompt — which is what it was called all along.
            let autoTitle = plan.autoTitleInput(workspaceID: workspace.id)
            Task { _ = try? await client.autoTitleWorkspace(autoTitle) }
            Haptics.success()
            onLaunched(workspace, session)
        } catch {
            Haptics.warning()
            failure = hostFailureMessage(error)
            launching = false
        }
    }
}

#if DEBUG
#Preview("New chat") {
    Color.clear.sheet(isPresented: .constant(true)) {
        NewChatSheet(store: previewStore(), client: previewClient()) { _, _ in }
    }
}

#Preview("No project registered") {
    Color.clear.sheet(isPresented: .constant(true)) {
        NewChatSheet(store: DashboardStore(client: previewClient()), client: previewClient()) { _, _ in }
    }
}
#endif

/// One choice, one line: a glyph, the chosen value, and the up/down chevron
/// that says it can be changed.
private struct ChoiceRow: View {
    let systemImage: String
    let value: String
    var mono = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.row) {
                Image(systemName: systemImage)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 22, alignment: .center)
                Text(value)
                    .font(mono ? .body.monospaced() : .body)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 40)
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .accessibilityLabel(value)
    }
}

extension ReasoningEffort: Identifiable {
    var id: String { rawValue }
}

/// The dial in a short sheet of its own: header, dial, done. Shared with
/// `TranscriptComposer`, which opens the same picker for a running chat.
struct EffortSheet: View {
    let efforts: [ReasoningEffort]
    @Binding var selection: ReasoningEffort
    let label: (ReasoningEffort) -> String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "Effort") {
                HeaderGlyphButton(systemName: "xmark", label: "Close", tint: Theme.muted) { dismiss() }
            }
            EffortDial(efforts: efforts, selection: $selection, label: label)
                .screenGutter()
                .padding(.bottom, Spacing.section)
        }
        .background(Theme.ground)
        .argmaxSheet(detents: [.height(Spacing.headerHeight + 140 + Spacing.section)])
    }
}
