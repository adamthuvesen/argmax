import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The images waiting to go out with a draft, and the picker that adds them.
///
/// Both composers hold one of these: the chat's card, where the store folder
/// is the session, and New chat's, where it is the launcher's own key for the
/// project — the same split `launcherDraftKey` makes on the desktop. The file
/// lives on the Mac from the moment it is picked; what is kept here is the
/// path the send will name and a preview to show meanwhile.
@MainActor
final class ComposerImages: ObservableObject {
    @Published private(set) var attachments: [ComposerAttachment] = []
    @Published private(set) var previews: [String: UIImage] = [:]
    @Published private(set) var attaching = false

    var isEmpty: Bool { attachments.isEmpty }

    /// Store each pick on the Mac as it is read, so the send that follows only
    /// has to name the files. A pick that fails leaves the ones that worked
    /// attached and answers with what went wrong.
    func attach(
        _ picks: [PhotosPickerItem],
        storeKey: String,
        client: BridgeClient
    ) async -> String? {
        attaching = true
        defer { attaching = false }
        var failure: String?
        for pick in picks {
            let data = try? await pick.loadTransferable(type: Data.self)
            guard let data else {
                failure = "That image could not be attached."
                continue
            }
            if let reported = await store(data, storeKey: storeKey, client: client) {
                failure = reported
            }
        }
        return failure
    }

    /// The same road in from the clipboard: a screenshot taken with Copy and
    /// Save is a PNG sitting on the pasteboard, and the composer's standard
    /// edit-menu Paste action hands it over as item providers.
    func attach(
        pasted providers: [NSItemProvider],
        storeKey: String,
        client: BridgeClient
    ) async -> String? {
        attaching = true
        defer { attaching = false }
        var failure: String?
        for provider in providers {
            guard let data = await Self.imageData(from: provider) else {
                failure = "That image could not be pasted."
                continue
            }
            if let reported = await store(data, storeKey: storeKey, client: client) {
                failure = reported
            }
        }
        return failure
    }

    /// Encode to something the store takes, put it on the Mac, and hold the
    /// preview. Answers with what went wrong, or nil.
    private func store(_ data: Data, storeKey: String, client: BridgeClient) async -> String? {
        guard let image = PickedImage.encoded(from: data) else {
            return "That image could not be attached."
        }
        do {
            let saved = try await client.saveAttachmentImage(
                SaveAttachmentImageInput(
                    sessionId: storeKey,
                    mimeType: image.mimeType,
                    dataBase64: image.data.base64EncodedString()
                )
            )
            attachments.append(
                ComposerAttachment(
                    filePath: saved.filePath,
                    mimeType: image.mimeType,
                    sizeBytes: saved.sizeBytes
                )
            )
            previews[saved.filePath] = UIImage(data: image.data)
            return nil
        } catch {
            return hostFailureMessage(error)
        }
    }

    /// The provider's bytes as they were registered — a pasted PNG stays a
    /// PNG, which `PickedImage` needs to tell the store what it is holding.
    /// `NSItemProvider` predates concurrency and answers on a callback.
    private static func imageData(from provider: NSItemProvider) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(for: .image) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    /// Drops the image from this draft. The file stays in the host's store,
    /// which prunes it with the chat, exactly as removing a pending image on
    /// the desktop does.
    func remove(_ attachment: ComposerAttachment) {
        attachments.removeAll { $0.filePath == attachment.filePath }
        previews[attachment.filePath] = nil
    }

    /// The prompt as it goes out: the typed text, then one `@path` per image.
    /// The desktop composer sends both — the reference for the agent to read
    /// inline, the list for the host to record with the message.
    func prompt(from text: String) -> String {
        ([text] + attachments.map { "@\($0.filePath)" })
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Put a failed send's images back, the way its text goes back in the field.
    func restore(_ sent: [ComposerAttachment]) {
        attachments = sent
    }

    /// Clear after a send that landed, dropping the previews with them.
    func clear() {
        for attachment in attachments { previews[attachment.filePath] = nil }
        attachments = []
    }
}

/// The composer's own plus. Photos only — the store holds images, and a file
/// on this phone is not a path the agent on the Mac could open anyway.
struct AttachImageButton: View {
    @Binding var picks: [PhotosPickerItem]
    let busy: Bool

    var body: some View {
        PhotosPicker(selection: $picks, maxSelectionCount: 4, matching: .images) {
            Group {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "plus")
                        .typeSymbol(.body, weight: .medium)
                        .foregroundStyle(Theme.ink)
                }
            }
            .composerGlyphSurface()
        }
        .disabled(busy)
        .accessibilityLabel("Attach image")
    }
}

/// The picked images above the field, each with the × that drops it.
struct ComposerImageStrip: View {
    @ObservedObject var images: ComposerImages

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.snug) {
                ForEach(images.attachments, id: \.filePath) { attachment in
                    ZStack(alignment: .topTrailing) {
                        thumbnail(attachment)
                        Button {
                            images.remove(attachment)
                        } label: {
                            Image(systemName: "xmark")
                                .typeSymbol(.caption2, weight: .bold)
                                .foregroundStyle(Theme.ground)
                                .frame(width: 18, height: 18)
                                .background(Theme.ink.opacity(0.75), in: .circle)
                        }
                        .buttonStyle(.plain)
                        .padding(4)
                        .accessibilityLabel("Remove image")
                    }
                }
            }
        }
        // The strip is one row of thumbs; the scroll view would otherwise
        // claim the height the field wants.
        .frame(height: 56)
    }

    private func thumbnail(_ attachment: ComposerAttachment) -> some View {
        Group {
            if let preview = images.previews[attachment.filePath] {
                Image(uiImage: preview)
                    .resizable()
                    .scaledToFill()
            } else {
                Theme.ground
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(.rect(cornerRadius: Radius.control, style: .continuous))
        .accessibilityLabel("Attached image")
    }
}
