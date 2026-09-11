import MermaidRender
import SwaTex
import SwaTexRender
import SwiftUI
import UIKit

enum TranscriptRichKind: String { case mermaid, math }

struct TranscriptRichBlock: View {
    let kind: TranscriptRichKind
    let source: String
    let display: Bool
    private let support: TranscriptRichSupport
    @State private var expanded = false

    init(kind: TranscriptRichKind, source: String, display: Bool) {
        self.kind = kind
        self.source = source
        self.display = display
        support = TranscriptRichSupport(kind: kind, source: source)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 2) {
                Text(kind == .mermaid ? "Diagram" : "Equation")
                    .typeStyle(.footnote, weight: .semibold)
                    .foregroundStyle(Theme.muted)
                Spacer()
                Button { UIPasteboard.general.string = source } label: {
                    Image(systemName: "doc.on.doc").frame(width: 32, height: 32)
                }
                .accessibilityLabel(kind == .mermaid ? "Copy diagram source" : "Copy equation source")
                Button { expanded = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 32, height: 32)
                }
                .accessibilityLabel(kind == .mermaid ? "View full diagram" : "View full equation")
            }
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 10)

            TranscriptNativeRichPreview(
                kind: kind,
                source: source,
                display: display,
                support: support
            )
        }
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .fullScreenCover(isPresented: $expanded) {
            NavigationStack {
                TranscriptExpandedRichContent(kind: kind, source: source, support: support)
                    .background(Theme.ground)
                    .navigationTitle(kind == .mermaid ? "Diagram" : "Equation")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { expanded = false }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button { UIPasteboard.general.string = source } label: {
                                Label("Copy source", systemImage: "doc.on.doc")
                            }
                        }
                    }
            }
        }
    }
}

struct TranscriptNativeRichPreview: View {
    let kind: TranscriptRichKind
    let source: String
    let display: Bool
    let support: TranscriptRichSupport

    var body: some View {
        switch support.presentation {
        case .sourceFallback(let message):
            ScrollView(.vertical) {
                TranscriptRichSourceFallback(message: message, source: source)
            }
            .frame(maxHeight: 260, alignment: .top)
        case .native(let sourceNote):
            VStack(alignment: .leading, spacing: 10) {
                if let sourceNote {
                    TranscriptRichSourceNote(message: sourceNote, source: source, compact: true)
                }
                nativeContent
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 12)
        }
    }

    @ViewBuilder
    private var nativeContent: some View {
        switch kind {
        case .math:
            ScrollView(.horizontal) {
                MathView(source)
                    .font(size: display ? 22 : 17)
                    .inlineStyle(!display)
                    .mathColor(Theme.ink)
                    .fixedSize()
                    .padding(.vertical, display ? 8 : 4)
            }
            .frame(minHeight: display ? 54 : 30, maxHeight: display ? 360 : 48)
        case .mermaid:
            MermaidView(source, spacing: .compact)
                .frame(maxWidth: .infinity, maxHeight: support.showsSource ? 220 : 360)
                .accessibilityIdentifier("Native Mermaid diagram")
        }
    }
}

private struct TranscriptExpandedRichContent: View {
    let kind: TranscriptRichKind
    let source: String
    let support: TranscriptRichSupport

    var body: some View {
        switch support.presentation {
        case .sourceFallback(let message):
            ScrollView([.horizontal, .vertical]) {
                TranscriptRichSourceFallback(message: message, source: source)
                    .padding(16)
            }
        case .native(let sourceNote):
            VStack(spacing: 0) {
                TranscriptRichZoomCanvas {
                    switch kind {
                    case .math:
                        MathView(source)
                            .font(size: 30)
                            .mathColor(Theme.ink)
                            .fixedSize()
                            .padding(32)
                    case .mermaid:
                        MermaidView(source, spacing: .comfortable)
                            .fixedSize()
                            .padding(32)
                    }
                }
                if let sourceNote {
                    Divider().overlay(Theme.line)
                    TranscriptRichSourceNote(message: sourceNote, source: source, compact: false)
                        .padding(16)
                }
            }
        }
    }
}

private struct TranscriptRichZoomCanvas<Content: View>: View {
    let content: Content
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero
    @State private var contentSize: CGSize = .zero

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        GeometryReader { geometry in
            let fittedScale = fitScale(in: geometry.size)
            let maximumScale = max(4, 1 / fittedScale)
            ZStack {
                content
                    .background {
                        GeometryReader { contentGeometry in
                            Color.clear.preference(
                                key: TranscriptRichContentSizeKey.self,
                                value: contentGeometry.size
                            )
                        }
                    }
                    .scaleEffect(fittedScale * scale)
                    .offset(offset)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .contentShape(Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Rich content canvas")
            .gesture(panGesture.simultaneously(with: zoomGesture(maximumScale: maximumScale)))
            .onTapGesture(count: 2) { reset() }
            .onPreferenceChange(TranscriptRichContentSizeKey.self) { contentSize = $0 }
            .clipped()
            .overlay(alignment: .bottomTrailing) { zoomControls(maximumScale: maximumScale) }
        }
    }

    private func fitScale(in viewport: CGSize) -> CGFloat {
        guard contentSize.width > 0, contentSize.height > 0,
              viewport.width > 0, viewport.height > 0
        else { return 1 }
        return min(1, viewport.width / contentSize.width, viewport.height / contentSize.height)
    }

    private var panGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                offset = CGSize(
                    width: settledOffset.width + value.translation.width,
                    height: settledOffset.height + value.translation.height
                )
            }
            .onEnded { _ in settledOffset = offset }
    }

    private func zoomGesture(maximumScale: CGFloat) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(max(settledScale * value.magnification, 0.75), maximumScale)
            }
            .onEnded { _ in settledScale = scale }
    }

    private func zoomControls(maximumScale: CGFloat) -> some View {
        HStack(spacing: 0) {
            Button { setScale(scale - 0.25, maximumScale: maximumScale) } label: {
                Image(systemName: "minus.magnifyingglass").frame(width: 42, height: 42)
            }
            .accessibilityLabel("Zoom out")
            Button { reset() } label: {
                Text("\(Int((scale * 100).rounded()))%")
                    .typeStyle(.footnote, monospacedDigit: true)
                    .frame(minWidth: 48, minHeight: 42)
            }
            .accessibilityLabel("Reset zoom")
            Button { setScale(scale + 0.25, maximumScale: maximumScale) } label: {
                Image(systemName: "plus.magnifyingglass").frame(width: 42, height: 42)
            }
            .accessibilityLabel("Zoom in")
        }
        .foregroundStyle(Theme.ink)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(16)
    }

    private func setScale(_ newScale: CGFloat, maximumScale: CGFloat) {
        withAnimation(.easeOut(duration: 0.15)) {
            scale = min(max(newScale, 0.75), maximumScale)
            settledScale = scale
        }
    }

    private func reset() {
        withAnimation(.easeOut(duration: 0.2)) {
            scale = 1
            settledScale = 1
            offset = .zero
            settledOffset = .zero
        }
    }
}

private struct TranscriptRichContentSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero

    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        value = nextValue()
    }
}

struct TranscriptRichSourceFallback: View {
    let message: String
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(message).typeStyle(.footnote)
            } icon: {
                Image(systemName: "exclamationmark.triangle").typeSymbol(.caption)
            }
                .foregroundStyle(Theme.amber)
                .fixedSize(horizontal: false, vertical: true)
            TranscriptRichSource(source: source)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 12)
    }
}

private struct TranscriptRichSourceNote: View {
    let message: String
    let source: String
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(message).typeStyle(.footnote)
            } icon: {
                Image(systemName: "info.circle").typeSymbol(.caption)
            }
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView(.vertical) {
                TranscriptRichSource(source: source)
            }
            .frame(maxHeight: compact ? 72 : 150, alignment: .top)
        }
    }
}

private struct TranscriptRichSource: View {
    let source: String

    var body: some View {
        ScrollView(.horizontal) {
            Text(source)
                .typeStyle(.caption, mono: true)
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: true)
                .padding(10)
        }
        .background(Theme.ground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct TranscriptRichSupport: Equatable {
    enum Presentation: Equatable {
        case native(sourceNote: String?)
        case sourceFallback(message: String)
    }

    let presentation: Presentation

    var showsSource: Bool {
        switch presentation {
        case .native(let sourceNote): sourceNote != nil
        case .sourceFallback: true
        }
    }

    init(kind: TranscriptRichKind, source: String) {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            presentation = .sourceFallback(
                message: kind == .mermaid ? "Diagram source is empty" : "Equation source is empty"
            )
            return
        }

        switch kind {
        case .math:
            do {
                let displayList = try SwaTexEngine.displayList(for: source, cache: .shared)
                if displayList.truncated {
                    presentation = .sourceFallback(
                        message: "This equation is too deeply nested for complete native rendering"
                    )
                } else {
                    presentation = .native(sourceNote: nil)
                }
            } catch {
                presentation = .sourceFallback(
                    message: "Equation could not be rendered: \(error.message)"
                )
            }
        case .mermaid:
            guard MermaidRenderer.altText(source: source) != nil else {
                presentation = .sourceFallback(
                    message: "This Mermaid syntax is not supported by the native renderer"
                )
                return
            }
            presentation = .native(sourceNote: Self.mermaidSourceNote(source))
        }
    }

    private static func mermaidSourceNote(_ source: String) -> String? {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        let header = lines
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("%%") } ?? ""
        let isClassDiagram = header.hasPrefix("classDiagram")
        var hasConfiguration = false
        var hasStyling = false
        var hasInteraction = false
        var hasUnsupportedContent = false

        for rawLine in lines {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("%%{") {
                hasConfiguration = true
            }
            if line.hasPrefix("classDef ") || line.hasPrefix("style ")
                || line.hasPrefix("linkStyle ") || line.contains(":::")
                || (!isClassDiagram && line.hasPrefix("class ")) {
                hasStyling = true
            }
            if line.hasPrefix("click ") {
                hasInteraction = true
            }
            if line.localizedCaseInsensitiveContains("fa:") {
                hasUnsupportedContent = true
            }
        }

        let flowchartUsesShapeSyntax = (header.hasPrefix("flowchart") || header.hasPrefix("graph"))
            && source.contains("@{")
        hasUnsupportedContent = hasUnsupportedContent || flowchartUsesShapeSyntax

        var omissions: [String] = []
        if hasConfiguration { omissions.append("configuration") }
        if hasStyling { omissions.append("custom styling") }
        if hasInteraction { omissions.append("click interactions") }
        if hasUnsupportedContent { omissions.append("some label or shape extensions") }
        guard !omissions.isEmpty else { return nil }

        return "Native preview does not apply \(omissions.formatted()). Source is shown for accuracy."
    }
}
