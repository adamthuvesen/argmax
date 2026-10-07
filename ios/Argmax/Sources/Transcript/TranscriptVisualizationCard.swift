import SwiftUI
import WebKit

struct TranscriptVisualizationCard: View {
    let sessionID: String
    let reference: TranscriptVisualizationReference
    let title: String
    let summary: String
    var format: String? = nil
    let client: BridgeClient
    @Environment(\.visualizationSessionID) private var owningComposerSessionID
    @Environment(\.visualizationFollowUp) private var prepareFollowUp
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.typeScale) private var typeScale
    @Environment(\.accentTint) private var accent
    @State private var viewerID = UUID()
    @ObservedObject private var viewers = TranscriptVisualizationViewers.shared
    @State private var loaded: TranscriptVisualizationDocument?
    @State private var renderedLeaseID: UUID?
    @State private var renderedImage: UIImage?
    @State private var failure: String?
    @State private var visible = false
    @State private var fullScreenOpen = false
    @State private var switchingSurface = false
    @State private var pendingFollowUp: String?
    @State private var sourceOpen = false
    @State private var retry = 0
    @State private var inlineHeight: CGFloat = 240
    @State private var fullScreenHeight: CGFloat = 240
    @State private var followUp: String?
    @State private var externalLink: URL?
    @State private var controls: [TranscriptVisualizationControls] = []
    @State private var host: TranscriptVisualizationWeb.Coordinator?
    @State private var originalGroups = Set<String>()
    @State private var exportOpen = false
    @State private var exporting = false
    @State private var persistenceFailure: String?
    @State private var exportFailure: String?
    @State private var exportURL: URL?
    @Environment(\.openURL) private var openURL

    var body: some View {
        let identity = loadIdentity
        return content(fullScreen: false)
            .padding(Spacing.snug)
            .background(Theme.raised, in: .rect(cornerRadius: Radius.card))
            .onAppear {
                visible = true
                if format != "image" && loaded?.artifact.format != "image" { viewers.activate(viewerID) }
            }
            .onDisappear {
                visible = false
                // A cover can hide the transcript. The active full-screen surface
                // retains this card's lease until it closes.
                guard !fullScreenOpen, !switchingSurface else { return }
                viewers.release(viewerID)
                let previous = host
                Task {
                    await previous?.flushState()
                    if host === previous { host = nil }
                }
            }
            .task(id: identity) {
                guard !fullScreenOpen else { return }
                await load(identity)
            }
            .fullScreenCover(isPresented: $fullScreenOpen, onDismiss: restoreInline) {
                NavigationStack {
                    GeometryReader { geometry in
                        ScrollView {
                            content(fullScreen: true, viewportHeight: max(120, geometry.size.height - 2 * Spacing.snug))
                                .padding(Spacing.snug)
                        }
                    }
                    .background(Theme.ground)
                    .navigationTitle(title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { Task { await dismissFullScreen() } }
                                .disabled(switchingSurface)
                                .accessibilityLabel("Close visualization")
                        }
                        ToolbarItem(placement: .topBarTrailing) { actions }
                    }
                }
                .interactiveDismissDisabled()
                .task(id: identity) {
                    guard fullScreenOpen else { return }
                    await load(identity)
                }
            }
    }

    private var actions: some View {
        Menu {
            Button("View source", systemImage: "chevron.left.forwardslash.chevron.right") { sourceOpen = true }
            Button("Export", systemImage: "square.and.arrow.up") { Task { await export() } }
                .disabled(loaded == nil || exporting)
            Button("Reload", systemImage: "arrow.clockwise") { retry += 1 }
        } label: {
            Image(systemName: "ellipsis").typeSymbol(.footnote).frame(width: 44, height: 44)
        }.accessibilityLabel("Visualization actions")
    }

    private func content(fullScreen: Bool, viewportHeight: CGFloat = 0) -> some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            if !fullScreen {
                HStack {
                    Text(title).typeSubtitle(weight: .semibold)
                    Spacer(minLength: 0)
                    Button { Task { await presentFullScreen() } } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .typeSymbol(.footnote).frame(width: 44, height: 44)
                    }.accessibilityLabel("Expand visualization").disabled(switchingSurface)
                    actions
                }
            }
            if !summary.isEmpty { Text(summary).typeMeta() }
            if let persistenceFailure { Text(persistenceFailure).typeMeta().foregroundStyle(Theme.rose) }
            if let exportFailure { Text(exportFailure).typeMeta().foregroundStyle(Theme.rose) }
            if let failure {
                Text(failure).typeMeta().foregroundStyle(Theme.rose)
                Button("Try again") { retry += 1 }.typeChrome().frame(minHeight: 44)
            } else if let loaded {
                if loaded.artifact.format == "image", let renderedImage {
                    Image(uiImage: renderedImage).resizable().scaledToFit()
                        .frame(maxHeight: fullScreen ? viewportHeight : 480)
                        .accessibilityLabel(summary.isEmpty ? title : summary)
                } else if !switchingSurface, fullScreen == fullScreenOpen, loadIdentity.visible,
                          let leaseID = viewers.leases[viewerID], renderedLeaseID == leaseID {
                    TranscriptVisualizationWeb(document: loaded, client: client, sessionID: sessionID,
                                               appearance: appearance,
                                               height: fullScreen ? $fullScreenHeight : $inlineHeight, host: $host,
                                               onFollowUp: { followUp = $0 }, onLink: { externalLink = $0 },
                                               onControls: { controls = $0 }, onPersistenceFailure: { persistenceFailure = $0 },
                                               onFailure: { failure = $0 })
                        .id(retry)
                        .frame(height: fullScreen ? viewportHeight : min(480, inlineHeight))
                        .accessibilityLabel(summary.isEmpty ? title : summary)
                        .accessibilityIdentifier(fullScreen ? "Full-screen visualization" : "Inline visualization")
                } else {
                    ZStack {
                        if viewers.leases[viewerID] != nil || switchingSurface || fullScreenOpen {
                            ProgressView("Restoring visualization").typeMeta()
                        } else {
                            Button("Activate visualization") { viewers.activate(viewerID, replacing: true) }
                                .typeChrome().frame(minHeight: 44)
                        }
                    }.frame(maxWidth: .infinity)
                        .frame(height: fullScreen ? viewportHeight : min(480, inlineHeight))
                }
                if !loaded.artifact.externalDependencies.isEmpty {
                    Text("Some resources require an internet connection.").typeMeta()
                }
                if let followUp {
                    VStack(alignment: .leading, spacing: Spacing.snug) {
                        Text(followUp).typeStyle(.body).lineLimit(5)
                        HStack {
                            Button("Prepare follow-up") {
                                self.followUp = nil
                                if fullScreen {
                                    pendingFollowUp = followUp
                                    Task { await dismissFullScreen() }
                                } else if owningComposerSessionID == sessionID { prepareFollowUp?(followUp) }
                            }.disabled(prepareFollowUp == nil || owningComposerSessionID != sessionID)
                            Button("Dismiss") { self.followUp = nil }
                        }.typeChrome().frame(minHeight: 44)
                    }
                }
                if let externalLink {
                    HStack {
                        Button("Open \(externalLink.host ?? "link")") { openURL(externalLink); self.externalLink = nil }
                        Button("Dismiss") { self.externalLink = nil }
                    }.typeChrome().frame(minHeight: 44)
                }
                ForEach(controls, id: \.id) { group in
                    DisclosureGroup {
                        HStack {
                            Button("Reset") { host?.send(["type": "argmax:visualization-reset", "groupId": group.id]) }
                            Button(originalGroups.contains(group.id) ? "Show changes" : "Show original") {
                                if originalGroups.contains(group.id) { originalGroups.remove(group.id) }
                                else { originalGroups.insert(group.id) }
                                host?.send(["type": "argmax:visualization-original", "groupId": group.id,
                                            "active": originalGroups.contains(group.id)])
                            }
                        }.typeChrome().frame(minHeight: 44)
                        ForEach(group.controls) { control in
                            visualizationControl(control)
                        }
                    } label: { Text(group.label).typeChrome() }
                    .disabled(switchingSurface || fullScreen != fullScreenOpen || !loadIdentity.visible || viewers.leases[viewerID] == nil || renderedLeaseID != viewers.leases[viewerID])
                }
            } else if viewers.leases[viewerID] == nil {
                Button("Activate visualization") { viewers.activate(viewerID, replacing: true) }
                    .typeChrome().frame(maxWidth: .infinity, minHeight: 120)
            } else {
                ProgressView("Loading visualization").typeMeta().frame(maxWidth: .infinity, minHeight: 120)
            }
        }
        .sheet(isPresented: Binding(get: { exportOpen && fullScreenOpen == fullScreen }, set: { exportOpen = $0 }), onDismiss: {
            if let exportURL { try? FileManager.default.removeItem(at: exportURL) }
            exportURL = nil
        }) {
            if let exportURL { TranscriptVisualizationShare(file: exportURL) }
        }
        .sheet(isPresented: Binding(get: { sourceOpen && fullScreenOpen == fullScreen }, set: { sourceOpen = $0 })) {
            NavigationStack {
                ScrollView {
                    Text(loaded?.source ?? "Source unavailable").typeStyle(.footnote, mono: true)
                        .textSelection(.enabled).padding()
                }
                .navigationTitle("Visualization source")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { sourceOpen = false } } }
            }
        }
    }

    private func presentFullScreen() async {
        guard !fullScreenOpen, !switchingSurface else { return }
        switchingSurface = true
        let previous = host
        await previous?.flushState()
        if host === previous { host = nil }
        renderedLeaseID = nil
        if format != "image" && loaded?.artifact.format != "image" { viewers.activate(viewerID, replacing: true) }
        retry += 1
        fullScreenOpen = true
        switchingSurface = false
    }

    private func dismissFullScreen() async {
        guard fullScreenOpen, !switchingSurface else { return }
        switchingSurface = true
        let previous = host
        await previous?.flushState()
        if host === previous { host = nil }
        renderedLeaseID = nil
        fullScreenOpen = false
    }

    private func restoreInline() {
        switchingSurface = false
        retry += 1
        if !visible { viewers.release(viewerID) }
        if let pendingFollowUp, owningComposerSessionID == sessionID { prepareFollowUp?(pendingFollowUp) }
        pendingFollowUp = nil
    }

    @ViewBuilder private func visualizationControl(_ control: TranscriptVisualizationControls.Control) -> some View {
        switch control.kind {
        case "toggle":
            Toggle(control.label, isOn: Binding(
                get: { control.value.bool ?? false }, set: { updateControl(control.id, value: .bool($0)) }
            )).typeChrome()
        case "slider":
            if case .number(let current) = control.value,
               let lower = control.min, let upper = control.max, lower < upper {
                VStack(alignment: .leading) {
                    Text("\(control.label): \(current.formatted())\(control.unit ?? "")").typeChrome()
                    Slider(value: Binding(get: { min(upper, max(lower, current)) }, set: { updateControl(control.id, value: .number($0)) }),
                           in: lower...upper, step: max(0.001, control.step ?? 1))
                }
            }
        case "select":
            Picker(control.label, selection: Binding(get: { control.value }, set: { updateControl(control.id, value: $0) })) {
                ForEach(Array((control.options ?? []).enumerated()), id: \.offset) { _, option in
                    Text(option.label).tag(option.value)
                }
            }.typeChrome()
        case "color":
            ColorPicker(control.label, selection: Binding(
                get: {
                    let hex = (control.value.string ?? "#000000").trimmingCharacters(in: CharacterSet(charactersIn: "#"))
                    let expandedHex = hex.count == 3 ? hex.map { String(repeating: String($0), count: 2) }.joined() : hex
                    let rgb = UInt32(expandedHex, radix: 16) ?? 0
                    return Color(red: Double((rgb >> 16) & 255) / 255,
                                 green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
                }, set: { color in
                    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
                    UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
                    let hex = String(format: "#%02x%02x%02x", Int(red * 255), Int(green * 255), Int(blue * 255))
                    updateControl(control.id, value: .string(hex))
                }
            ), supportsOpacity: false).typeChrome()
        default: Text("Unsupported control: \(control.label)").typeMeta()
        }
    }

    private func updateControl(_ id: String, value: TranscriptJSONValue) {
        for groupIndex in controls.indices {
            if let index = controls[groupIndex].controls.firstIndex(where: { $0.id == id }) {
                controls[groupIndex].controls[index].value = value
            }
        }
        guard let encoded = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: encoded, options: .fragmentsAllowed) else { return }
        host?.send(["type": "argmax:visualization-control", "id": id, "value": object])
    }

    private var loadIdentity: TranscriptVisualizationLoadIdentity {
        .init(reference: reference, retry: retry, visible: visible || fullScreenOpen, leaseID: viewers.leases[viewerID])
    }

    private func load(_ identity: TranscriptVisualizationLoadIdentity) async {
        guard !switchingSurface, identity.visible, identity == loadIdentity,
              identity.leaseID != nil || format == "image" || loaded?.artifact.format == "image" else { return }
        let leaseID = identity.leaseID
        failure = nil
        do {
            await host?.flushState()
            try Task.checkCancellation()
            guard identity == loadIdentity else { return }
            let result = try await client.visualizationDocument(sessionID: sessionID, reference: reference)
            guard !Task.isCancelled, identity == loadIdentity else { return }
            guard result.artifact.sessionId == sessionID, ["html", "image"].contains(result.artifact.format) else {
                throw BridgeError.malformedResponse
            }
            if result.artifact.format == "image" {
                guard let image = image(from: result.source) else { throw BridgeError.malformedResponse }
                renderedImage = image
            }
            loaded = result
            if result.artifact.format == "image" { viewers.release(viewerID) }
            renderedLeaseID = leaseID
            controls = []
            originalGroups = []
        } catch {
            guard !Task.isCancelled, identity == loadIdentity else { return }
            failure = "Visualization unavailable. \(hostFailureMessage(error))"
        }
    }

    private func export() async {
        guard let result = loaded, !exporting else { return }
        exporting = true
        exportFailure = nil
        defer { exporting = false }
        await host?.flushState()
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("visualization-exports", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let imageExtension = result.source.hasPrefix("data:image/jpeg;") ? "jpg"
                : result.source.hasPrefix("data:image/svg+xml;") ? "svg"
                : result.source.hasPrefix("data:image/gif;") ? "gif"
                : result.source.hasPrefix("data:image/webp;") ? "webp" : "png"
            let file = directory.appendingPathComponent("\(UUID().uuidString).\(result.artifact.format == "image" ? imageExtension : "html")")
            if result.artifact.format == "image", let data = imageData(from: result.source) { try data.write(to: file) }
            else {
                let standalone = try await client.visualizationExport(sessionID: sessionID, artifactID: result.artifact.id)
                try standalone.write(to: file, atomically: true, encoding: .utf8)
            }
            exportURL = file
            exportOpen = true
        } catch { exportFailure = "Export failed. \(hostFailureMessage(error))" }
    }

    private func imageData(from source: String) -> Data? {
        guard source.hasPrefix("data:image/"), let comma = source.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(source[source.index(after: comma)...]))
    }
    private func image(from source: String) -> UIImage? { imageData(from: source).flatMap(UIImage.init(data:)) }

    private var appearance: [String: Any] {
        let traits = UITraitCollection(userInterfaceStyle: colorScheme == .dark ? .dark : .light)
        func css(_ color: UIColor) -> String {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
        }
        let fontSize = UIFontMetrics(forTextStyle: .body).scaledValue(for: 16 * typeScale.fontScale.multiplier)
        return ["dark": colorScheme == .dark, "variables": [
            "--background": "transparent", "--foreground": css(Theme.inkColor),
            "--card": css(Theme.insetColor), "--card-foreground": css(Theme.inkColor),
            "--popover": css(Theme.raisedColor), "--popover-foreground": css(Theme.inkColor),
            "--primary": css(Theme.inkColor), "--primary-foreground": css(Theme.groundColor),
            "--secondary": css(Theme.insetColor), "--secondary-foreground": css(Theme.inkColor),
            "--muted": css(Theme.insetColor), "--muted-foreground": css(Theme.mutedColor),
            "--accent-foreground": css(Theme.inkColor), "--border": css(Theme.lineColor),
            "--input": css(Theme.lineColor), "--ring": css(accent.uiColor),
            "--blue": css(Theme.activityBlueColor), "--green": css(Theme.sageColor),
            "--red": css(Theme.roseColor), "--destructive": css(Theme.roseColor),
            "--orange": css(Theme.activityGoldColor), "--purple": css(Theme.activityPurpleColor),
            "--yellow": css(Theme.activityGoldColor), "--font-size-base": "\(fontSize)px",
            "--color-text-primary": css(Theme.inkColor), "--color-text-secondary": css(Theme.mutedColor),
            "--color-background-primary": css(Theme.groundColor), "--color-background-secondary": css(Theme.raisedColor),
            "--color-border-primary": css(Theme.lineColor), "--color-border-secondary": css(Theme.lineColor),
            "--color-text-info": css(Theme.activityBlueColor), "--color-text-success": css(Theme.sageColor),
            "--color-text-warning": css(Theme.amberColor), "--color-text-danger": css(Theme.roseColor),
            "--accent": css(accent.uiColor),
            "--viz-series-1": css(Theme.activityBlueColor), "--viz-series-2": css(Theme.activityGoldColor),
            "--viz-series-3": css(Theme.sageColor), "--viz-series-4": css(Theme.activityCoralColor),
            "--viz-series-5": css(Theme.activityPurpleColor), "--viz-series-6": css(Theme.roseColor)
        ]]
    }
}

private struct TranscriptVisualizationShare: UIViewControllerRepresentable {
    let file: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [file], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct TranscriptVisualizationLoadIdentity: Hashable {
    let reference: TranscriptVisualizationReference
    let retry: Int
    let visible: Bool
    let leaseID: UUID?
}
