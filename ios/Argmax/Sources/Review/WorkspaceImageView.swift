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
    var revision = ""

    @State private var image: UIImage?
    @State private var failure: String?

    var body: some View {
        Group {
            if let image {
                // The same canvas the transcript's full-screen image uses, so
                // a PNG reached through Review pinches and pans like one
                // reached from a chat. A fit written as `.aspectRatio(.fit)`
                // inside a two-axis ScrollView does not fit: the scroll view
                // proposes unbounded width, `maxWidth: .infinity` resolves
                // against it, and the image falls back to its intrinsic size —
                // 1280pt of screenshot in a 402pt phone, with scrolling turned
                // off in exactly that state. The canvas measures the viewport
                // first, which is what makes "fit" mean anything.
                TranscriptRichZoomCanvas {
                    Image(uiImage: image)
                        .interpolation(.high)
                        .accessibilityLabel("Image")
                }
            } else if let failure {
                EmptyState(mark: .glyph("photo"), message: failure)
            } else {
                ProgressView().tint(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: revision) { await fetch() }
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
            try Task.checkCancellation()
            image = decoded
            failure = nil
        } catch {
            guard !Task.isCancelled else { return }
            failure = "Can't reach this image."
        }
    }
}
