import UIKit

/// The three taps the app has, so a caller never has to remember which
/// generator class does which.
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

}
