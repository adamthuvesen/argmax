import SwiftUI

/// Whether a new wording is worth painting, and when.
///
/// Two rules, both about what a reader can follow rather than what the
/// provider did:
///
/// - **The wording changes on the kind of work, not on the count.** A turn
///   reading six files re-words its headline six times ("read 2 files", "read
///   3 files", …) and real turns land four of those calls in the same
///   millisecond, so the count is not news while the work is still going. The
///   line holds until the kinds present change — read → edit → command — and
///   the final counts land when the work settles.
/// - **One wording per beat.** A change arriving inside the dwell is held to
///   the end of it, and only the newest wording is ever painted: a burst
///   collapses to one change rather than one per member.
///
/// A tool boundary is the case that made this necessary — the completion and
/// the next start land tens of milliseconds apart, so a fold's headline used
/// to pass through "Ran a command" on its way to "Ran a command, reading a
/// file" for a frame or two.
enum TranscriptDwell: Equatable {
    case now
    case after(Duration)
    case hold

    static func decide(
        keyChanged: Bool,
        running: Bool,
        shownFor: Duration?,
        dwell: Duration
    ) -> Self {
        // Settled work is the moment the counts are worth reading, so it paints
        // whatever the dwell was holding back.
        if !running { return .now }
        if !keyChanged { return .hold }
        guard let shownFor, shownFor < dwell else { return .now }
        return .after(dwell - shownFor)
    }
}

/// Paces a value a reader has to follow while it churns, on the rules in
/// `TranscriptDwell`.
struct TranscriptDwelledValue<Value: Equatable, Key: Equatable, Content: View>: View {
    let value: Value
    /// What a change has to move while the work is in flight: the kinds of
    /// work in a fold, not the number of calls in it.
    let key: Key
    /// Work still in flight.
    let running: Bool
    var dwell: Duration = .milliseconds(800)
    @ViewBuilder let content: (Value) -> Content

    @State private var displayed: Value?
    @State private var displayedKey: Key?
    @State private var shownAt: ContinuousClock.Instant?

    var body: some View {
        content(displayed ?? value)
            // Restarted by each change, which is what drops the intermediates
            // in a burst: the commit reads the newest wording, and the deadline
            // it waits for comes from `shownAt` rather than from this task, so
            // a restart re-derives the same deadline instead of pushing it out.
            .task(id: Inputs(value: value, key: key, running: running)) { await accept() }
    }

    private struct Inputs: Equatable {
        var value: Value
        var key: Key
        var running: Bool
    }

    private func accept() async {
        if value == displayed { return }
        switch TranscriptDwell.decide(keyChanged: key != displayedKey, running: running,
                                      shownFor: shownAt.map { ContinuousClock.now - $0 },
                                      dwell: dwell) {
        case .hold:
            return
        case .now:
            show()
        case .after(let remaining):
            try? await Task.sleep(for: remaining)
            guard !Task.isCancelled else { return }
            show()
        }
    }

    private func show() {
        displayed = value
        displayedKey = key
        shownAt = .now
    }
}
