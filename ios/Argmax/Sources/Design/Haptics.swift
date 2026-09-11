import UIKit

/// The three taps the app has, so a caller never has to remember which
/// generator class does which.
///
/// The web transcript sends the same three over the native contract
/// (`NativeHapticKind`), so a send inside the page and a "Start chat" outside
/// it feel identical.
enum Haptics {
    /// A choice landed: a chip picked, a chat launched, a row opened.
    static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    static func play(_ kind: NativeHapticKind) {
        switch kind {
        case .light: light()
        case .success: success()
        case .warning: warning()
        }
    }
}
