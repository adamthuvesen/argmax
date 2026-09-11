import SwiftUI

/// How much supporting activity a transcript spends phone-sized space on.
enum MobileChatDetail: Int, CaseIterable, Identifiable, Sendable {
    case minimal = 1
    case compact = 2
    case balanced = 3
    case detailed = 4

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .minimal: return "Minimal"
        case .compact: return "Compact"
        case .balanced: return "Balanced"
        case .detailed: return "Detailed"
        }
    }

    var hint: String {
        switch self {
        case .minimal:
            return "Answers, with one folded activity summary."
        case .compact:
            return "Short grouped activity between messages."
        case .balanced:
            return "Adds thoughts inline."
        case .detailed:
            return "Also shows tool steps. Outputs stay folded."
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
