import SwiftUI

private struct TranscriptWorkspacePathKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var transcriptWorkspacePath: String? {
        get { self[TranscriptWorkspacePathKey.self] }
        set { self[TranscriptWorkspacePathKey.self] = newValue }
    }
}
