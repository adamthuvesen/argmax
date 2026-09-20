import SwiftUI

/// How much supporting activity a transcript spends phone-sized space on.
enum MobileChatDetail: Int, CaseIterable, Identifiable, Sendable {
    case minimal = 1
    case compact = 2
    /// Was "Balanced"; the raw value is what `argmax.phone.chatDetail` persists.
    case steps = 3
    case detailed = 4

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .minimal: return "Minimal"
        case .compact: return "Compact"
        case .steps: return "Steps"
        case .detailed: return "Detailed"
        }
    }

    var hint: String {
        switch self {
        case .minimal:
            // The desktop also hides finished work behind a "Worked for" chip.
            // The phone has no chip yet, so saying so here would promise a
            // level it does not have.
            return "One activity line with a single icon. Finished turns fold in the remarks before each call."
        case .compact:
            return "One activity summary between messages."
        case .steps:
            return "Every step listed by name. Outputs stay folded."
        case .detailed:
            return "Steps and thoughts in full."
        }
    }
}

private struct MobileChatDetailKey: EnvironmentKey {
    static let defaultValue = MobileChatDetail.compact
}

extension EnvironmentValues {
    var mobileChatDetail: MobileChatDetail {
        get { self[MobileChatDetailKey.self] }
        set { self[MobileChatDetailKey.self] = newValue }
    }
}
