import SwiftUI
import UIKit

struct TranscriptAttachment: Decodable, Hashable, Identifiable, Sendable {
    let filePath: String
    let mimeType: String
    let sizeBytes: Int

    var id: String { filePath }
    var isImage: Bool { mimeType.lowercased().hasPrefix("image/") || WorkspaceImage.isImage(filePath) }
    var name: String { URL(fileURLWithPath: filePath).lastPathComponent }

    init(filePath: String, mimeType: String, sizeBytes: Int = 0) {
        self.filePath = filePath
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
    }

    private enum CodingKeys: String, CodingKey { case filePath, mimeType, sizeBytes }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        filePath = try container.decode(String.self, forKey: .filePath)
        mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType) ?? "application/octet-stream"
        sizeBytes = try container.decodeIfPresent(Int.self, forKey: .sizeBytes) ?? 0
    }
}

struct TranscriptAttachmentStrip: View {
    let attachments: [TranscriptAttachment]
    let client: BridgeClient
    let onOpenFile: (String) -> Void

    init(
        attachments: [TranscriptAttachment],
        client: BridgeClient,
        onOpenFile: @escaping (String) -> Void = { _ in }
    ) {
        self.attachments = attachments
        self.client = client
        self.onOpenFile = onOpenFile
    }

    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal) {
                LazyHStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        if attachment.isImage {
                            TranscriptImageTile(
                                source: .init(alt: attachment.name, target: attachment.filePath),
                                client: client,
                                attachment: true,
                                compact: true,
                                onOpenFile: onOpenFile
                            )
                            .frame(width: 168, height: 120)
                        } else {
                            Button { onOpenFile(attachment.filePath) } label: {
                                Label {
                                    Text(attachment.name).typeStyle(.footnote)
                                } icon: {
                                    Image(systemName: "doc").typeSymbol(.footnote)
                                }
                                    .lineLimit(2)
                                    .padding(10)
                                    .frame(width: 168, height: 54, alignment: .leading)
                                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
            .accessibilityLabel("Attachments")
        }
    }
}

struct TranscriptMarkdownImageSource: Sendable {
    let alt: String
    let target: String

    var isStoredAttachment: Bool {
        target.hasPrefix("argmax-attachment://") || target.contains("/attachments/")
    }

    init(alt: String, target: String) {
        self.alt = alt
        self.target = target
    }

    init?(markdownLine: String) {
        guard markdownLine.hasPrefix("!["),
              let closeAlt = markdownLine.range(of: "]("),
              markdownLine.hasSuffix(")")
        else { return nil }
        let altStart = markdownLine.index(markdownLine.startIndex, offsetBy: 2)
        let alt = String(markdownLine[altStart..<closeAlt.lowerBound])
        var destination = String(markdownLine[closeAlt.upperBound..<markdownLine.index(before: markdownLine.endIndex)])
            .trimmingCharacters(in: .whitespaces)
        if destination.hasPrefix("<"), let close = destination.firstIndex(of: ">") {
            destination = String(destination[destination.index(after: destination.startIndex)..<close])
        } else if let title = destination.range(of: " \"") ?? destination.range(of: " '") {
            destination = String(destination[..<title.lowerBound])
        }
        guard !destination.isEmpty else { return nil }
        self.init(alt: alt, target: destination.removingPercentEncoding ?? destination)
    }
}

struct TranscriptMarkdownImage: View {
    let image: TranscriptMarkdownImageSource
    let client: BridgeClient?
    let onOpenFile: (String) -> Void

    var body: some View {
        if let client {
            TranscriptImageTile(
                source: image,
                client: client,
                attachment: image.isStoredAttachment,
                compact: false,
                onOpenFile: onOpenFile
            )
                .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 360)
        } else if let scheme = URL(string: image.target)?.scheme, scheme == "http" || scheme == "https" {
            TranscriptImageTile(source: image, client: nil, attachment: false, compact: false, onOpenFile: onOpenFile)
                .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 360)
        } else {
            TranscriptFileFallback(source: image, onOpenFile: onOpenFile)
        }
    }
}

private struct TranscriptImageTile: View {
    let source: TranscriptMarkdownImageSource
    let client: BridgeClient?
    let attachment: Bool
    let compact: Bool
    let onOpenFile: (String) -> Void
    @State private var request: URLRequest?
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var failed = false
    @State private var expanded = false

    var body: some View {
        Group {
            if let image {
                Button { expanded = true } label: {
                    Image(uiImage: image)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(source.alt.isEmpty ? "Attached image" : source.alt)
                .accessibilityHint("Opens full screen")
            } else if failed {
                TranscriptFileFallback(source: source, onOpenFile: onOpenFile)
            } else {
                ProgressView().tint(Theme.muted)
            }
        }
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: compact ? 10 : 12, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: compact ? 10 : 12, style: .continuous))
        .task(id: source.target) { await load() }
        .fullScreenCover(isPresented: $expanded) {
            TranscriptFullScreenImage(image: image, request: request, title: source.alt, isPresented: $expanded)
        }
    }

    private func load() async {
        if let url = URL(string: source.target), url.scheme == "http" || url.scheme == "https" {
            await load(URLRequest(url: url)); return
        }
        let sourceURL = URL(string: source.target) ?? URL(fileURLWithPath: source.target)
        let path = TranscriptMarkdownDocument.isLocalLink(sourceURL)
            ? TranscriptMarkdownDocument.localPath(from: sourceURL)
            : source.target
        let request = attachment
            ? client?.attachmentRequest(absolutePath: path)
            : client?.assetRequest(absolutePath: path)
        guard let request else { failed = true; return }
        await load(request)
    }

    private func load(_ request: URLRequest) async {
        self.request = request
        failed = false
        do {
            let decoded = try await NativeImageCache.shared.image(for: request,
                pixels: Int((compact ? 168 : 420) * displayScale))
            guard !Task.isCancelled else { return }
            image = decoded
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }

}

private struct TranscriptFileFallback: View {
    let source: TranscriptMarkdownImageSource
    let onOpenFile: (String) -> Void

    var body: some View {
        Button { onOpenFile(source.target) } label: {
            Label {
                Text(source.alt.isEmpty ? URL(fileURLWithPath: source.target).lastPathComponent : source.alt)
                    .typeStyle(.footnote)
            } icon: {
                Image(systemName: "photo").typeSymbol(.footnote)
            }
                .foregroundStyle(Theme.ink)
                .padding(10)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct TranscriptFullScreenImage: View {
    let image: UIImage?
    let request: URLRequest?
    @State private var expandedImage: UIImage?
    let title: String
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            TranscriptRichZoomCanvas {
                // Laid out at the decode's own size; the canvas fits it to the
                // viewport, so swapping the thumbnail for the full decode
                // changes resolution, not the size on screen.
                if let image = expandedImage ?? image {
                    Image(uiImage: image).padding(16)
                }
            }
            .background(Theme.ground)
            .task {
                guard let request,
                      let full = try? await NativeImageCache.shared.image(for: request, pixels: 4096),
                      !Task.isCancelled else { return }
                expandedImage = full
            }
            .navigationTitle(title.isEmpty ? "Image" : title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { isPresented = false } } }
        }
    }
}
