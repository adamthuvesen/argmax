import AVFoundation
import Speech
import SwiftUI

/// Speaking a prompt instead of typing it.
///
/// The phone's own recognizer, kept on-device wherever the model is there for
/// it (`requiresOnDeviceRecognition`): this app holds a person's whole working
/// day, and a prompt is the most sensitive thing it carries, so the audio has
/// no business going to Apple's servers when the phone can read it itself.
/// Where on-device recognition is missing — an older device, a locale without
/// the model — it falls back rather than refusing, because a dictation button
/// that does nothing on some phones is worse than one that says where the
/// audio went. The keyboard's own mic key is always there as well; this button
/// is for the times the keyboard is not.
///
/// One recognizer for the phone's current locale. A session ends on the second
/// tap, on `SFSpeechRecognitionTask` finishing, or when the view goes away.
@MainActor
final class Dictation: ObservableObject {
    /// The mic is open and audio is reaching the recognizer.
    @Published private(set) var listening = false
    /// Everything heard since the mic was opened, partial results included.
    @Published private(set) var heard = ""
    /// What went wrong, in words a person can act on.
    @Published private(set) var failure: String?
    /// Whether the audio is being read on this phone rather than by Apple.
    @Published private(set) var onDevice = true

    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Set for the async gap before `listening` goes true, so a second tap
    /// during the authorization round-trip cannot start a second session and
    /// install a second tap on the same audio bus.
    private var starting = false

    /// Whether this phone can dictate at all — no recognizer for the current
    /// locale, or the service is down, and the button has nothing to offer.
    var available: Bool { recognizer != nil }

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
        failure = nil
        heard = ""
        guard await authorized() else { return }
        guard recognizer.isAvailable else {
            failure = "Dictation is not available right now."
            return
        }
        do {
            try openMicrophone(recognizer)
            listening = true
        } catch {
            teardown()
            failure = "Could not start dictation."
        }
    }

    func stop() {
        guard listening else { return }
        // Let the recognizer finish the phrase it is mid-way through; the
        // final result lands in the callback below and the task ends there.
        request?.endAudio()
        teardown()
        listening = false
    }

    private func openMicrophone(_ recognizer: SFSpeechRecognizer) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        onDevice = recognizer.supportsOnDeviceRecognition
        self.request = request

        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        try engine.start()

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.heard = result.bestTranscription.formattedString
                }
                guard error != nil || result?.isFinal == true else { return }
                // A recognizer that stops on its own — a long silence, a lost
                // service — leaves the button saying it is listening unless
                // the end is mirrored here. The words heard so far stay in
                // the draft; only an empty session reports the failure.
                if error != nil, self.heard.isEmpty, self.listening {
                    self.failure = "Dictation stopped early."
                }
                self.teardown()
                self.listening = false
            }
        }
    }

    private func teardown() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        task = nil
        request = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

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

/// The draft as it stands with what has been heard so far folded in.
///
/// Dictation never replaces what was typed: the phrase joins the end of the
/// draft that was in the field when the mic was opened, so a half-written
/// prompt survives being finished out loud. Partial results rewrite the same
/// tail rather than stacking, which is why this takes the draft from before
/// the session rather than the field's current contents.
func draftWithDictation(_ draft: String, heard: String) -> String {
    let spoken = heard.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !spoken.isEmpty else { return draft }
    guard !draft.isEmpty else { return spoken }
    return draft.last?.isWhitespace == true ? draft + spoken : "\(draft) \(spoken)"
}

/// The composer's mic. The keyboard has a mic key of its own, but only while
/// it is up and only into the field it is attached to; this one starts from a
/// closed keyboard, which on a phone is most of the time.
struct DictateButton: View {
    @ObservedObject var dictation: Dictation
    /// The draft to fold what is heard into, read when the mic opens.
    let draft: () -> String
    let onOpen: (String) -> Void

    var body: some View {
        Button {
            if !dictation.listening { onOpen(draft()) }
            Haptics.light()
            dictation.toggle()
        } label: {
            Image(systemName: dictation.listening ? "waveform" : "mic")
                .font(.body.weight(.medium))
                .foregroundStyle(dictation.listening ? Theme.stop : Theme.ink)
                .symbolEffect(.variableColor.iterative, isActive: dictation.listening)
                .composerGlyphSurface()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(dictation.listening ? "Stop dictating" : "Dictate")
    }
}
