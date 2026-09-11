import PhotosUI
import SwiftUI

/// The composer for the chat on screen, drawn under the shared web view once
/// it hides its own (`setComposer(true)`; `docs/plan/hybrid-native-phone.md`).
///
/// The same card `NewChatSheet`'s composer draws — field, model chip opening
/// `PickerSheet`, effort chip opening `EffortDial`, round send button — plus
/// the running-state controls the web composer carries and a phone has no
/// other way to offer: Stop in place of send, a queue button beside it, and a
/// compact stack of queued follow-ups above the card (`docs/chat-cards.md`).
///
/// Bound to `TranscriptHost.composer`, the wire state the page posts, so this
/// view never has to re-derive the composer's own rules — which efforts a
/// model offers, queue vs send while running — for whichever model the
/// session is actually running. Picking a *different* model before sending is
/// the one thing that state cannot describe yet, so that candidate reads its
/// own effort ladder from the bundled catalogue instead, the same source
/// `NewChatSheet` uses.
struct TranscriptComposer: View {
    @EnvironmentObject private var transcript: TranscriptHost
    @EnvironmentObject private var store: DashboardStore
    @Environment(\.accentTint) private var accent

    @State private var input = ""
    @FocusState private var focused: Bool
    @State private var sending = false
    @State private var stopping = false
    @State private var sendingQueuedID: String?
    @State private var failure: String?
    @State private var picking: Picking?
    @State private var pendingProviderSwitch: PendingProviderSwitch?
    /// Install/auth state per CLI, the same probe `NewChatSheet` reads, so a
    /// mid-conversation switch dims a provider that isn't signed in instead
    /// of only discovering that once the switch is attempted.
    @State private var discovered: [ProviderCapability] = []
    /// The user's own pick, once they have made one. Nil reads the session's
    /// live model and effort off the wire state instead.
    @State private var modelOverride: ModelSelection?
    /// Images already stored on the Mac, waiting to go out with this draft —
    /// the phone's cut of the desktop composer's pending attachments.
    @StateObject private var images = ComposerImages()
    @State private var photoPicks: [PhotosPickerItem] = []
    @StateObject private var dictation = Dictation()
    /// The draft as it stood when the mic was opened. Partial results rewrite
    /// the tail after it rather than stacking on each other.
    @State private var draftBeforeDictation = ""

    private let catalog = ProviderCatalog.bundled

    private enum Picking: String, Identifiable {
        case model
        case effort
        var id: String { rawValue }
    }

    private struct PendingProviderSwitch: Identifiable {
        let model: ModelSelection
        var id: String { "\(model.provider)/\(model.modelId)" }
    }

    var body: some View {
        if let composer = transcript.composer {
            VStack(alignment: .leading, spacing: Spacing.snug) {
                if !composer.queued.isEmpty {
                    queue(composer)
                }
                card(composer)
            }
            .screenGutter()
            .padding(.bottom, Spacing.snug)
            .task { await loadDiscovered() }
            .sheet(item: $picking) { picker($0, composer) }
            .sheet(item: $pendingProviderSwitch) { pending in
                ProviderSwitchConfirmation(
                    toName: catalog.provider(pending.model.provider)?.displayName ?? pending.model.provider,
                    onCancel: { pendingProviderSwitch = nil },
                    onSwitch: {
                        modelOverride = pending.model
                        ModelRecency.touch("\(pending.model.provider)/\(pending.model.modelId)")
                        pendingProviderSwitch = nil
                    }
                )
            }
        }
    }

    // MARK: - The card

    private func card(_ composer: NativeComposerState) -> some View {
        let model = activeModel(for: composer)
        return VStack(alignment: .leading, spacing: Spacing.row) {
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(Theme.rose)
            }
            if !images.isEmpty {
                ComposerImageStrip(images: images)
            }
            TextField("Message", text: $input, axis: .vertical)
                .font(.body)
                .foregroundStyle(Theme.ink)
                .tint(accent.color)
                .lineLimit(1...6)
                .focused($focused)
                .submitLabel(.send)
                .onSubmit { send(composer) }
                .accessibilityLabel("Message")
            HStack(alignment: .center, spacing: Spacing.snug) {
                AttachImageButton(picks: $photoPicks, busy: images.attaching)
                HStack(spacing: Spacing.snug) {
                    modelEffortControl(composer, model: model)
                }
                .composerChipSurface()
                Spacer(minLength: Spacing.tight)
                if dictation.available {
                    DictateButton(dictation: dictation, draft: { input }) { draft in
                        draftBeforeDictation = draft
                        failure = nil
                    }
                }
                if composer.running && hasSendableContent {
                    // The desktop's Enter always queues mid-turn; a phone has
                    // no Enter, so a second control does the same thing
                    // beside Stop (docs/chat-cards.md).
                    Button {
                        send(composer)
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .frame(width: Spacing.composerControl, height: Spacing.composerControl)
                            .background(Theme.raised, in: .circle)
                    }
                    .buttonStyle(.plain)
                    .disabled(sending)
                    .accessibilityLabel("Queue follow-up")
                }
                sendOrStopButton(composer)
            }
        }
        .composerCardSurface()
        .onChange(of: photoPicks) { _, picks in
            guard !picks.isEmpty else { return }
            photoPicks = []
            Task {
                if let reported = await images.attach(picks, storeKey: composer.sessionId, client: store.client) {
                    failure = reported
                } else {
                    failure = nil
                }
            }
        }
        .onChange(of: dictation.heard) { _, heard in
            input = draftWithDictation(draftBeforeDictation, heard: heard)
        }
        .onChange(of: dictation.failure) { _, reported in
            if let reported { failure = reported }
        }
        .onDisappear { dictation.stop() }
    }

    /// Model and effort inside one chip: two decisions, two tap targets, one
    /// pill — the same pair `NewChatSheet` draws. No provider mark here; the
    /// model's name already says which CLI, and the mark is in the picker
    /// where a choice is actually being made.
    @ViewBuilder
    private func modelEffortControl(_ composer: NativeComposerState, model: ModelSelection) -> some View {
        ComposerChipButton { picking = .model } content: {
            Text(model.label)
                .font(.subheadline)
                .foregroundStyle(Theme.ink)
        }
        .accessibilityLabel("Model, \(model.label)")
        if supportsEffort(composer) {
            ComposerChipButton { picking = .effort } content: {
                Text(catalog.label(for: effortBinding(composer).wrappedValue))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
            }
            .accessibilityLabel("Effort, \(catalog.label(for: effortBinding(composer).wrappedValue))")
        }
    }

    private func sendOrStopButton(_ composer: NativeComposerState) -> some View {
        Button {
            if composer.running {
                stop(composer)
            } else {
                send(composer)
            }
        } label: {
            Group {
                if sending || stopping {
                    ProgressView().tint(Theme.ground)
                } else if composer.running {
                    // Drawn rather than set as a symbol: the stop mark is a
                    // proportion of its circle — the desktop's 9-in-28 — and
                    // a font size only approximates one.
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Theme.ground)
                        .frame(width: 11, height: 11)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.ground)
                }
            }
            .frame(width: Spacing.composerControl, height: Spacing.composerControl)
            .background(
                Circle().fill(
                    composer.running
                        ? Theme.stop
                        : hasSendableContent ? accent.color : Theme.muted.opacity(0.35)
                )
            )
        }
        .buttonStyle(.plain)
        .disabled((!composer.running && !hasSendableContent) || sending || stopping)
        .accessibilityLabel(composer.running ? "Stop" : "Send")
        .animation(.easeOut(duration: 0.15), value: composer.running)
    }

    private var hasSendableContent: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty
    }

    // MARK: - Queued follow-ups

    /// The compact stack above the card: the text, then the desktop lane's
    /// own five actions — Steer, Send now, Multitask, Edit, Cancel — as
    /// glyphs. A row this narrow cannot spell them out and still show the
    /// follow-up it is about, so the words live in the accessibility labels
    /// and the glyphs are the desktop's: steer turns into the turn, send is
    /// the plane, a multitask is the split column, edit is the pencil.
    /// Steer only appears when the page says this row can take it.
    private func queue(_ composer: NativeComposerState) -> some View {
        VStack(alignment: .leading, spacing: Spacing.tight) {
            ForEach(composer.queued, id: \.id) { message in
                HStack(spacing: Spacing.tight) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                        .accessibilityHidden(true)
                    Text(message.text)
                        .font(.footnote)
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .accessibilityLabel("Queued follow-up: \(message.text)")
                    Spacer(minLength: Spacing.tight)
                    // Butted together: each glyph's own 30pt frame is the gap,
                    // and five of them plus a gap apiece would leave the
                    // follow-up a word wide.
                    HStack(spacing: 0) {
                        if message.canSteer {
                            queueAction("arrow.turn.up.right", "Steer queued follow-up", tint: accent.color) {
                                sendQueuedNow(composer, messageID: message.id, delivery: "steer")
                            }
                        }
                        queueAction("paperplane.fill", "Send queued follow-up", tint: accent.color) {
                            sendQueuedNow(composer, messageID: message.id)
                        }
                        queueAction("rectangle.split.2x1", "Multitask queued follow-up") {
                            multitaskQueued(composer, message: message)
                        }
                        queueAction("pencil", "Edit queued follow-up") {
                            editQueued(composer, message: message)
                        }
                        queueAction("trash", "Cancel queued follow-up") {
                            cancelQueued(composer, messageID: message.id)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(sendingQueuedID != nil)
                .padding(.leading, Spacing.row)
                .padding(.trailing, Spacing.tight)
                .padding(.vertical, Spacing.tight + 2)
                .background(Theme.raised, in: .rect(cornerRadius: Radius.control, style: .continuous))
            }
        }
        .screenGutter()
    }

    /// One glyph in the queued row. 30pt of hit area around a caption-sized
    /// mark: smaller than the 44 a standalone control takes, because five of
    /// those would leave no room for the follow-up they act on, and larger
    /// than the glyph, which a thumb would miss.
    private func queueAction(
        _ symbol: String,
        _ label: String,
        tint: Color = Theme.muted,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .contentShape(.rect)
        }
        .accessibilityLabel(label)
    }

    // MARK: - Model & effort

    private func activeModel(for composer: NativeComposerState) -> ModelSelection {
        modelOverride ?? ModelSelection(
            provider: composer.provider,
            label: composer.modelLabel,
            modelId: composer.modelId,
            reasoningEffort: composer.effort.map(ReasoningEffort.init(rawValue:))
        )
    }

    /// Whether the *active* model — the override once there is one, else the
    /// session's own — offers a rung at all. The wire `efforts` list answers
    /// this for the session's own model without a catalogue lookup; a
    /// candidate the user just picked has not round-tripped through the wire
    /// yet, so it reads the catalogue directly, same as `NewChatSheet`.
    private func supportsEffort(_ composer: NativeComposerState) -> Bool {
        guard let modelOverride else { return !composer.efforts.isEmpty }
        return catalog.model(provider: modelOverride.provider, modelId: modelOverride.modelId)?.supportsReasoningEffort ?? false
    }

    private func effortOptions(_ composer: NativeComposerState) -> [ReasoningEffort] {
        guard let modelOverride else { return composer.efforts.map { ReasoningEffort(rawValue: $0) } }
        return catalog.model(provider: modelOverride.provider, modelId: modelOverride.modelId)?.reasoningEfforts ?? []
    }

    private func effortBinding(_ composer: NativeComposerState) -> Binding<ReasoningEffort> {
        Binding(
            get: {
                activeModel(for: composer).reasoningEffort
                    ?? effortOptions(composer).first
                    ?? catalog.defaultEffort
            },
            set: { newValue in
                var model = activeModel(for: composer)
                model.reasoningEffort = newValue
                modelOverride = model
            }
        )
    }

    /// Every model from every CLI, grouped by provider — the same list
    /// `NewChatSheet` offers — unless the chat is running, which locks the
    /// choice to its own provider: the host only switches provider on an idle
    /// follow-up (`ProvidersSendInput`'s `provider` doc comment).
    private func modelOptions(for composer: NativeComposerState) -> [PickerOption<String>] {
        let grouped = !composer.running
        let providers = grouped ? catalog.providers : (catalog.provider(composer.provider).map { [$0] } ?? [])
        let catalogRows = providers.flatMap { provider -> [PickerOption<String>] in
            let groupGlyph: AnyView? = grouped ? AnyView(ProviderMark(provider: provider.id, size: 14)) : nil
            // Only worth asking while every provider is on offer — locked to
            // the running session's own CLI, availability is moot.
            let reason = grouped ? catalog.unavailability(provider.id, among: discovered) : nil
            return provider.models.map { option in
                PickerOption(
                    value: "\(provider.id)/\(option.modelId)",
                    label: option.label,
                    detail: option.contextWindowLabel,
                    detailMono: true,
                    dimmed: reason != nil,
                    group: grouped ? provider.displayName : nil,
                    groupGlyph: groupGlyph,
                    groupDetail: reason
                )
            }
        }
        return grouped ? ModelRecency.prefixed(catalogRows) : catalogRows
    }

    private func loadDiscovered() async {
        discovered = (try? await store.client.discoverProviders()) ?? []
    }

    /// Picking a model carries the chosen effort onto whatever ladder the new
    /// model offers (`resolveEffort`), the same as `NewChatSheet`. Switching
    /// provider while idle asks first (`ProviderSwitchConfirmation`) unless
    /// it is already what is picked, so re-picking within it does not re-ask.
    private func chooseModel(_ id: String, composer: NativeComposerState) {
        let parts = id.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2, let target = catalog.model(provider: parts[0], modelId: parts[1]) else { return }
        let current = activeModel(for: composer)
        let next = ModelSelection(
            provider: parts[0],
            label: target.label,
            modelId: target.modelId,
            reasoningEffort: catalog.resolveEffort(current.reasoningEffort, for: target)
        )
        if !composer.running, parts[0] != composer.provider, parts[0] != current.provider {
            pendingProviderSwitch = PendingProviderSwitch(model: next)
            return
        }
        modelOverride = next
        ModelRecency.touch(id)
    }

    @ViewBuilder
    private func picker(_ picking: Picking, _ composer: NativeComposerState) -> some View {
        switch picking {
        case .model:
            PickerSheet(
                title: "Model",
                options: modelOptions(for: composer),
                selection: Binding(
                    get: {
                        let model = activeModel(for: composer)
                        return "\(model.provider)/\(model.modelId)"
                    },
                    set: { chooseModel($0, composer: composer) }
                )
            )
        case .effort:
            EffortSheet(
                efforts: effortOptions(composer),
                selection: effortBinding(composer),
                label: { catalog.label(for: $0) }
            )
        }
    }

    // MARK: - Sending

    /// The session's own agent mode. The wire `composer` message carries no
    /// mode field — this card has no toggle for it, only New chat's picker
    /// grid does — so a follow-up sent from here carries whatever the session
    /// is already running rather than silently defaulting to auto.
    private var currentAgentMode: String {
        guard let sessionID = transcript.composer?.sessionId else { return "auto" }
        return store.snapshot.sessions.first { $0.id == sessionID }?.agentMode ?? "auto"
    }

    private func send(_ composer: NativeComposerState) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hasSendableContent, !sending else { return }
        let model = activeModel(for: composer)
        let mode = currentAgentMode
        let sent = images.attachments
        // Both, the way `SessionComposer.deliverDraft` sends them: the paths
        // as `@references` in the prompt for the agent to read inline, and the
        // same files listed for the host to record with the message.
        let prompt = images.prompt(from: trimmed)
        sending = true
        failure = nil
        dictation.stop()
        input = ""
        images.clear()
        Haptics.light()
        Task {
            do {
                _ = try await store.client.sendInput(
                    SendInputInput(
                        sessionId: composer.sessionId,
                        input: prompt,
                        provider: model.provider,
                        modelLabel: model.label,
                        modelId: model.modelId,
                        reasoningEffort: model.reasoningEffort?.rawValue,
                        agentMode: mode,
                        attachments: sent
                    )
                )
            } catch {
                // The draft is not lost: text and images go back the same way
                // a failed desktop send restores them.
                input = trimmed
                images.restore(sent)
                failure = hostFailureMessage(error)
            }
            sending = false
        }
    }

    private func stop(_ composer: NativeComposerState) {
        guard !stopping else { return }
        stopping = true
        Task {
            do {
                _ = try await store.client.terminateSession(sessionID: composer.sessionId)
            } catch {
                failure = hostFailureMessage(error)
            }
            stopping = false
        }
    }

    private func cancelQueued(_ composer: NativeComposerState, messageID: String) {
        guard sendingQueuedID == nil else { return }
        sendingQueuedID = messageID
        Task {
            do {
                _ = try await store.client.cancelQueuedMessage(sessionID: composer.sessionId, messageID: messageID)
            } catch {
                failure = hostFailureMessage(error)
            }
            sendingQueuedID = nil
        }
    }

    private func sendQueuedNow(
        _ composer: NativeComposerState,
        messageID: String,
        delivery: String = "interrupt"
    ) {
        guard sendingQueuedID == nil else { return }
        sendingQueuedID = messageID
        Task {
            do {
                _ = try await store.client.sendQueuedMessageNow(
                    sessionID: composer.sessionId,
                    messageID: messageID,
                    delivery: delivery
                )
            } catch {
                failure = hostFailureMessage(error)
            }
            sendingQueuedID = nil
        }
    }

    /// Dispatch the row as its own chat. It never touches the running turn:
    /// the host claims the queued row in the same operation, and the chat it
    /// starts is named by the same cheap title model the launcher uses.
    private func multitaskQueued(_ composer: NativeComposerState, message: NativeQueuedMessage) {
        guard sendingQueuedID == nil else { return }
        sendingQueuedID = message.id
        Task {
            do {
                let launched = try await store.client.multitask(
                    sessionID: composer.sessionId,
                    prompt: message.text,
                    pendingMessageID: message.id
                )
                Haptics.success()
                if let titleModelId = catalog.provider(composer.provider)?.titleModelId {
                    // Best-effort, and never awaited: the multitask is already
                    // running, and a failure leaves it named after the first
                    // line of its prompt.
                    let autoTitle = AutoTitleWorkspaceInput(
                        workspaceId: launched.workspaceId,
                        provider: composer.provider,
                        modelId: titleModelId,
                        prompt: message.text
                    )
                    Task { try? await store.client.autoTitleWorkspace(autoTitle) }
                }
            } catch {
                Haptics.warning()
                failure = hostFailureMessage(error)
            }
            sendingQueuedID = nil
        }
    }

    /// Take the row back into the field to reword it. It leaves the queue
    /// first: a dequeue that failed after the text was restored would leave
    /// the same prompt in two places, and the queued copy would still be
    /// delivered as written. A half-written draft is kept — the queued
    /// message would have been delivered before it, so it goes above it.
    private func editQueued(_ composer: NativeComposerState, message: NativeQueuedMessage) {
        guard sendingQueuedID == nil else { return }
        sendingQueuedID = message.id
        Task {
            do {
                _ = try await store.client.cancelQueuedMessage(
                    sessionID: composer.sessionId,
                    messageID: message.id
                )
                input = input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? message.text
                    : "\(message.text)\n\n\(input)"
                focused = true
            } catch {
                failure = hostFailureMessage(error)
            }
            sendingQueuedID = nil
        }
    }
}

/// The transcript composer's cut of `ProviderSwitchDialog.tsx`: switching a
/// chat's provider starts the new CLI fresh from a short summary rather than
/// resuming it, so this asks first. Only Cancel or Switch — the web dialog's
/// third button, "New chat", is reachable here from the chat's own trailing
/// menu ("New chat here") instead of a second path out of this sheet. A
/// bespoke sheet rather than a system alert: the design brief's rule is that
/// stock chrome is a decision to *not* design, and this app's other
/// confirmations (`EffortSheet`, `PickerSheet`) are all sheets on our own
/// ground.
private struct ProviderSwitchConfirmation: View {
    let toName: String
    let onCancel: () -> Void
    let onSwitch: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.row) {
            Text("Switch to \(toName)?")
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.ink)
            Text("\(toName) can't resume this chat. It starts fresh from a short summary of it.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
            HStack(spacing: Spacing.snug) {
                QuietButton(title: "Cancel", action: onCancel)
                PrimaryButton(title: "Switch", action: onSwitch)
            }
        }
        .padding(Spacing.gutter)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.ground)
        .argmaxSheet(detents: [.height(220)])
    }
}
