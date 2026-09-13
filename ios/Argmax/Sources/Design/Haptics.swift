import UIKit

/// Short, semantic feedback for events the interface also shows visually.
/// Ordinary buttons and navigation stay quiet. Apple already gives stock
/// controls such as switches their own feedback.
@MainActor
enum Haptics {
    static let enabledKey = "argmax.phone.haptics"

    private static weak var attachedView: UIView?
    private static var selectionFeedback: UISelectionFeedbackGenerator?
    private static var notificationFeedback: UINotificationFeedbackGenerator?

    static func isEnabled(in store: UserDefaults = .standard) -> Bool {
        store.object(forKey: enabledKey) as? Bool ?? true
    }

    /// A value changed within a discrete set: a segment, filter, or dial stop.
    static func selection() {
        guard isEnabled(), prepareGenerators() else { return }
        selectionFeedback?.selectionChanged()
    }

    static func success() {
        notification(.success)
    }

    static func error() {
        notification(.error)
    }

    private static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        guard isEnabled(), prepareGenerators() else { return }
        notificationFeedback?.notificationOccurred(type)
    }

    /// Associate generators with the active SwiftUI host. Reuse keeps the
    /// engine warm, while rebuilding after a root replacement avoids routing
    /// feedback through a view that is no longer on screen.
    private static func prepareGenerators() -> Bool {
        guard let view = hostView() else { return false }
        if attachedView !== view {
            attachedView = view
            selectionFeedback = UISelectionFeedbackGenerator(view: view)
            notificationFeedback = UINotificationFeedbackGenerator(view: view)
        }
        return true
    }

    private static func hostView() -> UIView? {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            if let view = scene.windows.first(where: \.isKeyWindow)?.rootViewController?.view {
                return view
            }
        }
        return nil
    }
}
