import SwiftUI
import UIKit

/// The mark beside a native transcript tool call.
///
/// Brand artwork is generated from the desktop's `serverIconFor` catalogue.
/// Provider-specific names are reduced to the MCP server before lookup, while
/// web, shell and unbranded MCP tools keep distinct system fallbacks.
struct TranscriptToolIcon: View {
    enum Source: Equatable {
        /// `monochrome` is the same mark with the depth of each sprite role
        /// baked into alpha, for the marks that would otherwise flatten to a
        /// silhouette once the row tints them.
        case asset(name: String, monochrome: String?, title: String)
        case gitBranch
        case system(name: String)
    }

    let name: String
    var size: CGFloat = 16
    var activity: TranscriptToolActivity? = nil
    var state: TranscriptToolActivityState? = nil

    @Environment(\.activityIconColorMode) private var colorMode

    var body: some View {
        Group {
            switch Self.source(for: name, activity: activity) {
            case .asset(let assetName, let monochrome, _):
                Image(colorMode == .color ? assetName : monochrome ?? assetName)
                    .renderingMode(colorMode == .color ? .original : .template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(Theme.muted)
            case .gitBranch:
                GitBranchGlyph()
                    .stroke(
                        activity.map { Color(Self.uiColor(for: $0, state: state, colorMode: colorMode)) }
                            ?? Theme.muted,
                        style: StrokeStyle(lineWidth: size / 12, lineCap: .round, lineJoin: .round)
                    )
            case .system(let systemName):
                Image(systemName: systemName)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(activity.map { Color(Self.uiColor(for: $0, state: state, colorMode: colorMode)) }
                        ?? Theme.muted)
            }
        }
        .frame(width: size, height: size)
        // `square.and.pencil` sits optically low inside its SF Symbol canvas.
        // Lift it one point so mixed activity icons share the same visual axis.
        .offset(y: activity?.kind == .edit ? -1 : 0)
        .accessibilityHidden(true)
    }

    static func source(for toolName: String, activity: TranscriptToolActivity? = nil) -> Source {
        if activity?.kind == .git { return .gitBranch }
        if activity?.kind == .computer { return .system(name: systemSymbol(for: .computer)) }
        if let server = serverName(in: toolName), let icon = catalogue.icon(for: server) {
            return .asset(
                name: "Integrations/\(icon.key)",
                monochrome: icon.monochromeKey.map { "Integrations/\($0)" },
                title: icon.title
            )
        }
        if let activity { return .system(name: systemSymbol(for: activity.kind)) }
        if isWebTool(toolName) { return .system(name: "globe") }
        if serverName(in: toolName) != nil { return .system(name: "powerplug") }
        return .system(name: "terminal")
    }

    static func assetName(for toolName: String, activity: TranscriptToolActivity? = nil) -> String? {
        guard case .asset(let name, _, _) = source(for: toolName, activity: activity) else { return nil }
        return name
    }

    static func systemSymbol(for kind: TranscriptToolActivityKind) -> String {
        switch kind {
        case .read: return "book"
        case .edit: return "square.and.pencil"
        case .image: return "photo.on.rectangle.angled"
        case .search: return "magnifyingglass"
        case .list: return "folder"
        case .webSearch, .webFetch: return "globe"
        case .discovery: return "wrench.adjustable"
        case .command: return "terminal"
        case .computer: return "desktopcomputer"
        case .tool: return "wrench.and.screwdriver"
        case .agent: return "cpu"
        case .skill, .imageGenerate: return "sparkles"
        case .imageCapture: return "camera"
        case .agentMessage: return "bubble.left"
        case .agentWait: return "hourglass"
        case .agentStop: return "stop.circle"
        case .memoryRecall, .memorySave: return "brain"
        case .git: return "arrow.triangle.branch"
        case .browser: return "globe"
        case .plan: return "checklist"
        }
    }

    static func uiColor(
        for kind: TranscriptToolActivityKind,
        state: TranscriptToolActivityState? = nil,
        colorMode: ActivityIconColorMode = .color
    ) -> UIColor {
        guard colorMode == .color else { return Theme.mutedColor }
        // A delete is a file change, not a failure, so red stays the mark of
        // work that did not finish.
        if state == .failed || state == .cancelled || kind == .agentStop {
            return Theme.activityRedColor
        }
        // Mirrors tool-activity.css: one sayable family per colour, with blue
        // as the fallback for rows nothing else named.
        switch kind {
        // Changed a file.
        case .edit: return Theme.activityCoralColor
        // Looked at the project, without changing it.
        case .read, .list, .git: return Theme.activityGreenColor
        // Went looking for something, in the files or on the web.
        case .search, .discovery, .webSearch, .webFetch, .browser:
            return Theme.activityPurpleColor
        // The agent's own machinery rather than the repo.
        case .skill, .plan, .memoryRecall, .memorySave, .agent, .agentMessage, .agentWait:
            return Theme.activityGoldColor
        // Ran a command, including work we could not identify.
        case .command, .computer: return Theme.activityOrangeColor
        case .image, .tool, .imageCapture, .imageGenerate:
            return Theme.activityBlueColor
        case .agentStop: return Theme.activityRedColor
        }
    }

    static func uiColor(
        for activity: TranscriptToolActivity,
        state: TranscriptToolActivityState? = nil,
        colorMode: ActivityIconColorMode = .color
    ) -> UIColor {
        uiColor(for: activity.kind, state: state, colorMode: colorMode)
    }

    /// Used by the asset-integrity test so adding an exported mark cannot fail
    /// silently as an empty SwiftUI image.
    static var generatedAssetNames: [String] {
        catalogue.icons.flatMap { icon in
            ["Integrations/\(icon.key)"] + (icon.monochromeKey.map { ["Integrations/\($0)"] } ?? [])
        }
    }

    private static let argmaxToolNames: Set<String> = [
        "browser_back", "browser_click", "browser_close", "browser_evaluate", "browser_find",
        "browser_get_text", "browser_handle_dialog", "browser_hover", "browser_navigate", "browser_open",
        "browser_press_key", "browser_reload", "browser_screenshot", "browser_scroll", "browser_select",
        "browser_snapshot", "browser_tabs", "browser_type", "browser_wait_for", "inbox_read", "session_launch",
        "session_list", "session_message", "session_move", "session_read", "session_status", "session_stop",
        "session_wait"
    ]

    private static func serverName(in toolName: String) -> String? {
        let trimmed = toolName.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        if argmaxToolNames.contains(lower) { return "argmax" }

        let codexAppsPrefix = "mcp__codex_apps__"
        if lower.hasPrefix(codexAppsPrefix) {
            let remainder = String(lower.dropFirst(codexAppsPrefix.count))
            return catalogue.serverPrefix(in: remainder)
        }

        if lower.hasPrefix("mcp__") {
            let remainder = String(trimmed.dropFirst("mcp__".count))
            let segments = remainder.components(separatedBy: "__")
            guard segments.count >= 2 else { return nil }
            return normalizedNamespace(segments[0])
        }

        let dotted = trimmed.split(separator: ".", omittingEmptySubsequences: true).map(String.init)
        if dotted.count >= 3, dotted[0].lowercased() == "mcp" { return normalizedNamespace(dotted[1]) }
        if dotted.count >= 2 { return normalizedNamespace(dotted[0]) }

        return catalogue.serverPrefix(in: lower)
    }

    private static func normalizedNamespace(_ namespace: String) -> String {
        var server = namespace
        if server.lowercased().hasPrefix("claude_ai_") {
            server = String(server.dropFirst("claude_ai_".count))
        }
        if server.lowercased().hasPrefix("plugin-") {
            let parts = server.dropFirst("plugin-".count).split(separator: "-").map(String.init)
            let half = parts.count / 2
            if parts.count.isMultiple(of: 2), Array(parts[..<half]) == Array(parts[half...]) {
                server = parts[..<half].joined(separator: " ")
            } else if let last = parts.last {
                server = last
            }
        }
        return TranscriptToolIconCatalog.normalize(server)
    }

    private static func isWebTool(_ name: String) -> Bool {
        let lower = name.lowercased()
        return ["web", "browser", "navigate", "fetch", "url", "http"].contains { lower.contains($0) }
    }

    private static let catalogue = TranscriptToolIconCatalog.bundled
}

private final class TranscriptToolIconBundleMarker {}

private struct TranscriptToolIconCatalog: Decodable {
    struct Icon: Decodable {
        var key: String
        var title: String
        var aliases: [String]
        /// Set only for marks the exporter gave a tinted rendition.
        var monochromeKey: String?
    }

    var icons: [Icon]
    var mcpServersWithoutIcons: [String]

    static let bundled: TranscriptToolIconCatalog = {
        guard let url = Bundle(for: TranscriptToolIconBundleMarker.self)
            .url(forResource: "toolIcons", withExtension: "json")
        else {
            fatalError(
                "toolIcons.json is not in the app bundle. Run `node scripts/export-ios-tool-icons.mjs` "
                    + "from the repository root, then re-run xcodegen."
            )
        }
        do {
            return try JSONDecoder().decode(TranscriptToolIconCatalog.self, from: Data(contentsOf: url))
        } catch {
            fatalError("toolIcons.json is bundled but unreadable: \(error)")
        }
    }()

    func icon(for server: String) -> Icon? {
        let server = Self.normalize(server)
        return icons.first { icon in icon.aliases.contains { Self.normalize($0) == server } }
    }

    /// OpenCode calls MCP tools `<server>_<tool>` without an MCP marker.
    /// Longest first keeps `google-drive_*` ahead of its `drive` alias.
    func serverPrefix(in toolName: String) -> String? {
        let known = icons.flatMap(\.aliases) + mcpServersWithoutIcons
        for server in known.sorted(by: { $0.count > $1.count }) {
            for spelling in [Self.normalize(server).replacingOccurrences(of: " ", with: "-"),
                             Self.normalize(server).replacingOccurrences(of: " ", with: "_")] {
                if toolName == spelling || toolName.hasPrefix("\(spelling)_") {
                    return Self.normalize(server)
                }
            }
        }
        return nil
    }

    static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
}
