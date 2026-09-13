import AVFoundation
import Speech
import SwiftUI

/// Speaking a prompt instead of typing it.
///
/// The phone's own recognizer, kept on-device by default
/// (`requiresOnDeviceRecognition`): this app holds a person's whole working
/// day, and a prompt is the most sensitive thing it carries, so the audio has
/// no business going to Apple's servers unless the person says so. Settings
/// holds that answer under `onDeviceKey`, because the on-device model is the
/// less accurate of the two and a prompt full of branch names and library
/// names is the hardest thing to ask of it. Where on-device recognition is
/// missing — an older device, a locale without the model — it falls back
/// rather than refusing, because a dictation button that does nothing on some
/// phones is worse than one that says where the audio went. The keyboard's
/// own mic key is always there as well; this button is for the times the
/// keyboard is not.
///
/// One open microphone per session, and a run of recognition tasks behind it.
/// The recognizer finalizes a phrase on its own — a pause it reads as an
/// ending, a segment limit on the service path — and a session that ended
/// there would cut a person off mid-prompt, so each finalized phrase is
/// committed and a fresh task takes over on the same open microphone. What is
/// committed never moves again; only the phrase still being spoken is
/// rewritten as the recognizer changes its mind, which is what keeps finished
/// words from shifting under the cursor.
///
/// A session ends on the second tap, on the recognizer failing twice over, or
/// when the view goes away.
@MainActor
final class Dictation: ObservableObject {
    /// Where the audio is read: this phone, or Apple's service. Settings owns
    /// the answer, defaulting to on-device, and `Dictation` reads it as each
    /// recognition task opens.
    nonisolated static let onDeviceKey = "argmax.phone.dictation.onDevice"

    /// The mic is open and audio is reaching the recognizer.
    @Published private(set) var listening = false
    /// Everything heard since the mic was opened: the phrases the recognizer
    /// has finalized, and the one it is still working on.
    @Published private(set) var heard = ""
    /// What went wrong, in words a person can act on.
    @Published private(set) var failure: String?
    /// Whether the audio is being read on this phone rather than by Apple.
    @Published private(set) var onDevice = true

    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private let store: UserDefaults
    private let engine = AVAudioEngine()
    private let sink = AudioSink()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// The finalized phrases of this session, in order. Frozen once here.
    private var committed: [String] = []
    /// The phrase the recognizer is still working on, and still revising.
    private var pending = ""
    /// Recognition tasks that have ended without hearing anything, back to
    /// back, reset by any result. Two is the end of the session: one is a
    /// segment limit or a blip worth taking again, a pair is a recognizer that
    /// is not coming back — and a recognizer that refuses instantly would
    /// otherwise be handed a fresh task forever.
    private var failures = 0
    /// When the current task opened, so an instant empty ending is read as a
    /// refusal rather than as a phrase that came to its natural end.
    private var opened = ContinuousClock.now
    /// Set for the async gap before `listening` goes true, so a second tap
    /// during the authorization round-trip cannot start a second session and
    /// install a second tap on the same audio bus.
    private var starting = false
    /// `stop()` has asked for the last phrase and is waiting for it. The
    /// session already reads as closed; only the transcript is still landing.
    private var finishing = false
    /// Closes the session if the last phrase never arrives.
    private var lastCall: Task<Void, Never>?
    /// Bumped every time a session closes, so a `start()` still waiting on
    /// the two permission prompts can tell that what it was starting is gone.
    private var generation = 0
    private var tapped = false

    init(store: UserDefaults = .standard) {
        self.store = store
    }

    /// Whether this phone can dictate at all — no recognizer for the current
    /// locale, or the service is down, and the button has nothing to offer.
    var available: Bool { recognizer != nil }

    /// Whether this phone has an on-device model for its locale. Settings
    /// reads it to say whether its switch can change anything.
    nonisolated static var canReadOnDevice: Bool {
        SFSpeechRecognizer(locale: Locale.current)?.supportsOnDeviceRecognition ?? false
    }

    func toggle() {
        if listening {
            stop()
        } else {
            Task { await start() }
        }
    }

    func start() async {
        guard !listening, !starting, let recognizer else { return }
        starting = true
        defer { starting = false }
        // A phrase still landing from the previous session belongs to a
        // transcript that is about to be thrown away.
        if finishing { close() }
        failure = nil
        committed = []
        pending = ""
        failures = 0
        heard = ""
        let session = generation
        guard await authorized() else { return }
        // The first dictation is the only one that waits here, and the prompts
        // it waits on are long enough to send the draft behind its back.
        guard session == generation else { return }
        guard recognizer.isAvailable else {
            failure = "Dictation is not available right now."
            return
        }
        do {
            try openMicrophone()
            listen(recognizer)
            listening = true
        } catch {
            close()
            failure = "Could not start dictation."
        }
    }

    func stop() {
        guard listening else {
            // A stop during the wait for the last phrase closes it out now.
            if finishing { close() }
            return
        }
        // The microphone closes and the button stops saying it is listening at
        // once. The recognizer keeps the phrase it is mid-way through, and its
        // final reading of it — punctuated, second-guessed, and reliably
        // better than the partial on screen — lands a moment later. Cancelling
        // the task here instead is what used to leave a half-heard phrase in
        // the draft and make finished words look like they had been deleted.
        listening = false
        finishing = true
        sink.replace(nil)
        request?.endAudio()
        closeMicrophone()
        lastCall = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            self?.close()
        }
    }

    /// Close the microphone and let go of the phrase in flight.
    ///
    /// The send paths take this rather than `stop()`: the words on screen are
    /// the ones going out, and a final reading arriving after the field was
    /// cleared would put the sent prompt straight back in the composer.
    func discard() {
        guard listening || finishing || starting else { return }
        close()
    }

    private func openMicrophone() throws {
        let session = AVAudioSession.sharedInstance()
        // `.default` rather than `.measurement`: measurement mode asks the
        // system for as little signal processing as it can give, and a phone
        // held at arm's length in a room needs exactly the gain and noise
        // handling that processing is.
        try session.setCategory(.record, mode: .default, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let input = engine.inputNode
        // A tap left behind by an engine stopped from under us — an
        // interruption, a route change — makes the next install raise an
        // ObjC exception that no `try` on this side would catch.
        if tapped { input.removeTap(onBus: 0) }
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [sink] buffer, _ in
            sink.append(buffer)
        }
        tapped = true
        engine.prepare()
        try engine.start()
    }

    /// One recognition task, feeding off the microphone this session already
    /// opened. Each one ends with a finalized phrase, and the next takes over.
    private func listen(_ recognizer: SFSpeechRecognizer) {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        // A prompt is prose. The default hint biases the language model
        // towards a short search query, which is the other kind of thing
        // people say into a phone and not this one.
        request.taskHint = .dictation
        request.contextualStrings = Self.vocabulary
        onDevice = prefersOnDevice && recognizer.supportsOnDeviceRecognition
        request.requiresOnDeviceRecognition = onDevice
        self.request = request
        sink.replace(request)
        opened = .now

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                self?.received(result, error: error, from: recognizer)
            }
        }
    }

    private func received(
        _ result: SFSpeechRecognitionResult?,
        error: Error?,
        from recognizer: SFSpeechRecognizer
    ) {
        // A task cancelled by `close()` can still call back. The session it
        // belonged to is over, and its transcript has been handed over to the
        // field already, so nothing it says now belongs anywhere.
        guard listening || finishing else { return }
        if let result {
            pending = result.bestTranscription.formattedString
            failures = 0
            publish()
        }
        guard error != nil || result?.isFinal == true else { return }
        let heardNothing = pending.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        commitPending()
        if error != nil || (heardNothing && opened.duration(to: .now) < .milliseconds(200)) {
            failures += 1
        }

        if finishing {
            close()
            return
        }
        guard failures < 2 else {
            if committed.isEmpty { failure = "Dictation stopped early." }
            close()
            return
        }
        listen(recognizer)
    }

    /// The phrase the recognizer has finished with joins the ones before it.
    private func commitPending() {
        let phrase = pending.trimmingCharacters(in: .whitespacesAndNewlines)
        pending = ""
        guard !phrase.isEmpty else { return }
        committed.append(phrase)
        publish()
    }

    private func publish() {
        heard = (committed + [pending])
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// The session is over: no task, no request, no microphone, and nothing
    /// left waiting on a phrase.
    private func close() {
        lastCall?.cancel()
        lastCall = nil
        closeMicrophone()
        task?.cancel()
        task = nil
        request = nil
        sink.replace(nil)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        listening = false
        finishing = false
        generation += 1
    }

    private func closeMicrophone() {
        if engine.isRunning { engine.stop() }
        if tapped {
            engine.inputNode.removeTap(onBus: 0)
            tapped = false
        }
    }

    private var prefersOnDevice: Bool {
        store.object(forKey: Self.onDeviceKey) as? Bool ?? true
    }

    /// Words a general-purpose recognizer mishears and this app is made of.
    /// Hints rather than a dictionary: they raise the odds of the right
    /// spelling without ruling anything else out.
    private static let vocabulary = [
        "Argmax", "Claude", "Codex", "Cursor", "OpenCode", "Grok",
        "Opus", "Sonnet", "Haiku", "Fable",
        "worktree", "rebase", "cherry-pick", "pull request", "diff", "stash",
        "merge conflict", "commit", "branch", "repo", "lint", "typecheck",
        "refactor", "regex", "async", "TypeScript", "SwiftUI", "Swift",
        "Rust", "Tauri", "SQLite", "Xcode",
    ]

    /// Speech recognition and the microphone are two separate grants, and a
    /// refusal of either is permanent until the person changes it in Settings
    /// — so say that rather than re-asking on the next tap.
    private func authorized() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else {
            failure = "Allow speech recognition for Argmax in Settings to dictate."
            return false
        }
        let microphone = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard microphone else {
            failure = "Allow the microphone for Argmax in Settings to dictate."
            return false
        }
        return true
    }
}

/// The recognition request the microphone tap is feeding.
///
/// The tap runs on a realtime audio thread while the main actor swaps requests
/// between phrases, so the handover goes through a lock rather than through a
/// main-actor property the audio thread has no business reading.
private final class AudioSink: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func replace(_ next: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        request = next
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        request?.append(buffer)
    }
}

/// The field as it stands with what has been heard so far folded in.
///
/// Dictation never replaces what was typed: the phrase joins the end of the
/// draft, so a half-written prompt survives being finished out loud. Each
/// update rewrites only the tail the update before it wrote — `replacing` —
/// rather than rebuilding from a snapshot of the field, which is what lets a
/// person keep typing, or go back and fix a word, while the mic is open. A
/// tail that is no longer at the end of the draft was edited or sent, so it is
/// left alone and the new phrase appends after whatever is there.
func draftWithDictation(_ draft: String, heard: String, replacing previous: String = "") -> String {
    let base = draftWithoutDictatedTail(draft, tail: previous)
    let spoken = heard.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !spoken.isEmpty else { return base }
    guard !base.isEmpty else { return spoken }
    return base.last?.isWhitespace == true ? base + spoken : "\(base) \(spoken)"
}

private func draftWithoutDictatedTail(_ draft: String, tail: String) -> String {
    let written = tail.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !written.isEmpty, draft.hasSuffix(written) else { return draft }
    return String(draft.dropLast(written.count))
}

/// The composer's mic. The keyboard has a mic key of its own, but only while
/// it is up and only into the field it is attached to; this one starts from a
/// closed keyboard, which on a phone is most of the time.
struct DictateButton: View {
    @ObservedObject var dictation: Dictation
    /// Called as the mic opens, before anything has been heard: the composer
    /// forgets the tail of the last session so this one appends rather than
    /// overwriting it.
    let onOpen: () -> Void

    var body: some View {
        Button {
            if !dictation.listening { onOpen() }
            dictation.toggle()
        } label: {
            Image(systemName: dictation.listening ? "waveform" : "mic")
                .typeSymbol(.body, weight: .medium)
                .foregroundStyle(dictation.listening ? Theme.stop : Theme.ink)
                .symbolEffect(.variableColor.iterative, isActive: dictation.listening)
                .composerGlyphSurface()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(dictation.listening ? "Stop dictating" : "Dictate")
    }
}
