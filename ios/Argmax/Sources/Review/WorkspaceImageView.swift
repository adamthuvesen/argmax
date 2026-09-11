import SwiftUI

/// The one file kind the text read cannot carry.
///
/// `workspace:read-file` reports every PNG as binary and a large sprite sheet
/// as too large, so the viewer would only ever have a sentence to show. The
/// bytes come over the host's authenticated asset endpoint instead — the same
/// path `ImageFilePreview.tsx` takes on the desktop.
enum WorkspaceImage {
    /// What the host will actually serve. Kept in step with the extension
    /// list in `src-tauri/src/workspace_assets/protocol.rs`, minus `svg`:
    /// an SVG reads back as *text*, so it never reaches this branch and is
    /// shown as its source, which is what the desktop does with it too.
    private static let extensions: Set<String> =
        ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]

    static func isImage(_ path: String) -> Bool {
        guard let dot = path.lastIndex(of: ".") else { return false }
        return extensions.contains(path[path.index(after: dot)...].lowercased())
    }
}

struct WorkspaceImageView: View {
    let absolutePath: String
    let client: BridgeClient

    @State private var image: UIImage?
    @State private var failure: String?
    /// Fit, until you ask for 1:1. A sprite sheet in a column this narrow is
    /// unreadable fitted, and unreachable without a way back out — so the tap
    /// toggles rather than zooming into a gesture you have to undo.
    @State private var actualSize = false

    var body: some View {
        Group {
            if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: actualSize ? .fill : .fit)
                        .frame(
                            maxWidth: actualSize ? image.size.width : .infinity,
                            maxHeight: actualSize ? image.size.height : .infinity
                        )
                        .onTapGesture {
                            Haptics.light()
                            withAnimation(.easeOut(duration: 0.18)) { actualSize.toggle() }
                        }
                        .accessibilityLabel(actualSize ? "Image, actual size" : "Image, fitted")
                        .accessibilityHint("Double tap to switch size")
                }
                .scrollDisabled(!actualSize)
            } else if let failure {
                EmptyState(mark: .glyph("photo"), message: failure)
            } else {
                ProgressView().tint(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await fetch() }
    }

    private func fetch() async {
        guard let request = client.assetRequest(absolutePath: absolutePath) else {
            failure = "Can't reach this image."
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let decoded = UIImage(data: data)
            else {
                failure = "Can't show this image."
                return
            }
            image = decoded
        } catch {
            failure = "Can't reach this image."
        }
    }
}
