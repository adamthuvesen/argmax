import SwiftUI

/// Holds a displayed value for at least `dwell` before accepting the next.
///
/// A tool boundary lands as two deltas tens of milliseconds apart (the
/// completion, then the next start), so a fold's headline used to pass
/// through "Ran a command" on its way to "Ran a command, reading a file"
/// for a frame or two. A change arriving inside the dwell replaces the
/// pending one, so a value that would only have been shown for a few
/// frames is never painted; the newest value always wins once the dwell
/// expires.
struct TranscriptDwelledValue<Value: Equatable, Content: View>: View {
    let value: Value
    var dwell: Duration = .milliseconds(400)
    @ViewBuilder let content: (Value) -> Content

    @State private var displayed: Value?
    @State private var shownAt: ContinuousClock.Instant?
    @State private var pending: Task<Void, Never>?

    var body: some View {
        content(displayed ?? value)
            .onChange(of: value, initial: true) { _, next in accept(next) }
            .onDisappear { pending?.cancel() }
    }

    private func accept(_ next: Value) {
        pending?.cancel()
        pending = nil
        if next == displayed { return }
        let now = ContinuousClock.now
        if let shownAt, now - shownAt < dwell {
            let remaining = dwell - (now - shownAt)
            pending = Task { @MainActor in
                try? await Task.sleep(for: remaining)
                guard !Task.isCancelled else { return }
                show(next)
            }
        } else {
            show(next)
        }
    }

    private func show(_ next: Value) {
        displayed = next
        shownAt = .now
    }
}

